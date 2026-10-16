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
  let idleSeconds = 1800;
  function close(owner, expected) {
    const s = session;
    if (!s || (expected && expected !== s) || (owner && owner !== s.owner)) return;
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
      stage: 'launch',
      starting: false,
      idleSeconds: 1800,
      idleSince: 0,
    };
    session = s;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      s.buffer += chunk;
      if (s.buffer.length > 100000) {
        close(s.owner, s);
        return;
      }
      let at;
      while ((at = s.buffer.indexOf('\n')) >= 0) {
        const line = s.buffer.slice(0, at);
        s.buffer = s.buffer.slice(at + 1);
        try {
          const result = JSON.parse(line);
          if (result.progress) {
            s.stage = String(result.progress.stage).slice(0, 60);
            onProgress?.(s.owner, {
              stage: s.stage,
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
              reject(
                Object.assign(Error('windows-speech-timeout'), {
                  stage: s.stage,
                  action: command.action,
                }),
              );
              close(s.owner, s);
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
      let ownedSession;
      try {
        if (r.action === 'idle-policy') {
          if (
            !Number.isInteger(r.idleReleaseSeconds) ||
            r.idleReleaseSeconds < 30 ||
            r.idleReleaseSeconds > 86400
          )
            return { ok: false, error: 'invalid' };
          idleSeconds = r.idleReleaseSeconds;
          if (session) {
            session.idleSeconds = idleSeconds;
            if (session.done) idle(session);
          }
          return { ok: true };
        }
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
          if (session && !session.done) return { ok: false, error: 'busy' };
          if (session && (r.action !== 'start' || session.engine !== r.engine)) close();
          const s = session || launch(owner, r.engine);
          clearTimeout(s.limit);
          s.owner = owner;
          s.id = crypto.randomUUID();
          s.done = false;
          s.stage = 'launch';
          s.idleSince = 0;
          if (
            Number.isInteger(r.idleReleaseSeconds) &&
            r.idleReleaseSeconds >= 30 &&
            r.idleReleaseSeconds <= 86400
          )
            idleSeconds = r.idleReleaseSeconds;
          s.idleSeconds = idleSeconds;
          ownedSession = s;
          s.starting = r.action === 'start';
          let microphoneName = '';
          if (r.microphone) {
            const listed = await microphones(owner);
            const input = listed?.data?.microphones?.find((m) => m.id === r.microphone);
            if (!input) {
              close(owner, s);
              return { ok: false, error: 'microphone-missing' };
            }
            microphoneName = input.name;
          }
          const result = await ask(
            s,
            { ...r, microphoneName },
            r.action === 'prepare'
              ? 600000
              : r.action === 'start' && r.engine === 'windows-ai'
                ? 600000
                : 60000,
          );
          s.starting = false;
          if (r.action !== 'start' || !result.ok) close(owner, s);
          else {
            s.limit = setTimeout(() => close(owner, s), 130000);
            return { ok: true, data: { id: s.id } };
          }
          return result;
        }
        const s = session;
        if (!s || s.owner !== owner) return { ok: false, error: 'cancelled' };
        ownedSession = s;
        if (r.action === 'stop') {
          // WinRT cannot read a stop command while TryCreateAsync is pending.
          // Kill only the owned helper, including any microphone startup in flight.
          if (s.starting) {
            close(owner);
            return { ok: true, data: { cancelled: true } };
          }
          return await ask(s, { action: 'stop' }, 20000);
        }
        if (r.action === 'cancel') {
          close(owner);
          return { ok: true };
        }
        if (r.action === 'read' && r.id === s.id) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const result = await ask(s, { action: 'read' });
          if (result.data?.done) {
            if (s.engine === 'windows-ai' && result.ok && !result.data.error) {
              if (!s.done) s.idleSince = Date.now();
              s.done = true;
              idle(s);
            } else close(owner, s);
          }
          return result;
        }
        return { ok: false, error: 'invalid' };
      } catch (e) {
        if (ownedSession) close(owner, ownedSession);
        return {
          ok: false,
          error: e.code === 'ENOENT' ? 'runtime' : e.message || 'windows-ai-unavailable',
          data: e.stage ? { stage: e.stage, action: e.action } : undefined,
        };
      }
    },
  };
  function idle(s) {
    clearTimeout(s.limit);
    s.limit = setTimeout(
      () => close(s.owner, s),
      Math.max(0, s.idleSeconds * 1000 - (Date.now() - s.idleSince)),
    );
  }
}
function createSystemSpeechRouter(legacy, native) {
  const routes = new Map();
  return {
    async run(owner, r) {
      if (r.action === 'idle-policy') return native.run(owner, r);
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
