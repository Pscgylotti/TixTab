import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
async function selection(page: Page, open = true) {
  if (open) {
    await page.goto('/');
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf
      .addPage([595, 842])
      .drawText('The book is on the table.', { x: 60, y: 700, size: 24, font });
    await page.locator('input[type=file]').setInputFiles({
      name: 'providers.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    });
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
  }
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  await page
    .locator('.textLayer span')
    .first()
    .evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
  await page
    .locator('.selection-actions')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await page.getByRole('button', { name: '翻译后端设置' }).click();
}
async function draw(page: Page) {
  const r = (await page.locator('.formula-canvas').boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.3, r.y + r.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.6, r.y + r.height * 0.7, { steps: 8 });
  await page.mouse.up();
}
function wave() {
  const b = Buffer.alloc(44 + 16000 * 2 * 10);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(b.length - 44, 40);
  return b;
}

test('per-backend profiles persist, HEAD check sends no selection, streaming and browser session credentials work', async ({
  page,
}) => {
  let post = 0,
    head = 0;
  await page.route('https://api.test/**', async (route) => {
    const r = route.request();
    expect(r.headers()['x-custom']).toBe('private-header');
    expect(r.headers().authorization).toBe('Bearer translation-secret');
    if (r.method() === 'HEAD') {
      head++;
      expect(r.postData()).toBeNull();
      await route.fulfill({ status: 405 });
    } else {
      post++;
      expect(r.postDataJSON()).toMatchObject({ model: 'small', stream: true });
      await route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"choices":[{"delta":{"content":"书在"}}]}\n\ndata: {"choices":[{"delta":{"content":"桌子上。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      });
    }
  });
  await selection(page);
  await page.getByLabel('翻译后端类型').selectOption('llm');
  await page.getByLabel('翻译接口地址').fill('https://api.test/v1');
  await page.getByLabel('翻译模型').fill('small');
  await page.getByLabel('翻译 API Key').fill('translation-secret');
  const advanced = page.locator('.provider-config>.provider-advanced');
  await advanced.locator('summary').click();
  await advanced.getByLabel('API 超时（秒）').fill('25');
  await advanced.getByLabel('自定义请求头（JSON）').fill('{"X-Custom":"private-header"}');
  await advanced.getByLabel('流式返回文本').check();
  expect(post).toBe(0);
  expect(head).toBe(0);
  await advanced.getByRole('button', { name: '检查连接（不发送选区）' }).click();
  await expect(advanced).toContainText('服务器可达（HTTP 405）');
  expect(post).toBe(0);
  expect(head).toBe(1);
  await page
    .locator('.translation-footer')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect(page.locator('.translation-result')).toHaveText('书在桌子上。');
  expect(post).toBe(1);
  await page.getByLabel('翻译接口地址').fill('https://changed.test/v1');
  await expect(page.getByLabel('翻译 API Key')).toHaveValue('');
  await expect(advanced.getByLabel('自定义请求头（JSON）')).toHaveValue('');
  await page.getByLabel('翻译接口地址').fill('https://api.test/v1');
  await page.getByLabel('翻译 API Key').fill('translation-secret');
  await advanced.getByLabel('自定义请求头（JSON）').fill('{"X-Custom":"private-header"}');
  await page.getByLabel('翻译后端类型').selectOption('web');
  await page.getByLabel('翻译接口地址').fill('https://other.test/translate?key=query-secret');
  await page.getByLabel('翻译 API Key').fill('other-secret');
  await page.getByLabel('翻译后端类型').selectOption('llm');
  await expect(page.getByLabel('翻译 API Key')).toHaveValue('translation-secret');
  await expect(page.getByLabel('翻译模型')).toHaveValue('small');
  const plain = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  for (const secret of ['translation-secret', 'private-header', 'other-secret', 'query-secret'])
    expect(plain).not.toContain(secret);
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.setViewportSize({ width: 560, height: 900 });
  await selection(page, false);
  await page.locator('.provider-config>.provider-advanced summary').click();
  await page.screenshot({ path: 'test-results/provider-night-portrait.png' });
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await selection(page, false);
  await expect(page.getByLabel('翻译后端类型')).toHaveValue('llm');
  await expect(page.getByLabel('翻译 API Key')).toHaveValue('');
  await expect(page.getByLabel('翻译模型')).toHaveValue('small');
  await page.locator('.provider-config>.provider-advanced summary').click();
  await expect(
    page.locator('.provider-config>.provider-advanced').getByLabel('API 超时（秒）'),
  ).toHaveValue('25');
  await expect(
    page.locator('.provider-config>.provider-advanced').getByLabel('自定义请求头（JSON）'),
  ).toHaveValue('');
});

test('OCR, formula and speech use distinct HTTP profiles, returned content and voices', async ({
  page,
}) => {
  const calls: Record<string, unknown> = {};
  await page.route('https://api.test/**', async (route) => {
    const kind = new URL(route.request().url()).pathname.slice(1);
    expect(route.request().headers().authorization).toBe(`Bearer ${kind}-secret`);
    const body = route.request().postDataJSON();
    calls[kind] = body;
    await route.fulfill(
      kind === 'speech'
        ? { body: wave(), contentType: 'audio/wav' }
        : { json: kind === 'ocr' ? { text: 'OCR output' } : { latex: 'x^2' } },
    );
  });
  await selection(page);
  await page.locator('.speech-settings summary').click();
  await page.getByLabel('语音后端').selectOption('web');
  await page.getByLabel('语音接口地址').fill('https://api.test/speech');
  await page.getByLabel('语音 API Key').fill('speech-secret');
  await page.getByLabel('声音 ID').fill('custom-voice');
  await page.getByRole('button', { name: '朗读选区' }).click();
  await expect(page.getByRole('button', { name: '暂停朗读' })).toBeVisible();
  expect(calls.speech).toMatchObject({ text: 'The book is on the table.', voice: 'custom-voice' });
  await page.getByRole('button', { name: '停止朗读' }).click();
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const r = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.1, r.y + r.height * 0.12);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.9, r.y + r.height * 0.25, { steps: 5 });
  await page.mouse.up();
  await page.getByLabel('OCR 后端').selectOption('web');
  await page.getByLabel('OCR 接口地址').fill('https://api.test/ocr');
  await page.getByLabel('OCR API Key').fill('ocr-secret');
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(page.getByLabel('识别结果 · 可修改')).toHaveValue('OCR output');
  expect((calls.ocr as { image: string }).image).toMatch(/^data:image\/png;base64,/);
  await page
    .getByRole('dialog', { name: '区域识别' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await page.getByLabel('公式识别后端').selectOption('web');
  await page.getByLabel('公式接口地址').fill('https://api.test/formula');
  await page.getByLabel('公式 API Key').fill('formula-secret');
  await draw(page);
  await page.getByRole('button', { name: '识别手写公式', exact: true }).click();
  await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('x^2');
  expect((calls.formula as { image: string }).image).toMatch(/^data:image\/png;base64,/);
  await page
    .getByRole('dialog', { name: '手写公式' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await expect(page.getByLabel('公式识别后端')).toHaveValue('web');
  await expect(page.getByLabel('公式 API Key')).toHaveValue('formula-secret');
});

test('bad settings and remote cancellation do not launch local models', async ({ page }) => {
  let modelLoads = 0,
    apiCalls = 0,
    started = false;
  await page.route('**/models/**', (route) => {
    modelLoads++;
    return route.abort();
  });
  await page.route('https://api.test/**', async (route) => {
    apiCalls++;
    started = true;
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({ json: { translation: 'late' } }).catch(() => {});
  });
  await selection(page);
  await page.getByLabel('翻译后端类型').selectOption('web');
  await page.getByLabel('翻译接口地址').fill('https://api.test/translate');
  const advanced = page.locator('.provider-config>.provider-advanced');
  await advanced.locator('summary').click();
  await advanced.getByLabel('自定义请求头（JSON）').fill('{bad');
  await page
    .locator('.translation-footer')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect(page.locator('.translation-status')).toContainText('请求头必须为 JSON 对象');
  expect(apiCalls).toBe(0);
  expect(modelLoads).toBe(0);
  await advanced.getByLabel('自定义请求头（JSON）').fill('{}');
  await page
    .locator('.translation-footer')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect.poll(() => started).toBe(true);
  await page.getByRole('button', { name: '取消翻译', exact: true }).click();
  await page.waitForTimeout(800);
  await expect(page.locator('.translation-status')).toHaveText('已取消');
  expect(modelLoads).toBe(0);
  await expect(page.locator('.translation-result')).not.toHaveText('late');
});
