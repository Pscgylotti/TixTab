import { test, expect } from '@playwright/test';
test('neural voice preparation, device selection, final phrase drain and compact night settings', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let installed = false,
      runtime = false,
      active: any;
    const jobs: Record<string, any> = {},
      calls: any[] = [];
    Object.assign(window, {
      voiceCalls: calls,
      surfaceDesktop: {
        onFullscreen: () => () => {},
        chatgpt: {
          run: async () => ({
            ok: true,
            data: { accounts: [], active: '', storage: 'encrypted', welcome: false },
          }),
        },
        models: {
          list: async () =>
            ['sensevoice-small', 'whisper-small'].map((id) => ({
              id,
              source: installed ? 'downloaded' : 'missing',
              bundled: false,
              downloaded: installed,
            })),
          run: async (id: string, action: string) => {
            calls.push({ model: id, action });
            installed = true;
            return { ok: true };
          },
          onProgress: () => () => {},
          cancel: async () => true,
        },
        dictation: {
          run: async (r: any) => {
            calls.push(r);
            if (r.action === 'microphones')
              return { ok: true, data: { microphones: [], defaultId: '' } };
            if (r.action === 'status')
              return {
                ok: true,
                data: { installed: runtime, devices: runtime ? ['CPU', 'GPU', 'NPU'] : [] },
              };
            if (r.action === 'setup') {
              runtime = true;
              return { ok: true, data: { installed: true, devices: ['CPU', 'GPU', 'NPU'] } };
            }
            if (r.action === 'start') {
              const id = crypto.randomUUID();
              active = jobs[id] = { stopped: false, n: 0 };
              return { ok: true, data: { id } };
            }
            if (r.action === 'stop' || r.action === 'cancel') {
              if (active) active.stopped = true;
              return { ok: true };
            }
            if (r.action === 'read') {
              await new Promise((resolve) => setTimeout(resolve, 100));
              const job = jobs[r.id];
              return {
                ok: true,
                data: {
                  text: job.stopped ? '最后一句。' : ++job.n === 1 ? '解释这条公式。' : '',
                  ready: !job.stopped,
                  done: job.stopped,
                  error: '',
                  level: 60,
                  device: 'NPU',
                },
              };
            }
            return { ok: true };
          },
        },
      },
    });
  });
  await page.setViewportSize({ width: 380, height: 800 });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByRole('button', { name: '账号与模型', exact: true }).click();
  await page.getByRole('button', { name: '语音设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '本地语音输入', exact: true });
  await expect(settings.getByLabel('识别引擎')).toHaveValue('sensevoice-small');
  await settings.getByRole('button', { name: /下载模型/ }).click();
  await expect(settings).toContainText('模型已安装');
  await settings.getByRole('button', { name: '安装本地语音运行时', exact: true }).click();
  await expect(settings).toContainText('运行时已安装');
  await settings.getByLabel('识别引擎').selectOption('whisper-small');
  await settings.getByLabel('语音推理设备').selectOption('NPU');
  await expect(settings).toBeInViewport();
  expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/voice-model-settings-day.png' });
  await settings.getByRole('button', { name: '关闭语音设置', exact: true }).click();
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.getByLabel('向 ChatGPT 提问')).toHaveValue('解释这条公式。');
  await page.getByRole('button', { name: '停止语音输入', exact: true }).click();
  await expect(page.getByLabel('向 ChatGPT 提问')).toHaveValue('解释这条公式。\n最后一句。');
  const calls = await page.evaluate(() => (window as any).voiceCalls);
  expect(calls.find((c: any) => c.action === 'start')).toMatchObject({
    engine: 'whisper-small',
    device: 'NPU',
    language: 'zh-CN',
  });
  await page.getByRole('button', { name: '收起聊天', exact: true }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByRole('button', { name: '语音设置', exact: true }).click();
  await expect(settings.getByLabel('识别引擎')).toHaveValue('whisper-small');
  await expect(settings.getByLabel('语音推理设备')).toHaveValue('NPU');
  await page.screenshot({ path: 'test-results/voice-model-settings-night.png' });
  await settings.getByRole('button', { name: '关闭语音设置', exact: true }).click();
  await page.getByRole('button', { name: '收起聊天', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Open ChatGPT chat', exact: true }).click();
  await page.getByRole('button', { name: 'Voice settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Local voice input', exact: true })).toBeVisible();
  await expect(page.getByLabel('Recognition engine')).toHaveValue('whisper-small');
});
