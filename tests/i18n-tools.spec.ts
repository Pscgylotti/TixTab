import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('surfacetab.locale', 'en'));
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
});

test('Draft controls, default names and custom names survive reload and language changes', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Draft', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Draft', exact: true });
  await panel.getByRole('button', { name: 'Enter draft mode', exact: true }).click();
  await expect(panel.getByLabel('Rename Draft 1', { exact: true })).toHaveValue('Draft 1');
  await panel.getByRole('button', { name: 'New draft', exact: true }).click();
  await panel.getByLabel('Rename Draft 2', { exact: true }).fill('我的计算');
  await panel.getByRole('button', { name: 'Clear current draft', exact: true }).click();
  await expect(panel).toContainText('Clear handwriting and objects? You can undo this.');
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await panel.getByRole('button', { name: 'Close draft panel', exact: true }).click();
  await expect(page.locator('.save-state')).toHaveText('Saved automatically');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: 'Draft', exact: true }).click();
  await expect(panel.getByLabel('Rename Draft 1', { exact: true })).toHaveValue('Draft 1');
  await expect(panel.getByLabel('Rename 我的计算', { exact: true })).toHaveValue('我的计算');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('zh-CN');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '草稿', exact: true }).click();
  const chinese = page.getByRole('dialog', { name: '草稿纸', exact: true });
  await expect(chinese.getByLabel('重命名草稿纸1', { exact: true })).toHaveValue('草稿纸1');
  await expect(chinese.getByLabel('重命名我的计算', { exact: true })).toHaveValue('我的计算');
});

test('English extra tools and Markdown controls preserve entered text', async ({ page }) => {
  await page.getByRole('button', { name: 'Extra tools', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Document correction', exact: true }).click();
  const correction = page.locator('.local-document-dialog');
  await expect(correction).toContainText('Document correction');
  await expect(
    correction.getByRole('button', { name: 'Preview first image', exact: true }),
  ).toBeVisible();
  await correction.getByRole('button', { name: 'Close document tools', exact: true }).click();
  await page.getByRole('button', { name: 'Extra tools', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Music recognition', exact: true }).click();
  await expect(page.locator('.local-document-dialog')).toContainText('Music recognition');
  await page.getByRole('button', { name: 'Close document tools', exact: true }).click();
  await page.getByRole('button', { name: 'Text box', exact: true }).click();
  const text = page.getByRole('dialog', { name: 'Insert text box', exact: true });
  await expect(text.getByRole('group', { name: 'Text format', exact: true })).toBeVisible();
  await text.getByRole('button', { name: 'Markdown', exact: true }).click();
  await text.getByLabel('Text box content', { exact: true }).fill('我的计算 **bold** ~~deleted~~');
  await text.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(text.locator('.text-box-preview strong')).toHaveText('bold');
  await expect(text.locator('.text-box-preview del')).toHaveText('deleted');
  await expect(text.locator('.text-box-preview')).toContainText('我的计算');
  await text.getByRole('button', { name: 'Plain text', exact: true }).click();
  await expect(text.getByLabel('Text box content', { exact: true })).toHaveValue(
    '我的计算 **bold** ~~deleted~~',
  );
});
