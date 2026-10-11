import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

function inspectWav(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.toString('ascii', 36, 40), 'data');
  assert.equal(buffer.readUInt16LE(22), 1);
  assert.equal(buffer.readUInt32LE(24), 16000);
  assert.equal(buffer.readUInt16LE(34), 16);
  const samples = buffer.readUInt32LE(40) / 2;
  assert.equal(buffer.length, 44 + samples * 2);
  let squares = 0,
    peak = 0;
  for (let i = 0; i < samples; i++) {
    const value = buffer.readInt16LE(44 + i * 2) / 32767;
    squares += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  const rms = Math.sqrt(squares / samples);
  assert.ok(samples > 16000 && rms > 0.003 && peak > rms, { samples, rms, peak });
  return { samples, durationSeconds: samples / 16000, rms, peak };
}

/** Real phonemizer, real native audio, real playback and real browser fallback. */
export async function verifyNativeTts(page) {
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    window.__surfaceTestAudio = [];
    const OriginalAudio = window.Audio;
    window.Audio = class extends OriginalAudio {
      constructor() {
        super();
        this.muted = true;
        window.__surfaceTestAudio.push(this);
      }
    };
  });
  const closeKeyboard = page.getByRole('button', { name: '关闭屏幕键盘', exact: true });
  if (await closeKeyboard.count()) await closeKeyboard.click();
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([595, 842]).drawText('The book is on the table. Please read this text aloud.', {
    x: 60,
    y: 700,
    size: 16,
    font,
  });
  await page.locator('input[type=file]').setInputFiles({
    name: 'native-speech-check.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
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
  const openSettings = async () => {
    await page
      .locator('.selection-actions')
      .getByRole('button', { name: '翻译', exact: true })
      .click();
    await page.getByRole('button', { name: '翻译后端设置', exact: true }).click();
    await page.locator('.speech-settings summary').click();
    await page.getByLabel('语音后端').selectOption('native');
  };
  await openSettings();
  if (process.env.SURFACETAB_VERIFY_TTS_MISSING === '1') {
    const pending = page.waitForResponse((r) => r.url() === 'http://127.0.0.1:8766/synthesize', {
      timeout: 180000,
    });
    await page.getByRole('button', { name: '朗读选区', exact: true }).click();
    const response = await pending;
    assert.equal(response.status(), 503);
    await page.getByRole('button', { name: '暂停朗读', exact: true }).waitFor({ timeout: 90000 });
    assert.ok((await page.locator('.translation-status').textContent()).includes('CPU (WASM)'));
    const base64 = await page.evaluate(async () => {
      const blob = await (await fetch(window.__surfaceTestAudio.at(-1).src)).arrayBuffer();
      let s = '';
      for (const b of new Uint8Array(blob)) s += String.fromCharCode(b);
      return btoa(s);
    });
    const wave = inspectWav(Buffer.from(base64, 'base64'));
    const health = await page.evaluate(async () =>
      (await fetch('http://127.0.0.1:8766/health')).json(),
    );
    assert.equal(health.loaded, false);
    await page.getByRole('button', { name: '停止朗读', exact: true }).click();
    const result = { actualMissingModelStatus: 503, realPiperWasmFallback: 'passed', wave, health };
    await writeFile(
      process.env.SURFACETAB_TTS_REPORT || 'test-results/native-tts0211-missing.json',
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    return result;
  }
  const records = [],
    inputs = [];
  const synthesize = async (device, voice) => {
    await page.getByLabel('朗读计算设备').selectOption(device);
    const pending = page.waitForResponse((r) => r.url() === 'http://127.0.0.1:8766/synthesize', {
      timeout: 180000,
    });
    await page.getByRole('button', { name: '朗读选区', exact: true }).click();
    const response = await pending;
    if (response.status() !== 200) assert.fail((await response.text()).slice(0, 300));
    const metadata = JSON.parse(response.headers()['x-surfacetab-speech']);
    assert.equal(metadata.voice, voice);
    assert.ok(
      metadata.vocoderDevices.includes(device === 'AUTO' ? 'NPU' : device),
      JSON.stringify(metadata),
    );
    assert.equal(metadata.upstreamDevice, 'CPU');
    assert.equal(metadata.tailDevice, 'CPU');
    await page.getByRole('button', { name: '暂停朗读', exact: true }).waitFor();
    assert.ok(
      (await page.locator('.translation-status').textContent()).includes(
        metadata.vocoderDevices.join(' + '),
      ),
      await page.locator('.translation-status').textContent(),
    );
    // Inspect the actual blob consumed by the app, after fetch completed. Some
    // Electron CDP builds expose an empty body when queried at response headers.
    const base64 = await page.evaluate(async () => {
      const blob = await (await fetch(window.__surfaceTestAudio.at(-1).src)).arrayBuffer();
      let s = '';
      for (const b of new Uint8Array(blob)) s += String.fromCharCode(b);
      return btoa(s);
    });
    const audio = Buffer.from(base64, 'base64');
    const wave = inspectWav(audio);
    assert.equal(wave.samples, metadata.audioSamples);
    await page.getByRole('button', { name: '暂停朗读', exact: true }).click();
    await page.getByRole('button', { name: '继续朗读', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__surfaceTestAudio.at(-1).paused), true);
    await page.getByRole('button', { name: '继续朗读', exact: true }).click();
    await page.getByRole('button', { name: '暂停朗读', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__surfaceTestAudio.at(-1).paused), false);
    await writeFile(`test-results/tts0211-${voice}-${device}-${records.length}.wav`, audio);
    inputs.push(response.request().postDataJSON());
    records.push({ requested: device, ...metadata, wave });
    await page.getByRole('button', { name: '停止朗读', exact: true }).click();
  };
  for (const device of ['AUTO', 'AUTO', 'GPU', 'CPU']) await synthesize(device, 'en_US-lessac-low');
  await page.getByRole('button', { name: '关闭划词工具', exact: true }).click();
  await page.getByRole('button', { name: '适合页面', exact: true }).click();
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const box = await page.locator('.paper').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 150, { steps: 4 });
  await page.mouse.up();
  await page
    .getByLabel('识别结果 · 可修改')
    .fill('这是本地中文语音测试。我们可以在阅读时暂停和继续朗读，并且使用低功耗设备。');
  await page.getByRole('button', { name: '翻译 / 朗读', exact: true }).click();
  await openSettings();
  for (const device of ['AUTO', 'AUTO', 'GPU', 'CPU'])
    await synthesize(device, 'zh_CN-huayan-x_low');
  await page.getByRole('button', { name: '关闭划词工具', exact: true }).click();
  await page.getByRole('button', { name: '适合页面', exact: true }).click();
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const longBox = await page.locator('.paper').boundingBox();
  await page.mouse.move(longBox.x + 20, longBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(longBox.x + 150, longBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page
    .getByLabel('识别结果 · 可修改')
    .fill('这是本地中文语音测试。我们可以在阅读时暂停和继续朗读，并且使用低功耗设备。'.repeat(3));
  await page.getByRole('button', { name: '翻译 / 朗读', exact: true }).click();
  await openSettings();
  await synthesize('AUTO', 'zh_CN-huayan-x_low');
  assert.ok(inputs.at(-1).chunks.length > 1);
  const health = await page.evaluate(async () =>
    (await fetch('http://127.0.0.1:8766/health')).json(),
  );
  assert.deepEqual(health.modelKind, ['piper', 'zh_CN-huayan-x_low']);
  await page.screenshot({ path: 'test-results/native-tts0211.png' });
  await page.route('http://127.0.0.1:8766/health', (r) =>
    r.fulfill({ json: { engine: 'Texo OpenVINO', devices: [], capabilities: ['recognize'] } }),
  );
  await page.getByRole('button', { name: '朗读选区', exact: true }).click();
  await page.getByRole('button', { name: '暂停朗读', exact: true }).waitFor({ timeout: 90000 });
  assert.ok((await page.locator('.translation-status').textContent()).includes('CPU (WASM)'));
  const base64 = await page.evaluate(async () => {
    const blob = await (await fetch(window.__surfaceTestAudio.at(-1).src)).arrayBuffer();
    let s = '';
    for (const b of new Uint8Array(blob)) s += String.fromCharCode(b);
    return btoa(s);
  });
  const fallbackWave = inspectWav(Buffer.from(base64, 'base64'));
  await page.getByRole('button', { name: '停止朗读', exact: true }).click();
  await page.unroute('http://127.0.0.1:8766/health');
  await page.getByRole('button', { name: '关闭划词工具', exact: true }).click();
  const result = {
    appVersion: '0.2.11',
    records,
    inputs,
    multiChunkSynthesis: 'passed',
    realPiperWasmFallback: 'passed',
    fallbackWave,
    actualAudioPlaybackPauseResume: 'passed',
    health,
  };
  await writeFile(
    process.env.SURFACETAB_TTS_REPORT || 'test-results/native-tts0211.json',
    JSON.stringify(result, null, 2),
  );
  console.log(
    'Actual native speech and real WASM fallback:',
    JSON.stringify(
      records.map((r) => ({
        voice: r.voice,
        requested: r.requested,
        actual: r.vocoderDevices,
        totalMs: r.timing.totalMs,
        durationSeconds: r.wave.durationSeconds,
      })),
    ),
  );
  return result;
}

if (process.argv[1]?.endsWith('verify-native-tts.mjs')) {
  const profile = await mkdtemp(join(tmpdir(), 'surfacetab-native-tts-'));
  const executablePath = process.env.SURFACETAB_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
    timeout: 60000,
  });
  try {
    await verifyNativeTts(await app.firstWindow());
  } catch (error) {
    await (await app.firstWindow()).screenshot({ path: 'test-results/native-tts0211-error.png' });
    throw error;
  } finally {
    await app.close();
  }
}
