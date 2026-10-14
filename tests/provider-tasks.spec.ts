import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
async function draw(page: Page) {
  const r = (await page.locator('.formula-canvas').boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.3, r.y + r.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.7, r.y + r.height * 0.6, { steps: 5 });
  await page.mouse.up();
}

test('task panel cancels queued work without sending it, shows actual route, and stays private in portrait night', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let formulaRequests = 0,
    ocrRequests = 0;
  await page.route('http://127.0.0.1:8766/**', async (route) => {
    if (route.request().url().endsWith('/health')) {
      await route.fulfill({
        json: {
          engine: 'Texo OpenVINO',
          devices: [{ id: 'NPU', name: 'NPU' }],
          capabilities: ['ocr-experimental'],
        },
      });
      return;
    }
    if (route.request().url().endsWith('/ocr')) ocrRequests++;
    else {
      formulaRequests++;
      await gate;
    }
    await route
      .fulfill({
        json: {
          latex: 'x',
          encoderDevice: 'NPU',
          decoderDevice: 'CPU',
          fallback: false,
          timing: { totalMs: 24 },
        },
      })
      .catch(() => {});
  });
  try {
    await page.goto('/');
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    await page.getByRole('button', { name: '公式', exact: true }).click();
    await draw(page);
    await page.getByRole('button', { name: '识别并覆盖', exact: true }).click();
    await expect.poll(() => formulaRequests).toBe(1);
    await page.evaluate(async () => {
      const loaded = performance
        .getEntriesByType('resource')
        .find((r) => new URL(r.name).pathname === '/src/providers.ts')?.name;
      const { executeProvider } = await import(loaded ?? '/src/providers.ts'),
        { defaultProfile } = await import('/src/providerSettings.ts' as string);
      void executeProvider({
        feature: 'ocr',
        config: { ...defaultProfile('ocr', 'native'), type: 'native' },
        input: 'private-image-that-must-not-be-recorded',
      }).catch(() => {});
    });
    await page.getByRole('button', { name: '任务与后端', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '任务与后端', exact: true });
    await expect(panel.locator('.task-card[data-phase=queued]')).toContainText('文字 OCR');
    await panel.getByRole('button', { name: '取消任务 文字 OCR', exact: true }).click();
    await expect(panel.locator('.task-card[data-phase=cancelled]')).toContainText('文字 OCR');
    expect(ocrRequests).toBe(0);
    release();
    await expect(panel.locator('.task-card[data-phase=completed]')).toContainText('NPU + CPU');
    await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('x');
    await expect(panel).not.toContainText('private-image-that-must-not-be-recorded');
    await page.setViewportSize({ width: 560, height: 900 });
    const bounds = (await panel.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(560);
    expect(
      await panel.evaluate((root) =>
        [root, ...root.querySelectorAll('*')]
          .filter((el) => {
            const s = getComputedStyle(el),
              r = el.getBoundingClientRect(),
              rgb = s.backgroundColor.match(/[\d.]+/g)?.map(Number);
            return (
              r.width > 6 &&
              r.height > 6 &&
              rgb &&
              rgb.slice(0, 3).every((v) => v > 170) &&
              (rgb.length < 4 || rgb[3] > 0.3)
            );
          })
          .map((el) => el.className),
      ),
    ).toEqual([]);
    expect(
      await panel
        .locator('button')
        .evaluateAll((buttons) => buttons.every((b) => b.getBoundingClientRect().height >= 44)),
    ).toBe(true);
    await page.screenshot({ path: 'test-results/tasks-night-portrait.png' });
    await panel.getByRole('button', { name: '清除已结束任务', exact: true }).click();
    await expect(panel.locator('.task-card')).toHaveCount(0);
    await panel.getByRole('button', { name: '关闭任务面板' }).click();
    await page
      .getByRole('dialog', { name: '手写公式' })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('界面语言 / Interface language').selectOption('en');
    await page.getByRole('button', { name: 'Tasks and backends', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Tasks and backends' })).toBeVisible();
    await page.getByText('Available backends and capabilities', { exact: true }).click();
    await expect(page.locator('.task-capabilities')).toContainText('Image input');
  } finally {
    release();
  }
});

test('cancelling active formula through task panel restores its controls and blocks late results', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let started = 0,
    models = 0;
  page.on('request', (r) => {
    if (/\/models\/.+\.onnx/.test(r.url())) models++;
  });
  await page.route('http://127.0.0.1:8766/**', async (route) => {
    if (route.request().url().endsWith('/health'))
      await route.fulfill({ json: { engine: 'Texo OpenVINO', devices: [] } });
    else {
      started++;
      await gate;
      await route
        .fulfill({ json: { latex: 'late', encoderDevice: 'NPU', timing: { totalMs: 4 } } })
        .catch(() => {});
    }
  });
  try {
    await page.goto('/');
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await page.getByRole('button', { name: '公式', exact: true }).click();
    await draw(page);
    await page.getByRole('button', { name: '识别并覆盖', exact: true }).click();
    await expect.poll(() => started).toBe(1);
    await page.getByRole('button', { name: '任务与后端', exact: true }).click();
    await page.getByRole('button', { name: '取消任务 公式识别', exact: true }).click();
    await expect(page.locator('.task-card')).toHaveAttribute('data-phase', 'cancelled');
    await page.getByRole('button', { name: '关闭任务面板' }).click();
    await expect(page.getByRole('button', { name: '识别并覆盖', exact: true })).toBeEnabled();
    await expect(page.locator('.formula-status')).toHaveText('已取消');
    release();
    await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('');
    expect(models).toBe(0);
  } finally {
    release();
  }
});

test('real OCR initialization cancellation terminates its worker, then succeeds and releases on model switch', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const image = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 160;
    const x = c.getContext('2d')!;
    x.fillStyle = 'white';
    x.fillRect(0, 0, 800, 160);
    x.fillStyle = 'black';
    x.font = '46px Arial';
    x.fillText('TixTab 12345', 25, 100);
    return c.toDataURL();
  });
  const doc = await PDFDocument.create(),
    pdfPage = doc.addPage([595, 842]),
    png = await doc.embedPng(image);
  pdfPage.drawImage(png, { x: 40, y: 600, width: 500, height: 100 });
  await page.locator('input[type=file]').setInputFiles({
    name: 'tasks-ocr.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const r = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.06, r.y + r.height * 0.16);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.93, r.y + r.height * 0.3, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('button', { name: '识别文字（OCR）', exact: true }).click();
  await page.getByLabel('OCR 后端').selectOption('local');
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let hold = true,
    languageRequests = 0;
  await page.route('**/models/ocr/*.traineddata', async (route) => {
    languageRequests++;
    if (hold) await gate;
    await route.continue().catch(() => {});
  });
  try {
    await page.getByRole('button', { name: '开始识别', exact: true }).click();
    await expect.poll(() => languageRequests, { timeout: 30000 }).toBeGreaterThan(0);
    await page.getByRole('button', { name: '任务与后端', exact: true }).click();
    await page.setViewportSize({ width: 560, height: 900 });
    const panel = page.getByRole('dialog', { name: '任务与后端', exact: true });
    const rect = (await panel.boundingBox())!;
    expect(rect.width).toBeGreaterThan(480);
    await panel.getByRole('button', { name: '取消任务 文字 OCR', exact: true }).click();
    await expect(panel.locator('.task-card')).toHaveAttribute('data-phase', 'cancelled');
    await expect
      .poll(() => page.workers().filter((w) => w.url().includes('/ocr/worker.min.js')).length)
      .toBe(0);
    hold = false;
    release();
    await panel.getByRole('button', { name: '关闭任务面板' }).click();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('button', { name: '开始识别', exact: true }).click();
    await expect(page.getByLabel('识别结果 · 可修改')).toHaveValue(/TixTab 12345/, {
      timeout: 30000,
    });
    expect(page.workers().filter((w) => w.url().includes('/ocr/worker.min.js'))).toHaveLength(1);
    await page.getByRole('button', { name: '任务与后端', exact: true }).click();
    await expect(page.locator('.task-card[data-phase=completed]')).toContainText('tesseract');
    await expect(page.getByRole('dialog', { name: '任务与后端' })).not.toContainText(
      'TixTab 12345',
    );
    await page.route('http://127.0.0.1:8766/models/release', (route) =>
      route.fulfill({ status: 404, json: { detail: 'older service' } }),
    );
    await panel.getByRole('button', { name: '释放闲置模型内存', exact: true }).click();
    await expect(panel).toContainText('旧原生服务仍按闲置策略释放');
    await expect
      .poll(() => page.workers().filter((w) => w.url().includes('/ocr/worker.min.js')).length)
      .toBe(0);
    await expect(page.getByLabel('识别结果 · 可修改')).toHaveValue(/TixTab 12345/);
    await panel.getByRole('button', { name: '关闭任务面板' }).click();
    await page.getByRole('button', { name: '开始识别', exact: true }).click();
    await expect(page.locator('.ocr-task-status')).toContainText('请检查结果', { timeout: 30000 });
    expect(page.workers().filter((w) => w.url().includes('/ocr/worker.min.js'))).toHaveLength(1);
    await page.getByRole('button', { name: '任务与后端', exact: true }).click();
    await page.evaluate(async () => {
      const loaded = performance
        .getEntriesByType('resource')
        .find((r) => new URL(r.name).pathname === '/src/providers.ts')?.name;
      const { executeProvider } = await import(loaded ?? '/src/providers.ts'),
        { defaultProfile } = await import('/src/providerSettings.ts' as string);
      const r = await executeProvider({
        feature: 'translation',
        config: { ...defaultProfile('translation', 'local'), type: 'local' },
        input: '中文',
        target: 'zh-CN',
      });
      if (r.modelId !== 'none') throw new Error('No inference expected');
    });
    // No-op translation should retain the warm OCR model rather than causing
    // unnecessary reloads. Explicit memory release still closes its worker.
    expect(page.workers().filter((w) => w.url().includes('/ocr/worker.min.js'))).toHaveLength(1);
    await panel.getByRole('button', { name: '释放闲置模型内存', exact: true }).click();
    await expect
      .poll(() => page.workers().filter((w) => w.url().includes('/ocr/worker.min.js')).length)
      .toBe(0);
  } finally {
    hold = false;
    release();
  }
});

test('manual memory release waits for native work and closing its panel cancels only the queued release', async ({
  page,
}) => {
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let inference = 0,
    releases = 0;
  await page.route('http://127.0.0.1:8766/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/health')) {
      await route.fulfill({
        json: { engine: 'Texo OpenVINO', devices: [], capabilities: ['release-idle'] },
      });
      return;
    }
    if (url.endsWith('/models/release')) {
      releases++;
      expect(route.request().postDataJSON()).toEqual({ action: 'release-idle' });
      await route.fulfill({
        json: { ok: true, engine: 'SurfaceTab model lifecycle', loaded: false, released: true },
      });
      return;
    }
    inference++;
    await gate;
    await route
      .fulfill({
        json: { latex: 'x', encoderDevice: 'NPU', timing: { totalMs: 24 }, fallback: false },
      })
      .catch(() => {});
  });
  try {
    await page.goto('/');
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await page.getByRole('button', { name: '公式', exact: true }).click();
    await draw(page);
    await page.getByRole('button', { name: '识别并覆盖', exact: true }).click();
    await expect.poll(() => inference).toBe(1);
    await page.getByRole('button', { name: '任务与后端', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '任务与后端', exact: true });
    await panel.getByRole('button', { name: '释放闲置模型内存', exact: true }).click();
    await expect(panel).toContainText('等待本地任务完成后');
    expect(releases).toBe(0);
    await panel.getByRole('button', { name: '关闭任务面板' }).click();
    complete();
    await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('x');
    expect(releases).toBe(0);
    await page.getByRole('button', { name: '任务与后端', exact: true }).click();
    await panel.getByRole('button', { name: '释放闲置模型内存', exact: true }).click();
    await expect(panel).toContainText('闲置模型已释放，再次使用时按需加载。');
    expect(releases).toBe(1);
    await expect(panel.locator('.task-card[data-phase=completed]')).toContainText('NPU + CPU');
  } finally {
    complete();
  }
});

test('a supported native session is released before WASM; busy release starts no OCR worker', async ({
  page,
}) => {
  let busy = true,
    releases = 0;
  await page.route('http://127.0.0.1:8766/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/health')) {
      await route.fulfill({
        json: { engine: 'Texo OpenVINO', devices: [], capabilities: ['release-idle'] },
      });
      return;
    }
    if (url.endsWith('/models/release')) {
      releases++;
      await route.fulfill(
        busy
          ? { status: 429, json: { detail: 'busy' } }
          : {
              json: {
                ok: true,
                engine: 'SurfaceTab model lifecycle',
                loaded: false,
                released: true,
              },
            },
      );
      return;
    }
    await route.fulfill({
      json: { latex: 'x', encoderDevice: 'NPU', timing: { totalMs: 24 }, fallback: false },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await draw(page);
  await page.getByRole('button', { name: '识别并覆盖', exact: true }).click();
  await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('x');
  await page
    .getByRole('dialog', { name: '手写公式' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const r = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(r.x + 20, r.y + 20);
  await page.mouse.down();
  await page.mouse.move(r.x + 200, r.y + 160, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('button', { name: '识别文字（OCR）', exact: true }).click();
  await page.getByLabel('OCR 后端').selectOption('local');
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(page.locator('.ocr-task-status')).toContainText('已有本地推理正在运行');
  expect(releases).toBe(1);
  expect(page.workers().filter((w) => w.url().includes('/ocr/worker.min.js'))).toHaveLength(0);
  busy = false;
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(page.locator('.ocr-task-status')).toContainText('请检查结果', { timeout: 30000 });
  expect(releases).toBe(2);
  expect(page.workers().filter((w) => w.url().includes('/ocr/worker.min.js'))).toHaveLength(1);
});
