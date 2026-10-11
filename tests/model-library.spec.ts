import { test, expect } from '@playwright/test';
test('model catalog is lazy, translated, touch sized, and dark without loading models', async ({
  page,
}) => {
  let weights = 0;
  page.on('request', (r) => {
    if (/\/models\/.*\.(onnx|traineddata|wasm|data)(?:\?|$)/.test(r.url())) weights++;
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '本地模型管理', exact: true }).click();
  await expect(page.locator('.model-card')).toHaveCount(12);
  await expect(
    page.getByText('浏览器预览仅展示模型清单；下载与删除请使用桌面应用。'),
  ).toBeVisible();
  await page.setViewportSize({ width: 560, height: 900 });
  await page.locator('[data-model-id=texo] summary').click();
  await expect(page.locator('[data-model-id=texo]')).toContainText('AGPL-3.0');
  await expect(page.locator('[data-model-id=texo] code')).toHaveCount(6);
  expect(
    await page.locator('.model-manager').evaluate((root) =>
      [root, ...root.querySelectorAll('*')].flatMap((el) => {
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el),
          c = s.backgroundColor.match(/[\d.]+/g)?.map(Number);
        return r.width > 6 &&
          r.height > 6 &&
          s.visibility !== 'hidden' &&
          c &&
          c.slice(0, 3).every((n) => n > 170) &&
          (c.length < 4 || c[3] > 0.3)
          ? [el.className]
          : [];
      }),
    ),
  ).toEqual([]);
  const buttons = await page
    .locator('.model-actions button')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(buttons.every((h) => h >= 44)).toBe(true);
  await page.screenshot({ path: 'test-results/models-night-portrait.png' });
  await page.getByRole('button', { name: '关闭模型管理' }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Local model library', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Local model library' })).toBeVisible();
  await expect(page.getByText('Version, license and files').first()).toBeVisible();
  expect(weights).toBe(0);
});
test('desktop model actions confirm downloads, render progress, cancel and refresh status', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = {
      id: 'texo',
      bundled: false,
      downloaded: false,
      source: 'missing',
      verified: null,
    };
    let callback: (value: unknown) => void = () => {},
      finish: ((value: unknown) => void) | undefined;
    Object.assign(window, {
      surfaceDesktop: {
        onFullscreen: () => () => {},
        models: {
          list: async () => [state, { ...state, id: 'whisper-small' }],
          onProgress: (fn: typeof callback) => {
            callback = fn;
            return () => {};
          },
          run: async (_id: string, action: string) => {
            if (action === 'install') {
              callback({ id: 'texo', action, done: 1000, total: 10000 });
              return new Promise((resolve) => {
                finish = resolve;
              });
            }
            if (action === 'remove') {
              state.downloaded = false;
              state.source = 'missing';
            }
            return { ok: true };
          },
          cancel: async () => {
            finish?.({ ok: false, error: 'cancelled' });
            return true;
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '本地模型管理', exact: true }).click();
  const bottom = page.locator('[data-model-id=whisper-small]');
  await bottom.getByRole('button', { name: '下载', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: '下载模型？' })).toBeInViewport();
  expect(await page.locator('.model-manager-body').evaluate((el) => el.scrollTop)).toBeGreaterThan(
    100,
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog', { name: '下载模型？' })).toHaveCount(0);
  const card = page.locator('[data-model-id=texo]');
  await expect(card.getByRole('button', { name: '下载', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: '下载', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: '下载模型？' })).toContainText('SHA256');
  await expect(page.getByRole('alertdialog', { name: '下载模型？' })).toBeInViewport();
  expect(
    await page.getByRole('alertdialog', { name: '下载模型？' }).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return (
        Math.abs(r.x + r.width / 2 - innerWidth / 2) < 2 &&
        Math.abs(r.y + r.height / 2 - innerHeight / 2) < 2
      );
    }),
  ).toBe(true);
  await page.getByRole('button', { name: '确认下载', exact: true }).click();
  await expect(page.locator('.model-progress progress')).toHaveAttribute('value', '1000');
  await page.getByRole('button', { name: '取消任务' }).click();
  await expect(page.locator('.model-message')).toHaveText('已取消');
  await expect(card.getByRole('button', { name: '下载', exact: true })).toBeEnabled();
});
