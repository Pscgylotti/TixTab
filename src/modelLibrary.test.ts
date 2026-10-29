import { test, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { createModelLibrary } = createRequire(import.meta.url)('../electron/model-library.cjs');
const fixtures: string[] = [];
const bytes = Buffer.alloc(180_000, 17),
  digest = createHash('sha256').update(bytes).digest('hex');
const model = {
  id: 'example',
  revision: 'abc123',
  files: [
    {
      path: 'example/data.onnx',
      bytes: bytes.length,
      sha256: digest,
      url: 'https://models.test/fixed/data.onnx',
    },
  ],
  metadata: [{ path: 'example/manifest.json', data: { revision: 'abc123' } }],
  bytes: bytes.length,
};
test('the shipped model catalog passes the actual desktop startup validator', () => {
  const catalog = createRequire(import.meta.url)('../electron/model-catalog.json');
  const library = createModelLibrary({
    root: path.join(tmpdir(), 'catalog-check'),
    bundled: path.join(tmpdir(), 'catalog-check-bundled'),
    catalog,
    fetch: () => {
      throw Error('No downloads in catalog validation');
    },
  });
  expect(catalog.models.some((m: any) => m.id === 'matchmaker')).toBe(true);
  expect(catalog.models.some((m: any) => m.id === 'docaligner')).toBe(true);
  library.dispose();
  for (const m of catalog.models)
    expect(m.bytes).toBe(m.files.reduce((total: number, f: any) => total + f.bytes, 0));
  expect(() =>
    createModelLibrary({
      root: tmpdir(),
      bundled: tmpdir(),
      catalog: { models: [{ ...model, revision: '0.4.0-invalid' }] },
      fetch: vi.fn(),
    }),
  ).toThrow('Invalid model catalog: example');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const folder of fixtures.splice(0)) {
    expect(path.dirname(folder)).toBe(tmpdir());
    expect(path.basename(folder)).toMatch(/^surfacetab-library-/);
    await rm(folder, { recursive: true, force: true });
  }
});
async function fixture(fetch = vi.fn(async () => new Response(bytes))) {
  const folder = await mkdtemp(path.join(tmpdir(), 'surfacetab-library-'));
  fixtures.push(folder);
  const root = path.join(folder, 'library'),
    bundled = path.join(folder, 'bundled'),
    events: unknown[] = [];
  const library = createModelLibrary({
    root,
    bundled,
    catalog: { models: [model] },
    fetch,
    notify: (_owner: unknown, value: unknown) => events.push(value),
  });
  return {
    folder,
    root,
    bundled,
    fetch,
    library,
    events,
    base: path.join(root, model.id, model.revision),
  };
}
test('listing is metadata-only; atomic install, hash verification, resolve and removal agree', async () => {
  const f = await fixture();
  expect(await f.library.list()).toMatchObject([{ source: 'missing', downloaded: false }]);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(await f.library.resolve('../data')).toBeNull();
  expect(await f.library.run(1, model.id, 'install')).toEqual({ ok: true });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(await f.library.list()).toMatchObject([
    { source: 'downloaded', downloaded: true, verified: { source: 'downloaded' } },
  ]);
  expect(await f.library.resolve('example/data.onnx')).toBe(path.join(f.base, 'example/data.onnx'));
  expect(
    JSON.parse(await readFile(path.join(f.base, 'example/manifest.json'), 'utf8')).revision,
  ).toBe('abc123');
  expect(f.events.length).toBeGreaterThan(0);
  expect(await f.library.run(1, model.id, 'verify')).toEqual({ ok: true });
  expect(await f.library.run(1, model.id, 'remove')).toEqual({ ok: true });
  expect(await f.library.resolve('example/data.onnx')).toBeNull();
  expect(await f.library.list()).toMatchObject([{ source: 'missing', downloaded: false }]);
});
test('failed hashes and overlong downloads never become usable or retain partial files', async () => {
  for (const response of [
    new Response(Buffer.alloc(bytes.length, 2)),
    new Response(Buffer.alloc(bytes.length + 1)),
    new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } }),
  ]) {
    const f = await fixture(vi.fn(async () => response));
    expect(await f.library.run(1, model.id, 'install')).toEqual({ ok: false, error: 'checksum' });
    expect(await f.library.resolve('example/data.onnx')).toBeNull();
    await expect(stat(f.base + '.partial')).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
test('only completed, undamaged downloads override an immutable bundled model', async () => {
  const f = await fixture();
  await mkdir(path.join(f.bundled, 'example'), { recursive: true });
  await writeFile(path.join(f.bundled, 'example/data.onnx'), bytes);
  expect(await f.library.list()).toMatchObject([{ source: 'bundled' }]);
  await f.library.run(1, model.id, 'install');
  await writeFile(path.join(f.base, 'example/data.onnx'), Buffer.alloc(bytes.length, 3));
  expect(await f.library.run(1, model.id, 'verify')).toEqual({ ok: false, error: 'checksum' });
  expect(await f.library.resolve('example/data.onnx')).toBeNull();
  expect(await f.library.list()).toMatchObject([{ source: 'bundled', downloaded: true }]);
  await f.library.run(1, model.id, 'remove');
  expect(await readFile(path.join(f.bundled, 'example/data.onnx'))).toEqual(bytes);
  expect(await f.library.run(1, model.id, 'verify')).toEqual({ ok: true });
});
test('single task, owner cancellation, and partial downloads clean up connections and staging', async () => {
  let started = false;
  const f = await fixture(
    vi.fn(
      (_url?: unknown, options?: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          started = true;
          options!.signal.addEventListener(
            'abort',
            () => reject(new DOMException('cancel', 'AbortError')),
            { once: true },
          );
        }),
    ),
  );
  const pending = f.library.run(1, model.id, 'install');
  await vi.waitFor(() => expect(started).toBe(true));
  await expect(f.library.run(2, model.id, 'verify')).rejects.toThrow('busy');
  expect(f.library.cancel(2)).toBe(false);
  expect(f.library.cancel(1)).toBe(true);
  expect(await pending).toEqual({ ok: false, error: 'cancelled' });
  await expect(stat(f.base + '.partial')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await f.library.list()).toMatchObject([{ source: 'missing' }]);
});
test('incomplete and junction-backed directories are not served or recursively removed', async () => {
  const f = await fixture();
  await mkdir(path.join(f.base, 'example'), { recursive: true });
  await writeFile(path.join(f.base, 'example/data.onnx'), bytes);
  expect(await f.library.resolve('example/data.onnx')).toBeNull();
  await rm(f.base, { recursive: true });
  const outside = path.join(f.folder, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel'), 'keep');
  await symlink(outside, f.base, process.platform === 'win32' ? 'junction' : 'dir');
  expect(await f.library.run(1, model.id, 'remove')).toEqual({ ok: false, error: 'unsafe' });
  expect(await readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
  expect(await f.library.resolve('example/data.onnx')).toBeNull();
});
test('unknown IDs/actions and invalid catalog paths cannot mutate storage', async () => {
  const f = await fixture();
  await expect(f.library.run(1, '../example', 'remove')).rejects.toThrow('invalid');
  await expect(f.library.run(1, model.id, 'arbitrary')).rejects.toThrow('invalid');
  expect(f.fetch).not.toHaveBeenCalled();
  expect(() =>
    createModelLibrary({
      root: f.root,
      bundled: f.bundled,
      catalog: { models: [{ ...model, files: [{ ...model.files[0], path: '../escape' }] }] },
    }),
  ).toThrow('Invalid model asset');
});
test('stream cancellation releases the reader; compressed lengths still use decoded SHA256', async () => {
  let closed = false,
    started = false;
  const f = await fixture(
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              started = true;
              c.enqueue(bytes.subarray(0, 1000));
            },
            cancel() {
              closed = true;
            },
          }),
        ),
    ),
  );
  const task = f.library.run(1, model.id, 'install');
  await vi.waitFor(() => expect(started).toBe(true));
  f.library.dispose();
  expect(await task).toEqual({ ok: false, error: 'cancelled' });
  expect(closed).toBe(true);
  expect(await f.library.resolve('example/data.onnx')).toBeNull();
  const compressed = await fixture(
    vi.fn(
      async () =>
        new Response(bytes, { headers: { 'content-length': '100', 'content-encoding': 'gzip' } }),
    ),
  );
  expect(await compressed.library.run(1, model.id, 'install')).toEqual({ ok: true });
});
