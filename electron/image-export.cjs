const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
/** One capability per window, no renderer-controlled filesystem paths. */
function createImageExport({ chooseDirectory }) {
  const owners = new Map();
  return {
    cancel(owner) {
      owners.delete(owner);
    },
    dispose() {
      owners.clear();
    },
    async run(owner, request) {
      let choosing;
      try {
        if (request?.action === 'choose') {
          choosing = { token: randomUUID(), directory: null, writing: false };
          owners.set(owner, choosing);
          const directory = await chooseDirectory(owner);
          const resolved = directory ? await fs.realpath(directory) : null;
          if (!resolved || owner.isDestroyed?.() || owners.get(owner) !== choosing) {
            if (owners.get(owner) === choosing) owners.delete(owner);
            return { ok: false, cancelled: true };
          }
          choosing.directory = resolved;
          return { ok: true, token: choosing.token, directory: resolved };
        }
        const entry = owners.get(owner);
        if (!entry?.directory || request?.token !== entry.token)
          return { ok: false, error: 'invalid' };
        if (request.action === 'finish') {
          owners.delete(owner);
          return { ok: true };
        }
        if (
          request.action !== 'write' ||
          entry.writing ||
          !/^page-\d+-image-\d+\.png$/.test(request.name) ||
          !(request.bytes instanceof Uint8Array) ||
          request.bytes.byteLength > 256 * 1024 * 1024 ||
          request.bytes.length < 8 ||
          !Buffer.from(request.bytes.subarray(0, 8)).equals(
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          )
        )
          return { ok: false, error: 'invalid' };
        entry.writing = true;
        try {
          for (let i = 0; i < 100; i++) {
            const name = i ? request.name.replace(/\.png$/, ` (${i + 1}).png`) : request.name;
            const target = path.join(entry.directory, name);
            if (path.dirname(target) !== entry.directory) return { ok: false, error: 'invalid' };
            let file;
            try {
              file = await fs.open(target, 'wx');
              await file.writeFile(request.bytes);
              await file.close();
              return { ok: true, name };
            } catch (e) {
              if (file) {
                await file.close().catch(() => {});
                await fs.unlink(target).catch(() => {});
              }
              if (e.code !== 'EEXIST') throw e;
            }
          }
          return { ok: false, error: 'collision' };
        } finally {
          entry.writing = false;
        }
      } catch {
        if (choosing && owners.get(owner) === choosing) owners.delete(owner);
        return { ok: false, error: 'image-export' };
      }
    },
  };
}
module.exports = { createImageExport };
