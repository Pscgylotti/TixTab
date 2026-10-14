import { test, expect } from '@playwright/test';
test('runtime setup reports readiness, progress, failure/retry and English labels', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let listener: any,
      attempts = 0;
    Object.assign(window, {
      surfaceDesktop: {
        onFullscreen: () => () => {},
        models: { list: async () => [], onProgress: () => () => {} },
        runtimes: {
          onProgress: (callback: any) => {
            listener = callback;
            return () => {};
          },
          run: async (r: any) => {
            if (r.action === 'status') return { ok: true, data: { installed: false, devices: [] } };
            if (r.action === 'install') {
              listener?.({ id: r.id, stage: 'dependencies', done: 0, total: 0 });
              await new Promise((resolve) => setTimeout(resolve, 250));
              return ++attempts === 1
                ? { ok: false, error: 'network' }
                : { ok: true, data: { installed: true, devices: ['CPU', 'GPU'] } };
            }
            return { ok: true };
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '本地模型管理', exact: true }).click();
  const setup = page.getByRole('region', { name: '自动安装本地运行时' });
  await setup.getByRole('button', { name: '自动安装', exact: true }).first().click();
  await expect(setup).toContainText('安装依赖，首次可能需要几分钟…');
  await expect(setup).toContainText('所有下载源均失败，请查看安装日志后重试。');
  await setup.getByRole('button', { name: '自动安装', exact: true }).first().click();
  await expect(setup).toContainText('运行时已准备就绪。');
  await expect(setup.getByRole('button', { name: '已就绪', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '关闭模型管理', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Local model library', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Set up local runtimes' })).toBeVisible();
});
