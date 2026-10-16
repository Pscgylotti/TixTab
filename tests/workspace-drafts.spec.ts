import { test, expect } from '@playwright/test';

test('untouched blank tabs stay session-only; first edit saves and survives restart', async ({
  page,
}) => {
  await page.goto('/');
  const manage = page.getByRole('button', { name: '管理工作空间', exact: true });
  await manage.click();
  await expect(page.locator('.workspace-document')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭工作空间', exact: true }).click();
  const first = await page.locator('.document-tab.active').getAttribute('data-tab-id');
  await page.getByRole('button', { name: '新建文档标签', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.locator(`[data-tab-id="${first}"] [role=tab]`).click();
  await manage.click();
  await expect(page.locator('.workspace-document')).toHaveCount(0);
  const counts = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('surfacetab-workspaces');
      r.onsuccess = () => resolve(r.result);
    });
    const result = await Promise.all(
      ['documents', 'pages', 'sources'].map(
        (name) =>
          new Promise<number>((resolve) => {
            const r = db.transaction(name).objectStore(name).count();
            r.onsuccess = () => resolve(r.result);
          }),
      ),
    );
    db.close();
    return result;
  });
  expect(counts).toEqual([0, 0, 0]);
  await page.getByRole('button', { name: '关闭工作空间', exact: true }).click();
  const editor = page.locator('.page-editor');
  const box = (await editor.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 10 });
  await page.mouse.up();
  await manage.click();
  await expect(page.locator('.workspace-document')).toHaveCount(1);
  const select = page.getByLabel('文档分组 未命名笔记', { exact: true });
  const metrics = await select.evaluate((el) => {
    const css = getComputedStyle(el);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = css.font;
    return {
      width: el.getBoundingClientRect().width,
      needed:
        ctx.measureText('未分组').width +
        parseFloat(css.paddingLeft) +
        parseFloat(css.paddingRight) +
        2,
    };
  });
  expect(metrics.width).toBeGreaterThanOrEqual(metrics.needed);
  await page.reload();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const store = await import('/src/workspaceStore.ts' as string);
        const docs = (await store.listWorkspace()).documents;
        return (await store.loadWorkspaceDocument(docs[0].id, false)).notebook.pages[0].strokes
          .length;
      }),
    )
    .toBe(1);
});

test('draft promotion retains its chosen group; existing cleared records and intentional metadata remain', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '管理工作空间', exact: true }).click();
  await page.getByRole('button', { name: '关闭工作空间', exact: true }).click();
  const result = await page.evaluate(async () => {
    const s = await import('/src/workspaceStore.ts' as string),
      m = await import('/src/model.ts' as string);
    const folder = await s.createWorkspaceFolder('Draft group'),
      n = m.newNotebook();
    await s.saveWorkspaceDocument('draft-group', n, s.defaultView, folder.id);
    const before = (await s.listWorkspace()).documents.length;
    const loaded = await s.loadWorkspaceDocument('draft-group');
    const named = { ...loaded.notebook, name: 'Saved draft' };
    await s.saveWorkspaceDocument('draft-group', named);
    const group = (await s.listWorkspace()).documents.find(
      (d: any) => d.id === 'draft-group',
    ).folderId;
    await s.saveWorkspaceDocument('draft-group', n);
    const cleared = (await s.listWorkspace()).documents.some((d: any) => d.id === 'draft-group');
    const color = m.newNotebook();
    color.pages[0].paperColor = '#eeeeee';
    await s.saveWorkspaceDocument('colored', color);
    const bookmark = m.newNotebook();
    bookmark.bookmarks = [{ id: 'b', pageId: bookmark.pages[0].id, title: 'A bookmark' }];
    await s.saveWorkspaceDocument('bookmarked', bookmark);
    const transient = m.newNotebook();
    await s.saveWorkspaceDocument('discarded', transient);
    await s.discardWorkspaceDraft('discarded');
    let discarded = false;
    try {
      await s.loadWorkspaceDocument('discarded');
    } catch {
      discarded = true;
    }
    return {
      before,
      group,
      expected: folder.id,
      cleared,
      ids: (await s.listWorkspace()).documents.map((d: any) => d.id).sort(),
      discarded,
    };
  });
  expect(result).toEqual({
    before: 0,
    group: result.expected,
    expected: result.expected,
    cleared: true,
    ids: ['bookmarked', 'colored', 'draft-group'],
    discarded: true,
  });
});
