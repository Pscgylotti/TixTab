import { _electron as electron } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { verifyNativeTexo } from './verify-native-ui.mjs';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const app = await electron.launch({
  executablePath: resolve(process.argv[2] || `release/${version}/win-unpacked/TixTab.exe`),
  args: [],
  env: {
    ...process.env,
    SURFACETAB_DEV: '0',
    SURFACETAB_PROFILE: await mkdtemp(join(tmpdir(), 'surfacetab-model-lifetime-')),
  },
  timeout: 60000,
});
try {
  const page = await app.firstWindow(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await verifyNativeTexo(page);
  const health = await page.evaluate(async () =>
    (await fetch('http://127.0.0.1:8766/health')).json(),
  );
  assert.ok(health.capabilities.includes('release-idle'));
  assert.equal(health.loaded, false, 'Native model must be freed before bundled WASM fallback');
  const texoWorkers = () => page.workers().filter((w) => w.url().includes('texo.worker'));
  assert.equal(texoWorkers().length, 1, 'Exercise a real loaded bundled Texo worker');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '任务与后端', exact: true }).click();
  await page.getByRole('button', { name: '释放闲置模型内存', exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('.task-memory')
      ?.textContent.includes('闲置模型已释放，再次使用时按需加载。'),
  );
  assert.equal(texoWorkers().length, 0, 'Manual release must terminate the actual model worker');
  await page.screenshot({ path: 'test-results/packaged-model-lifetime.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Actual packaged NPU -> real WASM -> manual worker release: passed; native loaded=false; renderer errors: none',
  );
} finally {
  await app.close();
}
