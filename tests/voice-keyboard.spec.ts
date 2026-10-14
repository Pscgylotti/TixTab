import { test, expect } from '@playwright/test';

test('voice keyboard inserts at caret, switches language, shows levels and cancels only its own recording', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: any[] = [];
    const jobs = new Map<string, { language: string; stopped: boolean; n: number }>();
    let active: string;
    Object.assign(window, {
      voiceCalls: calls,
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
                    { id: 'winmm:U3VyZmFjZQ==', name: 'Surface microphone', isDefault: true },
                  ],
                  defaultId: 'winmm:U3VyZmFjZQ==',
                },
              };
            if (r.action === 'start') {
              active = crypto.randomUUID();
              jobs.set(active, { language: r.language, stopped: false, n: 0 });
              return { ok: true, data: { id: active } };
            }
            if (r.action === 'stop' || r.action === 'cancel') {
              if (jobs.has(active)) jobs.get(active)!.stopped = true;
              return { ok: true };
            }
            if (r.action === 'read') {
              await new Promise((resolve) => setTimeout(resolve, 80));
              const job = jobs.get(r.id)!;
              return {
                ok: true,
                data: {
                  text: job.n++ === 0 ? (job.language === 'zh-CN' ? '你好' : 'hello') : '',
                  level: 64,
                  ready: true,
                  done: job.stopped,
                },
              };
            }
            return { ok: true, data: { installed: true, devices: ['CPU', 'GPU', 'NPU'] } };
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '公式', exact: true }).click();
  const field = page.getByLabel('LaTeX · 可直接修改');
  await field.fill('aXXb');
  await field.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(1, 3));
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  const keyboard = page.getByRole('dialog', { name: '悬浮屏幕键盘', exact: true });
  await keyboard.getByRole('button', { name: '语音', exact: true }).click();
  await expect(keyboard.locator('.hg-button')).toHaveCount(0);
  await keyboard.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(field).toHaveValue('a你好b');
  await expect(keyboard.getByRole('img', { name: '麦克风音量波形' })).toHaveAttribute(
    'data-level',
    '64',
  );
  await keyboard.getByLabel('语音输入语言').selectOption('en-US');
  await expect(field).toHaveValue('a你好hellob');
  await keyboard.getByRole('button', { name: '英文', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).voiceCalls.filter((r: any) => r.action === 'cancel').length,
      ),
    )
    .toBe(1);
  await keyboard.getByRole('button', { name: '语音', exact: true }).click();
  await keyboard.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(field).toHaveValue('a你好hello hellob');
  await keyboard.getByRole('button', { name: '关闭屏幕键盘', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).voiceCalls.filter((r: any) => r.action === 'cancel').length,
      ),
    )
    .toBe(2);
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await expect(keyboard.getByRole('button', { name: '语音', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.setViewportSize({ width: 360, height: 640 });
  await keyboard.getByRole('button', { name: '语音设置', exact: true }).click();
  await keyboard.getByLabel('语音输入麦克风').selectOption('winmm:U3VyZmFjZQ==');
  await keyboard.getByLabel('识别引擎').selectOption('whisper-small');
  await keyboard.getByLabel('语音推理设备').selectOption('NPU');
  await expect(keyboard).toBeInViewport();
  expect(await keyboard.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/voice-keyboard.png' });
  await keyboard.getByRole('button', { name: '关闭屏幕键盘', exact: true }).click();
  // An idle keyboard must not cancel a recording owned by the chat composer.
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  const chat = page.locator('.chat-panel');
  await chat.getByLabel('向 ChatGPT 提问').focus();
  await chat.getByRole('button', { name: '语音输入', exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as any).voiceCalls.filter((r: any) => r.action === 'start').at(-1).microphone,
    ),
  ).toBe('winmm:U3VyZmFjZQ==');
  await expect(chat.getByLabel('向 ChatGPT 提问')).toHaveValue('hello');
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await keyboard.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(keyboard).toContainText('语音引擎正在处理上一项任务');
  await keyboard.getByRole('button', { name: '关闭屏幕键盘', exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as any).voiceCalls.filter((r: any) => r.action === 'cancel').length,
    ),
  ).toBe(2);
  await expect(chat.getByRole('button', { name: '停止语音输入', exact: true })).toBeEnabled();
  await chat.getByRole('button', { name: '停止语音输入', exact: true }).click();
});
