import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
async function key(page: Page, value: string) {
  await page.locator(`.hg-button[data-skbtn="${value}"]`).click();
}
async function letters(page: Page, value: string) {
  for (const letter of value) await key(page, letter);
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
});

test('offline Pinyin, English, caret insertion, separators, partial candidates and lifecycle', async ({
  page,
}) => {
  const outbound: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:5173/') && !request.url().startsWith('data:'))
      outbound.push(request.url());
  });
  await page.getByRole('button', { name: '公式', exact: true }).click();
  const field = page.getByLabel('LaTeX · 可直接修改');
  await field.fill('abc');
  await field.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(1, 2));
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await page.getByRole('button', { name: '英文', exact: true }).click();
  await key(page, '{shift}');
  await key(page, 'H');
  await expect(field).toHaveValue('aHc');
  for (const width of [900, 480, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.locator('.surfacetab-keys').evaluate((el) => {
        const q = el.querySelector('[data-skbtn="Q"]')!.getBoundingClientRect(),
          a = el.querySelector('[data-skbtn="A"]')!.getBoundingClientRect();
        return a.left > q.left && el.scrollWidth <= el.clientWidth;
      }),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await key(page, '{bksp}');
  await expect(field).toHaveValue('ac');
  await key(page, '|');
  await expect(field).toHaveValue('a|c');
  await field.fill('');
  await page.getByRole('button', { name: '中文拼音', exact: true }).click();
  await letters(page, 'nihao');
  await key(page, '{space}');
  await expect(field).toHaveValue('你好');
  await letters(page, "xi'an");
  await expect(page.locator('.keyboard-candidates>div')).toContainText('西安');
  await page.locator('.keyboard-candidates>div>button').filter({ hasText: '西安' }).first().click();
  await expect(field).toHaveValue('你好西安');
  await key(page, '.');
  await expect(field).toHaveValue('你好西安。');
  await letters(page, 'nihaozhongguo');
  await page
    .locator('.keyboard-candidates>div>button')
    .filter({ hasText: /^\d你好$/ })
    .click();
  await expect(page.getByLabel('待转换拼音')).toHaveText('zhongguo');
  await key(page, '{space}');
  await expect(field).toHaveValue('你好西安。你好中国');
  await letters(page, 'gongshi');
  await page.getByRole('button', { name: '清空拼音', exact: true }).click();
  await expect(field).toHaveValue('你好西安。你好中国');
  await letters(page, 'tex');
  await key(page, '{enter}');
  await expect(field).toHaveValue('你好西安。你好中国tex');
  await page.getByRole('button', { name: '英文', exact: true }).click();
  await expect.poll(() => page.workers().filter((w) => w.url().includes('pinyin')).length).toBe(0);
  await expect(page.locator('.latex-shortcuts')).toHaveCount(0);
  await page.getByRole('button', { name: 'LaTeX', exact: true }).click();
  await expect(page.locator('.latex-shortcuts')).toBeVisible();
  await expect(page.getByLabel('键盘大小')).toHaveCount(0);
  expect(outbound).toEqual([]);
});

test('keyboard toggle stays clear of chat Send at desktop, portrait and narrow widths', async ({
  page,
}) => {
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await expect(page.locator('.chat-panel')).toBeVisible();
  for (const width of [1440, 800, 560, 380, 320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const k = document.querySelector('.keyboard-toggle')!.getBoundingClientRect(),
            c = document.querySelector('.chat-panel')!.getBoundingClientRect();
          const send = document.querySelector('.chat-send-row>button')!.getBoundingClientRect();
          return (
            k.left >= 0 &&
            k.right <= innerWidth &&
            k.bottom <= innerHeight &&
            !(
              k.left < send.right &&
              k.right > send.left &&
              k.top < send.bottom &&
              k.bottom > send.top
            ) &&
            (c.left < 60
              ? !!document.querySelector('.chat-keyboard-slot>.keyboard-toggle')
              : k.right <= c.left)
          );
        }),
      )
      .toBe(true);
  }
  await page.setViewportSize({ width: 380, height: 900 });
  await page.getByLabel('向 ChatGPT 提问').fill('');
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await page.getByRole('button', { name: '中文拼音', exact: true }).click();
  await letters(page, 'nihao');
  await key(page, '{space}');
  await expect(page.getByLabel('向 ChatGPT 提问')).toHaveValue('你好');
  await page.screenshot({ path: 'test-results/keyboard-pinyin-chat-day.png' });
  await page.getByRole('button', { name: '关闭屏幕键盘', exact: true }).click();
  await page.getByRole('button', { name: '收起聊天', exact: true }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByLabel('向 ChatGPT 提问').focus();
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await letters(page, 'gongshi');
  await expect(page.locator('.keyboard-candidates>div')).toContainText('公式');
  await expect(page.locator('.touch-keyboard')).toBeInViewport();
  await page.screenshot({ path: 'test-results/keyboard-pinyin-chat-night.png' });
});

test('clarity setting increases actual raster density at low zoom in all page layouts and persists', async ({
  page,
}) => {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++)
    doc
      .addPage([595, 842])
      .drawText('Small PDF text at low zoom 12345', { x: 40, y: 700, size: 12, font });
  await page.locator('input[type=file][accept=".pdf,.surfacetab"]').setInputFiles({
    name: 'clarity.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: '缩小', exact: true }).click();
  const setQuality = async (value: string) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('PDF 渲染清晰度').selectOption(value);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
  };
  for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    const canvas = page.locator(mode === '单页标注' ? '.pdf-layer' : '.reading-pdf').first();
    await setQuality('standard');
    await expect.poll(() => canvas.evaluate((el: any) => el.width)).toBeGreaterThan(10);
    await page.waitForTimeout(500);
    const standard = await canvas.evaluate((el: any) => el.width);
    await setQuality('high');
    await expect.poll(() => canvas.evaluate((el: any) => el.width)).toBeGreaterThan(standard);
    const high = await canvas.evaluate((el: any) => el.width);
    await setQuality('ultra');
    await expect.poll(() => canvas.evaluate((el: any) => el.width)).toBeGreaterThan(high);
  }
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('PDF 渲染清晰度')).toHaveValue('ultra');
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await expect(page.getByLabel('PDF rendering clarity')).toHaveValue('ultra');
});
