const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
function createBatchPdf({ chooseDirectory, grantFile }) {
  const roots = new Map(),
    indexes = new Map(),
    exports = new Map();
  let ready,
    writes = Promise.resolve(),
    disposed = false;
  const load = () =>
    (ready ||= (async () => {
      try {
        for (const value of JSON.parse(await fs.readFile(grantFile, 'utf8')))
          if (typeof value.id === 'string' && typeof value.directory === 'string')
            roots.set(value.id, value.directory);
      } catch {}
    })());
  const save = () => {
    const snapshot = JSON.stringify([...roots].map(([id, directory]) => ({ id, directory })));
    return (writes = writes
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(grantFile), { recursive: true });
        const temporary = `${grantFile}.tmp`;
        await fs.writeFile(temporary, snapshot);
        await fs.rename(temporary, grantFile);
      }));
  };
  async function scan(id) {
    const root = await fs.realpath(roots.get(id)),
      pending = [root],
      files = [];
    let directories = 0;
    while (pending.length) {
      if (disposed) throw Error('cancelled');
      if (++directories > 50000) throw Error('folder-limit');
      const directory = pending.pop();
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue;
        const absolute = path.join(directory, item.name);
        if (item.isDirectory()) pending.push(absolute);
        else if (item.isFile() && /\.pdf$/i.test(item.name)) {
          const name = path.relative(root, absolute).split(path.sep).join('/');
          files.push({ id: createHash('sha256').update(name).digest('hex').slice(0, 24), name });
          if (files.length > 10000) throw Error('folder-limit');
        }
      }
    }
    files.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );
    if (!indexes.has(id) && indexes.size >= 4) indexes.delete(indexes.keys().next().value);
    indexes.set(id, new Map(files.map((file) => [file.id, file.name])));
    return { id, name: path.basename(root), files };
  }
  const cancel = (owner) => exports.delete(owner);
  return {
    cancel,
    dispose() {
      disposed = true;
      indexes.clear();
      roots.clear();
      exports.clear();
    },
    async run(owner, request) {
      try {
        await load();
        if (disposed) return { ok: false, error: 'cancelled' };
        if (request?.action === 'choose') {
          const directory = await chooseDirectory(owner, false);
          if (!directory || disposed || owner.isDestroyed?.())
            return { ok: false, cancelled: true };
          const root = await fs.realpath(directory),
            id = [...roots].find(([, value]) => value === root)?.[0] || randomUUID();
          roots.set(id, root);
          await save();
          return { ok: true, folder: await scan(id) };
        }
        if (request?.action === 'read') {
          if (!roots.has(request.folderId)) throw Error('folder-unavailable');
          if (!indexes.has(request.folderId)) await scan(request.folderId);
          const relative = indexes.get(request.folderId).get(request.fileId);
          if (!relative) throw Error('file-unavailable');
          const root = await fs.realpath(roots.get(request.folderId));
          const file = await fs.realpath(path.join(root, relative));
          if (!file.startsWith(root + path.sep) || !/\.pdf$/i.test(file))
            throw Error('file-unavailable');
          if ((await fs.stat(file)).size > 256 * 1024 * 1024) throw Error('file-too-large');
          const bytes = await fs.readFile(file);
          if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw Error('invalid-pdf');
          return { ok: true, bytes };
        }
        if (request?.action === 'choose-output') {
          const entry = { token: randomUUID(), directory: null, writing: false };
          exports.set(owner, entry);
          const directory = await chooseDirectory(owner, true);
          if (!directory || disposed || owner.isDestroyed?.() || exports.get(owner) !== entry) {
            cancel(owner);
            return { ok: false, cancelled: true };
          }
          entry.directory = await fs.realpath(directory);
          return { ok: true, token: entry.token };
        }
        if (request?.action === 'cancel' || request?.action === 'finish') {
          cancel(owner);
          return { ok: true };
        }
        const entry = exports.get(owner);
        if (
          request?.action !== 'write' ||
          !entry?.directory ||
          entry.token !== request.token ||
          entry.writing ||
          typeof request.name !== 'string' ||
          request.name.length > 220 ||
          /[<>:"/\\|?*\x00-\x1f]/.test(request.name) ||
          !/\.pdf$/i.test(request.name) ||
          !(request.bytes instanceof Uint8Array) ||
          request.bytes.byteLength > 256 * 1024 * 1024 ||
          !Buffer.from(request.bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))
        )
          throw Error('invalid');
        entry.writing = true;
        try {
          for (let attempt = 0; attempt < 1000; attempt++) {
            const name = attempt
              ? request.name.replace(/\.pdf$/i, ` (${attempt + 1}).pdf`)
              : request.name;
            const target = path.join(entry.directory, name);
            let file;
            try {
              file = await fs.open(target, 'wx');
              for (let first = 0; first < request.bytes.length; first += 4 * 1024 * 1024) {
                if (exports.get(owner) !== entry) throw Error('cancelled');
                await file.writeFile(request.bytes.subarray(first, first + 4 * 1024 * 1024));
              }
              if (exports.get(owner) !== entry) throw Error('cancelled');
              await file.close();
              return { ok: true, name };
            } catch (error) {
              if (file) {
                await file.close().catch(() => {});
                await fs.unlink(target).catch(() => {});
              }
              if (error.code !== 'EEXIST') throw error;
            }
          }
          throw Error('collision');
        } finally {
          entry.writing = false;
        }
      } catch (error) {
        return { ok: false, error: error.message || 'batch-pdf' };
      }
    },
  };
}
module.exports = { createBatchPdf };
