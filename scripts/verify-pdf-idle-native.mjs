import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { readPerformanceFixture } from './performance-fixture.mjs';
import { waitForPerformanceSettled } from './performance-settle.mjs';

const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    'fixture-file': { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values['app-dir'] || !values['fixture-file'] || !values.output)
  throw Error('Supply frozen app, fixture and fresh output');
const hash = (b) => createHash('sha256').update(b).digest('hex');
const fixture = await readPerformanceFixture(values['fixture-file']);
const profile = await mkdtemp(join(tmpdir(), 'tixtab-pdf-idle-'));
const app = await electron.launch({
  args: [resolve(values['app-dir'])],
  env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
  timeout: 60000,
});
const checks = [],
  errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    localStorage.setItem('surfacetab.powerMode', 'quality');
    localStorage.setItem('tixtab.performance.enabled', 'true');
  });
  await page.reload();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
  );
  const settle = () => waitForPerformanceSettled(page, { timeoutMs: 60000 });
  const snapshot = () => page.evaluate(() => window.tixtabPerformance.snapshot());
  const pointer = (type, id = 871, buttons = 1) =>
    page.evaluate(
      ({ type, id, buttons }) => {
        document.dispatchEvent(
          new PointerEvent(type, { pointerId: id, pointerType: 'pen', buttons }),
        );
      },
      { type, id, buttons },
    );
  await settle();
  for (const scenario of ['release', 'cancel', 'lost-capture', 'stale-contact', 'hidden-restore']) {
    const before = await snapshot();
    await pointer('pointerdown');
    // Parsing/import can itself exceed the lost-contact watchdog. Keep a live
    // synthetic stroke until jobs reach the queue, then test the recovery path.
    await page.evaluate(() => {
      window.__pdfIdleHeartbeat = setInterval(
        () =>
          document.dispatchEvent(
            new PointerEvent('pointermove', { pointerId: 871, pointerType: 'pen', buttons: 1 }),
          ),
        100,
      );
    });
    await page.locator('input[type=file]').setInputFiles({
      name: scenario + '.tixtab',
      mimeType: 'application/json',
      buffer: fixture.bytes,
    });
    await expect.poll(async () => (await snapshot()).stages['pdf-job'].pending).toBeGreaterThan(0);
    await page.waitForTimeout(400);
    const during = await snapshot();
    console.log(
      JSON.stringify({
        scenario,
        before: before.stages['pdf-raster'],
        during: during.stages['pdf-raster'],
        recovery: during.stages['pointer-recovery'],
      }),
    );
    expect(during.stages['pdf-raster'].completed).toBe(before.stages['pdf-raster'].completed);
    expect(during.stages['pdf-raster'].pending).toBe(0);
    await page.evaluate(() => clearInterval(window.__pdfIdleHeartbeat));
    if (scenario === 'stale-contact') {
      await pointer('pointermove');
      await page.waitForTimeout(1000);
      expect((await snapshot()).stages['pdf-raster'].completed).toBe(
        before.stages['pdf-raster'].completed,
      );
      // No pointerup: actual application watchdog must release its queued PDF work.
    } else if (scenario === 'hidden-restore') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.windowHidden))
        .toBe('true');
      await page.waitForTimeout(1700);
      expect((await snapshot()).stages['pdf-raster'].completed).toBe(
        before.stages['pdf-raster'].completed,
      );
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.windowHidden))
        .toBe('false');
    } else {
      await pointer(
        scenario === 'release'
          ? 'pointerup'
          : scenario === 'cancel'
            ? 'pointercancel'
            : 'lostpointercapture',
        871,
        0,
      );
    }
    const after = await settle();
    expect(after.ledger.stages['pdf-raster'].completed).toBeGreaterThan(
      before.stages['pdf-raster'].completed,
    );
    expect(after.ledger.pending).toBe(0);
    expect(after.visibleBackgrounds).toBeGreaterThan(0);
    checks.push({ scenario, before, during, after });
    console.log(
      JSON.stringify({ scenario, completed: after.ledger.stages['pdf-raster'].completed }),
    );
  }
  expect(errors).toEqual([]);
  await writeFile(
    values.output,
    JSON.stringify(
      {
        schema: 1,
        appDir: resolve(values['app-dir']),
        sourceManifestSha256: hash(await readFile(join(values['app-dir'], 'SOURCE-MANIFEST.json'))),
        harnessSha256: hash(await readFile(new URL(import.meta.url))),
        fixture: fixture.description,
        checks,
        errors,
        limits:
          'Actual Electron PDF queue and completion checks with synthetic PointerEvents. Exact quiet-period boundaries are covered separately by fake-clock unit tests; not physical pen latency or power measurements.',
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
} finally {
  await app.close();
}
