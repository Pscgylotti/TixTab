import { test, expect } from '@playwright/test';
test('LaTeX buttons and keyboard undo/redo preserve editor history without changing the PDF page', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '公式', exact: true }).click();
  const field = page.getByLabel('LaTeX · 可直接修改');
  await expect(field).toBeEnabled();
  await field.fill('x');
  await field.fill('x^2');
  await field.press('Control+z');
  await expect(field).toHaveValue('x');
  await field.press('Control+Shift+z');
  await expect(field).toHaveValue('x^2');
  await page.getByRole('button', { name: '撤销 LaTeX 编辑', exact: true }).click();
  await expect(field).toHaveValue('x');
  await page.getByRole('button', { name: '重做 LaTeX 编辑', exact: true }).click();
  await expect(field).toHaveValue('x^2');
  await field.press('Control+z');
  await field.press('Control+y');
  await expect(field).toHaveValue('x^2');
});
