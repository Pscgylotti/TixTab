import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
async function edit(page: Page) {
  const paper = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(paper.x + paper.width * 0.5, paper.y + paper.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(paper.x + paper.width * 0.65, paper.y + paper.height * 0.65, { steps: 5 });
  await page.mouse.up();
}
test('one folder tab lazily reads PDFs, restores edits, searches/jumps and exports only edited documents', async ({
  page,
}) => {
  const source = await PDFDocument.create(),
    font = await source.embedFont(StandardFonts.Helvetica);
  source.addPage([400, 600]).drawText('Batch original', { font, x: 40, y: 520 });
  await page.addInitScript(
    (encoded) => {
      (window as any).__batchReads = [];
      (window as any).__batchWrites = [];
      (window as any).surfaceDesktop = {
        onFullscreen: () => () => {},
        toggleFullscreen: async () => false,
        batchPdf: {
          run: async (request: any) => {
            if (request.action === 'choose')
              return {
                ok: true,
                folder: {
                  id: 'folder-capability',
                  name: 'Paper folder',
                  files: [
                    { id: 'a', name: 'a.pdf' },
                    { id: 'b', name: 'b.pdf' },
                    { id: 'c', name: 'nested/c.pdf' },
                  ],
                },
              };
            if (request.action === 'read') {
              (window as any).__batchReads.push(request.fileId);
              return { ok: true, bytes: Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)) };
            }
            if (request.action === 'choose-output')
              return (window as any).__cancelExport
                ? { ok: false, cancelled: true }
                : { ok: true, token: 'output' };
            if (request.action === 'write') {
              (window as any).__batchWrites.push({
                name: request.name,
                bytes: Array.from(request.bytes),
              });
              return { ok: true };
            }
            return { ok: true };
          },
        },
      };
    },
    Buffer.from(await source.save()).toString('base64'),
  );
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '管理工作空间', exact: true }).click();
  await page.getByRole('button', { name: '连续批注', exact: true }).click();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const panel = page.getByRole('region', { name: '连续批注', exact: true });
  await expect(panel).toHaveCSS('position', 'fixed');
  expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(272);
  expect(await panel.evaluate((element) => element.parentElement === document.body)).toBe(true);
  const beforeDrag = (await panel.boundingBox())!;
  await page.mouse.move(beforeDrag.x + 15, beforeDrag.y + 12);
  await page.mouse.down();
  await page.mouse.move(30, 30, { steps: 6 });
  await page.mouse.up();
  expect((await panel.boundingBox())!.x).toBeLessThan(
    (await page.locator('.canvas-container').boundingBox())!.x,
  );
  await page.mouse.move(30, 30);
  await page.mouse.down();
  await page.mouse.move(beforeDrag.x + 15, beforeDrag.y + 12, { steps: 6 });
  await page.mouse.up();
  await expect(panel).toContainText('1 / 3');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Paper folder', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__batchReads)).toEqual(['a']);
  await edit(page);
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await panel.getByRole('button', { name: '下一份 PDF', exact: true }).click();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(panel).toContainText('2 / 3');
  await expect(page.getByRole('button', { name: '连续页面预览', exact: true })).toHaveClass(
    /active/,
  );
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  await edit(page);
  await page.getByRole('button', { name: '双页预览', exact: true }).click();
  await panel.getByRole('button', { name: '下一份 PDF', exact: true }).click();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(panel).toContainText('3 / 3');
  await expect(page.getByRole('button', { name: '双页预览', exact: true })).toHaveClass(/active/);
  await panel.getByRole('textbox', { name: '跳转到第几份 PDF' }).fill('1');
  await panel.getByRole('button', { name: '跳转', exact: true }).click();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(panel).toContainText('1 / 3');
  await expect(page.getByRole('button', { name: '连续页面预览', exact: true })).toHaveClass(
    /active/,
  );
  expect(await page.evaluate(() => (window as any).__batchReads)).toEqual(['a', 'b', 'c']);
  await panel.getByRole('button', { name: '展开文件列表' }).click();
  await panel.getByRole('textbox', { name: '搜索 PDF 文件名' }).fill('b.pdf');
  await panel.getByRole('listitem').click();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(panel).toContainText('2 / 3');
  await page.evaluate(() => {
    (window as any).__cancelExport = true;
  });
  await panel.getByRole('button', { name: '导出已编辑 PDF' }).click();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__batchWrites)).toEqual([]);
  await page.evaluate(() => {
    (window as any).__cancelExport = false;
  });
  await panel.getByRole('button', { name: '导出已编辑 PDF' }).click();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const writes = await page.evaluate(() => (window as any).__batchWrites);
  expect(writes.map((item: any) => item.name)).toEqual(['a-annotated.pdf', 'b-annotated.pdf']);
  for (const output of writes)
    expect((await PDFDocument.load(new Uint8Array(output.bytes))).getPageCount()).toBe(1);
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(panel).toContainText('2 / 3');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: '管理工作空间', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '工作空间管理' })).toContainText('1 份本地文档');
  await page.getByRole('button', { name: '关闭工作空间' }).click();
  await panel.getByRole('button', { name: '上一份 PDF', exact: true }).click();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__batchReads)).toEqual([]);
  const strokes = await page.evaluate(async () => {
    const store = await import('/src/workspaceStore.ts' as string);
    const entry = (await store.listWorkspace()).documents[0];
    return (await store.loadWorkspaceDocument(entry.id, false)).notebook.pages[0].strokes.length;
  });
  expect(strokes).toBe(1);
});
