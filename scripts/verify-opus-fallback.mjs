import { _electron as electron } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import assert from 'node:assert/strict';
const profile = await mkdtemp(join(tmpdir(), 'surfacetab-opus-unavailable-'));
// Point only this test process at an empty model root; never damage real weights.
const empty = await mkdtemp(join(tmpdir(), 'surfacetab-opus-empty-'));
const app = await electron.launch({
  executablePath: resolve('release/0.2.8/win-unpacked/SurfaceTab.exe'),
  args: [],
  env: {
    ...process.env,
    SURFACETAB_DEV: '0',
    SURFACETAB_PROFILE: profile,
    SURFACETAB_OPUS_DIR: empty,
  },
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('The book is on the table.', { x: 60, y: 700, size: 24, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'fallback.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await page
    .locator('.textLayer span')
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
  await page.locator('.selection-actions button').nth(1).click();
  await page.getByRole('button', { name: '翻译后端设置' }).click();
  await page.getByLabel('翻译后端类型').selectOption('local-native');
  const response = page.waitForResponse((r) => r.url() === 'http://127.0.0.1:8766/translate');
  await page.locator('.translation-footer .primary').click();
  const unavailable = await response;
  assert.equal(unavailable.status(), 503);
  await page.waitForFunction(
    () => document.querySelector('.translation-status')?.textContent.includes('CPU (WASM)'),
    null,
    { timeout: 180000 },
  );
  const status = await page.locator('.translation-status').textContent(),
    text = await page.locator('.translation-result').textContent();
  assert.ok(text.includes('书'), text);
  const health = await page.evaluate(async () =>
    (await fetch('http://127.0.0.1:8766/health')).json(),
  );
  assert.equal(health.loaded, false);
  const result = {
    nativeHttpStatus: unavailable.status(),
    nativeError: await unavailable.json(),
    status,
    text,
    health,
  };
  await writeFile(
    'test-results/native-opus028-model-fallback.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await app.close();
}
