import { test, expect } from '@playwright/test';
test('收缩工具合并到一行，夜间按钮保持位置，窄屏工具可访问', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '收起工具栏', exact: true }).click();
  const heading = page.locator('.workspace-heading'),
    tools = heading.getByRole('group', { name: '标注工具' });
  await expect(tools.getByRole('button')).toHaveCount(9);
  await expect(page.locator('#drawing-toolbar')).toBeHidden();
  expect((await tools.innerText()).trim()).toBe('');
  const ink = heading.locator('.compact-edit-controls');
  const history = heading.getByRole('group', { name: '编辑历史与剪贴板' });
  await expect(ink.getByRole('button', { name: '笔触颜色', exact: true })).toBeVisible();
  await expect(ink.locator('.color-swatch')).toHaveCount(0);
  await expect(ink.getByRole('slider', { name: '笔触粗细' })).toBeVisible();
  await expect(history.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await expect(history.getByRole('button', { name: '重做', exact: true })).toBeDisabled();
  await ink.getByRole('button', { name: '笔触颜色', exact: true }).click();
  const colors = page.getByRole('dialog', { name: '自定义笔触颜色', exact: true });
  await expect(colors.getByRole('group', { name: '预设颜色' }).getByRole('button')).toHaveCount(6);
  await colors.getByRole('button', { name: '颜色 #e46d65', exact: true }).click();
  await expect(colors).toHaveCount(0);
  await ink.getByRole('button', { name: '笔触颜色', exact: true }).click();
  await colors.getByRole('textbox', { name: '十六进制颜色' }).fill('#123456');
  await colors.getByRole('button', { name: '应用颜色' }).click();
  expect(
    await ink.locator('.selected-ink-color').evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe('rgb(18, 52, 86)');
  const slider = ink.getByRole('slider', { name: '笔触粗细' });
  await slider.focus();
  await slider.press('End');
  await expect(slider).toHaveValue('100');
  await expect(slider).toHaveAttribute('aria-valuetext', '12.00');
  await tools.getByRole('button', { name: '钢笔', exact: true }).click();
  const paper = (await page.locator('.paper').first().boundingBox())!;
  await page.mouse.move(paper.x + paper.width * 0.5, paper.y + paper.height * 0.72);
  await page.mouse.down();
  await page.mouse.move(paper.x + paper.width * 0.6, paper.y + paper.height * 0.75, { steps: 4 });
  await page.mouse.up();
  await expect(history.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
  await history.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(history.getByRole('button', { name: '重做', exact: true })).toBeEnabled();
  await history.getByRole('button', { name: '重做', exact: true }).click();
  await expect(history.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
  await heading.screenshot({ path: '.cache/compact-ink-controls.png' });
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
