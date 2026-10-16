import { test, expect } from '@playwright/test';
for (const failure of [false, true])
  test(`tail voice opt-in ${failure ? 'keeps text without sending on recognition failure' : 'drains the last phrase and sends exactly once'}`, async ({
    page,
  }) => {
    const sent: any[] = [];
    await page.route('https://tail.test/**', async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n',
      });
    });
    await page.addInitScript((failure) => {
      const progressListeners = new Set<(progress: any) => void>();
      (window as any).__voiceProgress = (progress: any) =>
        progressListeners.forEach((fn) => fn(progress));
      let press = () => {},
        stopped = false,
        reads = 0;
      (window as any).__voiceCalls = [];
      (window as any).__pressTail = () => press();
      (window as any).surfaceDesktop = {
        onFullscreen: () => () => {},
        penTailVoice: {
          configure: async (enabled: boolean) => ({ ok: true, enabled }),
          onPress: (fn: () => void) => {
            press = fn;
            return () => {
              press = () => {};
            };
          },
        },
        dictation: {
          onProgress: (fn: (progress: any) => void) => {
            progressListeners.add(fn);
            return () => progressListeners.delete(fn);
          },
          run: async (r: any) => {
            (window as any).__voiceCalls.push(r);
            if (r.action === 'start') {
              stopped = false;
              reads = 0;
              return { ok: true, data: { id: 'recording' } };
            }
            if (r.action === 'stop') {
              stopped = true;
              return { ok: true };
            }
            if (r.action === 'read') {
              await new Promise((resolve) => setTimeout(resolve, 60));
              return {
                ok: true,
                data: {
                  text: stopped ? 'the final words' : reads++ === 0 ? 'First words' : '',
                  done: stopped,
                  ready: true,
                  error: stopped && failure ? 'inference' : undefined,
                },
              };
            }
            if (r.action === 'windows-status') return { ok: true, data: { state: 'Ready' } };
            if (r.action === 'windows-prepare')
              return await new Promise((resolve) => {
                (window as any).__completeWindowsPreparation = () => resolve({ ok: true });
              });
            return { ok: true, data: { installed: true, devices: ['CPU'], microphones: [] } };
          },
        },
      };
    }, failure);
    await page.goto('/');
    await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
    await page.evaluate(() => (window as any).__pressTail());
    await expect(page.getByRole('complementary', { name: 'AI 阅读助手' })).toHaveCount(0);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('Surface Pen 尾键语音助手', { exact: true }).check();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
    await page.getByLabel('聊天接入方式', { exact: true }).selectOption('api');
    await page.getByLabel('聊天 API 地址', { exact: true }).fill('https://tail.test/v1');
    await page.getByLabel('聊天 API 模型', { exact: true }).fill('test-model');
    await page.getByLabel('聊天 API 密钥', { exact: true }).fill('test-key');
    await page.getByRole('button', { name: '语音设置', exact: true }).click();
    await page.getByLabel('识别引擎', { exact: true }).selectOption('windows-ai');
    await page.getByRole('button', { name: '检查 Windows 语音', exact: true }).click();
    await expect(page.locator('.chat-voice-settings')).toContainText('Ready');
    await page.getByRole('button', { name: '准备 Windows 语音模型', exact: true }).click();
    await expect(page.getByText('等待 Windows 返回模型进度…', { exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).__voiceProgress({ stage: 'Installing', value: 0.4 }));
    await expect(page.getByLabel('系统语音模型准备进度', { exact: true })).toHaveAttribute(
      'value',
      '0.4',
    );
    await expect(page.locator('.chat-voice-settings')).toContainText('40%');
    await page.evaluate(() => (window as any).__completeWindowsPreparation());
    await expect(
      page.getByRole('button', { name: '准备 Windows 语音模型', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: '语音设置', exact: true }).click();
    await page.getByRole('button', { name: '收起聊天', exact: true }).click();
    await page.evaluate(() => (window as any).__pressTail());
    const input = page.getByLabel('向 LLM 提问', { exact: true });
    await expect(input).toHaveValue('First words');
    expect(sent).toHaveLength(0);
    await page.evaluate(() => (window as any).__pressTail());
    if (failure) {
      await expect(input).toHaveValue('First words\nthe final words');
      await expect(page.getByRole('complementary', { name: 'AI 阅读助手' })).toContainText(
        '语音识别失败',
      );
      expect(sent).toHaveLength(0);
    } else {
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0].messages.at(-1).content).toContain('First words\nthe final words');
    }
    const starts = await page.evaluate(() =>
      (window as any).__voiceCalls.filter((r: any) => r.action === 'start'),
    );
    expect(starts).toHaveLength(1);
    expect(starts[0].engine).toBe('windows-ai');
    await page.getByRole('button', { name: '收起聊天', exact: true }).click();
    await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
    await expect(page.getByRole('button', { name: '语音输入', exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as any).__voiceCalls.filter((r: any) => r.action === 'start').length,
      ),
    ).toBe(1);
    await page.getByRole('button', { name: '收起聊天', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('Surface Pen 尾键语音助手', { exact: true }).uncheck();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => (window as any).__pressTail());
    await expect(page.getByRole('complementary', { name: 'AI 阅读助手' })).toHaveCount(0);
  });
