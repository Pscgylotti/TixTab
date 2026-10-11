import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
async function selectText(page: Page) {
  await page.getByRole('button', { name: /^(选文|Select text)$/ }).click();
  await page
    .locator('.textLayer span')
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
  await page.locator('.selection-actions button').nth(1).click();
  await page.locator('.translation-heading button').click();
}
async function prepare(page: Page) {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('The book is on the table.', { x: 60, y: 700, size: 24, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'native-opus.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.locator('.textLayer')).toHaveCount(0);
  await selectText(page);
}
test('native translation is opt-in, reports device, persists settings and fits English night portrait', async ({
  page,
}) => {
  const requests: object[] = [];
  await page.route('http://127.0.0.1:8766/**', async (route) => {
    if (route.request().url().endsWith('/health'))
      await route.fulfill({
        json: { engine: 'Texo OpenVINO', devices: [], capabilities: ['translate-experimental'] },
      });
    else {
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          translation: '书在桌上。',
          encoderDevice: 'NPU',
          encoderDevices: ['NPU'],
          decoderDevice: 'CPU',
          timing: { totalMs: 34 },
        },
      });
    }
  });
  await prepare(page);
  await expect(page.getByLabel('翻译后端类型')).toHaveValue('local');
  await page.getByLabel('翻译后端类型').selectOption('local-native');
  await expect(page.getByLabel('翻译计算设备')).toHaveValue('AUTO');
  await expect(page.getByLabel('翻译接口地址')).toHaveCount(0);
  await expect(page.getByLabel('翻译 API Key')).toHaveCount(0);
  await page.locator('.translation-footer .primary').click();
  await expect(page.locator('.translation-status')).toContainText('NPU + CPU');
  expect(requests).toEqual([
    {
      text: 'The book is on the table.',
      direction: 'en-zh',
      device: 'AUTO',
      idleReleaseSeconds: 1800,
    },
  ]);
  await page.getByLabel('翻译计算设备').selectOption('GPU');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await selectText(page);
  await expect(page.getByLabel('翻译后端类型')).toHaveValue('local-native');
  await expect(page.getByLabel('翻译计算设备')).toHaveValue('GPU');
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 560, height: 900 });
  await selectText(page);
  await expect(page.getByLabel('Translation device')).toHaveValue('GPU');
  await expect(
    page.getByRole('option', {
      name: 'Local experiment · OPUS OpenVINO (NPU/GPU/CPU)',
      exact: true,
    }),
  ).toHaveCount(1);
  const rect = (await page.locator('.selection-flyout').boundingBox())!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(560);
});
test('closing a native translation cancels without loading a duplicate WASM model', async ({
  page,
}) => {
  let started = false,
    modelLoads = 0;
  await page.route('**/models/opus-*/**', (route) => {
    modelLoads++;
    return route.abort();
  });
  await page.route('http://127.0.0.1:8766/**', async (route) => {
    if (route.request().url().endsWith('/health'))
      await route.fulfill({
        json: { engine: 'Texo OpenVINO', devices: [], capabilities: ['translate-experimental'] },
      });
    else {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({ json: { translation: 'late' } }).catch(() => {});
    }
  });
  await prepare(page);
  await page.getByLabel('翻译后端类型').selectOption('local-native');
  await page.locator('.translation-footer .primary').click();
  await expect.poll(() => started).toBe(true);
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  await page.waitForTimeout(1500);
  expect(modelLoads).toBe(0);
  await expect(page.locator('.selection-flyout')).toHaveCount(0);
});
