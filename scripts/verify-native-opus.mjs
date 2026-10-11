import { _electron as electron } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import assert from 'node:assert/strict';
import { verifyNativeTexo } from './verify-native-ui.mjs';

export async function verifyNativeOpus(page) {
  const errors = [];
  const onError = (e) => errors.push(e.message);
  page.on('pageerror', onError);
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('The book is on the table.', { x: 60, y: 700, size: 24, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'native-opus.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  const select = async () => {
    await page.getByRole('button', { name: '选文', exact: true }).click();
    await page.locator('.textLayer span').first().waitFor();
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
    await page
      .locator('.selection-actions')
      .getByRole('button', { name: '翻译', exact: true })
      .click();
    await page.getByRole('button', { name: '翻译后端设置', exact: true }).click();
  };
  await select();
  await page.getByLabel('翻译后端类型').selectOption('local-native');
  assert.equal(await page.getByLabel('翻译计算设备').inputValue(), 'AUTO');
  const translate = async (device) => {
    await page.getByLabel('翻译计算设备').selectOption(device);
    await page
      .locator('.translation-footer')
      .getByRole('button', { name: '翻译', exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('.translation-status')?.textContent.includes('请核对译文') ||
        document.querySelector('.translation-status')?.textContent.includes('无法翻译'),
      null,
      { timeout: 180000 },
    );
    const status = await page.locator('.translation-status').textContent(),
      text = await page.locator('.translation-result').textContent();
    assert.ok(status.includes(`${device === 'AUTO' ? 'NPU' : device} + CPU`), status);
    assert.ok(text.includes('书'), text);
    return { device, status, text };
  };
  const native = [
    await translate('AUTO'),
    await translate('AUTO'),
    await translate('GPU'),
    await translate('CPU'),
  ];
  const health = await page.evaluate(async () =>
    (await fetch('http://127.0.0.1:8766/health')).json(),
  );
  assert.deepEqual(health.modelKind, ['opus', 'en-zh']);
  const chinese = [];
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await page.evaluate(async () => {
      const response = await fetch('http://127.0.0.1:8766/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: '书在桌子上。\n\n实验性夜间模式可以降低图片亮度。',
          direction: 'zh-en',
          device: 'AUTO',
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    });
    assert.equal(result.encoderDevice, 'NPU');
    assert.match(result.translation, /book|table/i);
    assert.ok(result.translation.includes('\n\n'));
    chinese.push(result);
  }
  await page.screenshot({ path: 'test-results/native-opus028.png' });
  await page.reload();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await select();
  assert.equal(await page.getByLabel('翻译后端类型').inputValue(), 'local-native');
  assert.equal(await page.getByLabel('翻译计算设备').inputValue(), 'CPU');
  // An older manually started formula service must not be killed or duplicated.
  await page.route('http://127.0.0.1:8766/health', (route) =>
    route.fulfill({ json: { engine: 'Texo OpenVINO', devices: [] } }),
  );
  await page
    .locator('.translation-footer')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('.translation-status')?.textContent.includes('CPU (WASM)') ||
      document.querySelector('.translation-status')?.textContent.includes('无法翻译'),
    null,
    { timeout: 180000 },
  );
  const fallback = await page.locator('.translation-status').textContent();
  assert.ok(fallback.includes('CPU (WASM)'), fallback);
  assert.ok(fallback.includes('已回退'), fallback);
  assert.ok((await page.locator('.translation-result').textContent()).includes('书'));
  await page.unroute('http://127.0.0.1:8766/health');
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  page.off('pageerror', onError);
  assert.deepEqual(errors, []);
  return { native, chinese, fallback, health, rendererErrors: errors };
}

// Use an isolated profile; closing this app terminates only its owned service.
if (
  import.meta.url === new URL(process.argv[1], 'file:///').href ||
  process.argv[1]?.endsWith('verify-native-opus.mjs')
) {
  const profile = await mkdtemp(join(tmpdir(), 'surfacetab-opus-verify-'));
  const executablePath = process.env.SURFACETAB_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
    timeout: 60000,
  });
  try {
    const page = await app.firstWindow(),
      result = await verifyNativeOpus(page);
    await writeFile(
      process.env.SURFACETAB_OPUS_REPORT || 'test-results/native-opus028.json',
      JSON.stringify(result, null, 2),
    );
    await verifyNativeTexo(page);
    const after = await page.evaluate(async () =>
      (await fetch('http://127.0.0.1:8766/health')).json(),
    );
    assert.deepEqual(after.modelKind, ['texo', null]);
    result.texoAfterTranslation = 'passed';
    await writeFile(
      process.env.SURFACETAB_OPUS_REPORT || 'test-results/native-opus028.json',
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
}
