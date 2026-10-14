import { test, expect } from '@playwright/test';
test('voice edit pad selects, edits, copies/pastes and opens clipboard history with original focus', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    Object.assign(window, {
      clipboardOpened: false,
      surfaceDesktop: {
        onFullscreen: () => () => {},
        openClipboardHistory: async () => {
          (window as any).clipboardOpened = document.activeElement?.tagName === 'TEXTAREA';
          return true;
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '公式', exact: true }).click();
  const field = page.getByLabel('LaTeX · 可直接修改');
  await field.fill('alpha beta\nxyz');
  await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 6));
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  const keyboard = page.getByRole('dialog', { name: '悬浮屏幕键盘' });
  await keyboard.getByRole('button', { name: '语音', exact: true }).click();
  expect((await keyboard.boundingBox())!.height).toBeLessThan(300);
  expect((await keyboard.boundingBox())!.width).toBeLessThanOrEqual(440);
  await keyboard.getByRole('button', { name: '开始选择', exact: true }).click();
  for (let i = 0; i < 4; i++) await keyboard.getByRole('button', { name: '向右移动光标' }).click();
  expect(
    await field.evaluate((el: HTMLTextAreaElement) =>
      el.value.slice(el.selectionStart, el.selectionEnd),
    ),
  ).toBe('beta');
  await keyboard.getByRole('button', { name: '复制', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('beta');
  await keyboard.getByRole('button', { name: '剪切', exact: true }).click();
  await expect(field).toHaveValue('alpha \nxyz');
  await keyboard.getByRole('button', { name: '粘贴', exact: true }).click();
  await expect(field).toHaveValue('alpha beta\nxyz');
  await keyboard.getByRole('button', { name: '结束选择' }).click();
  await keyboard.getByRole('button', { name: '向下移动光标' }).click();
  await keyboard.getByRole('button', { name: '行首', exact: true }).click();
  await keyboard.getByRole('button', { name: '删除', exact: true }).click();
  await expect(field).toHaveValue('alpha beta\nyz');
  await keyboard.getByRole('button', { name: '剪贴板历史（Win+V）' }).click();
  expect(await page.evaluate(() => (window as any).clipboardOpened)).toBe(true);
  await page.screenshot({ path: '.cache/page-editing/voice-edit-pad.png' });
});
