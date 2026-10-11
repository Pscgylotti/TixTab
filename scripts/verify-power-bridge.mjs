import { _electron as electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const profile = await mkdtemp(join(tmpdir(), 'surfacetab-power-'));
const app = await electron.launch({
  executablePath: process.env.SURFACETAB_EXECUTABLE,
  args: [],
  env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
});
try {
  const page = await app.firstWindow();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  const onBattery = await page.evaluate(() => window.surfaceDesktop.getOnBattery());
  assert.equal(typeof onBattery, 'boolean');
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('on-battery'));
  await page.waitForFunction(() => document.documentElement.dataset.eco === 'true');
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('on-ac'));
  await page.waitForFunction(() => document.documentElement.dataset.eco === 'false');
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark');
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'light');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await page.waitForFunction(
    () => document.documentElement.dataset.windowHidden === 'true',
    {},
    { polling: 100 },
  );
  assert.equal(await page.evaluate(() => window.surfaceDesktop.getWindowVisible()), false);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.waitForFunction(
    () => document.documentElement.dataset.windowHidden === 'false',
    {},
    { polling: 100 },
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await page.waitForFunction(
    () => document.documentElement.dataset.windowHidden === 'true',
    {},
    { polling: 100 },
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await page.waitForFunction(
    () => document.documentElement.dataset.windowHidden === 'false',
    {},
    { polling: 100 },
  );
  console.log(
    JSON.stringify({
      realBatteryRead: onBattery,
      simulatedBatteryEvents: 'passed',
      nativeTheme: 'passed',
      nativeHideVisibility: 'passed',
    }),
  );
} finally {
  await app.close();
}
