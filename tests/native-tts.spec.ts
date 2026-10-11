import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
async function prepare(page: Page) {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([595, 842]).drawText('The book is on the table.', { x: 60, y: 700, size: 24, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'native-speech.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '选文', exact: true }).click();
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
}
function wav() {
  const buffer = Buffer.alloc(44 + 16000 * 2 * 10);
  buffer.write('RIFF');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}
test('native speech uses real local phonemes, pauses/resumes, keeps device preferences and fits portrait night', async ({
  page,
}) => {
  let calls = 0,
    busy = false,
    voiceLoads = 0;
  await page.addInitScript(() => {
    speechSynthesis.getVoices = () => [];
  });
  await page.route('**/models/piper/**/*.onnx', (route) => {
    voiceLoads++;
    return route.abort();
  });
  await page.route('http://127.0.0.1:8766/health', (route) =>
    route.fulfill({
      json: { engine: 'Texo OpenVINO', devices: [], capabilities: ['synthesize-experimental'] },
    }),
  );
  await page.route('http://127.0.0.1:8766/synthesize', async (route) => {
    calls++;
    const data = route.request().postDataJSON();
    expect(data.voice).toBe('en_US-lessac-low');
    expect(data.chunks[0][0]).toBe(1);
    expect(data.chunks[0].at(-1)).toBe(2);
    expect(data.chunks[0].length).toBeGreaterThan(30);
    await route.fulfill(
      busy
        ? { status: 429, json: { detail: 'busy' } }
        : {
            body: wav(),
            headers: {
              'Content-Type': 'audio/wav',
              'Access-Control-Expose-Headers': 'X-SurfaceTab-Speech',
              'X-SurfaceTab-Speech': JSON.stringify({
                voice: data.voice,
                sampleRate: 16000,
                vocoderDevices: ['CPU', 'NPU'],
                upstreamDevice: 'CPU',
                tailDevice: 'CPU',
                timing: { totalMs: 120 },
              }),
            },
          },
    );
  });
  await prepare(page);
  await page.getByRole('button', { name: '朗读选区' }).click();
  await expect(page.getByRole('button', { name: '暂停朗读' })).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.compact-speech-status')).toContainText('CPU + NPU');
  await page.getByRole('button', { name: '暂停朗读' }).click();
  await expect(page.getByRole('button', { name: '继续朗读' })).toBeVisible();
  await page.getByRole('button', { name: '继续朗读' }).click();
  await expect(page.getByRole('button', { name: '暂停朗读' })).toBeVisible();
  await page.getByRole('button', { name: '停止朗读' }).click();
  busy = true;
  await page.getByRole('button', { name: '朗读选区' }).click();
  await expect(page.locator('.compact-speech-status')).toContainText('已有本地推理正在运行');
  expect(calls).toBe(2);
  expect(voiceLoads).toBe(0);
  await page
    .locator('.selection-actions')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await page.getByRole('button', { name: '翻译后端设置' }).click();
  await page.locator('.speech-settings summary').click();
  await expect(page.getByLabel('语音后端')).toHaveValue('native');
  await page.getByLabel('朗读计算设备').selectOption('GPU');
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 560, height: 900 });
  await page.getByRole('button', { name: 'Select text', exact: true }).click();
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
  await page.getByRole('button', { name: 'Translation backend settings' }).click();
  await page.locator('.speech-settings summary').click();
  await expect(page.getByLabel('Speech device')).toHaveValue('GPU');
  const bounds = (await page.locator('.selection-flyout').boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(560);
  expect(
    await page.locator('.speech-settings').evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe('rgb(44, 53, 69)');
  await page.reload();
  expect(await page.evaluate(() => localStorage.getItem('surfacetab.speechDevice'))).toBe('GPU');
});
test('stopping native synthesis cancels without starting a second voice model', async ({
  page,
}) => {
  let started = false,
    voiceLoads = 0;
  await page.route('**/models/piper/**/*.onnx', (route) => {
    voiceLoads++;
    return route.abort();
  });
  await page.route('http://127.0.0.1:8766/health', (route) =>
    route.fulfill({
      json: { engine: 'Texo OpenVINO', devices: [], capabilities: ['synthesize-experimental'] },
    }),
  );
  await page.route('http://127.0.0.1:8766/synthesize', async (route) => {
    started = true;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ status: 503, json: { detail: 'late' } }).catch(() => {});
  });
  await prepare(page);
  await page.getByRole('button', { name: '朗读选区' }).click();
  await expect.poll(() => started).toBe(true);
  await page.getByRole('button', { name: '停止朗读' }).click();
  await page.waitForTimeout(1500);
  expect(voiceLoads).toBe(0);
  await expect(page.getByRole('button', { name: '暂停朗读' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止朗读' })).toHaveCount(0);
});
test('long phonemization keeps all chunks and adapts to expanded number sequences', async ({
  page,
}) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const worker = new Worker(new URL('/src/phonemize.worker.ts', location.href), {
      type: 'module',
    });
    const encode = (text: string) =>
      new Promise<number[][]>((resolve, reject) => {
        worker.onmessage = ({ data }) =>
          data.type === 'result' ? resolve(data.chunks) : reject(new Error(data.error));
        worker.onerror = (e) => reject(new Error(e.message));
        worker.postMessage({ text, voice: 'en_US-lessac-low', base: document.baseURI });
      });
    try {
      const long = ('x'.repeat(40) + ' ' + 'x'.repeat(79) + ' ').repeat(34).slice(0, 4000);
      const first = await encode(long),
        numbers = await encode('1234567890'.repeat(40));
      return [first, numbers].map((chunks) => ({
        count: chunks.length,
        lengths: chunks.map((c) => c.length),
        valid: chunks.every((c) => c[0] === 1 && c.at(-1) === 2),
      }));
    } finally {
      worker.terminate();
    }
  });
  expect(results[0].count).toBeGreaterThan(64);
  for (const result of results) {
    expect(result.count).toBeLessThanOrEqual(256);
    expect(Math.max(...result.lengths)).toBeLessThanOrEqual(1024);
    expect(result.valid).toBe(true);
  }
});
