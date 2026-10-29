const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { validRequest } = require('./music-midi-transport.cjs');
function createMusicMidi({
  notify = () => {},
  platform = process.platform,
  makeWorker = () => new Worker(path.join(__dirname, 'music-midi-worker.cjs')),
} = {}) {
  const sessions = new Map();
  let disposed = false;
  function close(owner) {
    const s = sessions.get(owner);
    if (!s) return;
    sessions.delete(owner);
    clearTimeout(s.idle);
    for (const pending of s.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: 'cancelled' });
    }
    s.pending.clear();
    try {
      s.worker.postMessage({ id: 0, request: { action: 'dispose' } });
    } catch {
      /* Worker already exited. */
    }
    const kill = setTimeout(() => void s.worker.terminate(), 1500);
    kill.unref?.();
    s.worker.once('exit', () => clearTimeout(kill));
  }
  function idle(owner, s) {
    clearTimeout(s.idle);
    if (!s.active && !s.pending.size) s.idle = setTimeout(() => close(owner), 30000);
    s.idle?.unref?.();
  }
  return {
    run(owner, request) {
      if (disposed || platform !== 'win32')
        return Promise.resolve({ ok: false, error: 'unavailable' });
      if (!validRequest(request)) return Promise.resolve({ ok: false, error: 'invalid' });
      let s = sessions.get(owner);
      if (!s && ['stop', 'configure'].includes(request.action))
        return Promise.resolve({ ok: true });
      if (!s) {
        try {
          s = { worker: makeWorker(), pending: new Map(), next: 0, active: '', idle: null };
        } catch {
          return Promise.resolve({ ok: false, error: 'unavailable' });
        }
        sessions.set(owner, s);
        s.worker.on('message', ({ id, result, event }) => {
          if (sessions.get(owner) !== s) return;
          if (event) {
            if (s.active === event.token) s.active = '';
            notify(owner, event);
          } else {
            const pending = s.pending.get(id);
            if (!pending) return;
            clearTimeout(pending.timer);
            s.pending.delete(id);
            if (pending.action === 'play' && !result.ok && s.active === pending.token)
              s.active = '';
            pending.resolve(result);
          }
          idle(owner, s);
        });
        const failed = () => {
          if (sessions.get(owner) !== s) return;
          if (s.active)
            notify(owner, { token: s.active, state: 'error', error: 'device-unavailable' });
          close(owner);
        };
        s.worker.on('error', failed);
        s.worker.on('exit', failed);
      }
      if (s.pending.size >= 8) {
        if (request.action === 'stop' && s.active === request.token) {
          close(owner);
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({ ok: false, error: 'busy' });
      }
      clearTimeout(s.idle);
      if (request.action === 'play') s.active = request.token;
      if (request.action === 'stop' && s.active === request.token) s.active = '';
      const id = ++s.next;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (s.active) notify(owner, { token: s.active, state: 'error', error: 'timeout' });
          close(owner);
        }, 10000);
        s.pending.set(id, { resolve, timer, action: request.action, token: request.token });
        try {
          s.worker.postMessage({ id, request });
        } catch {
          close(owner);
        }
      });
    },
    cancel: close,
    dispose() {
      disposed = true;
      for (const owner of sessions.keys()) close(owner);
    },
  };
}
module.exports = { createMusicMidi };
