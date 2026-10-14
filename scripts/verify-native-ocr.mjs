import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from '@playwright/test';

/** Actual packaged region capture + native inference + bundled Tesseract fallback. */
export async function verifyNativeOcr(page) {
  const closeKeyboard = page.getByRole('button', { name: '关闭屏幕键盘', exact: true });
  if (await closeKeyboard.count()) await closeKeyboard.click();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1000;
    c.height = 260;
    const x = c.getContext('2d');
    x.fillStyle = 'white';
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = 'black';
    x.font = '48px Arial';
    x.fillText('The book is on the table.', 25, 90);
    x.font = '42px "Microsoft YaHei"';
    x.fillText('本地文字识别', 25, 185);
    return c.toDataURL();
  });
  const pdf = await PDFDocument.create(),
    p = pdf.addPage([595, 842]),
    image = await pdf.embedPng(data);
  p.drawImage(image, { x: 40, y: 550, width: 500, height: 130 });
  await page.locator('input[type=file]').setInputFiles({
    name: 'native-ocr-check.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '适合页面', exact: true }).click();
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const r = await page.locator('.paper').boundingBox();
  await page.mouse.move(r.x + (r.width * 35) / 595, r.y + (r.height * 150) / 842);
  await page.mouse.down();
  await page.mouse.move(r.x + (r.width * 555) / 595, r.y + (r.height * 310) / 842, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: '识别文字（OCR）', exact: true }).click();
  await page.getByRole('dialog', { name: '区域识别' }).waitFor();
  await page.getByLabel('OCR 后端').selectOption('native');
  await page.locator('.native-settings summary').click();
  if (process.env.SURFACETAB_VERIFY_OCR_MISSING === '1') {
    const pending = page.waitForResponse(
      (response) => response.url() === 'http://127.0.0.1:8766/ocr',
      { timeout: 180000 },
    );
    await page.getByRole('button', { name: '开始识别', exact: true }).click();
    const response = await pending;
    assert.equal(response.status(), 503);
    await page.waitForFunction(
      () => document.querySelector('.ocr-task-status')?.textContent.includes('CPU (WASM)'),
      null,
      { timeout: 90000 },
    );
    assert.match(
      await page.getByLabel('识别结果 · 可修改').inputValue(),
      /The book is on the table\./,
    );
    const health = await page.evaluate(
      async () => await (await fetch('http://127.0.0.1:8766/health')).json(),
    );
    assert.equal(health.loaded, false);
    const report = { actualMissingModelStatus: 503, realTesseractFallback: 'passed', health };
    await writeFile(
      process.env.SURFACETAB_OCR_REPORT || 'test-results/native-ocr0210-missing.json',
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    return report;
  }
  const results = [];
  for (const device of ['AUTO', 'AUTO', 'GPU', 'CPU']) {
    await page.getByLabel('OCR 推理设备').selectOption(device);
    const pending = page.waitForResponse(
      (response) => response.url() === 'http://127.0.0.1:8766/ocr',
      { timeout: 180000 },
    );
    await page.getByRole('button', { name: '开始识别', exact: true }).click();
    const response = await pending,
      result = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(result));
    await page.getByRole('button', { name: '开始识别', exact: true }).waitFor();
    assert.match(
      await page.getByLabel('识别结果 · 可修改').inputValue(),
      /The book is on the table\./,
    );
    assert.ok((await page.getByLabel('识别结果 · 可修改').inputValue()).includes('本地文字识别'));
    assert.deepEqual(result.devices.det, [device === 'AUTO' ? 'NPU' : device]);
    assert.deepEqual(result.devices.rec, [device === 'AUTO' ? 'NPU' : device]);
    assert.equal(result.projectionDevice, 'CPU');
    results.push({ requested: device, ...result });
  }
  await page.screenshot({ path: 'test-results/native-ocr0210.png' });
  const health = await page.evaluate(
    async () => await (await fetch('http://127.0.0.1:8766/health')).json(),
  );
  assert.deepEqual(health.modelKind, ['ocr', null]);
  // A real bundled recognizer, with only native capability negotiation made unavailable.
  await page.route('http://127.0.0.1:8766/health', (route) =>
    route.fulfill({
      json: { ok: true, engine: 'Texo OpenVINO', devices: [], capabilities: ['recognize'] },
    }),
  );
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.ocr-task-status')?.textContent.includes('CPU (WASM)'),
    null,
    { timeout: 90000 },
  );
  assert.match(
    await page.getByLabel('识别结果 · 可修改').inputValue(),
    /The book is on the table\./,
  );
  assert.ok((await page.locator('.ocr-task-status').textContent()).includes('Tesseract'));
  await page.unroute('http://127.0.0.1:8766/health');
  await page
    .getByRole('dialog', { name: '区域识别' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  const report = { results, bundledTesseractFallback: 'passed', health };
  await writeFile(
    process.env.SURFACETAB_OCR_REPORT || 'test-results/native-ocr0210-portable.json',
    JSON.stringify(report, null, 2),
  );
  console.log(
    'Actual packaged OCR NPU / GPU / CPU and bundled fallback:',
    JSON.stringify(
      results.map((r) => ({
        requested: r.requested,
        actual: r.devices,
        totalMs: r.timing.totalMs,
      })),
    ),
  );
  return report;
}

if (process.argv[1]?.endsWith('verify-native-ocr.mjs')) {
  const profile = await mkdtemp(join(tmpdir(), 'surfacetab-native-ocr-'));
  const executablePath = process.env.SURFACETAB_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
    timeout: 60000,
  });
  try {
    await verifyNativeOcr(await app.firstWindow());
  } finally {
    await app.close();
  }
}
