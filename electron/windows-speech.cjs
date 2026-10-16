const { spawn: defaultSpawn, execFile } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
/** One isolated WinRT recognizer, bounded response buffers, no audio files. */
function createWindowsSpeech({
  executable,
  registerScript,
  spawn = defaultSpawn,
  microphones,
  onProgress,
}) {
  let session = null;
  function close(owner) {
    const s = session;
    if (!s || (owner && owner !== s.owner)) return;
    session = null;
    clearTimeout(s.limit);
    s.pending?.reject(Error('cancelled'));
    s.child.kill();
  }
  function launch(owner, engine) {
    const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const s = {
      owner,
      engine,
      child,
      id: crypto.randomUUID(),
      queue: Promise.resolve(),
      pending: null,
      buffer: '',
      done: false,
    };
    session = s;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      s.buffer += chunk;
      if (s.buffer.length > 100000) {
        close(owner);
        return;
      }
      let at;
      while ((at = s.buffer.indexOf('\n')) >= 0) {
        const line = s.buffer.slice(0, at);
        s.buffer = s.buffer.slice(at + 1);
        try {
          const result = JSON.parse(line);
          if (result.progress) {
            onProgress?.(s.owner, {
              stage: String(result.progress.stage).slice(0, 60),
              value: Math.max(0, Math.min(1, Number(result.progress.value) || 0)),
            });
            continue;
          }
          const pending = s.pending;
          s.pending = null;
          pending?.resolve(result);
        } catch {
          s.pending?.reject(Error('inference'));
          s.pending = null;
        }
      }
    });
    const exited = () => {
      s.pending?.reject(Error('windows-ai-unavailable'));
      s.pending = null;
      if (session === s) session = null;
      clearTimeout(s.limit);
    };
    child.once('close', exited);
    child.once('error', exited);
    return s;
  }
  function ask(s, command, timeout = 30000) {
    const work = s.queue
      .catch(() => {})
      .then(
        () =>
          new Promise((resolve, reject) => {
            if (session !== s) {
              reject(Error('cancelled'));
              return;
            }
            const timer = setTimeout(() => {
              reject(Error('timeout'));
              close(s.owner);
            }, timeout);
            s.pending = {
              resolve: (r) => {
                clearTimeout(timer);
                resolve(r);
              },
              reject: (e) => {
                clearTimeout(timer);
                reject(e);
              },
            };
            try {
              s.child.stdin.write(JSON.stringify({ ...command, engine: s.engine }) + '\n');
            } catch {
              s.pending.reject(Error('windows-ai-unavailable'));
            }
          }),
      );
    s.queue = work;
    return work;
  }
  return {
    cancel: close,
    dispose: () => close(),
    async run(owner, r) {
      try {
        if (r.action === 'register') {
          if (session) return { ok: false, error: 'busy' };
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
                '-ComponentName',
                'TixTab.WindowsAI.Speech',
              ],
              { windowsHide: true, timeout: 30000, maxBuffer: 32768 },
              (e) => (e ? reject(Error('windows-ai-registration-failed')) : resolve()),
            ),
          );
          return { ok: true };
        }
        if (['status', 'prepare', 'start'].includes(r.action)) {
          if (!['windows-ai', 'windows-sdk'].includes(r.engine))
            return { ok: false, error: 'invalid' };
          if (session) return { ok: false, error: 'busy' };
          const s = launch(owner, r.engine);
          let microphoneName = '';
          if (r.microphone) {
            const listed = await microphones(owner);
            const input = listed?.data?.microphones?.find((m) => m.id === r.microphone);
            if (!input) {
              close(owner);
              return { ok: false, error: 'microphone-missing' };
            }
            microphoneName = input.name;
          }
          const result = await ask(
            s,
            { ...r, microphoneName },
            r.action === 'prepare' ? 600000 : 60000,
          );
          if (r.action !== 'start' || !result.ok) close(owner);
          else {
            s.limit = setTimeout(() => close(owner), 130000);
            return { ok: true, data: { id: s.id } };
          }
          return result;
        }
        const s = session;
        if (!s || s.owner !== owner) return { ok: false, error: 'cancelled' };
        if (r.action === 'stop') return await ask(s, { action: 'stop' }, 20000);
        if (r.action === 'cancel') {
          close(owner);
          return { ok: true };
        }
        if (r.action === 'read' && r.id === s.id) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const result = await ask(s, { action: 'read' });
          if (result.data?.done) close(owner);
          return result;
        }
        return { ok: false, error: 'invalid' };
      } catch (e) {
        close(owner);
        return {
          ok: false,
          error: e.code === 'ENOENT' ? 'runtime' : e.message || 'windows-ai-unavailable',
        };
      }
    },
  };
}
function createSystemSpeechRouter(legacy, native) {
  const routes = new Map();
  return {
    async run(owner, r) {
      const service =
        r.action === 'start'
          ? r.engine === 'system'
            ? legacy
            : native
          : routes.get(owner) || legacy;
      if (r.action === 'start') routes.set(owner, service);
      const result = await service.run(owner, r);
      if (
        (r.action === 'read' && result.data?.done) ||
        (r.action === 'start' && !result.ok) ||
        r.action === 'cancel'
      )
        routes.delete(owner);
      return result;
    },
    cancel(owner) {
      legacy.cancel(owner);
      native.cancel(owner);
      if (owner) routes.delete(owner);
      else routes.clear();
    },
    dispose() {
      routes.clear();
      legacy.dispose();
      native.dispose();
    },
  };
}
module.exports = { createWindowsSpeech, createSystemSpeechRouter };
