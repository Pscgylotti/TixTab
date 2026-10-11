import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { verifyNightUi } from './verify-night-ui.mjs';
import { verifySelectionUi } from './verify-selection-ui.mjs';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const profile = await mkdtemp(join(tmpdir(), 'surfacetab-selection-'));
const options = {
  executablePath: resolve(process.argv[2] || `release/${version}/win-unpacked/TixTab.exe`),
  args: [],
  env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
  timeout: 60000,
};
let app = await electron.launch(options);
try {
  const page = await app.firstWindow(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.app-shell').waitFor();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await verifyNightUi(page);
  await verifySelectionUi(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('书写惯用手').selectOption('left');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await app.close();
  app = await electron.launch(options);
  const cold = await app.firstWindow();
  cold.on('pageerror', (e) => errors.push(e.message));
  await cold.locator('.app-shell').waitFor();
  await cold.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(await cold.locator('html').getAttribute('data-night'), 'true');
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
  assert.equal(
    await cold.locator('.workspace').evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(23, 27, 35)',
  );
  await cold.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await cold.getByLabel('书写惯用手').inputValue(), 'left');
  await cold.getByRole('button', { name: '关闭', exact: true }).click();
  await cold.screenshot({ path: 'test-results/packaged-night-cold-start.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Actual cold restart: saved night UI / Windows native dark theme / writing hand: verified',
  );
  console.log(
    'Actual packaged desktop night UI: passed; renderer errors: none; ' + options.executablePath,
  );
} finally {
  await app.close();
}
