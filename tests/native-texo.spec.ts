import { test, expect, type Page } from '@playwright/test';
async function drawX(page: Page) {
  const r = (await page.locator('.formula-canvas').boundingBox())!;
  for (const [start, end] of [
    [0.4, 0.6],
    [0.6, 0.4],
  ]) {
    await page.mouse.move(r.x + r.width * start, r.y + r.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width * end, r.y + r.height * 0.65, { steps: 8 });
    await page.mouse.up();
  }
}
test('formula defaults to NPU-first, remembers device and reports the actual native route', async ({
  page,
}) => {
  const requests: object[] = [];
  await page.route('http://127.0.0.1:8766/**', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'content-type',
        },
      });
      return;
    }
    if (route.request().url().endsWith('/health')) {
      await route.fulfill({
        json: { engine: 'Texo OpenVINO', devices: [{ id: 'NPU', name: 'Intel AI Boost' }] },
      });
      return;
    }
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        latex: 'x',
        encoderDevice: 'NPU',
        decoderDevice: 'CPU',
        fallback: false,
        timing: { totalMs: 24 },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await expect(page.getByLabel('公式识别后端')).toHaveValue('texo-native');
  await page.locator('.native-texo-settings summary').click();
  await expect(page.getByLabel('推理设备')).toHaveValue('AUTO');
  await page.getByRole('button', { name: '连接本地加速', exact: true }).click();
  await expect(page.locator('.native-texo-settings [role=status]')).toHaveText('NPU');
  await drawX(page);
  await page.getByRole('button', { name: '识别手写公式', exact: true }).click();
  await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('x');
  await expect(page.locator('.formula-status')).toContainText('NPU + CPU');
  expect(requests[0]).toMatchObject({ device: 'AUTO' });
  await page.getByLabel('推理设备').selectOption('CPU');
  await page.reload();
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await page.locator('.native-texo-settings summary').click();
  await expect(page.getByLabel('推理设备')).toHaveValue('CPU');
});
test('closing formula aborts an in-flight native request without starting a browser model', async ({
  page,
}) => {
  let started = false,
    modelLoads = 0;
  await page.route('**/models/texo/**', (route) => {
    modelLoads++;
    return route.abort();
  });
  await page.route('http://127.0.0.1:8766/**', async (route) => {
    if (route.request().url().endsWith('/health'))
      await route.fulfill({ json: { engine: 'Texo OpenVINO', devices: [] } });
    else {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route
        .fulfill({ json: { latex: 'late', encoderDevice: 'NPU', timing: { totalMs: 1000 } } })
        .catch(() => {});
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await drawX(page);
  await page.getByRole('button', { name: '识别手写公式', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await page
    .getByRole('dialog', { name: '手写公式' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.waitForTimeout(1500);
  expect(modelLoads).toBe(0);
  await expect(page.getByRole('dialog', { name: '手写公式' })).toHaveCount(0);
});
test('Pix2Text failure keeps the NPU-first local fallback', async ({ page }) => {
  let nativeDevice = '';
  await page.route('http://127.0.0.1:8765/**', (route) => route.abort());
  await page.route('http://127.0.0.1:8766/**', async (route) => {
    if (route.request().url().endsWith('/health'))
      await route.fulfill({ json: { engine: 'Texo OpenVINO', devices: [{ id: 'NPU' }] } });
    else {
      nativeDevice = route.request().postDataJSON().device;
      await route.fulfill({
        json: { latex: 'x', encoderDevice: 'NPU', fallback: false, timing: { totalMs: 30 } },
      });
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await drawX(page);
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await page.getByLabel('公式识别后端').selectOption('pix2text');
  await page.getByRole('button', { name: '识别手写公式', exact: true }).click();
  await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('x');
  expect(nativeDevice).toBe('AUTO');
  await expect(page.locator('.formula-status')).toContainText('NPU + CPU');
});
