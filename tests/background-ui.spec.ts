import { test, expect } from '@playwright/test';
test('floating keyboard stays for its own keys and hides on physical keyboard input', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '文本框', exact: true }).click();
  const field = page.getByLabel('文本框内容', { exact: true });
  await field.focus();
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await page.locator('.hg-button[data-skbtn="a"]').click();
  await expect(page.getByLabel('悬浮屏幕键盘', { exact: true })).toBeVisible();
  await expect(field).toHaveValue('a');
  await field.press('b');
  await expect(field).toHaveValue('ab');
  await expect(page.getByLabel('悬浮屏幕键盘', { exact: true })).toHaveCount(0);
});

test('model download continues silently after closing, can reopen, cancel, and releases active controls', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let callback = (p: any) => {},
      finish: (result: any) => void = () => {};
    (window as any).surfaceDesktop = {
      onFullscreen: () => () => {},
      models: {
        list: async () => [
          { id: 'texo', source: 'missing', bundled: false, downloaded: false, verified: null },
        ],
        onProgress: (fn: any) => {
          callback = fn;
          return () => {
            callback = () => {};
          };
        },
        run: async (id: string, action: string) => {
          callback({ id, action, done: 20, total: 100 });
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        cancel: async () => {
          finish({ ok: false, error: 'cancelled' });
          return true;
        },
      },
    };
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '本地模型管理', exact: true }).click();
  await page
    .locator('[data-model-id=texo]')
    .getByRole('button', { name: '下载', exact: true })
    .click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '确认下载', exact: true })
    .click();
  await expect(page.locator('.model-progress')).toBeVisible();
  await page.getByRole('button', { name: '关闭模型管理', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '本地模型管理', exact: true })).toBeHidden();
  await expect(page.getByLabel('后台任务', { exact: true })).toContainText('模型下载与管理');
  await page.getByRole('button', { name: '打开任务 模型下载与管理', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '本地模型管理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭模型管理', exact: true }).click();
  await page.getByRole('button', { name: '停止任务 模型下载与管理', exact: true }).click();
  await expect(page.locator('.model-manager')).toHaveCount(0);
  await expect(page.getByLabel('后台任务', { exact: true })).toContainText('已取消');
  await expect(
    page.getByRole('button', { name: '停止任务 模型下载与管理', exact: true }),
  ).toHaveCount(0);
});
