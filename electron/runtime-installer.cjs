const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync, createWriteStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const manifest = require('./runtime-manifest.json');

// All paths, commands and download records are main-process owned. The renderer
// can only choose one of two profiles; no URLs, pip arguments or paths cross IPC.
function createRuntimeInstaller({
  root,
  backend,
  fetch,
  notify = () => {},
  spawnProcess = spawn,
  platform = process.platform,
  arch = process.arch,
}) {
  root = path.resolve(root);
  const profiles = {
    openvino: {
      directory: 'openvino-runtime',
      requirements: 'requirements-ocr.txt',
      imports: 'import openvino,rapidocr,cv2,tokenizers,fastapi,uvicorn',
    },
    speech: {
      directory: 'asr-runtime',
      requirements: 'requirements-asr.txt',
      imports: 'import openvino,openvino_genai,sherpa_onnx,sounddevice,soxr,webrtcvad',
    },
  };
  let job = null;
  const pythonFor = (id) => path.join(root, profiles[id].directory, 'Scripts', 'python.exe');
  async function safe(target) {
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('unsafe');
    let current = root;
    for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw Error('unsafe');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return target;
  }
  function emit(current, stage, done = 0, total = 0) {
    current.stage = stage;
    if (Date.now() - current.last < 150 && stage === 'download' && done < total) return;
    current.last = Date.now();
    notify(current.owner, { id: current.id, stage, done, total });
  }
  function command(exe, args, current, timeout = 1200000) {
    current?.controller.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawnProcess(exe, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' },
      });
      if (current) current.child = child;
      let output = '',
        settled = false,
        timedOut = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        current?.controller.signal.removeEventListener('abort', abort);
        if (current?.child === child) current.child = null;
        error ? reject(error) : resolve(output);
      };
      const abort = () => {
        stop(child);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop(child);
      }, timeout);
      child.stdout.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-16000);
      });
      child.stderr.on('data', () => {}); // pip output can include proxy secrets.
      child.once('error', () => finish(Error('setup')));
      child.once('close', (code) =>
        finish(
          current?.controller.signal.aborted
            ? Error('cancelled')
            : timedOut
              ? Error('timeout')
              : code === 0
                ? null
                : Error('setup'),
        ),
      );
      current?.controller.signal.addEventListener('abort', abort, { once: true });
      if (current?.controller.signal.aborted) abort();
    });
  }
  function stop(child) {
    // pip may own a child process. Only terminate the process tree we spawned.
    if (platform === 'win32' && child.pid) {
      const killer = spawnProcess(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      killer.on('error', () => child.kill());
    } else child.kill();
  }
  async function requirements(file) {
    const result = {};
    for (const line of (await fs.readFile(path.join(backend, file), 'utf8')).split(/\r?\n/)) {
      if (line.startsWith('-r ')) Object.assign(result, await requirements(line.slice(3).trim()));
      else {
        const match = line.trim().match(/^([\w.-]+)==([\w.+-]+)$/);
        if (match) result[match[1]] = match[2];
      }
    }
    return result;
  }
  async function status(id, current = null) {
    if (!profiles[id]) return { installed: false, devices: [], error: 'invalid' };
    if (job && job !== current) return { installed: false, devices: [], installing: job.id };
    try {
      const python = await safe(pythonFor(id));
      if (!existsSync(python)) return { installed: false, devices: [] };
      const pins = await requirements(profiles[id].requirements);
      const code = `${profiles[id].imports}; import json,struct,sys; from importlib.metadata import version; pins=json.loads(${JSON.stringify(JSON.stringify(pins))}); assert sys.version_info[:2]==(3,10) and struct.calcsize('P')==8; assert all(version(k)==v for k,v in pins.items()); print(json.dumps({'installed':True,'devices':openvino.Core().available_devices}))`;
      const output = await command(python, ['-c', code], current, 60000);
      return JSON.parse(output.trim().split('\n').at(-1));
    } catch {
      return { installed: false, devices: [] };
    }
  }
  async function managedPython(current) {
    const base = await safe(path.join(root, 'python', manifest.version + '-' + manifest.revision));
    const executable = path.join(base, 'python', 'python.exe');
    if (existsSync(executable)) return executable;
    const stage = await safe(path.join(root, 'python', '.staging-' + randomUUID()));
    await fs.mkdir(stage, { recursive: true });
    const archive = path.join(stage, 'python.tar.gz');
    try {
      emit(current, 'download', 0, manifest.bytes);
      const response = await fetch(manifest.url, {
        signal: current.controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw Error('network');
      }
      let bytes = 0;
      const hash = createHash('sha256');
      const input = Readable.fromWeb(response.body, { signal: current.controller.signal });
      async function* checked() {
        for await (const chunk of input) {
          bytes += chunk.length;
          if (bytes > manifest.bytes) throw Error('checksum');
          hash.update(chunk);
          emit(current, 'download', bytes, manifest.bytes);
          yield chunk;
        }
      }
      await pipeline(checked(), createWriteStream(archive, { flags: 'wx' }), {
        signal: current.controller.signal,
      });
      if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256)
        throw Error('checksum');
      emit(current, 'extract');
      await command(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
        ['-xzf', archive, '-C', stage],
        current,
        120000,
      );
      await fs.unlink(archive);
      if (!existsSync(path.join(stage, 'python', 'python.exe'))) throw Error('setup');
      await fs.rename(stage, base);
      return executable;
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }
  async function install(owner, id) {
    if (!profiles[id]) return { ok: false, error: 'invalid' };
    if (platform !== 'win32' || arch !== 'x64') return { ok: false, error: 'unsupported' };
    if (job) return { ok: false, error: 'busy' };
    const current = { owner, id, child: null, controller: new AbortController(), last: 0 };
    job = current;
    let lock,
      acquired = false;
    const timer = setTimeout(() => current.controller.abort(), 1800000);
    try {
      await safe(root);
      await fs.mkdir(root, { recursive: true });
      // Cross-window/process lock; recover only a lock whose process has exited.
      const lockPath = await safe(path.join(root, '.runtime-install.lock'));
      try {
        lock = await fs.open(lockPath, 'wx');
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let previous;
        try {
          previous = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        } catch {
          throw Error('busy');
        }
        try {
          process.kill(previous.pid, 0);
          throw Error('busy');
        } catch (probe) {
          if (probe.code !== 'ESRCH') throw Error('busy');
        }
        await fs.unlink(lockPath);
        lock = await fs.open(lockPath, 'wx');
      }
      acquired = true;
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      emit(current, 'check');
      const ready = await status(id, current);
      current.controller.signal.throwIfAborted();
      if (ready.installed) return { ok: true, data: ready };
      if (!existsSync(pythonFor(id))) {
        const base = await managedPython(current);
        emit(current, 'environment');
        await safe(path.join(root, profiles[id].directory));
        await command(
          base,
          ['-m', 'venv', path.join(root, profiles[id].directory)],
          current,
          120000,
        );
      }
      emit(current, 'dependencies');
      await command(pythonFor(id), ['-m', 'ensurepip', '--upgrade'], current, 120000);
      await command(
        pythonFor(id),
        [
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          '--only-binary=:all:',
          '--no-warn-script-location',
          '--retries',
          '2',
          '--timeout',
          '30',
          '-r',
          path.join(backend, profiles[id].requirements),
        ],
        current,
      );
      emit(current, 'verify');
      const verified = await status(id, current);
      current.controller.signal.throwIfAborted();
      if (!verified.installed) throw Error('setup');
      return { ok: true, data: verified };
    } catch (e) {
      return {
        ok: false,
        error: current.controller.signal.aborted
          ? 'cancelled'
          : e.code === 'ENOSPC'
            ? 'disk-full'
            : ['busy', 'unsafe', 'checksum', 'network', 'unsupported'].includes(e.message)
              ? e.message
              : 'setup',
      };
    } finally {
      clearTimeout(timer);
      await lock?.close();
      if (acquired) await fs.unlink(path.join(root, '.runtime-install.lock')).catch(() => {});
      if (job === current) job = null;
      emit(current, 'idle');
    }
  }
  function cancel(owner) {
    if (job && job.owner === owner) {
      job.controller.abort();
      return true;
    }
    return false;
  }
  return {
    status,
    install,
    cancel,
    dispose() {
      job?.controller.abort();
    },
  };
}
module.exports = { createRuntimeInstaller };
