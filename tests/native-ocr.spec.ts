import { test, expect } from '@playwright/test';
test('native OCR shows devices, preserves input and handles busy without starting WASM', async ({
  page,
}) => {
  await page.route('http://127.0.0.1:8766/health', (route) =>
    route.fulfill({
      json: {
        ok: true,
        engine: 'Texo OpenVINO',
        devices: [{ id: 'NPU', name: 'Intel AI Boost' }],
        capabilities: ['ocr-experimental'],
      },
    }),
  );
  let busy = false,
    calls = 0;
  await page.route('http://127.0.0.1:8766/ocr', async (route) => {
    calls++;
    expect(route.request().postDataJSON()).toMatchObject({
      device: 'AUTO',
      image: expect.stringContaining('data:image/png;base64,'),
    });
    await route.fulfill(
      busy
        ? { status: 429, json: { detail: 'busy' } }
        : {
            json: {
              text: 'competitive\n本地识别',
              confidence: 98,
              devices: { det: ['NPU'], rec: ['NPU'] },
              projectionDevice: 'CPU',
              fallback: false,
              timing: { totalMs: 80 },
            },
          },
    );
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const r = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(r.x + 20, r.y + 20);
  await page.mouse.down();
  await page.mouse.move(r.x + 200, r.y + 200, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByLabel('OCR 后端')).toHaveValue('native');
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(page.getByLabel('识别结果 · 可修改')).toHaveValue('competitive\n本地识别');
  await expect(page.locator('.ocr-task-status')).toContainText('NPU + CPU');
  busy = true;
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(page.locator('.ocr-task-status')).toContainText('已有本地推理正在运行');
  expect(calls).toBe(2);
  await page
    .getByRole('dialog', { name: '区域识别' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Experimental night mode', exact: true }).click();
  await page.setViewportSize({ width: 560, height: 900 });
  await page.getByRole('button', { name: 'Region OCR', exact: true }).click();
  const b = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(b.x + 20, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(b.x + 150, b.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.locator('.native-settings summary').click();
  await page.getByLabel('OCR inference device').selectOption('GPU');
  await expect(
    page.getByRole('option', { name: 'Local power first · PP-OCRv4 (experimental)', exact: true }),
  ).toHaveCount(1);
  await expect(page.locator('.ocr-modal')).toBeVisible();
  expect(
    await page.locator('.native-settings').evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe('rgb(36, 46, 62)');
  await page
    .getByRole('dialog', { name: 'Region recognition' })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page.reload();
  expect(await page.evaluate(() => localStorage.getItem('surfacetab.ocrDevice'))).toBe('GPU');
});
