import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
test('saved first-page icons, old blank icons, and direct card grouping persist without opening PDFs', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([360, 480]).drawText('Stored preview', { x: 30, y: 420, size: 24, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'Preview.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '管理工作空间', exact: true }).click();
  const card = page
    .locator('.workspace-document')
    .filter({ has: page.getByRole('button', { name: '打开文档 Preview', exact: true }) });
  await expect(card.locator('.workspace-preview img')).toBeVisible();
  expect(
    await card
      .locator('.workspace-preview img')
      .evaluate((el: HTMLImageElement) => Math.max(el.naturalWidth, el.naturalHeight)),
  ).toBeLessThanOrEqual(192);
  const group = await page.evaluate(async () => {
    const s = await import('/src/workspaceStore.ts' as string);
    const f = await s.createWorkspaceFolder('Move here');
    const m = await import('/src/model.ts' as string);
    const n = m.newNotebook();
    n.name = 'Legacy no preview';
    await s.saveWorkspaceDocument('legacy-preview', n);
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('surfacetab-workspaces');
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('documents', 'readwrite'),
        st = tx.objectStore('documents'),
        r = st.get('legacy-preview');
      r.onsuccess = () => {
        const v = r.result;
        delete v.preview;
        st.put(v);
      };
      tx.oncomplete = () => resolve();
    });
    db.close();
    return f.id;
  });
  await page.getByRole('button', { name: '关闭工作空间', exact: true }).click();
  await page.getByRole('button', { name: '管理工作空间', exact: true }).click();
  await expect(
    page
      .locator('.workspace-document')
      .filter({ hasText: 'Legacy no preview' })
      .locator('.workspace-preview img'),
  ).toHaveCount(0);
  const before = await page.locator('.document-tab.active').getAttribute('data-tab-id');
  const from = (await card.locator('.workspace-open').boundingBox())!,
    to = (await page.locator(`[data-workspace-group="${group}"]`).boundingBox())!;
  await page.mouse.move(from.x + 80, from.y + 25);
  await page.mouse.down();
  await page.mouse.move(to.x + 30, to.y + 20, { steps: 12 });
  await expect(page.locator(`[data-workspace-group="${group}"]`)).toHaveClass(/drop-target/);
  await page.mouse.up();
  await expect(card.locator('select')).toHaveValue(group);
  expect(await page.locator('.document-tab.active').getAttribute('data-tab-id')).toBe(before);
  await page.getByRole('button', { name: '关闭工作空间', exact: true }).click();
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '管理工作空间', exact: true }).click();
  await expect(card.locator('select')).toHaveValue(group);
  await expect(card.locator('.workspace-preview img')).toBeVisible();
});
test('Markdown text preview inserts sharp editable formatted content and persists source', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '文本框', exact: true }).click();
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await expect(page.getByLabel('文本框字号', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Markdown', exact: true })).toHaveClass(/active/);
  const source =
    '# Title\n\nA **bold** phrase and *italic* 中文.\n\n1. first\n2. second\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n<script>window.badMarkdown=true</script>\n![remote](https://invalid.example/no.png)';
  await page.getByLabel('文本框内容', { exact: true }).fill(source);
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await page.evaluate(async () => {
    const a = await import('/src/appearance.ts' as string);
    a.setNight(true);
  });
  await expect(page.locator('.text-box-preview')).toHaveCSS('background-color', 'rgb(28, 32, 39)');
  await expect(page.locator('.text-box-preview > div')).toHaveCSS(
    'filter',
    'invert(0.9) hue-rotate(180deg)',
  );
  await expect(page.locator('.text-box-preview h1')).toHaveText('Title');
  await expect(page.locator('.text-box-preview strong')).toHaveText('bold');
  await expect(page.locator('.text-box-preview img')).toHaveCount(0);
  await page.getByRole('button', { name: '插入当前页', exact: true }).click();
  await expect(page.getByLabel('文本框对象', { exact: true })).toHaveCount(1);
  const xml = await page
    .locator('.placed-object img')
    .evaluate((el: HTMLImageElement) => atob(el.src.split(',')[1]));
  expect(xml).toContain('<text');
  expect(xml).not.toContain('<script');
  expect(xml).not.toContain('**bold**');
  expect(await page.evaluate(() => (window as any).badMarkdown)).toBeUndefined();
  await page.getByRole('button', { name: '编辑选中文本框', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Markdown', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('文本框内容', { exact: true })).toHaveValue(source);
  await page.getByRole('button', { name: '保存文本框', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await page.reload();
  await expect(page.getByLabel('文本框对象', { exact: true })).toHaveCount(1);
});
test('detached PDF snapshot has converted night pixels with no extra dimming, day pixels survive reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const pdf = await PDFDocument.create();
  pdf.addPage([360, 480]);
  await page.locator('input[type=file]').setInputFiles({
    name: 'Night snapshot.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '草稿', exact: true }).click();
  await page.getByRole('button', { name: '进入草稿模式', exact: true }).click();
  await page.keyboard.press('Escape');
  const card = page.getByRole('button', { name: '第 1 页', exact: true }),
    r = (await card.boundingBox())!,
    v = (await page.locator('.canvas-container').boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(520);
  await page.mouse.move(v.x + 100, v.y + 160, { steps: 12 });
  await page.mouse.up();
  const img = page.locator('.scratch-pdf-page img');
  await expect(img).toHaveCount(1);
  const day = await img.getAttribute('src');
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await expect(img).not.toHaveAttribute('src', day!);
  await expect(img).toHaveCSS('filter', 'none');
  const pixel = await img.evaluate((el: HTMLImageElement) => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    c.getContext('2d')!.drawImage(el, 0, 0, 1, 1);
    return [...c.getContext('2d')!.getImageData(0, 0, 1, 1).data];
  });
  expect(pixel[0]).toBeLessThan(60);
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(img).toHaveCSS('filter', 'none');
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await expect(img).toHaveAttribute('src', day!);
});

test('batch cards show persisted group counts and compact preview layout with grouping at top right', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.evaluate(async () => {
    const s = await import('/src/workspaceStore.ts' as string),
      m = await import('/src/model.ts' as string),
      b = await import('/src/batchWorkspace.ts' as string);
    const n = m.newNotebook();
    n.name = 'Current PDF';
    n.batch = { id: 'batch-card', itemId: 'b', title: 'Research collection' };
    await b.saveBatchManifest({
      id: 'batch-card',
      title: 'Research collection',
      folderId: 'folder',
      items: [
        { id: 'a', name: 'A.pdf', storageId: 'a', edited: true, cached: true },
        { id: 'b', name: 'B.pdf', storageId: 'b', edited: false, cached: true },
        { id: 'c', name: 'C.pdf', storageId: 'c', edited: true, cached: false },
      ],
    });
    await s.saveWorkspaceDocument('batch-card-doc', n);
  });
  await page.getByRole('button', { name: '管理工作空间', exact: true }).click();
  const card = page.locator('[data-document-id="batch-card-doc"]');
  await expect(card).toContainText('连续批注组 · 3 份文档');
  await expect(card).toContainText('当前 2/3 · 已编辑 2 份');
  const icon = await card.locator('.workspace-preview').boundingBox(),
    select = await card.locator('select').boundingBox(),
    box = await card.boundingBox();
  expect(icon!.width).toBe(88);
  expect(icon!.x - box!.x).toBeLessThan(3);
  expect(select!.y - box!.y).toBeLessThan(16);
  expect(select!.x).toBeGreaterThan(box!.x + box!.width / 2);
  await page.screenshot({ path: 'test-results/workspace-cards-day.png' });
  await page.evaluate(async () => {
    const a = await import('/src/appearance.ts' as string);
    a.setNight(true);
  });
  await page.screenshot({ path: 'test-results/workspace-cards-night.png' });
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(card.locator('select')).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace-cards-compact.png' });
});
