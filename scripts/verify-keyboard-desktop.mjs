// Isolated real packaged Electron window. No account login, network inference or microphone.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
const executablePath = resolve(process.argv[2]),
  profile = await mkdtemp(join(tmpdir(), 'surfacetab-keyboard-qa-'));
const app = await electron.launch({
  executablePath,
  args: [],
  env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
  timeout: 60000,
});
const errors = [],
  resolutions = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setMinimumSize(300, 400);
    w.setContentSize(1200, 900);
  });
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++)
    doc
      .addPage([595, 842])
      .drawText('Clarity in a real Electron window.', { x: 40, y: 700, size: 12, font });
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles({
    name: 'Clarity.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: '缩小', exact: true }).click();
  const quality = async (value) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('PDF 渲染清晰度').selectOption(value);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
  };
  for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    const canvas = page.locator(mode === '单页标注' ? '.pdf-layer' : '.reading-pdf').first();
    await quality('standard');
    await expect.poll(() => canvas.evaluate((el) => el.width)).toBeGreaterThan(10);
    await page.waitForTimeout(600);
    const standard = await canvas.evaluate((el) => el.width);
    await quality('high');
    await expect.poll(() => canvas.evaluate((el) => el.width)).toBeGreaterThan(standard);
    const high = await canvas.evaluate((el) => el.width);
    await quality('ultra');
    await expect.poll(() => canvas.evaluate((el) => el.width)).toBeGreaterThan(high);
    resolutions.push({ mode, standard, high, ultra: await canvas.evaluate((el) => el.width) });
  }
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await expect(page.locator('.chat-panel')).toBeVisible();
  const rects = () =>
    page.evaluate(() => {
      const k = document.querySelector('.keyboard-toggle').getBoundingClientRect(),
        c = document.querySelector('.chat-panel').getBoundingClientRect();
      return { k: { x: k.x, right: k.right }, c: { x: c.x } };
    });
  await expect
    .poll(async () => {
      const r = await rects();
      return r.k.right <= r.c.x;
    })
    .toBe(true);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(380, 900),
  );
  await expect(page.locator('.chat-keyboard-slot>.keyboard-toggle')).toBeVisible();
  const field = page.getByLabel('向 ChatGPT 提问');
  await field.fill('');
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await page.getByRole('button', { name: '中文拼音', exact: true }).click();
  const key = async (value) => page.locator(`.hg-button[data-skbtn="${value}"]`).click();
  for (const letter of 'nihao') await key(letter);
  await key('{space}');
  await expect(field).toHaveValue('你好');
  await page.getByRole('button', { name: '英文', exact: true }).click();
  await key('{space}');
  await key('{shift}');
  await key('H');
  await expect(field).toHaveValue('你好 H');
  await page.getByRole('button', { name: '关闭屏幕键盘', exact: true }).click();
  await page.getByRole('button', { name: '收起聊天', exact: true }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await field.focus();
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await page.getByRole('button', { name: '中文拼音', exact: true }).click();
  for (const letter of 'gongshi') await key(letter);
  await expect(page.locator('.keyboard-candidates>div')).toContainText('公式');
  await page.screenshot({
    path:
      '.cache/keyboard-desktop-' +
      (executablePath.includes('lite') ? 'lite' : 'full') +
      '-0234.png',
  });
  assert.deepEqual(errors, []);
  await writeFile(
    '.cache/keyboard-resolutions-' +
      (executablePath.includes('lite') ? 'lite' : 'full') +
      '-0234.json',
    JSON.stringify(resolutions, null, 2),
  );
  console.log(
    'Actual packaged keyboard/clarity: offline Pinyin worker, English, caret, chat avoidance, portrait/night, three clarity levels in all layouts passed. Renderer errors: none.',
  );
  console.log(JSON.stringify(resolutions));
} finally {
  await app.close();
}
