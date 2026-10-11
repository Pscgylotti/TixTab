import { test, expect } from '@playwright/test';

const answer = String.raw`## Flow matching 与 diffusion

**主要结论：** 两种方法可以通过 *score* 联系起来。

- 先定义概率路径
  - 再求速度场
- 保持边界条件一致

> 推导依赖所选的噪声约定。

行内公式：\(v_t(x)=f_t(x)-\frac{1}{2}g_t^2s_t(x)\)。

\[
\begin{aligned}
s_t(x)&=\nabla_x\log p_t(x)\\
v_t(x)&=f_t(x)-\frac{1}{2}g_t^2s_t(x)
\end{aligned}
\]

| 方法 | 目标 | 所需条件 | 备注 |
| --- | --- | --- | --- |
| Flow matching | 速度场回归 | 给定条件概率路径 | 可以采用直线路径 |
| Diffusion | 噪声或 score 回归 | 指定漂移和扩散系数 | 可以使用 probability flow ODE |

~~~python
def velocity(x, t):
    return drift(x, t) - 0.5 * diffusion(t)**2 * score(x, t)
~~~

参考：[论文](https://example.com/paper)；[不安全链接](javascript:alert%281%29)。

![Remote illustration](https://example.com/no-auto-download.png)

<script>window.markdownExecuted=true</script>

未完成的公式 \(x+
`;

test('restored and streamed Markdown: math, code copy, safe references and responsive modern chat', async ({
  page,
}) => {
  const errors: string[] = [],
    remoteImages: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.url().includes('no-auto-download')) remoteImages.push(r.url());
  });
  await page.addInitScript((text) => {
    let sent = false,
      n = 0;
    const calls: any[] = [];
    Object.assign(window, {
      markdownCalls: calls,
      markdownCopied: '',
      surfaceDesktop: {
        onFullscreen: () => () => {},
        chatgpt: {
          run: async (r: any) => {
            calls.push(r);
            if (r.action === 'status')
              return {
                ok: true,
                data: {
                  accounts: [
                    {
                      id: 'markdown-test',
                      email: 'reader@example.com',
                      signedIn: true,
                      enabled: true,
                    },
                  ],
                  active: 'markdown-test',
                  storage: 'encrypted',
                  welcome: false,
                },
              };
            if (r.action === 'models')
              return { ok: true, data: [{ id: 'm', name: 'Reading model' }] };
            if (r.action === 'start') {
              sent = true;
              n = 0;
              return { ok: true, data: { id: 'j' } };
            }
            if (r.action === 'read') {
              await new Promise((resolve) => setTimeout(resolve, 130));
              n++;
              return {
                ok: true,
                data: {
                  delta: n === 1 ? text.slice(0, 180) : text.slice(180),
                  done: n === 2,
                  error: '',
                },
              };
            }
            return { ok: true, data: true };
          },
        },
      },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).markdownCopied = text;
        },
      },
    });
  }, answer);
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await expect(page.getByLabel('聊天模型', { exact: true })).toHaveValue('m');
  await page.getByRole('button', { name: '账号与模型', exact: true }).click();
  await page.getByLabel('向 ChatGPT 提问').fill('解释公式 **原始提问**');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const message = page.locator('.chat-message.assistant');
  await expect(page.locator('.chat-messages')).toHaveAttribute('aria-busy', 'false');
  await expect(message.getByRole('heading', { level: 2 })).toHaveText('Flow matching 与 diffusion');
  await expect(message.locator('strong')).toHaveText('主要结论：');
  await expect(message.locator('ul ul')).toHaveCount(1);
  await expect(message.locator('blockquote')).toContainText('噪声约定');
  await expect(message.locator('.katex')).toHaveCount(2);
  await expect(message.locator('.katex-error')).toHaveCount(0);
  await expect(message.locator('table tbody tr')).toHaveCount(2);
  await expect(message).toContainText('未完成的公式');
  await expect(page.locator('.chat-user-text')).toHaveText('解释公式 **原始提问**');
  await message.getByRole('button', { name: '复制代码', exact: true }).click();
  expect(await page.evaluate(() => (window as any).markdownCopied)).toBe(
    'def velocity(x, t):\n    return drift(x, t) - 0.5 * diffusion(t)**2 * score(x, t)',
  );
  await message.getByRole('button', { name: '复制消息', exact: true }).click();
  expect(await page.evaluate(() => (window as any).markdownCopied)).toBe(answer);
  await message.getByRole('link', { name: '论文', exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as any).markdownCalls.find((r: any) => r.action === 'open-link').url,
    ),
  ).toBe('https://example.com/paper');
  expect(await page.evaluate(() => (window as any).markdownExecuted)).toBeUndefined();
  expect(remoteImages).toEqual([]);
  await expect(message.locator('img,script')).toHaveCount(0);
  await expect(message.locator('a[href^="javascript:"]')).toHaveCount(0);
  await page.getByRole('button', { name: '收起聊天', exact: true }).click();
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await expect(message.locator('.katex-display')).toHaveCount(1);
  await expect(message.getByRole('heading', { level: 2 })).toBeVisible();
  const scroll = page.locator('.chat-messages');
  await scroll.evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: 'test-results/chat-markdown-day.png' });
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.setViewportSize({ width: 380, height: 800 });
  await expect(page.getByLabel('向 ChatGPT 提问')).toBeInViewport();
  expect(await page.locator('.chat-panel').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  expect(
    await page.locator('.chat-messages').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await scroll.evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: 'test-results/chat-markdown-night.png' });
  await message.locator('.chat-table-scroll').evaluate((el) => (el.scrollLeft = el.scrollWidth));
  expect(
    await message.locator('.chat-table-scroll').evaluate((el) => el.scrollLeft),
  ).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 960 });
  await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.screenshot({ path: 'test-results/chat-markdown-code.png' });
  expect(errors).toEqual([]);
});
