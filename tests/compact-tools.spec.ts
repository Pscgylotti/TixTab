import { test, expect } from '@playwright/test';
test('收缩工具合并到一行，夜间按钮保持位置，窄屏工具可访问', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '收起工具栏', exact: true }).click();
  const heading = page.locator('.workspace-heading'),
    tools = heading.getByRole('group', { name: '标注工具' });
  await expect(tools.getByRole('button')).toHaveCount(8);
  await expect(page.locator('#drawing-toolbar')).toBeHidden();
  expect((await tools.innerText()).trim()).toBe('');
  await expect(page.locator('.workspace-path>span,.workspace-path>svg')).toHaveCount(0);
  for (const width of [1440, 800, 380, 320]) {
    await page.setViewportSize({ width, height: 960 });
    await expect.poll(() => heading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const night = heading.getByRole('button', { name: '实验性夜间模式', exact: true });
    const before = (await night.boundingBox())!.x;
    await night.click();
    const original = heading.getByRole('button', { name: '查看原色', exact: true });
    await expect(original).toBeVisible();
    const current = (await night.boundingBox())!,
      left = (await original.boundingBox())!;
    expect(Math.abs(current.x - before)).toBeLessThan(1);
    expect(left.x + left.width).toBeLessThanOrEqual(current.x);
    for (const name of ['钢笔', '圆珠笔', '铅笔', '移动', '选文', '对象']) {
      const tool = tools.getByRole('button', { name, exact: true });
      await tool.scrollIntoViewIfNeeded();
      await tool.click();
      await expect(tool).toHaveAttribute('aria-pressed', 'true');
    }
    await night.click();
  }
  await expect(page.locator('.preview-toggle')).toHaveCount(0);
  await page.getByRole('button', { name: '展开工具栏', exact: true }).click();
  await expect(page.locator('#drawing-toolbar')).toBeVisible();
});
