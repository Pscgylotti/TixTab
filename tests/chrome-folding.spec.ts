import { test, expect } from '@playwright/test';
test('collapsed header shares the tab row independently of compact layout and restores at portrait width', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '收起顶部区域', exact: true }).click();
  await expect(page.locator('.app-shell')).not.toHaveClass(/chrome-minimal/);
  const tabs = page.locator('.document-tabs'),
    toggle = page.getByRole('button', { name: '展开顶部区域', exact: true });
  const a = (await tabs.boundingBox())!,
    b = (await toggle.boundingBox())!;
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  expect(b.y + b.height).toBeLessThanOrEqual(a.y + a.height + 2);
  await expect(page.locator('.collapsed-title')).toBeHidden();
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.setViewportSize({ width: 600, height: 1000 });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeVisible();
});
