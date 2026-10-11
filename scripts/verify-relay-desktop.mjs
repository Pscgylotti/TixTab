import { _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const requests = [],
  closed = [],
  binary = Buffer.from(Uint8Array.from({ length: 200000 }, (_, i) => i % 251));
let redirected = 0;
const server = createServer((req, res) => {
  requests.push(req.url);
  res.on('close', () => closed.push(req.url));
  if (req.url === '/untrusted') {
    res.end('<!doctype html><title>Untrusted fixture</title>Fixture');
    return;
  }
  if (req.url === '/redirected') {
    redirected++;
    res.end('{}');
    return;
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: '/redirected' });
    res.end();
    return;
  }
  if (req.url.startsWith('/pending') || req.url === '/timeout') return;
  if (req.url === '/hold') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
    res.write(Buffer.alloc(4096));
    return;
  }
  if (req.url === '/large') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': '4000001',
    });
    res.write(Buffer.alloc(4096));
    return;
  }
  if (req.url === '/overflow') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write(Buffer.alloc(4_000_001));
    res.end();
    return;
  }
  if (req.url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: partial\n\n');
    return;
  }
  if (req.url === '/binary') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(binary);
    return;
  }
  res.writeHead(200);
  res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'surfacetab-relay-'));
const app = await electron.launch({
  ...(process.env.SURFACETAB_EXECUTABLE
    ? { executablePath: process.env.SURFACETAB_EXECUTABLE, args: [] }
    : { args: ['.'] }),
  env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
  timeout: 60000,
});
const packet = (path, extra = {}) => ({
  id: randomUUID(),
  url: origin + path,
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-sensitive' },
  body: '{}',
  timeoutMs: 15000,
  kind: 'text',
  ...extra,
});
const until = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(20);
  }
  assert.ok(predicate(), 'Expected fixture connection state');
};
let child;
try {
  const page = await app.firstWindow();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  const start = (r) => page.evaluate((r) => window.surfaceDesktop.providerHttp.start(r), r);
  const cancel = (id) => page.evaluate((id) => window.surfaceDesktop.providerHttp.cancel(id), id);
  const read = (id) =>
    page.evaluate(async (id) => {
      const result = await window.surfaceDesktop.providerHttp.read(id);
      return { ...result, bufferBytes: result.bytes?.buffer.byteLength };
    }, id);
  const r = packet('/binary');
  assert.equal((await start(r)).ok, true);
  const data = [];
  let maxChunk = 0,
    reads = 0;
  while (true) {
    const part = await read(r.id);
    assert.equal(part.ok, true);
    reads++;
    if (part.done) break;
    const bytes = Buffer.from(Object.values(part.bytes));
    assert.ok(bytes.length <= 65536);
    assert.ok(part.bufferBytes <= 65536, 'IPC must not clone a larger backing buffer');
    maxChunk = Math.max(maxChunk, bytes.length);
    data.push(bytes);
  }
  assert.deepEqual(Buffer.concat(data), binary);
  assert.ok(reads >= 5);
  for (const patch of [
    { url: 'file:///private' },
    { url: 'http://user:private@127.0.0.1' },
    { headers: { Cookie: 'private' } },
  ])
    assert.equal((await start(packet('/not-requested', patch))).error, 'invalid');
  assert.ok(!requests.includes('/not-requested'));
  assert.equal((await start(packet('/redirect'))).ok, false);
  assert.equal(redirected, 0);
  assert.equal((await start(packet('/large'))).error, 'limit');
  await until(() => closed.includes('/large'));
  const overflow = packet('/overflow');
  assert.equal((await start(overflow)).ok, true);
  let total = 0,
    error;
  while (!error) {
    const part = await read(overflow.id);
    if (!part.ok) {
      error = part.error;
      break;
    }
    assert.equal(part.done, false);
    total += Object.values(part.bytes).length;
    assert.ok(total <= 4_000_000);
  }
  assert.equal(error, 'limit');
  const stream = packet('/stream');
  assert.equal((await start(stream)).ok, true);
  assert.match(Buffer.from(Object.values((await read(stream.id)).bytes)).toString(), /partial/);
  await cancel(stream.id);
  await until(() => closed.includes('/stream'));
  const pending = packet('/pending-cancel');
  await page.evaluate((r) => {
    window.relayPending = window.surfaceDesktop.providerHttp.start(r);
  }, pending);
  await until(() => requests.includes('/pending-cancel'));
  await cancel(pending.id);
  assert.equal((await page.evaluate(() => window.relayPending)).error, 'aborted');
  await until(() => closed.includes('/pending-cancel'));
  const timeout = await start(packet('/timeout', { timeoutMs: 2000 }));
  assert.equal(timeout.error, 'timeout');
  await until(() => closed.includes('/timeout'));
  const hold = Array.from({ length: 4 }, () => packet('/hold'));
  assert.ok((await Promise.all(hold.map(start))).every((r) => r.ok));
  assert.equal((await start(packet('/hold'))).error, 'busy');
  await Promise.all(hold.map((r) => cancel(r.id)));
  const reload = packet('/pending-reload');
  await page.evaluate((r) => {
    window.relayPending = window.surfaceDesktop.providerHttp.start(r);
  }, reload);
  await until(() => requests.includes('/pending-reload'));
  await page.reload();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await until(() => closed.includes('/pending-reload'));
  // A sandboxed unrelated web page with the same preload must still be denied.
  await app.evaluate(({ BrowserWindow, app }, url) => {
    globalThis.relayFixtureWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: app.getAppPath() + '/electron/preload.cjs',
        contextIsolation: true,
        sandbox: true,
      },
    });
    void globalThis.relayFixtureWindow.loadURL(url);
  }, origin + '/untrusted');
  for (let i = 0; i < 100 && !child; i++) {
    child = (await app.windows()).find((p) => p.url() === origin + '/untrusted');
    if (!child) await delay(20);
  }
  assert.ok(child);
  const before = requests.length;
  assert.equal(
    (
      await child.evaluate(
        (r) => window.surfaceDesktop.providerHttp.start(r),
        packet('/untrusted-request'),
      )
    ).error,
    'untrusted',
  );
  assert.equal(requests.length, before);
  await app.evaluate(() => globalThis.relayFixtureWindow.loadURL('surfacetab://app/index.html'));
  await child.locator('.busy-overlay').waitFor({ state: 'hidden' });
  const isolated = packet('/pending-isolated');
  await page.evaluate((r) => {
    window.relayPending = window.surfaceDesktop.providerHttp.start(r);
  }, isolated);
  await until(() => requests.includes('/pending-isolated'));
  assert.equal(
    (await child.evaluate((id) => window.surfaceDesktop.providerHttp.read(id), isolated.id)).error,
    'missing',
  );
  await child.evaluate((id) => window.surfaceDesktop.providerHttp.cancel(id), isolated.id);
  assert.ok(!closed.includes('/pending-isolated'));
  await cancel(isolated.id);
  await until(() => closed.includes('/pending-isolated'));
  const closing = packet('/pending-close');
  await child.evaluate((r) => {
    window.relayPending = window.surfaceDesktop.providerHttp.start(r);
  }, closing);
  await until(() => requests.includes('/pending-close'));
  await app.evaluate(() => globalThis.relayFixtureWindow.close());
  child = null;
  await until(() => closed.includes('/pending-close'));
  const report = {
    version: JSON.parse(await readFile('package.json', 'utf8')).version,
    executable:
      process.env.SURFACETAB_EXECUTABLE || resolve('node_modules/electron/dist/electron.exe'),
    actualDesktop: true,
    corsHeaders: false,
    binaryBytes: binary.length,
    binarySha256: createHash('sha256').update(binary).digest('hex'),
    maxIpcChunkBytes: maxChunk,
    binaryReadCalls: reads,
    redirectTargetRequests: redirected,
    inputBoundaries: true,
    declaredAndStreamingOutputLimits: true,
    cancelBeforeHeaders: true,
    cancelStreaming: true,
    nativeTimeout: true,
    concurrencyLimit: true,
    navigationCleanup: true,
    ownerIsolation: true,
    windowCloseCleanup: true,
    untrustedWindowDenied: true,
  };
  await writeFile('test-results/relay-desktop0214.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (child) await app.evaluate(() => globalThis.relayFixtureWindow.close()).catch(() => {});
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
