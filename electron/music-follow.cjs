const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { zipMembers } = require('./local-tool-zip.cjs');
const { lowerPriority } = require('./low-priority.cjs');

function createMusicFollow({
  root,
  backend,
  resolveModel,
  notify = () => {},
  spawnProcess = spawn,
  maxReferenceBytes = 64 * 1024 * 1024,
}) {
  root = path.resolve(root);
  const sessions = new Map();
  const intents = new WeakMap();
  const lastFailures = new WeakMap();
  let disposed = false;
  let idleSeconds = 1800;
  const python = path.join(root, 'homr-runtime', 'Scripts', 'python.exe');
  const finite = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
  const tokenOk = (s) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s);
  const keyOk = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
  const idleOk = (n) => Number.isInteger(n) && finite(n, 30, 86400);
  const reference = (r) => ({
    notes: r.notes.map(({ midi, beat, duration, muted }) => ({
      midi,
      beat,
      duration,
      muted: !!muted,
    })),
    tempo: r.tempo,
    instrument: r.instrument || 0,
    method: r.method || 'global',
  });
  async function signature(files) {
    const stats = await Promise.all(files.map((file) => fs.stat(file)));
    return JSON.stringify(stats.map((s) => [s.size, s.mtimeMs, s.ctimeMs]));
  }
  async function removeDirectory(s) {
    if (s.directory && path.resolve(s.directory).startsWith(root + path.sep + 'music-follow-'))
      await fs.rm(s.directory, { recursive: true, force: true }).catch(() => {});
  }
  function failure(s, error, detail = '') {
    return { ok: false, error, logs: [s.logs, detail].filter(Boolean).join('\n').slice(-10000) };
  }
  async function close(owner, s = sessions.get(owner), result = { ok: false, error: 'cancelled' }) {
    if (!s) return;
    if (s.closing) return s.closing;
    if (sessions.get(owner) === s) {
      sessions.delete(owner);
      // A worker can exit between PCM packets, with no pending caller. Keep
      // its bounded diagnostic until that session's next packet or stop.
      if (result.error !== 'cancelled') lastFailures.set(owner, { token: s.token, result });
    }
    s.cancelled = true;
    clearTimeout(s.idle);
    clearTimeout(s.readyTimer);
    for (const item of s.pending.values()) {
      clearTimeout(item.timer);
      item.resolve(result);
    }
    s.pending.clear();
    s.readyResolve?.(result);
    s.closing = Promise.resolve().then(async () => {
      if (s.child) {
        const child = s.child;
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill();
            resolve();
          }, 1000);
          child.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          child.stdin?.end();
          if (child.exitCode !== null && child.exitCode !== undefined) {
            clearTimeout(timer);
            resolve();
          }
        });
      }
      await removeDirectory(s);
    });
    return s.closing;
  }
  function touch(s) {
    clearTimeout(s.idle);
    s.idle = setTimeout(
      () =>
        void close(
          s.owner,
          s,
          failure(s, 'timeout', 'No audio or control request received within 15000 ms.'),
        ),
      15000,
    );
    s.idle.unref?.();
  }
  function park(s) {
    clearTimeout(s.idle);
    s.idle = setTimeout(
      () => void close(s.owner, s),
      Math.max(0, idleSeconds * 1000 - (Date.now() - s.idleSince)),
    );
    s.idle.unref?.();
    // Keep only the most recently used idle reference across owners.
    for (const other of sessions.values())
      if (other !== s && other.ready && !other.active) void close(other.owner, other);
  }
  function send(s, request) {
    if (s.cancelled || !s.child?.stdin?.writable)
      return Promise.resolve({ ok: false, error: 'cancelled' });
    if (s.pending.size >= 8) return Promise.resolve({ ok: false, error: 'busy' });
    touch(s);
    return new Promise((resolve) => {
      const id = ++s.sequence;
      const timer = setTimeout(() => {
        void close(
          s.owner,
          s,
          failure(s, 'timeout', `No response to ${request.action} within 5000 ms.`),
        );
      }, 5000);
      s.pending.set(id, { resolve, timer });
      s.child.stdin.write(JSON.stringify({ ...request, id }) + '\n', (error) => {
        if (error) {
          void close(s.owner, s, failure(s, 'transport-error', error.message));
        }
      });
    });
  }
  async function start(owner, r) {
    if (
      !tokenOk(r.token) ||
      !finite(r.tempo, 20, 400) ||
      !finite(r.beat, 0, 100000) ||
      !Number.isInteger(r.epoch) ||
      !Number.isInteger(r.instrument ?? 0) ||
      !finite(r.instrument ?? 0, 0, 127) ||
      (r.method !== undefined && !['global', 'oltw'].includes(r.method)) ||
      (r.referenceKey !== undefined && !keyOk(r.referenceKey)) ||
      (r.idleReleaseSeconds !== undefined && !idleOk(r.idleReleaseSeconds)) ||
      (r.notes !== undefined &&
        (!Array.isArray(r.notes) ||
          !r.notes.length ||
          r.notes.length > 100000 ||
          !r.notes.every(
            (n) =>
              n &&
              Number.isInteger(n.midi) &&
              finite(n.midi, 0, 127) &&
              finite(n.beat, 0, 100000) &&
              finite(n.duration, 0.01, 1000) &&
              (!n.muted || n.muted === true),
          )))
    )
      return { ok: false, error: 'invalid' };
    if (disposed) return { ok: false, error: 'cancelled' };
    let payload,
      key = r.referenceKey;
    if (r.notes) {
      if ((r.notes.reduce((end, n) => Math.max(end, n.beat + n.duration), 0) * 60) / r.tempo > 3600)
        return { ok: false, error: 'score-limit' };
      if (r.notes.every((n) => n.muted)) return { ok: false, error: 'empty-score' };
      payload = reference(r);
      const calculated = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      if (key && key !== calculated) return { ok: false, error: 'invalid' };
      key = calculated;
    } else if (!key) return { ok: false, error: 'invalid' };
    if (idleOk(r.idleReleaseSeconds)) idleSeconds = r.idleReleaseSeconds;
    intents.set(owner, r.token);
    lastFailures.delete(owner);
    const cached = sessions.get(owner);
    if (
      cached?.ready &&
      !cached.cancelled &&
      cached.key === key &&
      cached.tempo === r.tempo &&
      cached.instrument === (r.instrument || 0) &&
      cached.method === (r.method || 'global')
    ) {
      const fresh = await signature(cached.files).then(
        (value) => value === cached.signature,
        () => false,
      );
      if (disposed || intents.get(owner) !== r.token) return { ok: false, error: 'cancelled' };
      if (fresh && !cached.cancelled && sessions.get(owner) === cached) {
        cached.token = r.token;
        cached.active = true;
        cached.idleSince = undefined;
        const resumed = await send(cached, { action: 'restart', beat: r.beat, epoch: r.epoch });
        if (intents.get(owner) !== r.token) return { ok: false, error: 'cancelled' };
        if (resumed.ok && !cached.cancelled) return { ok: true, cached: true };
        await close(owner, cached);
      } else await close(owner, cached);
    }
    if (disposed || intents.get(owner) !== r.token) return { ok: false, error: 'cancelled' };
    if (!payload) return { ok: false, error: 'reference-missing' };
    await close(owner);
    if (disposed || intents.get(owner) !== r.token) return { ok: false, error: 'cancelled' };
    const s = {
      owner,
      token: r.token,
      cancelled: false,
      pending: new Map(),
      sequence: 0,
      logs: '',
      key,
      tempo: r.tempo,
      instrument: r.instrument || 0,
      method: r.method || 'global',
      active: true,
      ready: false,
    };
    sessions.set(owner, s);
    try {
      if (!existsSync(python)) throw Error('runtime-missing');
      const [archive, soundfont] = await Promise.all([
        resolveModel('matchmaker/fluidsynth.zip'),
        resolveModel('matchmaker/GeneralUser-GS.sf2'),
      ]);
      if (!archive || !soundfont) throw Error('missing-model');
      if (s.cancelled) return { ok: false, error: 'cancelled' };
      s.files = [python, path.join(backend, 'matchmaker_runner.py'), archive, soundfont];
      // Runtime repairs/upgrades invalidate references built by older code.
      const packageRoot = path.join(root, 'homr-runtime', 'Lib', 'site-packages', 'matchmaker');
      s.files.push(
        ...['__init__.py', 'prob/outer_product_hmm_audio.py', 'dp/oltw_arzt.py']
          .map((name) => path.join(packageRoot, name))
          .filter(existsSync),
      );
      s.signature = await signature(s.files);
      // Per-session extraction avoids partially installed shared DLL directories.
      // 2.6.1 runtime is small and released with this session.
      await fs.mkdir(root, { recursive: true });
      s.directory = await fs.mkdtemp(path.join(root, 'music-follow-'));
      const members = await zipMembers(
        await fs.readFile(archive),
        (n) => /\.(dll|txt)$/i.test(n),
        32 * 1024 * 1024,
      );
      const dlls = path.join(s.directory, 'synth');
      await fs.mkdir(dlls);
      for (const member of members)
        await fs.writeFile(path.join(dlls, path.basename(member.name)), member.data);
      if (!existsSync(path.join(dlls, 'libfluidsynth-3.dll'))) throw Error('component-invalid');
      const config = path.join(s.directory, 'request.json');
      await fs.writeFile(
        config,
        JSON.stringify({
          ...payload,
          beat: r.beat,
          epoch: r.epoch,
        }),
      );
      if (s.cancelled) {
        await removeDirectory(s);
        return { ok: false, error: 'cancelled' };
      }
      const child = spawnProcess(
        python,
        ['-I', '-X', 'utf8', path.join(backend, 'matchmaker_runner.py'), config, dlls, soundfont],
        {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1',
            OMP_NUM_THREADS: '2',
            MKL_NUM_THREADS: '2',
            OPENBLAS_NUM_THREADS: '2',
            NUMBA_NUM_THREADS: '2',
          },
        },
      );
      s.child = child;
      child.stdin?.on?.(
        'error',
        (error) => void close(owner, s, failure(s, 'transport-error', error.message)),
      );
      lowerPriority(child);
      let buffer = '';
      child.stderr.on('data', (data) => {
        s.logs = (s.logs + data.toString()).slice(-10000);
      });
      const ready = new Promise((resolve) => {
        s.readyResolve = resolve;
      });
      const timer = setTimeout(() => {
        void close(owner, s, failure(s, 'timeout', 'No ready response within 120000 ms.'));
      }, 120000);
      s.readyTimer = timer;
      child.stdout.on('data', (data) => {
        if (s.cancelled) return;
        buffer += data.toString();
        if (buffer.length > 65536) {
          void close(
            owner,
            s,
            failure(s, 'transport-error', 'Worker response exceeded 65536 characters.'),
          );
          return;
        }
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          let m;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.event === 'ready') {
            clearTimeout(timer);
            s.ready = true;
            s.cacheable =
              Number.isSafeInteger(m.referenceBytes) &&
              m.referenceBytes > 0 &&
              m.referenceBytes <= maxReferenceBytes;
            touch(s);
            s.readyResolve?.({ ok: true, cached: false });
            s.readyResolve = null;
          } else if (m.event === 'preparing')
            notify(owner, { token: s.token, progress: m.progress });
          else if (m.event === 'error') {
            void close(
              owner,
              s,
              failure(s, m.error || 'follow-failed', typeof m.logs === 'string' ? m.logs : ''),
            );
          } else {
            const p = s.pending.get(m.id);
            if (p) {
              s.pending.delete(m.id);
              clearTimeout(p.timer);
              p.resolve(
                m.ok
                  ? m
                  : failure(
                      s,
                      m.error || 'follow-failed',
                      typeof m.logs === 'string' ? m.logs : '',
                    ),
              );
            }
          }
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        void close(owner, s, failure(s, 'runtime-missing', error.message));
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        s.child = null;
        void close(
          owner,
          s,
          failure(s, 'worker-exited', `Worker exited (code=${code}, signal=${signal || 'none'}).`),
        );
      });
      const result = await ready;
      if (disposed || intents.get(owner) !== r.token) {
        await close(owner, s);
        return { ok: false, error: 'cancelled' };
      }
      return result;
    } catch (e) {
      await close(owner, s);
      return { ok: false, error: e.message };
    } finally {
      // A stop can race with filesystem preparation before a child exists.
      // Remove anything created after that stop as well.
      if (s.cancelled) await removeDirectory(s);
    }
  }
  return {
    cancel: (owner) => {
      intents.delete(owner);
      lastFailures.delete(owner);
      return close(owner);
    },
    dispose() {
      disposed = true;
      for (const owner of sessions.keys()) void close(owner);
    },
    async run(owner, r) {
      if (r?.action === 'idle-policy') {
        if (!idleOk(r.idleReleaseSeconds)) return { ok: false, error: 'invalid' };
        idleSeconds = r.idleReleaseSeconds;
        for (const s of sessions.values()) if (s.idleSince !== undefined) park(s);
        return { ok: true };
      }
      if (r?.action === 'stop') {
        if (!r.token || intents.get(owner) === r.token) intents.delete(owner);
        if (!r.token || lastFailures.get(owner)?.token === r.token) lastFailures.delete(owner);
        const s = sessions.get(owner);
        if (!s || (r.token && s.token !== r.token)) return { ok: true };
        if (!s.ready || !s.cacheable) await close(owner, s);
        else if (s.active) {
          const token = s.token;
          s.active = false; // reject subsequent PCM immediately
          s.idleSince = Date.now();
          const suspended = await send(s, { action: 'suspend' });
          if (s.cancelled || s.token !== token || s.active) return { ok: true };
          if (suspended.ok) park(s);
          else await close(owner, s);
        }
        return { ok: true };
      }
      if (r?.action === 'start') return start(owner, r);
      const s = sessions.get(owner);
      if (!s || !s.active || !s.ready || r?.token !== s.token) {
        const failed = lastFailures.get(owner);
        return failed && failed.token === r?.token
          ? failed.result
          : { ok: false, error: 'cancelled' };
      }
      if (r.action === 'seek' && finite(r.beat, 0, 100000) && Number.isInteger(r.epoch))
        return send(s, { action: 'seek', beat: r.beat, epoch: r.epoch });
      if (
        r.action === 'audio' &&
        r.samples instanceof Float32Array &&
        [320, 640].includes(r.samples.length) &&
        finite(r.time, 0, 1e9) &&
        Number.isInteger(r.epoch)
      ) {
        // Device gain and transient peaks must not end a live session. Scale
        // the whole packet uniformly to retain its waveform; discard only
        // non-finite samples. Quiet audio is never amplified.
        let peak = 0,
          damaged = false;
        for (const value of r.samples) {
          if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
          else damaged = true;
        }
        const gain = peak > 4 ? 4 / peak : 1;
        const samples =
          gain < 1 || damaged
            ? Float32Array.from(r.samples, (value) => (Number.isFinite(value) ? value * gain : 0))
            : r.samples;
        return send(s, {
          action: 'audio',
          epoch: r.epoch,
          time: r.time,
          pcm: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString(
            'base64',
          ),
        });
      }
      return { ok: false, error: 'invalid' };
    },
  };
}
module.exports = { createMusicFollow };
