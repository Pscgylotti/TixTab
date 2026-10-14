import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { verifyNightUi } from './verify-night-ui.mjs';
const executablePath = resolve(process.argv[2] || 'release/0.2.38/lite/win-unpacked/TixTab.exe');
const fixture = await mkdtemp(resolve('.cache/shortcut-verify-')),
  profile = join(fixture, 'profile'),
  desktop = join(fixture, 'desktop');
await mkdir(desktop);
const app = await electron.launch({
  executablePath,
  args: [],
  env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
  timeout: 60000,
});
try {
  await app.evaluate(({ app }, folder) => app.setPath('desktop', folder), desktop);
  const page = await app.firstWindow(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '发送快捷方式到桌面', exact: true }).click();
  await page.getByText('桌面快捷方式已创建', { exact: true }).waitFor();
  let details = await app.evaluate(
    ({ shell }, file) => shell.readShortcutLink(file),
    join(desktop, 'TixTab.lnk'),
  );
  assert.equal(details.target.toLowerCase(), executablePath.toLowerCase());
  assert.equal(details.appUserModelId, 'local.surfacetab.app');
  assert.equal(details.icon.toLowerCase(), executablePath.toLowerCase());
  await page.getByRole('button', { name: '发送快捷方式到桌面', exact: true }).click();
  details = await app.evaluate(
    ({ shell }, file) => shell.readShortcutLink(file),
    join(desktop, 'TixTab.lnk'),
  );
  assert.equal(details.target.toLowerCase(), executablePath.toLowerCase());
  assert.deepEqual(errors, []);
  if (process.argv.includes('--night')) {
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await verifyNightUi(page);
    assert.deepEqual(errors, []);
  }
  console.log(
    JSON.stringify(
      { packaged: true, target: details.target, fixture, repeated: true, errors },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
