// Isolated packaged-window checks. --install additionally prepares fresh managed
// runtimes using Electron net.fetch, without touching existing user environments.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const executablePath = resolve(process.argv[2]);
const profile = await mkdtemp(join(tmpdir(), 'surfacetab-release-'));
const output = resolve('release/0.2.35/validation');
await mkdir(output, { recursive: true });
const app = await electron.launch({
  executablePath,
  env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
  timeout: 60000,
});
const errors = [],
  views = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(() => typeof window.surfaceDesktop.runtimes.onProgress),
    'function',
  );
  assert.equal(
    (
      await page.evaluate(() =>
        window.surfaceDesktop.runtimes.run({ id: 'invalid', action: 'install' }),
      )
    ).ok,
    false,
  );
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 4; i++)
    pdf
      .addPage([595, 842])
      .drawText(`Surface release page ${i}`, { x: 40, y: 700, size: 16, font });
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles({
    name: 'Release.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  for (const name of ['收起顶部区域', '收起工具栏', '收起底部工具'])
    await page.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.workspace-heading .tool-button')).toHaveCount(8);
  await expect(page.locator('.preview-toggle')).toHaveCount(0);
  const geometry = () =>
    page.locator('.canvas-container').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    });
  for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await page.waitForTimeout(800);
    const before = await geometry();
    for (const button of await page
      .locator('.workspace-heading button,.status-tools button')
      .all()) {
      if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
      await button.hover();
      assert.deepEqual(await geometry(), before, `Hover changed the PDF viewport: ${mode}`);
    }
    const canvas = page.locator('.canvas-container'),
      r = await canvas.boundingBox();
    await canvas.dispatchEvent('pointerdown', {
      pointerType: 'pen',
      pointerId: 81,
      button: 2,
      buttons: 2,
      clientX: r.x + r.width / 2,
      clientY: r.y + 160,
      bubbles: true,
    });
    const wheel = page.getByRole('menu', { name: '笔侧键工具环' });
    await expect(wheel).toBeVisible();
    await wheel.getByRole('menuitemradio', { name: '移动', exact: true }).click();
    await expect(page.getByRole('button', { name: '移动', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    views.push({ mode, viewport: before, hoverStable: true, penWheel: true });
  }
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.locator('.canvas-container').dispatchEvent('pointerdown', {
    pointerType: 'pen',
    pointerId: 82,
    button: 2,
    buttons: 2,
    clientX: 600,
    clientY: 350,
    bubbles: true,
  });
  await page.screenshot({ path: join(output, 'pen-wheel-night.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '本地模型管理', exact: true }).click();
  await expect(page.getByRole('region', { name: '自动安装本地运行时' })).toBeVisible();
  await expect(page.locator('.model-card')).toHaveCount(12);
  await page.getByRole('button', { name: '关闭模型管理', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await expect(page.getByLabel('公式识别后端')).toBeHidden();
  await expect(page.locator('.formula-canvas')).toBeVisible();
  await page.getByLabel('LaTeX · 可直接修改').fill('x^2');
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await expect(page.getByLabel('公式识别后端')).toBeVisible();
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await expect(page.getByLabel('公式识别后端')).toBeHidden();
  await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('x^2');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({ path: join(output, 'compact-workspace-night.png') });
  let runtimes;
  if (process.argv.includes('--install')) {
    const root = resolve(
      process.argv
        .find((arg) => arg.startsWith('--runtime-root='))
        ?.slice('--runtime-root='.length) || '.cache/runtime-electron-validation',
    );
    runtimes = await app.evaluate(
      async ({ app, net }, { root, backend }) => {
        const require = process
          .getBuiltinModule('module')
          .createRequire(app.getAppPath() + '/package.json');
        const { createRuntimeInstaller } = require(
          app.getAppPath() + '/electron/runtime-installer.cjs',
        );
        const stages = [],
          owner = {};
        const installer = createRuntimeInstaller({
          root,
          backend,
          fetch: (...args) => net.fetch(...args),
          notify: (_owner, value) => {
            if (stages.at(-1)?.stage !== value.stage) stages.push(value);
          },
        });
        const results = [];
        try {
          for (const id of ['openvino', 'speech']) {
            const start = Date.now(),
              result = await installer.install(owner, id);
            results.push({ id, milliseconds: Date.now() - start, result });
            if (!result.ok) break;
          }
          return { results, stages, isolated: true };
        } finally {
          installer.dispose();
        }
      },
      { root, backend: join(dirname(executablePath), 'backend') },
    );
    assert.equal(runtimes.results.length, 2, JSON.stringify(runtimes));
    for (const result of runtimes.results)
      assert.equal(result.result.ok, true, JSON.stringify(result));
  }
  assert.deepEqual(errors, []);
  const result = { views, runtimes, rendererErrors: errors, realPenHardwareTested: false };
  await writeFile(join(output, 'desktop.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await app.close();
}
