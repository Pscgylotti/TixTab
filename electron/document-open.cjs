const fs = require('node:fs/promises');
const path = require('node:path');

// Only OS launch arguments can grant access. The renderer cannot supply a read path.
function createDocumentOpenQueue({
  notify = () => {},
  readFile = fs.readFile,
  stat = fs.stat,
} = {}) {
  const pending = [];
  const enqueue = (args, cwd = process.cwd()) => {
    for (const raw of args) {
      if (
        typeof raw !== 'string' ||
        raw.startsWith('-') ||
        raw.includes('\0') ||
        /^[a-z]+:\/\//i.test(raw) ||
        !/\.(pdf|tixtab)$/i.test(raw)
      )
        continue;
      const file = path.resolve(cwd, raw);
      if (pending.length < 64 && !pending.some((p) => p.toLowerCase() === file.toLowerCase()))
        pending.push(file);
    }
    if (pending.length) notify();
  };
  return {
    enqueue,
    async next() {
      const file = pending.shift();
      if (!file) return null;
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > 1024 * 1024 * 1024) throw Error('invalid-file');
        return {
          path: file,
          name: path.basename(file),
          bytes: new Uint8Array(await readFile(file)),
        };
      } catch (error) {
        return {
          path: file,
          name: path.basename(file),
          error: error.code || error.message || 'read-failed',
        };
      }
    },
  };
}
module.exports = { createDocumentOpenQueue };
