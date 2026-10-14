import { verifyUiFeatures } from './verify-ui-features.mjs';
import { _electron as electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
const profile = await mkdtemp(join(tmpdir(), 'surfacetab-verify-'));
const executablePath = process.env.SURFACETAB_EXECUTABLE;
const app = await electron.launch({
  ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
  env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
  timeout: 60000,
});
try {
  const page = await app.firstWindow(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await page.getByRole('button', { name: '退出全屏', exact: true }).waitFor();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
    true,
  );
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await page.getByRole('button', { name: '全屏', exact: true }).waitFor();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
    false,
  );
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await page.getByRole('button', { name: '退出全屏', exact: true }).waitFor();
  await page.keyboard.press('F11');
  await page.getByRole('button', { name: '全屏', exact: true }).waitFor();
  await page.keyboard.press('F11');
  await page.getByRole('button', { name: '退出全屏', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '全屏', exact: true }).waitFor();
  for (const keyCode of ['F11', 'Escape']) {
    await app.evaluate(({ BrowserWindow }, keyCode) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode });
      wc.sendInputEvent({ type: 'keyUp', keyCode });
    }, keyCode);
    await page
      .getByRole('button', { name: keyCode === 'F11' ? '退出全屏' : '全屏', exact: true })
      .waitFor();
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
      keyCode === 'F11',
    );
  }
  console.log('Native fullscreen button / F11 / Escape: verified');
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await page.getByRole('dialog', { name: '工作空间管理' }).waitFor({ state: 'hidden' });
  await page.getByLabel('文档名称', { exact: true }).fill('桌面 workspace 验证');
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.workspace-document').length === 2);
  await page.getByRole('button', { name: '置顶 桌面 workspace 验证', exact: true }).click();
  await page.getByRole('button', { name: '关闭工作空间' }).click();
  await page.reload();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(
    await page.getByLabel('文档名称', { exact: true }).inputValue(),
    '桌面 workspace 验证',
  );
  console.log('Desktop workspace persistence / pin / reload: verified');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(768, 1024),
  );
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('The book is on the table.', { x: 50, y: 700, size: 20, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'desktop-check.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await page
    .locator('.textLayer span')
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection().addRange(range);
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    const items = await clipboard.read();
    globalThis.qaClipboard = await Promise.all(
      items.map(
        async (item) =>
          new ClipboardItem(
            Object.fromEntries(
              await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
            ),
          ),
      ),
    );
  });
  await page.getByRole('button', { name: '复制选区', exact: true }).click();
  await page.locator('.copy-done').waitFor();
  assert.equal(
    await app.evaluate(
      async ({ clipboard }) => (await clipboard.readText()) === 'The book is on the table.',
    ),
    true,
  );
  console.log('Windows clipboard: verified');
  assert.equal(await page.locator('.selection-actions a').count(), 0);
  assert.equal(await page.evaluate(() => 'openEtymology' in window.surfaceDesktop), false);
  await page
    .getByRole('dialog', { name: '划词工具' })
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await page
    .locator('.translation-footer')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector('.translation-status')?.textContent.includes('本地 OPUS'),
    null,
    { timeout: 30000 },
  );
  console.log(
    'Desktop offline translation:',
    await page.locator('.translation-result').textContent(),
    await page.locator('.translation-status').textContent(),
  );
  await page.getByRole('button', { name: '朗读选区', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.translation-status')?.textContent.includes('Piper · CPU'),
    null,
    { timeout: 30000 },
  );
  console.log('Desktop local Piper:', await page.locator('.translation-status').textContent());
  await page.screenshot({ path: 'test-results/desktop-offline-translation.png' });
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const paper = await page.locator('.paper').boundingBox();
  await page.mouse.move(paper.x + paper.width * 0.05, paper.y + paper.height * 0.14);
  await page.mouse.down();
  await page.mouse.move(paper.x + paper.width * 0.95, paper.y + paper.height * 0.23, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('button', { name: '识别文字（OCR）', exact: true }).click();
  // This check verifies the bundled WASM path. Select it explicitly rather than
  // relying on the current default (native PP-OCR can require cold setup).
  await page.getByLabel('OCR 后端').selectOption('local');
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('#ocr-result')?.value.includes('book'),
    null,
    { timeout: 30000 },
  );
  console.log('Desktop local OCR:', await page.locator('#ocr-result').inputValue());
  await page
    .getByRole('dialog', { name: '区域识别' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  const r = await page.locator('.formula-canvas').boundingBox();
  for (const [start, end] of [
    [0.45, 0.55],
    [0.55, 0.45],
  ]) {
    await page.mouse.move(r.x + r.width * start, r.y + r.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width * end, r.y + r.height * 0.65, { steps: 12 });
    await page.mouse.up();
  }
  await page.getByLabel('公式识别后端').selectOption('texo-gpu');
  await page.getByRole('button', { name: '识别并覆盖', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.formula-status')?.textContent.includes('秒') ||
      document.querySelector('.formula-status')?.textContent.includes('无法完成'),
    null,
    { timeout: 180000 },
  );
  const status = await page.locator('.formula-status').textContent();
  assert.ok(status.includes('秒'), status);
  console.log('Desktop Texo:', status);
  await page
    .getByRole('dialog', { name: '手写公式' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.getByRole('button', { name: '草图', exact: true }).click();
  await page.getByRole('radio', { name: '矩形', exact: true }).locator('..').click();
  const sketch = await page.locator('.excalidraw canvas').last().boundingBox();
  await page.mouse.move(sketch.x + sketch.width * 0.35, sketch.y + sketch.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(sketch.x + sketch.width * 0.65, sketch.y + sketch.height * 0.5, {
    steps: 8,
  });
  await page.mouse.up();
  await page
    .getByRole('dialog', { name: 'Excalidraw 草图' })
    .getByRole('button', { name: '插入当前页', exact: true })
    .click();
  await page.waitForFunction(() => document.querySelector('.placed-object img')?.naturalWidth > 0);
  assert.ok(
    (await page.locator('.placed-object img').getAttribute('src')).startsWith('data:image/svg+xml'),
  );
  console.log('Desktop packaged Excalidraw / SVG insertion: verified');
  await verifyUiFeatures(page);
  assert.deepEqual(errors, []);
  console.log('Desktop errors: none');
} finally {
  try {
    await app.evaluate(async ({ clipboard }) => {
      if (globalThis.qaClipboard) {
        await clipboard.write(globalThis.qaClipboard);
        delete globalThis.qaClipboard;
      }
    });
  } finally {
    await app.close();
  }
}
