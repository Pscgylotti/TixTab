const LIMIT = 200000;
const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
function validRequest(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.action === 'list') return true;
  if (typeof r.token !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(r.token)) return false;
  if (r.action === 'stop') return true;
  if (!Number.isInteger(r.program) || !finite(r.program, 0, 127) || !finite(r.volume, 0, 1))
    return false;
  if (r.action === 'configure') return true;
  return (
    r.action === 'play' &&
    typeof r.output === 'string' &&
    r.output.length <= 256 &&
    finite(r.tempo, 20, 400) &&
    finite(r.duration, 0, 1000000) &&
    finite(r.beat, 0, r.duration) &&
    Array.isArray(r.notes) &&
    r.notes.length <= LIMIT &&
    r.notes.every(
      (n) =>
        n &&
        Number.isInteger(n.midi) &&
        finite(n.midi, 0, 127) &&
        finite(n.beat, 0, r.duration) &&
        finite(n.duration, 0.000001, 1000000) &&
        n.beat + n.duration <= r.duration + 0.001 &&
        (n.muted === undefined || typeof n.muted === 'boolean'),
    )
  );
}
function createMidiTransport(native, notify = () => {}, clock = () => performance.now()) {
  let token = '',
    events = [],
    at = 0,
    start = 0,
    end = 0,
    timer;
  const sounding = new Map();
  const activeNotes = new Set();
  function stop() {
    clearTimeout(timer);
    timer = undefined;
    events = [];
    at = 0;
    sounding.clear();
    activeNotes.clear();
    token = '';
    native.close();
  }
  function configure(r) {
    native.send(0xc0, r.program);
    native.send(0xb0, 7, Math.round(r.volume * 127));
  }
  function pump() {
    const t = clock() - start;
    try {
      // If the host stalls, skip notes whose entire lifetime has already elapsed.
      while (at < events.length && events[at].time <= t) {
        const e = events[at++],
          count = sounding.get(e.midi) || 0;
        if (e.on) {
          if (e.end <= t) continue;
          if (!count) native.send(0x90, e.midi, 90);
          sounding.set(e.midi, count + 1);
          activeNotes.add(e.id);
        } else if (activeNotes.delete(e.id) && count) {
          if (count === 1) {
            native.send(0x80, e.midi, 0);
            sounding.delete(e.midi);
          } else sounding.set(e.midi, count - 1);
        }
      }
      if (t >= end) {
        const finished = token;
        stop();
        notify({ token: finished, state: 'ended' });
      } else timer = setTimeout(pump, Math.max(1, Math.min(10, (events[at]?.time ?? end) - t)));
    } catch {
      const failed = token;
      stop();
      notify({ token: failed, state: 'error', error: 'device-unavailable' });
    }
  }
  return {
    run(r) {
      if (!validRequest(r)) return { ok: false, error: 'invalid' };
      try {
        if (r.action === 'list')
          return { ok: true, devices: native.list().map(({ index, ...d }) => d) };
        if (r.action === 'stop') {
          if (token === r.token) stop();
          return { ok: true };
        }
        if (r.action === 'configure') {
          if (token === r.token) configure(r);
          return { ok: true };
        }
        stop();
        native.open(r.output);
        token = r.token;
        configure(r);
        const ms = 60000 / r.tempo;
        for (const [id, n] of r.notes.entries()) {
          if (n.muted || n.beat + n.duration <= r.beat) continue;
          const begin = Math.max(0, (n.beat - r.beat) * ms),
            finish = (n.beat + n.duration - r.beat) * ms;
          events.push({ id, time: begin, midi: n.midi, on: true, end: finish });
          events.push({ id, time: finish, midi: n.midi, on: false });
        }
        events.sort((a, b) => a.time - b.time || Number(a.on) - Number(b.on));
        start = clock() + 60;
        end = (r.duration - r.beat) * ms;
        const startedAt = Date.now() + 60;
        timer = setTimeout(pump, 60);
        return { ok: true, startedAt };
      } catch (e) {
        stop();
        return { ok: false, error: e.message === 'device-busy' ? e.message : 'device-unavailable' };
      }
    },
    dispose: stop,
  };
}
module.exports = { createMidiTransport, validRequest };
