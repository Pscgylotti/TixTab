import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.evaluate(async () => {
    await navigator.clipboard.writeText('');
  });
});
test('left history controls, previewed text/image/editable objects and ink paste with undo', async ({
  page,
}) => {
  const history = page.getByRole('group', { name: '编辑历史与剪贴板' });
  const first = await page.locator('#drawing-toolbar button').first().getAttribute('aria-label');
  expect(first).toBe('撤销');
  await page.evaluate(async () => {
    const { copyText, copyImage } = await import('/src/clipboard.ts' as string);
    await copyText('First clipboard text');
    await copyText('Second clipboard text');
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 30;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#e02040';
    ctx.fillRect(0, 0, 40, 30);
    await copyImage(canvas.toDataURL());
    const { copyObjects } = await import('/src/objectClipboard.ts' as string);
    const { textBoxImage, defaultTextBox } = await import('/src/textBox.ts' as string);
    const image = await textBoxImage({ ...defaultTextBox, content: 'Editable clipboard object' });
    const { blankPage } = await import('/src/model.ts' as string);
    const p = blankPage();
    p.images.push({
      ...image,
      kind: 'text',
      id: 'copied-object',
      x: 20,
      y: 20,
      width: 200,
      height: 40,
    });
    await copyObjects(p, ['copied-object']);
    const { copyInk } = await import('/src/inkSelection.ts' as string);
    p.strokes.push({
      id: 'copied-ink',
      tool: 'pen',
      color: '#4477dd',
      size: 3,
      points: [
        [40, 40, 0.5],
        [80, 80, 1],
      ],
    });
    await copyInk(p, ['copied-ink']);
  });
  const open = async () => {
    await history.getByRole('button', { name: '剪贴板历史', exact: true }).click();
  };
  const shelf = page.getByRole('dialog', { name: '剪贴板历史', exact: true });
  await open();
  await expect(shelf.locator('.clipboard-shelf-row')).toHaveCount(5);
  await expect(shelf.locator('.clipboard-shelf-preview img')).toHaveCount(3);
  await shelf.getByRole('button', { name: '粘贴：First clipboard text', exact: true }).click();
  await expect(page.getByLabel('文本框对象', { exact: true })).toHaveCount(1);
  await expect(page.locator('.placed-object img')).toHaveAttribute('alt', 'First clipboard text');
  await open();
  await shelf.getByRole('button', { name: '粘贴：图片', exact: true }).click();
  await expect(page.getByLabel('图片对象', { exact: true })).toHaveCount(1);
  await open();
  await shelf.getByRole('button', { name: '粘贴：1 个对象', exact: true }).click();
  await expect(page.getByLabel('文本框对象', { exact: true })).toHaveCount(2);
  await expect(page.locator('.placed-object img').last()).toHaveAttribute(
    'alt',
    'Editable clipboard object',
  );
  await open();
  await shelf.getByRole('button', { name: '粘贴：1 条笔迹', exact: true }).click();
  await expect(history.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  const countInk = () =>
    page.evaluate(async () => {
      const store = await import('/src/workspaceStore.ts' as string);
      const list = await store.listWorkspace();
      return (await store.loadWorkspaceDocument(list.documents[0].id, false)).notebook.pages[0]
        .strokes.length;
    });
  await expect.poll(countInk).toBe(1);
  await history.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(countInk).toBe(0);
  await history.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(countInk).toBe(1);
  await page.getByRole('button', { name: '收起工具栏', exact: true }).click();
  expect(await page.locator('.workspace-heading button').first().getAttribute('aria-label')).toBe(
    '撤销',
  );
  await open();
  await shelf.screenshot({ path: '.cache/clipboard-shelf.png' });
});
test('pause, remove, clear and session lifetime; compact panel stays inside narrow night viewport', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { copyText } = await import('/src/clipboard.ts' as string);
    await copyText('One');
    await copyText('Two');
  });
  const toggle = page.getByRole('button', { name: '剪贴板历史', exact: true });
  const shelf = page.getByRole('dialog', { name: '剪贴板历史', exact: true });
  await toggle.click();
  await shelf.getByRole('button', { name: '暂停记录', exact: true }).click();
  await page.evaluate(async () => {
    const { copyText } = await import('/src/clipboard.ts' as string);
    await copyText('Hidden while paused');
  });
  await expect(shelf.locator('.clipboard-shelf-row')).toHaveCount(2);
  await shelf.getByRole('button', { name: '移除此记录', exact: true }).first().click();
  await expect(shelf.locator('.clipboard-shelf-row')).toHaveCount(1);
  await shelf.getByRole('button', { name: '清空剪贴板历史', exact: true }).click();
  await expect(shelf.locator('.clipboard-shelf-row')).toHaveCount(0);
  await shelf.getByRole('button', { name: '继续记录', exact: true }).click();
  await shelf.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '收起工具栏', exact: true }).click();
  await page.setViewportSize({ width: 380, height: 740 });
  await toggle.click();
  const bounds = (await shelf.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(380);
  await shelf.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(async () => {
    const { copyText } = await import('/src/clipboard.ts' as string);
    await copyText('session only');
    await navigator.clipboard.writeText('');
  });
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await toggle.click();
  await expect(shelf.locator('.clipboard-shelf-row')).toHaveCount(0);
});
test('unlimited small entries use paged previews and follow the memory preference', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { rememberClipboard } = await import('/src/clipboardShelf.ts' as string);
    for (let i = 0; i < 85; i++) rememberClipboard({ text: `History ${i}`, html: '', image: '' });
  });
  await page.getByRole('button', { name: '剪贴板历史', exact: true }).click();
  const shelf = page.getByRole('dialog', { name: '剪贴板历史', exact: true });
  await expect(shelf.locator('.clipboard-shelf-row')).toHaveCount(40);
  await expect(shelf.locator('footer')).toContainText('85 条记录');
  await expect(shelf.locator('footer')).toContainText('/ 128 MB');
  await shelf.getByRole('button', { name: '下一组剪贴板' }).click();
  await expect(shelf.locator('.clipboard-shelf-pages')).toContainText('41–80 / 85');
  await shelf.getByRole('button', { name: '下一组剪贴板' }).click();
  await expect(shelf.locator('.clipboard-shelf-row')).toHaveCount(5);
  await shelf.getByRole('button', { name: '粘贴：History 0', exact: true }).click();
  await expect(page.locator('.placed-object img')).toHaveAttribute('alt', 'History 0');
  await page.evaluate(async () => {
    const { setMemoryMode } = await import('/src/appearance.ts' as string);
    setMemoryMode('minimal');
  });
  await page.getByRole('button', { name: '剪贴板历史', exact: true }).click();
  await expect(shelf.locator('footer')).toContainText('/ 32 MB');
});
