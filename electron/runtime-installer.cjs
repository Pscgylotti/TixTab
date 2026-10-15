const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync, createWriteStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const manifest = require('./runtime-manifest.json');
const { runtimeLog } = require('./runtime-log.cjs');
const { defaults, validateSources } = require('./runtime-sources.cjs');

// All paths, commands and download records are main-process owned. The renderer
// can only choose a fixed profile; no URLs, pip arguments or paths cross IPC.
function createRuntimeInstaller({
  root,
  backend,
  fetch,
  notify = () => {},
  spawnProcess = spawn,
  platform = process.platform,
  arch = process.arch,
  runtimeManifest = manifest,
}) {
  root = path.resolve(root);
  const profiles = {
    pdf: {
      directory: 'pdf-runtime',
      requirements: 'requirements-pdf.txt',
      imports: 'import pymupdf',
    },
    homr: {
      directory: 'homr-runtime',
      requirements: 'requirements-homr.txt',
      imports: "import importlib.util; assert importlib.util.find_spec('homr')",
      python: require('./runtime-homr-manifest.json'),
    },
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
  let configuring = false;
  async function downloadSources() {
    try {
      return validateSources(
        JSON.parse(
          await fs.readFile(await safe(path.join(root, 'runtime-download-sources.json')), 'utf8'),
        ),
      );
    } catch {
      return { ...defaults };
    }
  }
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
    notify(current.owner, { id: current.id, stage, done, total, source: current.source });
  }
  function command(exe, args, current, timeout = 1200000, events = false) {
    current?.controller.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawnProcess(exe, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' },
      });
      if (current) current.child = child;
      let output = '',
        lines = '',
        errors = '',
        settled = false,
        timedOut = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        current?.controller.signal.removeEventListener('abort', abort);
        if (current?.child === child) current.child = null;
        consume(lines);
        consume(errors);
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
        lines = (lines + chunk.toString()).slice(-16000);
        const parts = lines.split(/\r?\n/);
        lines = parts.pop();
        for (const line of parts) consume(line);
      });
      const consume = (line) => {
        if (!current || !line.trim()) return;
        if (events) {
          try {
            const event = JSON.parse(line);
            if (
              event.event === 'source' &&
              ['pypi', 'tuna', 'ustc', 'custom'].includes(event.source)
            ) {
              current.source = event.source;
              current.log.append(`Package source: ${event.source}`);
              emit(current, 'dependencies');
              return;
            }
            if (event.event === 'log' && typeof event.text === 'string') {
              current.log.append(event.text);
              return;
            }
            if (event.event === 'error') current.log.append('Dependency installation failed.');
          } catch {
            current.log.append(line);
          }
        } else current.log.append(line);
      };
      child.stderr.on('data', (chunk) => {
        errors = (errors + chunk.toString()).slice(-16000);
        const parts = errors.split(/\r?\n/);
        errors = parts.pop();
        for (const line of parts) consume(line);
      });
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
      const pythonVersion = (profiles[id].python || runtimeManifest).version
        .split('.')
        .slice(0, 2)
        .join(',');
      const code = `${profiles[id].imports}; import json,struct,sys; from importlib.metadata import version; pins=json.loads(${JSON.stringify(JSON.stringify(pins))}); assert sys.version_info[:2]==(${pythonVersion}) and struct.calcsize('P')==8; assert all(version(k)==v for k,v in pins.items()); print(json.dumps({'installed':True,'devices':${['openvino', 'speech'].includes(id) ? 'openvino.Core().available_devices' : '[]'}}))`;
      const output = await command(python, ['-c', code], current, 60000);
      return JSON.parse(output.trim().split('\n').at(-1));
    } catch {
      return { installed: false, devices: [] };
    }
  }
  async function managedPython(current) {
    const manifest = profiles[current.id].python || runtimeManifest;
    const base = await safe(path.join(root, 'python', manifest.version + '-' + manifest.revision));
    const executable = path.join(base, 'python', 'python.exe');
    if (existsSync(executable)) return executable;
    const stage = await safe(path.join(root, 'python', '.staging-' + randomUUID()));
    await fs.mkdir(stage, { recursive: true });
    const archive = path.join(stage, 'python.tar.gz');
    try {
      let downloaded = false,
        lastError = Error('network');
      const sources = [
        { id: 'github', url: manifest.url },
        ...(manifest.mirrors || []).map((url) => ({ id: 'npmmirror', url })),
      ];
      if (current.sources.python === 'npmmirror')
        sources.sort((a, b) => Number(b.id === 'npmmirror') - Number(a.id === 'npmmirror'));
      for (let attempt = 0; attempt < sources.length; attempt++) {
        current.controller.signal.throwIfAborted();
        current.source = sources[attempt].id;
        current.log.append(`Python source: ${current.source}`);
        emit(current, 'download', 0, manifest.bytes);
        const download = new AbortController();
        const abort = () => download.abort();
        current.controller.signal.addEventListener('abort', abort, { once: true });
        let idle = setTimeout(abort, 15000);
        const limit = setTimeout(abort, 300000);
        try {
          const response = await fetch(sources[attempt].url, {
            signal: download.signal,
            credentials: 'omit',
            cache: 'no-store',
          });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw Error('network');
          }
          let bytes = 0;
          const hash = createHash('sha256');
          const input = Readable.fromWeb(response.body, { signal: download.signal });
          async function* checked() {
            for await (const chunk of input) {
              bytes += chunk.length;
              clearTimeout(idle);
              idle = setTimeout(abort, 20000);
              if (bytes > manifest.bytes) throw Error('checksum');
              hash.update(chunk);
              emit(current, 'download', bytes, manifest.bytes);
              yield chunk;
            }
          }
          await pipeline(checked(), createWriteStream(archive, { flags: 'wx' }), {
            signal: download.signal,
          });
          if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256)
            throw Error('checksum');
          downloaded = true;
          break;
        } catch (error) {
          if (current.controller.signal.aborted) throw Error('cancelled');
          if (error.code === 'ENOSPC') throw error;
          if (error.message === 'checksum' || lastError.message !== 'checksum')
            lastError = Error(error.message === 'checksum' ? 'checksum' : 'network');
          current.log.append(
            `Python source ${current.source} failed (${error.message === 'checksum' ? 'checksum' : 'network'}).`,
          );
          await fs.unlink(archive).catch(() => {});
        } finally {
          clearTimeout(idle);
          clearTimeout(limit);
          current.controller.signal.removeEventListener('abort', abort);
        }
      }
      if (!downloaded) throw lastError;
      current.log.append('Python archive size and SHA256 verified.');
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
    if (job || configuring) return { ok: false, error: 'busy' };
    const current = {
      owner,
      id,
      child: null,
      controller: new AbortController(),
      last: 0,
      source: undefined,
      startedAt: Date.now(),
      sources: { ...defaults },
      log: { append() {}, snapshot: () => ({ logs: '', updatedAt: 0 }), flush: async () => {} },
    };
    job = current;
    let lock,
      acquired = false;
    const timer = setTimeout(() => current.controller.abort(), 1800000);
    try {
      await safe(root);
      await fs.mkdir(root, { recursive: true });
      await safe(path.join(root, `runtime-install-${id}.log`));
      current.sources = await downloadSources();
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
      current.log = runtimeLog(root, id);
      current.log.append(`Install started: ${id}`);
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
          path.join(backend, 'install_dependencies.py'),
          path.join(backend, profiles[id].requirements),
          '--source',
          current.sources.packages,
          ...(current.sources.packages === 'custom'
            ? ['--custom-index', current.sources.customIndex]
            : []),
        ],
        current,
        1500000,
        true,
      );
      emit(current, 'verify');
      const verified = await status(id, current);
      current.controller.signal.throwIfAborted();
      if (!verified.installed) throw Error('setup');
      current.log.append('Install verified and complete.');
      return { ok: true, data: verified };
    } catch (e) {
      current.log.append(
        `Install ended: ${current.controller.signal.aborted ? 'cancelled' : e.code === 'ENOSPC' ? 'disk-full' : e.message}`,
      );
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
      await current.log.flush();
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
    downloadSources,
    async configureSources(value) {
      if (job || configuring) return { ok: false, error: 'busy' };
      configuring = true;
      try {
        const sources = validateSources(value);
        await safe(root);
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(
          await safe(path.join(root, 'runtime-download-sources.json')),
          JSON.stringify(sources),
          'utf8',
        );
        return { ok: true, sources };
      } catch (error) {
        return {
          ok: false,
          error: error.message === 'invalid-source' ? 'invalid-source' : 'unsafe',
        };
      } finally {
        configuring = false;
      }
    },
    status,
    async diagnostics(owner, id) {
      if (!profiles[id]) return null;
      if (job?.owner === owner && job.id === id)
        return {
          installing: true,
          id,
          stage: job.stage,
          source: job.source,
          startedAt: job.startedAt,
          ...job.log.snapshot(),
        };
      try {
        const file = await safe(path.join(root, `runtime-install-${id}.log`)),
          stat = await fs.stat(file);
        const handle = await fs.open(file, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(64000, stat.size));
          await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
          return {
            installing: false,
            id,
            stage: 'idle',
            logs: buffer.toString('utf8'),
            updatedAt: stat.mtimeMs,
          };
        } finally {
          await handle.close();
        }
      } catch {
        return { installing: false, id, stage: 'idle', logs: '', updatedAt: 0 };
      }
    },
    install,
    cancel,
    dispose() {
      job?.controller.abort();
    },
  };
}
module.exports = { createRuntimeInstaller };
