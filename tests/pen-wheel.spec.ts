import { test, expect } from '@playwright/test';
test('笔侧键打开工具环，切换工具不画线，边缘与夜间布局可用', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  for (const view of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    const canvas = page.locator('.canvas-container');
    const r = (await canvas.boundingBox())!;
    await canvas.dispatchEvent('pointerdown', {
      pointerType: 'pen',
      button: 2,
      buttons: 2,
      pressure: 0.5,
      pointerId: 91,
      clientX: r.x + r.width - 3,
      clientY: r.y + 3,
      bubbles: true,
    });
    await canvas.dispatchEvent('pointerup', {
      pointerType: 'pen',
      pointerId: 91,
      button: 0,
      buttons: 0,
      pressure: 0,
      clientX: r.x + r.width - 3,
      clientY: r.y + 3,
      bubbles: true,
    });
    const wheel = page.getByRole('menu', { name: '笔侧键工具环' });
    await expect(wheel).toBeVisible();
    expect(
      await wheel.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight;
      }),
    ).toBe(true);
    await wheel.getByRole('menuitemradio', { name: '移动', exact: true }).click();
    await expect(wheel).toHaveCount(0);
    await expect(page.getByRole('button', { name: '移动', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await canvas.dispatchEvent('pointerdown', {
      pointerType: 'pen',
      button: 2,
      buttons: 2,
      pressure: 0.5,
      pointerId: 92,
      clientX: r.x + 30,
      clientY: r.y + 30,
      bubbles: true,
    });
    await expect(wheel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(wheel).toHaveCount(0);
  }
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.setViewportSize({ width: 380, height: 800 });
  const canvas = page.locator('.canvas-container');
  const r = (await canvas.boundingBox())!;
  await canvas.dispatchEvent('pointerdown', {
    pointerType: 'pen',
    button: 2,
    buttons: 2,
    pressure: 0.5,
    pointerId: 93,
    clientX: r.x + 10,
    clientY: r.y + 10,
    bubbles: true,
  });
  await expect(page.getByRole('menu', { name: '笔侧键工具环' })).toBeInViewport();
  await page.screenshot({ path: 'test-results/pen-wheel-night-portrait.png' });
});
