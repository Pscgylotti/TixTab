const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const TYPES = {
  translation: ['local', 'local-native', 'local-service', 'google', 'web', 'llm'],
  speech: ['native', 'local', 'system', 'web', 'llm'],
  ocr: ['native', 'local', 'texo', 'web', 'llm'],
  formula: ['texo-native', 'texo-cpu', 'texo-gpu', 'unimumer', 'pix2text', 'web', 'llm'],
};
function validate(feature, data) {
  if (
    !Object.hasOwn(TYPES, feature) ||
    !data ||
    typeof data !== 'object' ||
    !TYPES[feature].includes(data.selected) ||
    !data.profiles ||
    typeof data.profiles !== 'object'
  )
    throw new Error('Invalid provider settings');
  const profiles = {};
  for (const [type, p] of Object.entries(data.profiles)) {
    if (!TYPES[feature].includes(type) || !p || typeof p !== 'object')
      throw new Error('Invalid provider profile');
    const result = {};
    for (const [key, max] of Object.entries({
      url: 2048,
      model: 256,
      voice: 128,
      key: 8192,
      headers: 16384,
    })) {
      if (typeof p[key] !== 'string' || p[key].length > max)
        throw new Error('Invalid provider field');
      result[key] = p[key];
    }
    if (
      !Number.isFinite(p.timeoutSeconds) ||
      p.timeoutSeconds < 2 ||
      p.timeoutSeconds > 180 ||
      typeof p.fallback !== 'boolean' ||
      typeof p.stream !== 'boolean'
    )
      throw new Error('Invalid provider options');
    result.timeoutSeconds = p.timeoutSeconds;
    result.fallback = p.fallback;
    result.stream = p.stream;
    profiles[type] = result;
  }
  return { selected: data.selected, profiles };
}
function createProviderVault({ file, safeStorage }) {
  let data = {},
    status = 'session',
    initialized,
    queue = Promise.resolve();
  const available = async () => {
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
      return false;
    return typeof safeStorage.isAsyncEncryptionAvailable === 'function'
      ? safeStorage.isAsyncEncryptionAvailable()
      : safeStorage.isEncryptionAvailable();
  };
  const encrypt = (text) =>
    typeof safeStorage.encryptStringAsync === 'function'
      ? safeStorage.encryptStringAsync(text)
      : safeStorage.encryptString(text);
  const decrypt = async (bytes) =>
    typeof safeStorage.decryptStringAsync === 'function'
      ? (await safeStorage.decryptStringAsync(bytes)).result
      : safeStorage.decryptString(bytes);
  const init = () =>
    (initialized ??= (async () => {
      try {
        if (!(await available())) return;
        status = 'encrypted';
        let bytes;
        try {
          const stat = await fs.stat(file);
          if (stat.size > 1048576) throw new Error('Vault too large');
          bytes = await fs.readFile(file);
        } catch (e) {
          if (e.code === 'ENOENT') return;
          throw e;
        }
        const raw = JSON.parse(await decrypt(bytes));
        if (raw.version !== 1 || !raw.features || typeof raw.features !== 'object')
          throw new Error('Invalid vault');
        const next = {};
        for (const [feature, entry] of Object.entries(raw.features))
          next[feature] = validate(feature, entry);
        data = next;
      } catch {
        status = 'error';
      }
    })());
  const serial = (fn) => {
    const job = queue.then(fn);
    queue = job.catch(() => {});
    return job;
  };
  return {
    read(feature) {
      return serial(async () => {
        if (!Object.hasOwn(TYPES, feature)) throw new Error('Unknown provider feature');
        await init();
        return { status, data: data[feature] ? structuredClone(data[feature]) : null };
      });
    },
    write(feature, entry) {
      return serial(async () => {
        const clean = validate(feature, entry);
        await init();
        // Never replace an unreadable vault with empty/default state.
        if (status === 'error') return { status };
        const next = { ...data, [feature]: clean };
        if (status === 'encrypted') {
          let temporary;
          try {
            const serialized = JSON.stringify({ version: 1, features: next });
            if (Buffer.byteLength(serialized) > 1000000) throw new Error('Vault too large');
            const bytes = await encrypt(serialized);
            await fs.mkdir(path.dirname(file), { recursive: true });
            temporary = `${file}.${randomUUID()}.tmp`;
            await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
            await fs.rename(temporary, file);
          } catch {
            if (temporary) await fs.unlink(temporary).catch(() => {});
            return { status: 'error' };
          }
        }
        data = next;
        return { status };
      });
    },
  };
}
module.exports = { createProviderVault, validate };
