import { test, expect } from '@playwright/test';
test('source preferences save, runtime progress survives closing the panel, and logs/cancel remain accessible', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let progress: any,
      finish: any,
      sources = { packages: 'auto', python: 'auto', customIndex: '' };
    const calls: any[] = [];
    Object.assign(window, {
      runtimeCalls: calls,
      surfaceDesktop: {
        onFullscreen: () => () => {},
        models: { list: async () => [], onProgress: () => () => {} },
        runtimes: {
          onProgress: (listener: any) => {
            progress = listener;
            return () => {};
          },
          run: async (request: any) => {
            calls.push(request);
            if (request.action === 'status')
              return { ok: true, data: { installed: false, devices: [] } };
            if (request.action === 'sources') return { ok: true, sources };
            if (request.action === 'configure-sources') {
              sources = request.sources;
              return { ok: true, sources };
            }
            if (request.action === 'install') {
              progress({
                id: request.id,
                stage: 'dependencies',
                source: 'tuna',
                done: 0,
                total: 0,
              });
              return new Promise((resolve) => {
                finish = resolve;
              });
            }
            if (request.action === 'diagnostics')
              return {
                ok: true,
                diagnostics: {
                  id: request.id,
                  installing: true,
                  stage: 'dependencies',
                  logs: 'Downloading PyMuPDF from the selected HTTPS mirror',
                  updatedAt: Date.now(),
                },
              };
            if (request.action === 'cancel') {
              finish?.({ ok: false, error: 'cancelled' });
              return { ok: true };
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
  await setup.locator('summary').filter({ hasText: '下载源设置' }).click();
  await setup
    .getByRole('combobox', { name: 'Python 包优先下载源', exact: true })
    .selectOption('tuna');
  await setup
    .getByRole('combobox', { name: 'Python 本体优先下载源', exact: true })
    .selectOption('npmmirror');
  await setup.getByRole('button', { name: '保存下载源' }).click();
  await expect(setup).toContainText('下载源已保存。');
  await setup.getByRole('button', { name: '自动安装', exact: true }).nth(2).click();
  await page.getByRole('button', { name: '关闭模型管理', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: '关闭安装面板' })).toHaveCount(0);
  await expect(page.getByLabel('后台任务', { exact: true })).toContainText('运行时安装');
  expect(
    await page.evaluate(() => (window as any).runtimeCalls.some((r: any) => r.action === 'cancel')),
  ).toBe(false);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '本地模型管理', exact: true }).click();
  await expect(setup).toContainText('当前源：清华镜像');
  await setup.getByRole('button', { name: '查看安装日志' }).click();
  await expect(setup.getByLabel('安装日志')).toContainText('Downloading PyMuPDF');
  await page.getByRole('button', { name: '关闭模型管理', exact: true }).click();
  await page.getByRole('button', { name: '停止任务 pdf · 运行时安装', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).runtimeCalls.filter((r: any) => r.action === 'cancel').length,
      ),
    )
    .toBe(1);
});
