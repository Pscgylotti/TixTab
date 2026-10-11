import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, link, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
const catalog = JSON.parse(await readFile('electron/model-catalog.json', 'utf8'));
const profile = await mkdtemp(join(tmpdir(), 'surfacetab-asr-qa-'));
for (const m of catalog.models.filter((m) => m.feature === 'dictation')) {
  const source = join(process.env.APPDATA, 'surfacetab/model-library/v1', m.id, m.revision),
    target = join(profile, 'model-library/v1', m.id, m.revision);
  for (const f of m.files) {
    await mkdir(dirname(join(target, f.path)), { recursive: true });
    await link(join(source, f.path), join(target, f.path));
  }
  await copyFile(join(source, '.complete.json'), join(target, '.complete.json'));
}
const app = await electron.launch({
  executablePath: process.env.SURFACETAB_EXECUTABLE,
  args: [],
  env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
  timeout: 60000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  const status = await page.evaluate(() =>
    window.surfaceDesktop.dictation.run({ action: 'status' }),
  );
  assert.ok(status.data.installed);
  assert.ok(status.data.devices.includes('NPU'));
  // Change only the captured input to public WAVs; actual packaged controller,
  // Python worker, model verification, IPC, inference and renderer are exercised.
  await app.evaluate(async ({ app, ipcMain }, samples) => {
    const path = process.getBuiltinModule('path'),
      { spawn } = process.getBuiltinModule('child_process'),
      { createRequire } = process.getBuiltinModule('module'),
      require = createRequire(path.join(app.getAppPath(), 'package.json'));
    const { createNeuralDictation } = require(
        path.join(app.getAppPath(), 'electron/neural-dictation.cjs'),
      ),
      { createModelLibrary } = require(path.join(app.getAppPath(), 'electron/model-library.cjs'));
    const backend = path.join(path.dirname(app.getPath('exe')), 'backend'),
      modelRoot = path.join(app.getPath('userData'), 'model-library/v1'),
      bundled = path.join(app.getAppPath(), 'dist/models');
    const models = createModelLibrary({
      root: modelRoot,
      bundled,
      catalog: require(path.join(app.getAppPath(), 'electron/model-catalog.json')),
      fetch,
    });
    const service = createNeuralDictation({
      backend,
      runtime: path.join(app.getPath('home'), '.surfacetab/asr-runtime'),
      modelRoot,
      bundled,
      models,
      system: { cancel() {}, dispose() {} },
      spawnProcess: (exe, args, options) =>
        spawn(
          exe,
          args.includes(path.join(backend, 'asr_worker.py'))
            ? [...args, '--capture-wav', samples]
            : args,
          options,
        ),
    });
    ipcMain.removeHandler('dictation:run');
    ipcMain.handle('dictation:run', (event, r) => service.run(event.sender, r));
    globalThis.asrQA = { service, models };
  }, resolve('.cache/asr-samples'));
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByRole('button', { name: '账号与模型', exact: true }).click();
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await page.getByRole('img', { name: '麦克风音量波形', exact: true }).waitFor();
  await page.waitForTimeout(6000);
  await page.waitForFunction(
    () => document.querySelector('.chat-compose textarea')?.value.includes('时间'),
    null,
    { timeout: 30000 },
  );
  await page.getByRole('button', { name: '语音输入', exact: true }).waitFor(); // end of fixture input, not a live microphone
  await page.getByLabel('语音输入语言').selectOption('en-US');
  await page.getByRole('button', { name: '语音设置', exact: true }).click();
  await page.getByLabel('识别引擎').selectOption('whisper-small');
  await page.getByLabel('语音推理设备').selectOption('NPU');
  await page.getByRole('button', { name: '关闭语音设置', exact: true }).click();
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.chat-compose textarea')?.value.includes('gold'),
    null,
    { timeout: 45000 },
  );
  const prompt = await page.getByLabel('向 ChatGPT 提问').inputValue();
  assert.match(prompt, /时间/);
  assert.match(prompt, /gold/i);
  assert.equal(await page.locator('.chat-message').count(), 0);
  await page.getByRole('button', { name: '语音设置', exact: true }).click();
  await page.getByRole('dialog', { name: '本地语音输入', exact: true }).waitFor();
  assert.equal(await page.getByLabel('识别引擎').inputValue(), 'whisper-small');
  assert.equal(await page.getByLabel('语音推理设备').inputValue(), 'NPU');
  await page.screenshot({ path: '.cache/asr-desktop-0233.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Actual packaged ASR: SenseVoiceSmall CPU / Whisper small NPU, pinned model files, public WAV capture fixture, live waveform, bilingual editable draft, engine/device controls and no automatic chat submission passed. No microphone capture or account inference. Renderer errors: none.',
  );
} finally {
  await app.evaluate(() => {
    globalThis.asrQA?.service.dispose();
    globalThis.asrQA?.models.dispose();
  });
  await app.close();
}
