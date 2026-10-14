import { test, expect, type Page } from '@playwright/test';
async function fixture(page: Page, copies: number) {
  await page.goto('/');
  const data = await page.evaluate(async (copies) => {
    const { newNotebook } = await import('/src/model.ts');
    const n = newNotebook();
    const c = document.createElement('canvas');
    c.width = 700;
    c.height = 700;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 700, 700);
    ctx.fillStyle = 'black';
    ctx.font = '22px Microsoft YaHei';
    for (let y = 35; y < 680; y += 30)
      ctx.fillText('中文 English recognition test: sample words 123', 20, y);
    const data = c.toDataURL();
    n.pages[0].images = Array.from({ length: copies }, (_, i) => ({
      id: 'scan-' + i,
      kind: 'image',
      data,
      x: 20 + i * 10,
      y: 20 + i * 10,
      width: 300,
      height: 300,
    }));
    return JSON.stringify(n);
  }, copies);
  await page.locator('input[type=file]').setInputFiles({
    name: 'mixed-scan.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(data),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  await page.getByRole('button', { name: '解析位图', exact: true }).click();
  return page.getByRole('dialog', { name: '解析位图' });
}
test('real CPU OCR with four workers stops without retaining workers or locking the UI', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Original = window.Worker;
    const state = ((window as any).cpuStop = { workers: 0, started: 0, clicked: 0, returned: 0 });
    window.Worker = class extends Original {
      owned: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.owned = String(url).includes('/ocr/worker');
        if (this.owned) state.workers++;
      }
      postMessage(packet: any, transfer?: Transferable[]) {
        super.postMessage(packet, transfer ?? []);
        if (this.owned && packet?.action === 'recognize' && ++state.started === 4)
          setTimeout(() => {
            const button = Array.from(document.querySelectorAll('button')).find(
              (b) => b.textContent === '停止',
            );
            if (button) {
              state.clicked = performance.now();
              button.click();
              state.returned = performance.now();
            }
          }, 0);
      }
      terminate() {
        if (this.owned) {
          this.owned = false;
          state.workers--;
        }
        super.terminate();
      }
    };
  });
  const dialog = await fixture(page, 4);
  await dialog.getByText('设置', { exact: true }).click();
  await dialog.getByLabel('并行任务数').selectOption('4');
  await dialog.getByRole('button', { name: '开始解析', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).cpuStop.started), { timeout: 45000 })
    .toBe(4);
  await expect(dialog.getByRole('status')).toContainText('已停止', { timeout: 5000 });
  const state = await page.evaluate(() => (window as any).cpuStop);
  expect(state.workers).toBe(0);
  expect(state.returned - state.clicked).toBeLessThan(2000);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置与笔诊断' })).toBeVisible();
});
test('mixed NPU option uses bilingual CPU layout, batch one and exposes timing', async ({
  page,
}) => {
  await page.route('http://127.0.0.1:8766/health', (r) =>
    r.fulfill({
      json: {
        engine: 'Texo OpenVINO',
        devices: [{ id: 'NPU' }],
        capabilities: ['tesseract-npu-queue-v1', 'tesseract-npu-mixed-v1', 'release-idle'],
      },
    }),
  );
  let body: any;
  await page.route('http://127.0.0.1:8766/ocr-tesseract-npu', (r) => {
    body = r.request().postDataJSON();
    const [x0, y0, x1, y1] = body.boxes[0];
    return r.fulfill({
      json: {
        device: 'NPU',
        text: '中文 English 123',
        lines: [{ text: '中文 English 123', polygon: [x0, y0, x1, y0, x1, y1, x0, y1] }],
        timing: { inferenceMs: 10, compileMs: 20, serviceMs: 35 },
      },
    });
  });
  const dialog = await fixture(page, 1);
  await dialog.getByLabel('OCR 后端').selectOption('tesseract-npu');
  await dialog.getByLabel('NPU Tesseract 模型').selectOption('mixed-best');
  await dialog.getByText('设置', { exact: true }).click();
  await expect(dialog.getByLabel('最大识别批量')).toBeDisabled();
  await expect(dialog.getByLabel('最大识别批量')).toHaveValue('1');
  await dialog.getByRole('button', { name: '开始解析', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('解析完成：1 张位图', { timeout: 45000 });
  expect(body).toMatchObject({ variant: 'mixed-best', batch: 1 });
  expect(body.boxes.length).toBeGreaterThan(0);
  await dialog.getByText('耗时详情', { exact: true }).click();
  await expect(dialog).toContainText('NPU 推理：0.01 秒');
  expect(await page.evaluate(() => localStorage.getItem('tixtab.bitmapOcrNpuVariant'))).toBe(
    'mixed-best',
  );
});
