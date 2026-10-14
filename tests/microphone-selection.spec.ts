import { test, expect } from '@playwright/test';

test('microphone selection is shared by engines, remembers identity, refreshes defaults and reports disconnects', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: any[] = [];
    let connected = true,
      defaultId = 'winmm:VmlydHVhbA==',
      active: any;
    Object.assign(window, {
      microphoneCalls: calls,
      disconnectMicrophone: () => {
        connected = false;
        defaultId = 'winmm:U3VyZmFjZQ==';
      },
      surfaceDesktop: {
        onFullscreen: () => () => {},
        chatgpt: {
          run: async () => ({ ok: true, data: { accounts: [], active: '', welcome: false } }),
        },
        dictation: {
          run: async (r: any) => {
            calls.push(r);
            if (r.action === 'microphones')
              return {
                ok: true,
                data: {
                  microphones: [
                    {
                      id: 'winmm:VmlydHVhbA==',
                      name: 'Voicemod',
                      isDefault: defaultId === 'winmm:VmlydHVhbA==',
                    },
                    {
                      id: 'winmm:U3VyZmFjZQ==',
                      name: 'Surface microphone',
                      isDefault: defaultId === 'winmm:U3VyZmFjZQ==',
                    },
                    ...(connected ? [{ id: 'winmm:VVNC', name: 'USB microphone' }] : []),
                  ],
                  defaultId,
                },
              };
            if (r.action === 'status')
              return { ok: true, data: { installed: true, devices: ['CPU'] } };
            if (r.action === 'start') {
              active = { id: crypto.randomUUID(), microphone: r.microphone, done: false };
              return { ok: true, data: { id: active.id } };
            }
            if (r.action === 'stop' || r.action === 'cancel') {
              if (active) active.done = true;
              return { ok: true };
            }
            if (r.action === 'read') {
              await new Promise((resolve) => setTimeout(resolve, 60));
              return {
                ok: true,
                data: {
                  ready: true,
                  level: 42,
                  done: active.done,
                  microphoneName:
                    active.microphone === 'winmm:VVNC' ? 'USB microphone' : 'Surface microphone',
                  error:
                    !connected && active.microphone === 'winmm:VVNC' ? 'microphone-missing' : '',
                },
              };
            }
            return { ok: true };
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '本地语音输入', exact: true });
  for (const engine of ['sensevoice-small', 'whisper-small', 'system']) {
    await page.getByRole('button', { name: '语音设置', exact: true }).click();
    await expect(settings.getByLabel('语音输入麦克风')).toBeEnabled();
    await expect(settings.getByLabel('语音输入麦克风')).toContainText('跟随系统默认 · Voicemod');
    await settings.getByLabel('语音输入麦克风').selectOption('winmm:U3VyZmFjZQ==');
    await settings.getByLabel('识别引擎').selectOption(engine);
    await settings.getByRole('button', { name: '关闭语音设置', exact: true }).click();
    await page.getByRole('button', { name: '语音输入', exact: true }).click();
    await expect(page.locator('.chat-voice-input')).toHaveText('Surface microphone');
    await expect(page.getByRole('img', { name: '麦克风音量波形' })).toHaveAttribute(
      'data-level',
      '42',
    );
    expect(
      await page.evaluate(() =>
        (window as any).microphoneCalls.filter((r: any) => r.action === 'start').at(-1),
      ),
    ).toMatchObject({ engine, microphone: 'winmm:U3VyZmFjZQ==' });
    await page.getByRole('button', { name: '停止语音输入', exact: true }).click();
    await expect(page.getByRole('button', { name: '语音输入', exact: true })).toBeEnabled();
  }
  await page.reload();
  if (await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).count())
    await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByRole('button', { name: '语音设置', exact: true }).click();
  await expect(settings.getByLabel('语音输入麦克风')).toHaveValue('winmm:U3VyZmFjZQ==');
  await expect(settings.getByLabel('语音输入麦克风')).toBeEnabled();
  await settings.getByLabel('语音输入麦克风').selectOption('winmm:VVNC');
  await page.evaluate(() => (window as any).disconnectMicrophone());
  await settings.getByRole('button', { name: '刷新麦克风列表', exact: true }).click();
  await expect(settings.getByLabel('语音输入麦克风')).toBeEnabled();
  await expect(settings.getByLabel('语音输入麦克风')).toHaveValue('winmm:VVNC');
  await expect(settings.getByLabel('语音输入麦克风')).toContainText('所选麦克风不可用');
  await expect(settings.getByLabel('语音输入麦克风')).toContainText(
    '跟随系统默认 · Surface microphone',
  );
  await settings.getByRole('button', { name: '关闭语音设置', exact: true }).click();
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.locator('.chat-panel')).toContainText('所选麦克风不可用，请重新连接设备');
  await page.getByRole('button', { name: '语音设置', exact: true }).click();
  await settings.getByLabel('语音输入麦克风').selectOption('winmm:U3VyZmFjZQ==');
  await page.setViewportSize({ width: 380, height: 800 });
  await expect(settings).toBeInViewport();
  expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/microphone-selection.png' });
});
