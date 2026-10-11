const path = require('node:path');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Only compiled-in IDs and records cross this boundary. No renderer paths/URLs.
function createModelLibrary({ root, bundled, catalog, fetch, notify = () => {} }) {
  root = path.resolve(root);
  bundled = path.resolve(bundled);
  const models = new Map(),
    files = new Map(),
    verified = new Map();
  let job = null;
  for (const m of catalog.models) {
    if (!/^[a-z0-9-]+$/.test(m.id) || !/^[a-zA-Z0-9.]+$/.test(m.revision) || models.has(m.id))
      throw new Error('Invalid model catalog');
    for (const f of m.files) {
      if (
        !/^[a-zA-Z0-9_./-]+$/.test(f.path) ||
        f.path.split('/').some((p) => !p || p === '.' || p === '..') ||
        files.has(f.path) ||
        !Number.isSafeInteger(f.bytes) ||
        f.bytes <= 0 ||
        f.bytes > (m.id === 'unimumer-qwen3-vl-2b' ? 2_000_000_000 : 256_000_000) ||
        !/^[0-9a-f]{64}$/.test(f.sha256) ||
        new URL(f.url).protocol !== 'https:'
      )
        throw new Error('Invalid model asset');
      files.set(f.path, { model: m, file: f });
    }
    models.set(m.id, m);
  }
  function model(id) {
    const m = models.get(id);
    if (!m) throw new Error('invalid');
    return m;
  }
  const directory = (m) => path.join(root, m.id, m.revision);
  const target = (base, name) => {
    const p = path.resolve(base, name);
    if (!p.startsWith(base + path.sep)) throw new Error('invalid');
    return p;
  };
  async function safe(base, relative = '') {
    // Refuse symlink/junction traversal even for our fixed model directories.
    const absolute = path.resolve(base, relative),
      parts = path.relative(root, absolute).split(path.sep);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error('invalid');
    let current = root;
    for (const part of ['', ...parts.filter(Boolean)]) {
      if (part) current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('unsafe');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return absolute;
  }
  async function exists(file, bytes) {
    try {
      const s = await fs.stat(file);
      return s.isFile() && s.size === bytes;
    } catch {
      return false;
    }
  }
  async function complete(m) {
    try {
      await safe(directory(m));
      const data = JSON.parse(await fs.readFile(path.join(directory(m), '.complete.json'), 'utf8'));
      return data.id === m.id && data.revision === m.revision && data.signature === signature(m);
    } catch {
      return false;
    }
  }
  const signature = (m) =>
    createHash('sha256')
      .update(JSON.stringify(m.files.map((f) => [f.path, f.bytes, f.sha256])))
      .digest('hex');
  async function available(m, base) {
    for (const f of m.files) if (!(await exists(target(base, f.path), f.bytes))) return false;
    return true;
  }
  async function list() {
    return Promise.all(
      [...models.values()].map(async (m) => {
        const ready = (await complete(m)) && (await available(m, directory(m))),
          inPackage = await available(m, bundled);
        let downloaded = false;
        try {
          await safe(directory(m));
          downloaded = (await fs.stat(directory(m))).isDirectory();
        } catch {}
        return {
          id: m.id,
          bundled: inPackage,
          downloaded,
          source: ready ? 'downloaded' : inPackage ? 'bundled' : 'missing',
          verified: verified.get(m.id) || null,
        };
      }),
    );
  }
  async function resolve(relative) {
    const entry = files.get(relative);
    if (!entry) return null;
    const { model: m, file: f } = entry,
      base = directory(m);
    if ((await complete(m)) && (await exists(target(base, f.path), f.bytes))) {
      await safe(base, f.path);
      return target(base, f.path);
    }
    return null;
  }
  async function hash(file, signal, onBytes = () => {}) {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024, signal })) {
      digest.update(chunk);
      onBytes(chunk.length);
    }
    return digest.digest('hex');
  }
  function progress(current, force = false) {
    if (!force && Date.now() - current.last < 180) return;
    current.last = Date.now();
    notify(current.owner, {
      id: current.id,
      action: current.action,
      done: current.done,
      total: current.total,
    });
  }
  function cancel(owner) {
    if (job && job.owner === owner) {
      job.controller.abort();
      return true;
    }
    return false;
  }
  async function run(owner, id, action) {
    const m = model(id);
    if (!['install', 'verify', 'remove'].includes(action)) throw new Error('invalid');
    if (job) throw new Error('busy');
    const current = {
      owner,
      id,
      action,
      controller: new AbortController(),
      done: 0,
      total: m.bytes,
      last: 0,
    };
    job = current;
    const signal = current.controller.signal;
    const base = directory(m),
      stage = base + '.partial',
      deadline = setTimeout(() => current.controller.abort(), 1200000);
    let verificationSource = null,
      stagingOwned = false;
    try {
      progress(current, true);
      await safe(base);
      await safe(stage);
      if (action === 'remove') {
        // A download is a versioned directory owned exclusively by this library.
        await fs.rm(base, { recursive: true, force: false }).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
        verified.delete(id);
        return { ok: true };
      }
      if (action === 'verify') {
        const useDownload = await complete(m),
          source = useDownload ? base : bundled;
        verificationSource = useDownload ? base : null;
        for (const f of m.files) {
          signal.throwIfAborted();
          if (useDownload) await safe(base, f.path);
          if (
            !(await exists(target(source, f.path), f.bytes)) ||
            (await hash(target(source, f.path), signal, (n) => {
              current.done += n;
              progress(current);
            })) !== f.sha256
          )
            throw new Error('checksum');
        }
        verified.set(id, { source: useDownload ? 'downloaded' : 'bundled', at: Date.now() });
        return { ok: true };
      }
      if ((await complete(m)) && (await available(m, base))) return { ok: true };
      await fs.rm(stage, { recursive: true, force: false }).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
      await fs.mkdir(stage, { recursive: true });
      stagingOwned = true;
      for (const f of m.files) {
        signal.throwIfAborted();
        const output = await safe(stage, f.path);
        await fs.mkdir(path.dirname(output), { recursive: true });
        const response = await fetch(f.url, {
          signal,
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error('network');
        }
        const length = response.headers.get('content-length'),
          encoding = response.headers.get('content-encoding');
        if (length && (!encoding || encoding === 'identity') && Number(length) !== f.bytes) {
          await response.body.cancel();
          throw new Error('checksum');
        }
        const digest = createHash('sha256');
        let size = 0;
        const input = Readable.fromWeb(response.body, { signal });
        async function* checked() {
          for await (const chunk of input) {
            size += chunk.length;
            if (size > f.bytes) throw new Error('checksum');
            digest.update(chunk);
            current.done += chunk.length;
            progress(current);
            yield chunk;
          }
        }
        const { createWriteStream } = require('node:fs');
        await pipeline(checked(), createWriteStream(output, { flags: 'wx' }), { signal });
        if (size !== f.bytes || digest.digest('hex') !== f.sha256) throw new Error('checksum');
      }
      for (const item of m.metadata || []) {
        const output = await safe(stage, item.path);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, JSON.stringify(item.data));
      }
      await fs.writeFile(
        path.join(stage, '.complete.json'),
        JSON.stringify({ id, revision: m.revision, signature: signature(m) }),
      );
      signal.throwIfAborted();
      // Never expose partial files through the custom protocol or native backend.
      await fs.rm(base, { recursive: true, force: false }).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
      await fs.rename(stage, base);
      verified.set(id, { source: 'downloaded', at: Date.now() });
      return { ok: true };
    } catch (e) {
      if (action !== 'remove') verified.delete(id);
      if (e.message === 'checksum' && verificationSource)
        await fs.unlink(path.join(verificationSource, '.complete.json')).catch(() => {});
      return {
        ok: false,
        error: signal.aborted
          ? 'cancelled'
          : ['checksum', 'busy', 'unsafe', 'invalid'].includes(e.message)
            ? e.message
            : e.code === 'ENOSPC'
              ? 'disk-full'
              : 'failed',
      };
    } finally {
      clearTimeout(deadline);
      if (stagingOwned) await fs.rm(stage, { recursive: true, force: false }).catch(() => {});
      progress(current, true);
      if (job === current) job = null;
    }
  }
  return { list, resolve, run, cancel, dispose: () => job?.controller.abort() };
}
module.exports = { createModelLibrary };
