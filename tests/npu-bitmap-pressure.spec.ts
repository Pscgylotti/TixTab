import { test, expect } from '@playwright/test';

test('NPU bitmap option uses real CPU layout, persists line OCR and terminates its worker', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Original = window.Worker;
    (window as any).ocrWorkers = 0;
    window.Worker = class extends Original {
      owned: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.owned = String(url).includes('/ocr/worker');
        if (this.owned) (window as any).ocrWorkers++;
      }
      terminate() {
        if (this.owned) {
          this.owned = false;
          (window as any).ocrWorkers--;
        }
        super.terminate();
      }
    };
  });
  await page.route('http://127.0.0.1:8766/health', (r) =>
    r.fulfill({
      json: {
        ok: true,
        engine: 'Texo OpenVINO',
        devices: [{ id: 'NPU', name: 'NPU' }],
        capabilities: ['tesseract-npu-queue-v1', 'release-idle'],
      },
    }),
  );
  let request: any;
  await page.route('http://127.0.0.1:8766/ocr-tesseract-npu', async (r) => {
    request = r.request().postDataJSON();
    const [x0, y0, x1, y1] = request.boxes[0] ?? [0, 0, 1, 1];
    await r.fulfill({
      json: {
        device: 'NPU',
        text: 'English bitmap words',
        lines: [{ text: 'English bitmap words', polygon: [x0, y0, x1, y0, x1, y1, x0, y1] }],
      },
    });
  });
  await page.goto('/');
  const data = await page.evaluate(async () => {
    const { newNotebook } = await import('/src/model.ts');
    const n = newNotebook();
    const c = document.createElement('canvas');
    c.width = 1000;
    c.height = 250;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1000, 250);
    ctx.fillStyle = '#000';
    ctx.font = '40px Arial';
    ctx.fillText('English bitmap words', 80, 100);
    n.pages[0].images = [
      { id: 'bitmap', kind: 'image', data: c.toDataURL(), x: 50, y: 50, width: 500, height: 125 },
    ];
    return JSON.stringify(n);
  });
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'npu.tixtab', mimeType: 'application/json', buffer: Buffer.from(data) });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  await page.getByRole('button', { name: '解析位图', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '解析位图' });
  await dialog.getByLabel('OCR 后端').selectOption('tesseract-npu');
  await expect(dialog.getByLabel('NPU Tesseract 模型')).toHaveValue('best');
  await dialog.getByText('设置', { exact: true }).click();
  await dialog.getByLabel('最大识别批量').selectOption('4');
  await dialog.getByRole('button', { name: '开始解析', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('解析完成：1 张位图', { timeout: 45000 });
  expect(request.boxes.length).toBeGreaterThan(0);
  expect(request).toMatchObject({ variant: 'best', batch: 4, idleReleaseSeconds: 1800 });
  await expect.poll(() => page.evaluate(() => (window as any).ocrWorkers)).toBe(0);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const fs = await import('node:fs/promises');
  const saved = JSON.parse(await fs.readFile((await (await download).path())!, 'utf8'));
  expect(saved.pages[0].images[0].ocr).toMatchObject({
    text: 'English bitmap words',
    engine: 'Tesseract best · NPU (experimental)',
  });
  expect(saved.pages[0].images[0].ocr.lines[0].polygon.every((n: number) => n >= 0 && n <= 1)).toBe(
    true,
  );
});

test('pressure editor adds, adjusts, persists and resets a curve', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('压感曲线', { exact: true }).click();
  const graph = page.getByLabel('压感曲线编辑器');
  const box = (await graph.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
  await expect(page.locator('.pressure-curve-actions')).toContainText('分割点 1 / 16');
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('tixtab.pressureCurve')!),
  );
  expect(stored).toHaveLength(3);
  expect(stored[1][1]).toBeGreaterThan(stored[1][0]);
  await page.getByRole('button', { name: '恢复线性压感' }).click();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('tixtab.pressureCurve')!)),
  ).toEqual([
    [0, 0],
    [1, 1],
  ]);
});

test('pressure curve maps new PDF and Excalidraw pen samples without rewriting earlier strokes', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.page-editor')).toBeVisible();
  await page.evaluate(async () => {
    const { savePressureCurve } = await import('/src/pressureCurve.ts');
    savePressureCurve([
      [0, 0],
      [0.5, 0.8],
      [1, 1],
    ]);
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  });
  const draw = async (selector: string) =>
    page.locator(selector).evaluate((el) => {
      const r = el.getBoundingClientRect();
      for (const [type, x, p] of [
        ['pointerdown', 100, 0.2],
        ['pointermove', 130, 0.3],
        ['pointermove', 170, 0.4],
        ['pointerup', 170, 0],
      ] as const)
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 45,
            pointerType: 'pen',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: r.left + x,
            clientY: r.top + 150,
            pressure: p,
          }),
        );
    });
  await draw('.page-editor');
  const fs = await import('node:fs/promises');
  const saved = async () => {
    const pending = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    return JSON.parse(await fs.readFile((await (await pending).path())!, 'utf8'));
  };
  expect((await saved()).pages[0].strokes[0].points[0][2]).toBeCloseTo(0.32);
  await page.getByRole('button', { name: '草图', exact: true }).click();
  await page.locator('.sketch-editor [data-testid="toolbar-freedraw"]').check({ force: true });
  await draw('.sketch-editor canvas.interactive');
  await page.getByRole('button', { name: '插入当前页', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Excalidraw 草图' })).toHaveCount(0);
  const result = await saved();
  const element = result.pages[0].images[0].scene.elements.find((e: any) => e.type === 'freedraw');
  expect(element.simulatePressure).toBe(false);
  expect(element.pressures[0]).toBeCloseTo(0.32);
  expect(result.pages[0].strokes[0].points[0][2]).toBeCloseTo(0.32);
});
