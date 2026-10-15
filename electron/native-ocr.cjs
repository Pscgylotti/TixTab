const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');
const os = require('node:os');
const variants = {
  fast: [['ocr/eng.traineddata', 'eng']],
  'mixed-fast': [
    ['ocr/eng.traineddata', 'eng'],
    ['ocr/chi_sim.traineddata', 'chi_sim'],
  ],
  best: [['tesseract-openvino/best.traineddata', 'eng']],
  'mixed-best': [
    ['tesseract-openvino/best.traineddata', 'eng'],
    ['tesseract-openvino-zh/mixed-best.traineddata', 'chi_sim'],
  ],
};
function createNativeOcr({ executable, workingRoot, resolveModel, npu, spawn = defaultSpawn }) {
  const sessions = new Map();
  let disposed = false;
  function worker(session) {
    const process = spawn(
      session.executable || executable,
      [session.modelDirectory || session.directory, session.language],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...global.process.env, OMP_THREAD_LIMIT: '1', OMP_NUM_THREADS: '1' },
      },
    );
    try {
      os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {}
    const slot = { process, busy: true, pixels: 0, closed: false, pending: null };
    session.slots.push(slot);
    let buffer = '';
    process.stdout.setEncoding('utf8');
    const exited = new Promise((resolve) => process.once('close', resolve));
    const fail = () => {
      slot.closed = true;
      slot.pending?.reject(Error(session.closed ? 'cancelled' : 'native-ocr-crashed'));
    };
    process.once('error', fail);
    process.once('exit', fail);
    process.stdin.on('error', fail);
    process.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) {
        fail();
        process.kill();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          slot.pending?.resolve(JSON.parse(line));
        } catch {
          fail();
          process.kill();
        }
      }
    });
    slot.wait = (timeout) =>
      new Promise((resolve, reject) => {
        if (slot.closed) {
          reject(Error('native-ocr-crashed'));
          return;
        }
        const timer = setTimeout(() => {
          reject(Error('native-ocr-timeout'));
          process.kill();
        }, timeout);
        slot.pending = {
          resolve(value) {
            clearTimeout(timer);
            slot.pending = null;
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            slot.pending = null;
            reject(error);
          },
        };
      });
    slot.stop = () => {
      if (!slot.closed) {
        slot.closed = true;
        slot.pending?.reject(Error('cancelled'));
        process.kill();
      }
      return exited;
    };
    slot.ready = slot.wait(45000).then((value) => {
      if (value.ready !== true) throw Error(value.error || 'model-load-failed');
    });
    // Attach rejection handler immediately, even if cancellation precedes recognize().
    void slot.ready.catch(() => {});
    return slot;
  }
  async function close(owner, id) {
    const session = sessions.get(owner);
    if (!session || (id && session.id !== id)) return;
    if (session.closing) return session.closing;
    session.closed = true;
    clearTimeout(session.timer);
    session.closing = (async () => {
      await Promise.allSettled(session.slots.map((slot) => slot.stop()));
      await Promise.allSettled([session.preparing, ...session.jobs]);
      if (session.directory) await fs.rm(session.directory, { recursive: true, force: true });
      owner.removeListener?.('destroyed', session.destroyed);
      if (sessions.get(owner) === session) sessions.delete(owner);
    })();
    return session.closing;
  }
  function idle(owner, session) {
    clearTimeout(session.timer);
    if (!session.closed && !session.jobs.size)
      session.timer = setTimeout(
        () => void close(owner, session.id).catch(() => {}),
        session.idleMs,
      );
    session.timer?.unref?.();
  }
  async function recognize(owner, session, image) {
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
      height = bytes.readUInt32BE(20),
      pixels = width * height;
    if (!width || !height || width > 8192 || height > 8192 || pixels > 4000000)
      throw Error('image-limit');
    if (session.activePixels + pixels > 4000000) throw Error('native-ocr-busy');
    let slot = session.slots.find((s) => !s.busy && !s.closed);
    if (!slot && session.slots.filter((s) => !s.closed).length >= session.count)
      throw Error('native-ocr-busy');
    session.activePixels += pixels;
    clearTimeout(session.timer);
    try {
      if (!slot) slot = worker(session);
      slot.busy = true;
      slot.pixels = Math.max(slot.pixels, pixels);
      await slot.ready;
      if (session.closed) throw Error('cancelled');
      const response = slot.wait(180000),
        header = Buffer.alloc(4);
      header.writeUInt32LE(bytes.length);
      slot.process.stdin.write(header);
      slot.process.stdin.write(bytes);
      const result = await response;
      if (!result.ok) throw Error(result.error || 'recognition-failed');
      if (
        result.width !== width ||
        result.height !== height ||
        typeof result.text !== 'string' ||
        result.text.length > 100000 ||
        !Array.isArray(result.lines) ||
        result.lines.length > 4096
      )
        throw Error('invalid-result');
      if (session.npu && result.device !== 'NPU') throw Error('unexpected-inference-device');
      return {
        ...result,
        engine: session.npu ? 'Tesseract C++ + NPU (experimental)' : 'Tesseract C++',
        device: session.npu ? 'NPU' : 'CPU (native)',
      };
    } finally {
      session.activePixels -= pixels;
      if (slot) slot.busy = false;
      // Retire surplus high-water processes rather than retaining four large heaps.
      while (session.slots.filter((s) => !s.closed).reduce((n, s) => n + s.pixels, 0) > 4000000) {
        const spare = session.slots.find((s) => !s.busy && !s.closed);
        if (!spare) break;
        await spare.stop();
      }
      session.slots = session.slots.filter((s) => !s.closed);
    }
  }
  return {
    async dispose() {
      disposed = true;
      await Promise.allSettled([...sessions].map(([owner]) => close(owner)));
    },
    async run(owner, request) {
      try {
        if (disposed) throw Error('cancelled');
        if (request?.action === 'status') {
          await fs.access(executable);
          const npuAvailable =
            !!npu &&
            (await fs
              .access(npu.executable)
              .then(() => fs.access(path.join(npu.modelsRoot, 'best/codes.bin')))
              .then(
                () => true,
                () => false,
              ));
          return { ok: true, available: true, npuAvailable };
        }
        if (typeof request?.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(request.id))
          throw Error('invalid');
        if (request.action === 'close') {
          await close(owner, request.id);
          return { ok: true };
        }
        if (request.action === 'open') {
          const npuVariant = ['npu-fast', 'npu-best'].includes(request.variant);
          if (
            sessions.has(owner) ||
            (!variants[request.variant] && !npuVariant) ||
            ![1, 2, 4].includes(request.count)
          )
            throw Error('native-ocr-busy');
          if (npuVariant && (!npu || request.count !== 1)) throw Error('native-npu-missing');
          await fs.access(npuVariant ? npu.executable : executable).catch(() => {
            throw Error('native-ocr-missing');
          });
          if (sessions.has(owner) || disposed) throw Error('native-ocr-busy');
          const session = {
            id: request.id,
            count: request.count,
            npu: npuVariant,
            executable: npuVariant ? npu.executable : executable,
            closed: false,
            slots: [],
            jobs: new Set(),
            activePixels: 0,
            idleMs: Math.max(30, Math.min(86400, Number(request.idleSeconds) || 1800)) * 1000,
          };
          sessions.set(owner, session);
          session.destroyed = () => void close(owner, session.id).catch(() => {});
          owner.once?.('destroyed', session.destroyed);
          session.preparing = (async () => {
            await fs.mkdir(workingRoot, { recursive: true });
            session.directory = await fs.mkdtemp(path.join(workingRoot, 'job-'));
            if (npuVariant) {
              const variant = request.variant.slice(4);
              const folder = path.join(npu.modelsRoot, variant);
              const manifest = JSON.parse(
                await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'),
              );
              if (manifest.variant !== variant || manifest.batch !== 1)
                throw Error('native-npu-missing');
              session.modelDirectory = folder;
              session.language = path.join(npu.cacheRoot, variant);
              await fs.mkdir(session.language, { recursive: true });
              if (session.closed) throw Error('cancelled');
              return;
            }
            const languages = [];
            for (const [relative, language] of variants[request.variant]) {
              if (session.closed) throw Error('cancelled');
              const source = await resolveModel(relative);
              if (!source) throw Error('missing-model');
              const target = path.join(session.directory, language + '.traineddata');
              await fs.link(source, target).catch(() => fs.copyFile(source, target));
              languages.push(language);
            }
            session.language = languages.join('+');
            if (session.closed) throw Error('cancelled');
          })();
          try {
            await session.preparing;
            idle(owner, session);
            return { ok: true };
          } catch (error) {
            await close(owner, session.id);
            throw error;
          }
        }
        const session = sessions.get(owner);
        if (
          !session ||
          session.id !== request.id ||
          session.closed ||
          !session.language ||
          request.action !== 'recognize'
        )
          throw Error('cancelled');
        const job = recognize(owner, session, request.image);
        session.jobs.add(job);
        try {
          return { ok: true, data: await job };
        } finally {
          session.jobs.delete(job);
          idle(owner, session);
        }
      } catch (error) {
        return { ok: false, error: error.message || 'native-ocr-failed' };
      }
    },
  };
}
module.exports = { createNativeOcr };
