/** Own a single controller per window. Only native IDs are accepted; DOM IDs
 * never cross into GetFromPointerId. Unsupported hardware quietly stays off. */
function createPenHaptics({
  platform = process.platform,
  create = () => require('./pen-haptics-native.cjs').createNativeHaptics(),
  notify = () => {},
} = {}) {
  let strength = 0.5,
    enabled = false,
    native = null,
    latest = null,
    detected = null,
    status = platform === 'win32' ? 'waiting' : 'unavailable',
    timer;
  const update = (value) => {
    if (status !== value) {
      status = value;
      notify(value);
    }
    return status;
  };
  const stop = () => {
    clearTimeout(timer);
    timer = null;
    try {
      native?.stop();
    } catch {}
  };
  const clear = () => {
    stop();
    try {
      native?.clear();
    } catch {}
    detected = null;
  };
  const detect = () => {
    if (!enabled || platform !== 'win32' || !latest?.inRange) return false;
    if (detected === latest.pointerId) return status === 'supported';
    try {
      native ??= create();
      detected = latest.pointerId;
      return update(native.detect(detected) ? 'supported' : 'unsupported') === 'supported';
    } catch {
      detected = latest.pointerId;
      update('unavailable');
      return false;
    }
  };
  return {
    sample(value) {
      const old = latest;
      latest = value;
      if (!value?.inRange) {
        clear();
        return;
      }
      if (old?.pointerId !== value.pointerId) clear();
      if (!value.contact && old?.contact) stop();
      // Resolve the native pointer while its WM_POINTER message is current.
      // Deferring this to IPC/setImmediate can lose the pointer's device data.
      if (enabled && detected !== value.pointerId) detect();
    },
    configure(value) {
      enabled = value === true;
      clear();
      if (enabled && platform === 'win32') {
        try {
          native ??= create();
          update('waiting');
        } catch {
          update('unavailable');
        }
      }
      return status;
    },
    intensity(value) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
        strength = value;
      return status;
    },
    start(tool) {
      if (
        !enabled ||
        !['pen', 'ballpoint', 'pencil', 'highlighter', 'eraser'].includes(tool) ||
        !latest?.contact ||
        detected !== latest.pointerId ||
        status !== 'supported'
      )
        return status;
      try {
        if (!native.start(tool, strength)) return update('unsupported');
        // Native pointer-up and DOM pointer-up both stop it. A watchdog covers
        // a missing release after renderer failure without polling input.
        clearTimeout(timer);
        timer = setTimeout(stop, 30000);
      } catch {
        stop();
        update('unavailable');
      }
      return status;
    },
    stop,
    status: () => status,
    reset() {
      latest = null;
      clear();
    },
    dispose() {
      enabled = false;
      latest = null;
      clear();
      try {
        native?.dispose();
      } catch {}
      native = null;
    },
  };
}
module.exports = { createPenHaptics };
