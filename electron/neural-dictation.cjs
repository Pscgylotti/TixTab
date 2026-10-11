const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ENGINES = ['sensevoice-small', 'whisper-small'],
  DEVICES = ['AUTO', 'CPU', 'GPU', 'NPU'];

function createNeuralDictation({
  backend,
  runtime,
  runtimeInstaller,
  modelRoot,
  bundled,
  models,
  system,
  spawnProcess = spawn,
  exists = existsSync,
}) {
  const python = path.join(runtime, 'Scripts', 'python.exe');
  let worker = null,
    job = null,
    setup = null,
    statusCache = null,
    starting = false,
    startOwner = null,
    startCancelled = false;
  let idleSeconds = 1800;
  const validIdle = (value) => Number.isInteger(value) && value >= 30 && value <= 86400;
  const send = (child, message) => {
    try {
      child.stdin.write(JSON.stringify(message) + '\n');
    } catch {}
  };
  function killWorker() {
    if (worker) {
      worker.child.kill();
      worker = null;
    }
  }
  function finish(current) {
    clearTimeout(current.timer);
    clearTimeout(current.drain);
    current.done = true;
    current.ready = false;
    current.wake?.();
  }
  function cancel(owner) {
    if (starting && (!owner || startOwner === owner)) startCancelled = true;
    system.cancel(owner);
    if (job && (!owner || job.owner === owner)) {
      finish(job);
      killWorker();
    }
  }
  function command(exe, args, owner, timeout = 600000) {
    return new Promise((resolve, reject) => {
      const child = spawnProcess(exe, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (setup && setup.owner === owner) setup.child = child;
      let output = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(Error('timeout'));
      }, timeout);
      child.stdout.on('data', (data) => {
        output = (output + data.toString()).slice(-16000);
      });
      child.stderr.on('data', () => {}); // pip may print proxy credentials; never send raw logs to UI.
      child.once('error', () => {
        clearTimeout(timer);
        reject(Error('runtime'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        code === 0 ? resolve(output) : reject(Error('runtime'));
      });
    });
  }
  async function runtimeStatus() {
    if (statusCache) return statusCache;
    if (!exists(python)) return { installed: false, devices: [] };
    try {
      const output = await command(
        python,
        [
          '-c',
          'import json,openvino as ov,openvino_genai,sherpa_onnx,sounddevice,soxr,webrtcvad; print(json.dumps({"installed":True,"devices":ov.Core().available_devices}))',
        ],
        null,
        30000,
      );
      return (statusCache = JSON.parse(output.trim().split('\n').at(-1)));
    } catch {
      return { installed: false, devices: [] };
    }
  }
  return {
    async run(owner, r) {
      if (r?.action === 'idle-policy') {
        if (!validIdle(r.idleReleaseSeconds)) return { ok: false, error: 'invalid' };
        idleSeconds = r.idleReleaseSeconds;
        if (worker) send(worker.child, { action: 'idle-policy', idleReleaseSeconds: idleSeconds });
        return { ok: true };
      }
      if (r?.action === 'status')
        return { ok: true, data: { ...(await runtimeStatus()), installing: !!setup } };
      if (r?.action === 'setup') {
        if (setup || (job && !job.done)) return { ok: false, error: 'busy' };
        if (runtimeInstaller) {
          setup = { owner, cancelled: false };
          const task = setup;
          try {
            const result = await runtimeInstaller.install(owner, 'speech');
            statusCache = null;
            return result;
          } finally {
            if (setup === task) setup = null;
          }
        }
        setup = { owner, child: null, cancelled: false };
        const task = setup;
        try {
          if (!exists(python)) await command('py', ['-3.10', '-m', 'venv', runtime], owner, 60000);
          if (task.cancelled) throw Error('cancelled');
          await command(
            python,
            [
              '-m',
              'pip',
              'install',
              '--disable-pip-version-check',
              '--only-binary=:all:',
              '-r',
              path.join(backend, 'requirements-asr.txt'),
            ],
            owner,
          );
          if (task.cancelled) throw Error('cancelled');
          statusCache = null;
          const status = await runtimeStatus();
          if (!status.installed) throw Error('runtime');
          return { ok: true, data: status };
        } catch {
          return { ok: false, error: task.cancelled ? 'cancelled' : 'setup' };
        } finally {
          if (setup === task) setup = null;
        }
      }
      if (r?.action === 'cancel-setup') {
        if (setup?.owner === owner) {
          setup.cancelled = true;
          setup.child?.kill();
          runtimeInstaller?.cancel(owner);
        }
        return { ok: true };
      }
      if (r?.action === 'start') {
        if (r.idleReleaseSeconds !== undefined) {
          if (!validIdle(r.idleReleaseSeconds)) return { ok: false, error: 'invalid' };
          idleSeconds = r.idleReleaseSeconds;
          if (worker)
            send(worker.child, { action: 'idle-policy', idleReleaseSeconds: idleSeconds });
        }
        if (starting) return { ok: false, error: 'busy' };
        starting = true;
        startOwner = owner;
        startCancelled = false;
        try {
          const engine = r.engine || 'system';
          if (
            !['system', ...ENGINES].includes(engine) ||
            !['zh-CN', 'en-US'].includes(r.language) ||
            (r.device && !DEVICES.includes(r.device))
          )
            return { ok: false, error: 'invalid' };
          if (setup || (job && !job.done)) return { ok: false, error: 'busy' };
          if (engine === 'system') {
            killWorker();
            job = { owner, system: true, done: false };
            const result = await system.run(owner, r);
            if (!result.ok) job.done = true;
            return result;
          }
          const states = await models.list();
          if (startCancelled) return { ok: false, error: 'cancelled' };
          if (!states.some((s) => s.id === engine && s.source !== 'missing'))
            return { ok: false, error: 'model-missing' };
          if (!exists(python)) return { ok: false, error: 'runtime' };
          const device = engine === 'sensevoice-small' ? 'CPU' : r.device || 'AUTO';
          const key = [engine, device, engine === 'sensevoice-small' ? r.language : ''].join(':');
          if (worker?.key !== key) killWorker();
          const current = {
            owner,
            id: crypto.randomUUID(),
            system: false,
            done: false,
            ready: false,
            stopping: false,
            text: '',
            level: 0,
            error: '',
            device: '',
            fallback: '',
            reading: false,
            wake: null,
          };
          job = current;
          if (!worker) {
            const child = spawnProcess(
              python,
              [
                '-u',
                path.join(backend, 'asr_worker.py'),
                '--models-root',
                modelRoot,
                '--bundled',
                bundled,
                '--engine',
                engine,
                '--device',
                device,
                '--language',
                r.language,
                '--idle-seconds',
                String(idleSeconds),
              ],
              {
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'ignore'],
                env: { ...process.env, PYTHONUTF8: '1', OMP_NUM_THREADS: '2' },
              },
            );
            const active = { child, key, buffer: '', device: '', fallback: '' };
            worker = active;
            child.stdin.on('error', () => {});
            child.stdout.on('data', (chunk) => {
              active.buffer += chunk.toString('utf8');
              if (active.buffer.length > 65536) {
                if (job && !job.done) {
                  job.error = 'runtime';
                  finish(job);
                }
                killWorker();
                return;
              }
              let index;
              while ((index = active.buffer.indexOf('\n')) >= 0) {
                const line = active.buffer.slice(0, index);
                active.buffer = active.buffer.slice(index + 1);
                let message;
                try {
                  message = JSON.parse(line);
                } catch {
                  continue;
                }
                if (message.event === 'loaded') {
                  active.device = message.device;
                  active.fallback = message.fallback || '';
                }
                const session = job;
                if (!session || session.system || session.done) continue;
                if (message.event === 'fatal') {
                  session.error = ['runtime', 'model-missing', 'device'].includes(message.error)
                    ? message.error
                    : 'runtime';
                  finish(session);
                  continue;
                }
                if (message.id !== session.id) continue;
                session.device = active.device;
                session.fallback = active.fallback;
                if (message.event === 'ready') session.ready = !session.stopping;
                if (message.event === 'level')
                  session.level = Math.min(100, Math.max(0, Number(message.level) || 0));
                if (message.event === 'processing') session.processing = true;
                if (message.event === 'text') {
                  session.processing = false;
                  session.text +=
                    (session.text ? '\n' : '') + String(message.text || '').slice(0, 8000);
                  if (session.text.length > 16000) cancel(owner);
                }
                if (message.event === 'error')
                  session.error = ['microphone', 'overload', 'inference'].includes(message.error)
                    ? message.error
                    : 'runtime';
                if (message.event === 'done') finish(session);
                session.wake?.();
              }
            });
            const exited = () => {
              if (worker === active) {
                worker = null;
                if (job && !job.system && !job.done) {
                  job.error = job.error || 'runtime';
                  finish(job);
                }
              }
            };
            child.once('error', exited);
            child.once('close', exited);
          }
          current.device = worker.device;
          current.fallback = worker.fallback;
          send(worker.child, { action: 'start', id: current.id, language: r.language });
          // Loading/compiling may take longer on the first NPU run. Record itself
          // has a separate two-minute bound enforced in the native worker.
          current.timer = setTimeout(() => cancel(owner), 240000);
          return { ok: true, data: { id: current.id } };
        } finally {
          starting = false;
          startOwner = null;
        }
      }
      if (r?.action === 'stop') {
        if (job?.owner === owner && !job.done) {
          if (job.system) {
            job.done = true;
            return system.run(owner, r);
          }
          job.stopping = true;
          job.ready = false;
          if (!worker?.device) {
            finish(job);
            killWorker();
            return { ok: true, data: true };
          }
          if (worker) send(worker.child, { action: 'stop', id: job.id });
          if (!job.drain)
            job.drain = setTimeout(() => {
              if (job && !job.done) {
                job.error = 'timeout';
                cancel(owner);
              }
            }, 45000);
        }
        return { ok: true, data: true };
      }
      if (r?.action === 'cancel') {
        cancel(owner);
        return { ok: true, data: true };
      }
      if (r?.action === 'read') {
        const current = job;
        if (!current || current.owner !== owner) return { ok: false, error: 'cancelled' };
        if (current.system) {
          const result = await system.run(owner, r);
          if (result.data?.done) current.done = true;
          return result;
        }
        if (r.id !== current.id || current.reading) return { ok: false, error: 'cancelled' };
        current.reading = true;
        try {
          if (!current.done && !current.text)
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 100);
              current.wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
          const text = current.text;
          current.text = '';
          return {
            ok: true,
            data: {
              text,
              level: current.level,
              ready: current.ready,
              done: current.done,
              error: current.error,
              device: current.device,
              fallback: current.fallback,
              processing: !!current.processing,
              stopping: current.stopping,
            },
          };
        } finally {
          current.reading = false;
          current.wake = null;
        }
      }
      return { ok: false, error: 'invalid' };
    },
    cancel(owner) {
      cancel(owner);
      if (setup?.owner === owner) {
        setup.cancelled = true;
        setup.child?.kill();
        runtimeInstaller?.cancel(owner);
      }
    },
    dispose() {
      cancel();
      killWorker();
      if (setup) {
        setup.cancelled = true;
        setup.child?.kill();
      }
      system.dispose();
    },
  };
}
module.exports = { createNeuralDictation };
