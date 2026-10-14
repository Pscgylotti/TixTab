import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { waitForPerformanceSettled } from './performance-settle.mjs';
const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    'fixture-file': { type: 'string' },
    output: { type: 'string' },
    'expect-late-gap': { type: 'boolean', default: false },
  },
});
if (!values['app-dir'] || !values['fixture-file'] || !values.output)
  throw Error('Supply frozen app, fixture and fresh output');
const root = resolve(values['app-dir']),
  hash = (b) => createHash('sha256').update(b).digest('hex');
const profile = await mkdtemp(join(tmpdir(), 'tixtab-foreground-lifecycle-'));
const launch = () =>
  electron.launch({
    args: [root],
    env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
    timeout: 60000,
  });
let app = await launch();
const checks = [],
  errors = [];
try {
  let page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.evaluate(() => localStorage.setItem('tixtab.performance.enabled', 'true'));
  await page.reload();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
  );
  const settle = () => waitForPerformanceSettled(page, { timeoutMs: 60000 });
  await settle();
  await page
    .locator('input[type=file][accept=".pdf,.tixtab"]')
    .setInputFiles(resolve(values['fixture-file']));
  await settle();
  const check = async (label, expected, old = false) => {
    const before = await page.evaluate(
      () => window.tixtabPerformance.snapshot().stages['foreground-view'].completed,
    );
    await page.evaluate((old) => {
      const view = old
        ? window.__oldForegroundViewport
        : document.querySelector('.surface,.reading-view');
      if (!view) throw Error('Missing viewport');
      view.dispatchEvent(new Event('scroll'));
    }, old);
    await settle();
    const after = await page.evaluate(
      () => window.tixtabPerformance.snapshot().stages['foreground-view'].completed,
    );
    const result = { label, delta: after - before, expected };
    checks.push(result);
    assert.equal(result.delta, expected, label);
  };
  await check('import-existing-surface', 1);
  for (const [view, label, expected] of [
    ['连续页面预览', 'continuous', 1],
    ['单页标注', 'return-single', values['expect-late-gap'] ? 0 : 1],
    ['双页预览', 'dual', 1],
    ['单页标注', 'return-single-again', values['expect-late-gap'] ? 0 : 1],
  ]) {
    await page.evaluate(() => {
      window.__oldForegroundViewport = document.querySelector('.surface,.reading-view');
    });
    await page.getByRole('button', { name: view, exact: true }).click();
    await settle();
    await check(label, expected);
    await check(label + '-old-disposed', 0, true);
  }
  // Workspace restoration starts with an existing empty surface: validate it
  // separately instead of attributing the view-switch gap to every startup.
  await page.reload();
  await settle();
  await check('workspace-reload', 1);
  await expect(page.locator('.placed-object').count()).resolves.toBeGreaterThan(0);
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForURL('surfacetab://app/index.html');
  await expect(page.locator('.canvas-container')).toBeVisible();
  await page.waitForFunction(() => !!window.tixtabPerformance);
  await settle();
  await check('process-restart', 1);
  await expect(page.locator('.placed-object').count()).resolves.toBeGreaterThan(0);
  assert.deepEqual(errors, []);
} finally {
  await app.close();
}
async function inventory(dir) {
  const items = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = join(dir, e.name);
    if (e.isDirectory()) items.push(...(await inventory(file)));
    else if (e.isFile())
      items.push([relative(root, file).replaceAll('\\', '/'), hash(await readFile(file))]);
  }
  return items;
}
const buildManifest = [
  ...(await inventory(join(root, 'dist'))),
  ...(await inventory(join(root, 'electron'))),
  ['package.json', hash(await readFile(join(root, 'package.json')))],
];
await writeFile(
  values.output,
  JSON.stringify(
    {
      passed: true,
      checks,
      errors,
      buildManifest,
      buildSha256: hash(JSON.stringify(buildManifest)),
      sourceManifestSha256: hash(await readFile(join(root, 'SOURCE-MANIFEST.json'))),
      fixtureSha256: hash(await readFile(values['fixture-file'])),
      harnessSha256: hash(await readFile(new URL(import.meta.url))),
      settleSha256: hash(await readFile(new URL('./performance-settle.mjs', import.meta.url))),
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify({ passed: true, checks }));
