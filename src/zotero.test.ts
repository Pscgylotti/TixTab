import { test, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validZoteroSource } from './zoteroSource';
import { newNotebook, validNotebook } from './model';
import { decodeProject, encodeProject } from './storage';
const { createZotero } = createRequire(import.meta.url)('../electron/zotero.cjs');
const folders: string[] = [];
afterEach(async () => {
  for (const p of folders.splice(0)) {
    expect(path.dirname(p)).toBe(tmpdir());
    expect(path.basename(p)).toMatch(/^surfacetab-zotero-/);
    await rm(p, { recursive: true, force: true });
  }
});
const raw = {
  key: 'ABCD1234',
  data: {
    itemType: 'attachment',
    title: 'Attachment',
    contentType: 'application/pdf',
    filename: 'test.pdf',
  },
  meta: {},
};
const response = (data: unknown, headers = {}) =>
  new Response(JSON.stringify(data), { headers: { 'Zotero-Server-ID': 'local-1', ...headers } });
function fixture(fetch: ReturnType<typeof vi.fn>) {
  const clipboard = { writeText: vi.fn() },
    shell = { openExternal: vi.fn(async () => {}) };
  return { service: createZotero({ fetch, clipboard, shell }), clipboard, shell, fetch };
}
test('fixed loopback routes, group discovery, bounded pagination and Unicode search', async () => {
  const f = fixture(
    vi.fn(async (url: string) =>
      url.includes('/groups?')
        ? response([{ id: 12, data: { name: 'Group' } }])
        : response([raw], { 'total-results': '52' }),
    ),
  );
  expect(await f.service.run(1, { action: 'libraries' })).toMatchObject({
    ok: true,
    data: [{ id: 'users/0' }, { id: 'groups/12', name: 'Group' }],
  });
  expect(
    await f.service.run(1, {
      action: 'items',
      library: 'groups/12',
      collection: 'ABCDEFGH',
      start: 50,
      query: '多行 x&y',
    }),
  ).toMatchObject({
    ok: true,
    serverId: 'local-1',
    data: { rows: [{ pdf: true, key: raw.key }], more: true },
  });
  const [url, options] = f.fetch.mock.calls[1];
  const u = new URL(url);
  expect(u.origin).toBe('http://127.0.0.1:23119');
  expect(u.pathname).toBe('/api/groups/12/collections/ABCDEFGH/items/top');
  expect(u.searchParams.get('q')).toBe('多行 x&y');
  expect(u.searchParams.get('limit')).toBe('50');
  expect(options.redirect).toBe('manual');
  for (const request of [
    { action: 'pdf', key: '../bad' },
    { action: 'items', library: 'https://evil.test' },
    { action: 'items', start: -1 },
    { action: 'items', serverId: 'bad\r\nHeader' },
    { action: 'write' },
  ])
    expect(await f.service.run(1, request)).toMatchObject({ ok: false, error: 'invalid' });
  expect(f.fetch).toHaveBeenCalledTimes(2);
});
test('local attachment bytes are read after metadata and file URL validation', async () => {
  const p = await mkdtemp(path.join(tmpdir(), 'surfacetab-zotero-'));
  folders.push(p);
  const file = path.join(p, '测试.pdf'),
    bytes = Buffer.from('%PDF-1.7\nfixture');
  await writeFile(file, bytes);
  const f = fixture(
    vi.fn(async (url: string) =>
      url.includes('/file/view/url')
        ? new Response(pathToFileURL(file).href, { headers: { 'Zotero-Server-ID': 'local-1' } })
        : response(raw),
    ),
  );
  const result = await f.service.run(1, {
    action: 'pdf',
    key: raw.key,
    parentKey: 'PARENT12',
    serverId: 'local-1',
  });
  expect(result).toMatchObject({
    ok: true,
    data: {
      filename: 'test.pdf',
      source: { library: 'users/0', key: raw.key, parentKey: 'PARENT12', serverId: 'local-1' },
    },
  });
  expect(Buffer.from(result.data.bytes)).toEqual(bytes);
  expect(f.fetch.mock.calls.every(([, o]) => o.headers['Zotero-Server-ID'] === 'local-1')).toBe(
    true,
  );
  await writeFile(file, 'not PDF');
  expect(await f.service.run(1, { action: 'pdf', key: raw.key })).toMatchObject({
    ok: false,
    error: 'not-pdf',
  });
});
test('remote redirects, UNC shares, non-PDF and unsolicited renderer paths cannot be read', async () => {
  for (const location of [
    'https://evil.test/test.pdf',
    'file://server/share/a.pdf',
    'file:///C:/secret.txt',
    'file:///C:/file.pdf?query=1',
  ]) {
    const f = fixture(
      vi.fn(async (url: string) =>
        url.includes('/file/view/url') ? new Response(location) : response(raw),
      ),
    );
    expect(
      (await f.service.run(1, { action: 'pdf', key: raw.key, path: 'C:/secret.txt' })).ok,
    ).toBe(false);
  }
  const f = fixture(
    vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }),
    ),
  );
  expect(await f.service.run(1, { action: 'pdf', key: raw.key })).toMatchObject({
    ok: false,
    error: 'response',
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
test('offline, disabled API, missing attachments and switched database are distinct', async () => {
  for (const [status, error] of [
    [403, 'disabled'],
    [404, 'missing'],
    [412, 'changed'],
    [501, 'unsupported'],
    [500, 'response'],
  ] as const) {
    const f = fixture(vi.fn(async () => new Response('', { status })));
    expect(await f.service.run(1, { action: 'items' })).toEqual({ ok: false, error });
  }
  const malformed = fixture(vi.fn(async () => new Response('not JSON')));
  expect(await malformed.service.run(1, { action: 'items' })).toEqual({
    ok: false,
    error: 'response',
  });
  const f = fixture(
    vi.fn(async () => {
      throw new Error('ECONNREFUSED private details');
    }),
  );
  expect(await f.service.run(1, { action: 'items' })).toEqual({ ok: false, error: 'offline' });
});
test('copy uses native clipboard and Zotero deep links accept only fixed library/item forms', async () => {
  const f = fixture(vi.fn(async () => new Response('@article{test,title={Test}}')));
  expect((await f.service.run(1, { action: 'bibtex', key: 'PARENT12' })).ok).toBe(true);
  expect(f.clipboard.writeText).toHaveBeenCalledWith('@article{test,title={Test}}');
  await f.service.run(1, { action: 'reveal', library: 'groups/12', key: 'PARENT12' });
  expect(f.shell.openExternal).toHaveBeenCalledWith('zotero://select/groups/12/items/PARENT12');
  await f.service.run(1, { action: 'reveal', key: 'ABCD1234' });
  expect(f.shell.openExternal).toHaveBeenCalledWith('zotero://select/library/items/ABCD1234');
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
test('owner cancellation frees blocked requests; other windows cannot cancel', async () => {
  let started = false;
  const f = fixture(
    vi.fn(
      (_url: string, o: { signal: AbortSignal }) =>
        new Promise((_r, reject) => {
          started = true;
          o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    ),
  );
  const pending = f.service.run(1, { action: 'items' });
  await vi.waitFor(() => expect(started).toBe(true));
  expect(await f.service.run(1, { action: 'items' })).toEqual({ ok: false, error: 'busy' });
  expect(f.service.cancel(2)).toBe(false);
  expect(f.service.cancel(1)).toBe(true);
  expect(await pending).toEqual({ ok: false, error: 'cancelled' });
});
test('Zotero association survives project round trip and rejects untrusted identifiers', () => {
  const source = { library: 'users/0', key: 'ABCD1234', serverId: 'local-1', title: 'Paper' };
  expect(validZoteroSource(source)).toBe(true);
  expect(validZoteroSource({ ...source, key: '../../../' })).toBe(false);
  const notebook = { ...newNotebook(), zotero: source };
  expect(decodeProject(encodeProject(notebook)).zotero).toEqual(source);
  expect(validNotebook({ ...notebook, zotero: { ...source, library: 'evil' } })).toBe(false);
});
