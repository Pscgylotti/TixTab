import { test, expect } from '@playwright/test';
const illustration =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" onload="alert(1)"><script>alert(2)</script><foreignObject><div>unsafe</div></foreignObject><image href="https://outside.invalid/image.png"/><rect x="10" y="10" width="300" height="160" fill="#4682b4"/><text x="40" y="95" font-size="24" fill="white">Surface 思考</text></svg>';
async function mock(page: import('@playwright/test').Page) {
  await page.addInitScript(
    ({ illustration }) => {
      const calls: unknown[] = [];
      Object.assign(window, {
        chatCalls: calls,
        surfaceDesktop: {
          onFullscreen: () => () => {},
          chatgpt: {
            run: async (request: any) => {
              calls.push(request);
              if (request.action === 'status')
                return {
                  ok: true,
                  data: {
                    accounts: [
                      { id: 'test', email: 'reader@example.com', enabled: true, signedIn: true },
                    ],
                    active: 'test',
                    storage: 'session',
                    welcome: false,
                  },
                };
              if (request.action === 'models')
                return { ok: true, data: [{ id: 'test-model', name: 'Test model' }] };
              if (request.action === 'start') return { ok: true, data: { id: 'generation' } };
              if (request.action === 'read')
                return {
                  ok: true,
                  data: { delta: '```svg\n' + illustration + '\n```', done: true },
                };
              return { ok: true, data: {} };
            },
          },
        },
      });
    },
    { illustration },
  );
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
}
test('floating chat preserves draft, page context and keyboard input without reducing PDF width', async ({
  page,
}) => {
  await mock(page);
  const original = await page.locator('.canvas-container').evaluate((el) => el.clientWidth);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByLabel('向 ChatGPT 提问').fill('A draft');
  const popupEvent = page.waitForEvent('popup');
  await page.getByRole('button', { name: '在独立悬浮窗中打开', exact: true }).click();
  const popup = await popupEvent;
  await expect(popup.getByLabel('向 ChatGPT 提问')).toHaveValue('A draft');
  await expect(page.locator('.chat-panel')).toHaveCount(0);
  expect(await page.locator('.canvas-container').evaluate((el) => el.clientWidth)).toBe(original);
  await page.getByRole('button', { name: '加页', exact: true }).click();
  await expect(popup.getByLabel('聊天附件页码')).toHaveValue('2');
  await popup.getByLabel('向 ChatGPT 提问').focus();
  await popup.getByLabel('向 ChatGPT 提问').press('End');
  await popup.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await popup.getByRole('button', { name: '英文', exact: true }).click();
  await popup.locator('.hg-button[data-skbtn="x"]').click();
  await expect(popup.getByLabel('向 ChatGPT 提问')).toHaveValue('A draftx');
  await popup.getByRole('button', { name: '关闭屏幕键盘', exact: true }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await expect(popup.locator('html')).toHaveAttribute('data-night', 'true');
  await popup.getByRole('button', { name: '停靠到侧栏', exact: true }).click();
  await expect(page.getByLabel('向 ChatGPT 提问')).toHaveValue('A draftx');
  await expect.poll(() => popup.isClosed()).toBe(true);
  expect(
    await page.evaluate(
      () => (window as any).chatCalls.filter((r: any) => r.action === 'start').length,
    ),
  ).toBe(0);
});
test('generate SVG request, safe vector preview and object insertion can be undone and deleted', async ({
  page,
}) => {
  await mock(page);
  let external = 0;
  await page.route('https://outside.invalid/**', (route) => {
    external++;
    return route.abort();
  });
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByLabel('向 ChatGPT 提问').fill('画一个蓝色矩形并写上 Surface 思考');
  await page.getByRole('button', { name: '根据描述生成 SVG', exact: true }).click();
  await expect(page.getByRole('button', { name: '插入 SVG 到当前页', exact: true })).toBeVisible();
  const safe = await page.locator('.chat-svg-preview img').evaluate((image) => {
    const text = atob((image as HTMLImageElement).src.split(',')[1]);
    return {
      active: /<script|foreignObject|<image|onload|outside\.invalid/.test(text),
      rect: /<rect/.test(text),
    };
  });
  expect(safe).toEqual({ active: false, rect: true });
  expect(external).toBe(0);
  expect(
    JSON.stringify(
      await page.evaluate(() => (window as any).chatCalls.find((r: any) => r.action === 'start')),
    ),
  ).toContain('蓝色矩形');
  await page.getByRole('button', { name: '插入 SVG 到当前页', exact: true }).click();
  await expect(page.locator('.placed-object img')).toHaveAttribute(
    'src',
    /^data:image\/svg\+xml;base64,/,
  );
  await page.getByRole('button', { name: '收起聊天', exact: true }).click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.placed-object')).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.placed-object')).toHaveCount(1);
});
