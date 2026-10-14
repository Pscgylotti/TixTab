import { test, expect } from '@playwright/test';
test('page jump uses typed input for mouse and a local number pad for touch/pen in all views', async ({
  page,
}) => {
  await page.goto('/');
  const raw = await page.evaluate(async () => {
    const { newNotebook, blankPage } = await import('/src/model.ts' as string);
    const n = newNotebook();
    n.pages = Array.from({ length: 12 }, () => blankPage());
    return JSON.stringify(n);
  });
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'jump.tixtab', mimeType: 'application/json', buffer: Buffer.from(raw) });
  for (const view of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.getByRole('button', { name: '跳转到页码', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '跳转到页码', exact: true });
    await dialog.getByLabel('目标页码', { exact: true }).fill('8');
    await page.keyboard.press('Enter');
    await expect(page.locator('.page-navigation')).toContainText('8 / 12');
    await page.getByRole('button', { name: '跳转到页码', exact: true }).click();
    await dialog.getByLabel('目标页码', { exact: true }).fill('99');
    await expect(dialog.getByRole('button', { name: '跳转', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    const trigger = page.getByRole('button', { name: '跳转到页码', exact: true });
    await trigger.dispatchEvent('pointerdown', { pointerType: 'touch', button: 0 });
    await trigger.dispatchEvent('click', { detail: 1 });
    await expect(dialog.locator('input')).toHaveCount(0);
    await dialog.getByRole('button', { name: '1', exact: true }).click();
    await dialog.getByRole('button', { name: '2', exact: true }).click();
    await expect(dialog.getByLabel('目标页码', { exact: true })).toHaveText('12');
    await dialog.getByRole('button', { name: '跳转', exact: true }).click();
    await expect(page.locator('.page-navigation')).toContainText('12 / 12');
  }
});
