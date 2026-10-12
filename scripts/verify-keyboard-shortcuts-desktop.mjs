// Real Electron clipboard commands, isolated app profile, no account or inference.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
const profile = await mkdtemp(join(tmpdir(), 'tixtab-shortcuts-'));
const app = await electron.launch({
  executablePath: resolve(process.argv[2]),
  args: [],
  env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
  timeout: 60000,
});
const errors = [];
try {
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    // Materialize lazy clipboard data before later writes change its source.
    globalThis.shortcutClipboard = await Promise.all(
      (await clipboard.read()).map(
        async (item) =>
          new ClipboardItem(
            Object.fromEntries(
              await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
            ),
          ),
      ),
    );
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.surfaceDesktop.editCommand('delete')), false);
  await page.getByRole('button', { name: '公式', exact: true }).click();
  const field = page.getByLabel('LaTeX · 可直接修改');
  await field.fill('alpha beta');
  await field.evaluate((el) => el.setSelectionRange(6, 10));
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  const shortcut = async (label, target = page) => {
    await target.locator('[data-skbtn="{ctrl}"]').click();
    await target.locator(`[data-skbtn="${label.match(/Ctrl\+([A-Z])/)[1].toLowerCase()}"]`).click();
  };
  await shortcut('复制 (Ctrl+C)');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('beta');
  await shortcut('剪切 (Ctrl+X)');
  await expect(field).toHaveValue('alpha ');
  await shortcut('撤销 (Ctrl+Z)');
  await expect(field).toHaveValue('alpha beta');
  await shortcut('重做 (Ctrl+Y)');
  await expect(field).toHaveValue('alpha ');
  await shortcut('粘贴 (Ctrl+V)');
  await expect(field).toHaveValue('alpha beta');
  await shortcut('全选 (Ctrl+A)');
  assert.deepEqual(await field.evaluate((el) => [el.selectionStart, el.selectionEnd]), [0, 10]);
  await page.getByRole('button', { name: '关闭屏幕键盘', exact: true }).click();
  await page
    .getByRole('dialog', { name: '手写公式', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('competitive', { x: 230, y: 440, size: 24, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'Shortcuts.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '选文', exact: true }).click();
  const box = await page.locator('.textLayer span').first().boundingBox();
  await page.mouse.dblclick(box.x + 12, box.y + box.height / 2);
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await shortcut('复制 (Ctrl+C)');
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('competitive');
  await shortcut('粘贴 (Ctrl+V)');
  await expect(page.locator('[data-object-id]')).toHaveCount(1);
  await shortcut('复制 (Ctrl+C)');
  await expect
    .poll(() =>
      app.evaluate(async ({ clipboard }) => {
        const item = (await clipboard.read()).find((item) => item.types.includes('text/html'));
        return item ? (await item.getType('text/html')).text() : '';
      }),
    )
    .toContain('data-tixtab-objects');
  await shortcut('粘贴 (Ctrl+V)');
  await expect(page.locator('[data-object-id]')).toHaveCount(2);
  await shortcut('剪切 (Ctrl+X)');
  await expect(page.locator('[data-object-id]')).toHaveCount(1);
  await shortcut('粘贴 (Ctrl+V)');
  await expect(page.locator('[data-object-id]')).toHaveCount(2);
  await shortcut('撤销 (Ctrl+Z)');
  await expect(page.locator('[data-object-id]')).toHaveCount(1);
  await shortcut('重做 (Ctrl+Y)');
  await expect(page.locator('[data-object-id]')).toHaveCount(2);
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 20;
    c.getContext('2d').fillRect(0, 0, 20, 20);
    return c.toDataURL();
  });
  await app.evaluate(async ({ clipboard, ClipboardItem }, data) => {
    const buffer = Buffer.from(data.split(',')[1], 'base64');
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([buffer], { type: 'image/png' }) }),
    ]);
  }, png);
  await shortcut('粘贴 (Ctrl+V)');
  await expect(page.locator('[data-object-id]')).toHaveCount(3);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.screenshot({ path: '.cache/keyboard-shortcuts-desktop.png' });
  await page.getByRole('button', { name: '关闭屏幕键盘', exact: true }).click();
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  const childOpened = app.waitForEvent('window');
  await page.getByRole('button', { name: '在独立悬浮窗中打开', exact: true }).click();
  const child = await childOpened;
  child.on('pageerror', (e) => errors.push(e.message));
  const prompt = child.getByLabel('向 ChatGPT 提问');
  await prompt.fill('floating chat');
  await child.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await shortcut('全选 (Ctrl+A)', child);
  await shortcut('剪切 (Ctrl+X)', child);
  await expect(prompt).toHaveValue('');
  await shortcut('粘贴 (Ctrl+V)', child);
  await expect(prompt).toHaveValue('floating chat');
  assert.deepEqual(errors, []);
  console.log(
    'Actual packaged shortcuts: select all / cut / copy / paste / undo / redo in React fields, PDF selection copy, rich object clipboard cut/copy/paste, PDF history, PNG paste, independent chat window and rejected unknown IPC command passed. Renderer errors: none.',
  );
} finally {
  await app
    .evaluate(async ({ clipboard }) => {
      if (globalThis.shortcutClipboard) await clipboard.write(globalThis.shortcutClipboard);
    })
    .catch(() => {});
  await app.close();
}
