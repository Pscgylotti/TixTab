import { test, expect } from '@playwright/test';
test('editable multiline text objects survive undo and reload, and clipboard images take priority', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.paper').waitFor();
  expect(await page.title()).toBe('TixTab · Thinking over Screen');
  await page.getByRole('button', { name: '文本框', exact: true }).click();
  await page.getByLabel('文本框内容', { exact: true }).fill('  Hello <script>\n中文第二行');
  await page.getByLabel('文本框字号', { exact: true }).fill('24');
  await page.getByLabel('粗体', { exact: true }).check();
  await page.getByRole('button', { name: '插入当前页', exact: true }).click();
  await expect(page.getByLabel('文本框对象', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '编辑选中文本框', exact: true }).click();
  await expect(page.getByLabel('文本框内容', { exact: true })).toHaveValue(
    '  Hello <script>\n中文第二行',
  );
  await page.getByLabel('文本框内容', { exact: true }).fill('Edited 中文\nnext line');
  await page.getByRole('button', { name: '保存文本框', exact: true }).click();
  await expect(page.locator('.placed-object img')).toHaveAttribute('alt', 'Edited 中文\nnext line');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.placed-object img')).toHaveAttribute(
    'alt',
    '  Hello <script>\n中文第二行',
  );
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await page.reload();
  await expect(page.locator('.placed-object img')).toHaveAttribute('alt', 'Edited 中文\nnext line');
  await page.locator('.paper').evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'Pasted <b>literal</b>\n第二行');
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    );
  });
  await expect(page.getByLabel('文本框对象', { exact: true })).toHaveCount(2);
  await expect(page.locator('.placed-object img').last()).toHaveAttribute(
    'alt',
    'Pasted <b>literal</b>\n第二行',
  );
  await page.locator('.paper').evaluate(async (element) => {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 30;
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    data.setData('text/plain', 'Do not duplicate');
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    );
  });
  await expect(page.getByLabel('图片对象', { exact: true })).toHaveCount(1);
  await expect(page.locator('.placed-object')).toHaveCount(3);
  await page.getByRole('button', { name: '文本框', exact: true }).click();
  const handled = await page.getByLabel('文本框内容', { exact: true }).evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'ordinary paste');
    return element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    );
  });
  expect(handled).toBe(true);
  await expect(page.locator('.placed-object')).toHaveCount(3);
});
test('idle preference is persisted and available in English', async ({ page }) => {
  await page.goto('/');
  await page.locator('.paper').waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '任务与后端', exact: true }).click();
  const input = page.getByLabel('模型闲置卸载时间（秒）', { exact: true });
  await expect(input).toHaveValue('1800');
  await input.fill('29');
  await expect(page.getByRole('button', { name: '保存闲置设置', exact: true })).toBeDisabled();
  await input.fill('600');
  await page.getByRole('button', { name: '保存闲置设置', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '任务与后端', exact: true }).click();
  await expect(input).toHaveValue('600');
  await page.getByRole('button', { name: '关闭任务面板', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Tasks and backends', exact: true }).click();
  await expect(page.getByLabel('Model idle unload time (seconds)', { exact: true })).toHaveValue(
    '600',
  );
});
