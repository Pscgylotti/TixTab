// Exercise owned native popup windows with fake chat/voice replies and an isolated profile.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const app = await electron.launch({
  executablePath: resolve(process.argv[2]),
  env: {
    ...process.env,
    SURFACETAB_PROFILE: await mkdtemp(join(tmpdir(), 'surfacetab-floating-')),
    SURFACETAB_DEV: '0',
  },
  timeout: 60000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.paper').waitFor();
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('chatgpt:run');
    ipcMain.handle('chatgpt:run', (_event, r) => {
      if (r.action === 'status')
        return {
          ok: true,
          data: {
            accounts: [{ id: 'test', email: 'reader@example.com', enabled: true, signedIn: true }],
            active: 'test',
            storage: 'session',
            welcome: false,
          },
        };
      if (r.action === 'models')
        return { ok: true, data: [{ id: 'test-model', name: 'Test model' }] };
      if (r.action === 'start') return { ok: true, data: { id: 'generation' } };
      if (r.action === 'read')
        return {
          ok: true,
          data: {
            delta:
              '```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="steelblue"/><text x="40" y="90">Surface</text></svg>\n```',
            done: true,
          },
        };
      return { ok: true, data: {} };
    });
    let active;
    const jobs = new Map();
    ipcMain.removeHandler('dictation:run');
    ipcMain.handle('dictation:run', async (_event, r) => {
      if (r.action === 'start') {
        active = String(Date.now());
        jobs.set(active, { n: 0, stopped: false });
        return { ok: true, data: { id: active } };
      }
      if (r.action === 'stop' || r.action === 'cancel') {
        if (active) jobs.get(active).stopped = true;
        return { ok: true };
      }
      if (r.action === 'read') {
        await new Promise((resolve) => setTimeout(resolve, 80));
        const j = jobs.get(r.id);
        return {
          ok: true,
          data: { text: j.n++ === 0 ? 'voice text' : '', level: 70, done: j.stopped, ready: true },
        };
      }
      return { ok: true, data: { installed: true, devices: ['CPU', 'GPU', 'NPU'] } };
    });
  });
  const width = await page.locator('.canvas-container').evaluate((el) => el.clientWidth);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByLabel('向 ChatGPT 提问').fill('Native draft');
  const created = app.waitForEvent('window');
  await page.getByRole('button', { name: '在独立悬浮窗中打开', exact: true }).click();
  const child = await created;
  child.on('pageerror', (e) => errors.push(e.message));
  await expect(child.getByLabel('向 ChatGPT 提问')).toHaveValue('Native draft');
  await expect(page.locator('.chat-panel')).toHaveCount(0);
  assert.equal(await page.locator('.canvas-container').evaluate((el) => el.clientWidth), width);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2);
  await page.getByRole('button', { name: '加页', exact: true }).click();
  await expect(child.getByLabel('聊天附件页码')).toHaveValue('2');
  await child.getByLabel('向 ChatGPT 提问').focus();
  await child.getByLabel('向 ChatGPT 提问').press('End');
  await child.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await child.getByRole('button', { name: '英文', exact: true }).click();
  await child.locator('.hg-button[data-skbtn="x"]').click();
  await expect(child.getByLabel('向 ChatGPT 提问')).toHaveValue('Native draftx');
  await child.getByRole('button', { name: '语音', exact: true }).click();
  const keyboard = child.locator('.touch-keyboard');
  await keyboard.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(child.getByLabel('向 ChatGPT 提问')).toHaveValue('Native draftx voice text');
  await expect(keyboard.getByRole('img', { name: '麦克风音量波形' })).toHaveAttribute(
    'data-level',
    '70',
  );
  await keyboard.getByRole('button', { name: '关闭屏幕键盘', exact: true }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await expect(child.locator('html')).toHaveAttribute('data-night', 'true');
  await child.getByLabel('向 ChatGPT 提问').fill('Draw a blue rectangle');
  await child.getByRole('button', { name: '根据描述生成 SVG', exact: true }).click();
  await child.getByRole('button', { name: '插入 SVG 到当前页', exact: true }).click();
  await expect(page.locator('.placed-object')).toHaveCount(1);
  await child.getByLabel('向 ChatGPT 提问').fill('Keep native close draft');
  const output = resolve('release/0.2.35/validation');
  await mkdir(output, { recursive: true });
  await child.screenshot({ path: join(output, 'chat-native-floating.png') });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL() === 'about:blank')
      .close(),
  );
  await expect(page.getByLabel('向 ChatGPT 提问')).toHaveValue('Keep native close draft');
  await expect(page.locator('.chat-svg-preview')).toHaveCount(1);
  // A second detach and explicit dock must also work.
  const again = app.waitForEvent('window');
  await page.getByRole('button', { name: '在独立悬浮窗中打开', exact: true }).click();
  const second = await again;
  await second.getByRole('button', { name: '停靠到侧栏', exact: true }).click();
  await expect(page.getByLabel('向 ChatGPT 提问')).toHaveValue('Keep native close draft');
  assert.deepEqual(errors, []);
  const result = {
    nativeWindows: true,
    pdfWidthRestored: true,
    pageContext: true,
    englishKeyboard: true,
    voiceKeyboard: true,
    waveform: true,
    themeSync: true,
    svgInsertion: true,
    nativeCloseDraft: true,
    dock: true,
    rendererErrors: errors,
    paidInference: false,
    microphoneCapture: false,
  };
  await writeFile(join(output, 'floating-chat.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await app.close();
}
