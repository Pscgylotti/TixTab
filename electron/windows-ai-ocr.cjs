const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn: defaultSpawn, execFile } = require('node:child_process');
/** At most one model process and one decoded image. All paths are host-owned. */
function createWindowsAiOcr({ executable, workingRoot, registerScript, spawn = defaultSpawn }) {
  let session = null,
    disposed = false;
  async function close(owner, id) {
    const current = session;
    if (!current || (owner && current.owner !== owner) || (id && current.id !== id)) return;
    if (current.closing) return current.closing;
    current.closed = true;
    clearTimeout(current.idle);
    current.pending?.reject(Error('cancelled'));
    current.process?.kill();
    current.closing = (async () => {
      await current.exit;
      await Promise.allSettled([...current.jobs]);
      if (current.directory) await fs.rm(current.directory, { recursive: true, force: true });
      current.owner.removeListener?.('destroyed', current.destroyed);
      if (session === current) session = null;
    })();
    return current.closing;
  }
  function ask(current, request, timeout = 180000) {
    if (current.closed || current.pending) return Promise.reject(Error('windows-ai-busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        current.pending?.reject(Error('windows-ai-timeout'));
        current.process.kill();
      }, timeout);
      const finish = (fn) => (value) => {
        clearTimeout(timer);
        current.pending = null;
        fn(value);
      };
      current.pending = { resolve: finish(resolve), reject: finish(reject) };
      current.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }
  async function launch(owner, id) {
    if (disposed || session) throw Error('windows-ai-busy');
    const current = { owner, id, jobs: new Set(), closed: false, directory: null, process: null };
    session = current; // Reserve before awaiting filesystem work.
    current.destroyed = () => void close(owner, id).catch(() => {});
    owner.once?.('destroyed', current.destroyed);
    try {
      await fs.access(executable).catch(() => {
        throw Error('windows-ai-missing');
      });
      await fs.mkdir(workingRoot, { recursive: true });
      current.directory = await fs.mkdtemp(path.join(workingRoot, 'job-'));
      if (current.closed || disposed) throw Error('cancelled');
      current.process = spawn(executable, [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      current.exit = new Promise((resolve) => current.process.once('close', resolve));
      const fail = () =>
        current.pending?.reject(Error(current.closed ? 'cancelled' : 'windows-ai-crashed'));
      current.process.on('error', fail);
      current.process.on('exit', fail);
      current.process.stdin.on('error', fail);
      let buffer = '';
      current.process.stdout.setEncoding('utf8');
      current.process.stdout.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 8 * 1024 * 1024) {
          fail();
          current.process.kill();
          return;
        }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            current.pending?.resolve(JSON.parse(line));
          } catch {
            fail();
            current.process.kill();
          }
        }
      });
      return current;
    } catch (error) {
      if (current.directory) await fs.rm(current.directory, { recursive: true, force: true });
      owner.removeListener?.('destroyed', current.destroyed);
      if (session === current) session = null;
      throw error;
    }
  }
  return {
    dispose: async () => {
      disposed = true;
      await close();
    },
    async run(owner, request) {
      try {
        if (disposed) throw Error('cancelled');
        if (request?.action === 'register') {
          if (session) throw Error('windows-ai-busy');
          if (!registerScript) throw Error('windows-ai-registration-unavailable');
          await new Promise((resolve, reject) =>
            execFile(
              'powershell.exe',
              [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-WindowStyle',
                'Hidden',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                registerScript,
                '-RuntimeDirectory',
                path.dirname(executable),
              ],
              { windowsHide: true, timeout: 30000, maxBuffer: 32768 },
              (error) => (error ? reject(Error('windows-ai-registration-failed')) : resolve()),
            ),
          );
          return { ok: true };
        }
        if (request?.action === 'close') {
          await close(owner, request.id);
          return { ok: true };
        }
        if (
          !['status', 'open', 'recognize'].includes(request?.action) ||
          typeof request.id !== 'string' ||
          !/^[a-zA-Z0-9-]{1,64}$/.test(request.id)
        )
          throw Error('invalid');
        if (request.action === 'status') {
          const current = await launch(owner, request.id);
          try {
            return await ask(current, { action: 'status' }, 30000);
          } finally {
            await close(owner, request.id);
          }
        }
        if (request.action === 'open') {
          const current = await launch(owner, request.id);
          const result = await ask(current, { action: 'open' }, 600000);
          if (!result.ok) await close(owner, request.id);
          else {
            current.idleMs =
              Math.max(30, Math.min(86400, Number(request.idleSeconds) || 120)) * 1000;
            current.idle = setTimeout(
              () => void close(owner, request.id).catch(() => {}),
              current.idleMs,
            );
            current.idle.unref?.();
          }
          return result;
        }
        const current = session;
        if (!current || current.owner !== owner || current.id !== request.id || current.closed)
          throw Error('windows-ai-not-open');
        if (current.jobs.size || current.pending) throw Error('windows-ai-busy');
        const image = request.image;
        if (
          typeof image !== 'string' ||
          image.length > 34 * 1024 * 1024 ||
          !image.startsWith('data:image/png;base64,')
        )
          throw Error('invalid-image');
        const bytes = Buffer.from(image.slice(22), 'base64');
        if (
          bytes.length < 24 ||
          bytes.length > 24 * 1024 * 1024 ||
          bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
          bytes.toString('ascii', 12, 16) !== 'IHDR'
        )
          throw Error('invalid-image');
        const width = bytes.readUInt32BE(16),
          height = bytes.readUInt32BE(20);
        if (!width || !height || width > 8192 || height > 8192 || width * height > 4000000)
          throw Error('image-limit');
        clearTimeout(current.idle);
        const file = path.join(current.directory, 'input.png');
        const job = (async () => {
          try {
            await fs.writeFile(file, bytes);
            if (current.closed) throw Error('cancelled');
            const result = await ask(current, { action: 'recognize', path: file });
            if (!result.ok)
              await fs
                .writeFile(
                  path.join(workingRoot, 'last-error.json'),
                  JSON.stringify({
                    at: new Date().toISOString(),
                    action: 'recognize',
                    error: result.error,
                    hresult: result.hresult,
                    stage: result.stage,
                  }),
                )
                .catch(() => {});
            if (
              result.ok &&
              (result.data?.width !== width ||
                result.data?.height !== height ||
                typeof result.data?.text !== 'string' ||
                result.data.text.length > 100000 ||
                !Array.isArray(result.data.lines) ||
                result.data.lines.length > 10000)
            )
              throw Error('invalid-result');
            return result;
          } finally {
            await fs.rm(file, { force: true });
          }
        })();
        current.jobs.add(job);
        try {
          return await job;
        } finally {
          current.jobs.delete(job);
          if (!current.closed) {
            current.idle = setTimeout(
              () => void close(owner, request.id).catch(() => {}),
              current.idleMs,
            );
            current.idle.unref?.();
          }
        }
      } catch (error) {
        // Any interrupted/failed session is retired; a later request starts clean.
        if (
          session?.owner === owner &&
          !['windows-ai-busy', 'invalid', 'invalid-image', 'image-limit'].includes(error.message)
        )
          await close(owner, request?.id);
        return { ok: false, error: error.message };
      }
    },
  };
}
module.exports = { createWindowsAiOcr };
