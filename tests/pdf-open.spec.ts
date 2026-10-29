import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');

test('OS PDF launch creates, reopens, or chooses linked workspace projects without conflating same names', async ({
  page,
}) => {
  const pdf = await PDFDocument.create();
  pdf.addPage([360, 480]).drawText('Associated original PDF', { x: 20, y: 400, size: 18 });
  const bytes = [...(await pdf.save())];
  await page.addInitScript(
    ({ bytes }) => {
      const w = window as any;
      const pending = [
        { name: 'Score.pdf', path: 'C:\\Scores\\Score.pdf', bytes: new Uint8Array(bytes) },
      ];
      let listener = () => {};
      w.openPdf = (path: string, data = bytes) => {
        pending.push({ name: path.split(/[\\/]/).at(-1)!, path, bytes: new Uint8Array(data) });
        listener();
      };
      w.openReads = 0;
      w.surfaceDesktop = {
        onFullscreen: () => () => {},
        toggleFullscreen: async () => false,
        documentOpen: {
          next: async () => {
            w.openReads++;
            return pending.shift() ?? null;
          },
          onRequest: (callback: () => void) => {
            listener = callback;
            return () => {
              listener = () => {};
            };
          },
        },
      };
    },
    { bytes },
  );
  await page.goto('/');
  const name = page.getByRole('textbox', { name: '文档名称', exact: true });
  await expect(name).toHaveValue('Score');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await name.fill('Annotated first');
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  const state = () =>
    page.evaluate(async () => {
      const s = await import('/src/workspaceStore.ts' as string);
      return (await s.listWorkspace()).documents;
    });
  await expect.poll(async () => (await state()).length).toBe(1);
  await page.evaluate(() => (window as any).openPdf('c:/scores/SCORE.PDF'));
  await expect.poll(() => page.evaluate(() => (window as any).openReads)).toBeGreaterThan(2);
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(name).toHaveValue('Annotated first');
  expect((await state()).length).toBe(1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  const project = await fs.readFile((await (await download).path())!);
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'Revision.tixtab', mimeType: 'application/json', buffer: project });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await name.fill('Annotated second');
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await expect.poll(async () => (await state()).length).toBe(2);
  await page.evaluate(() => (window as any).openPdf('D:/Moved/Renamed.pdf'));
  const chooser = page.getByRole('dialog', { name: '选择关联工程', exact: true });
  await expect(chooser).toBeVisible();
  await expect(chooser.locator('.linked-pdf-choice')).toHaveCount(2);
  await expect(chooser.locator('.linked-pdf-preview img')).toHaveCount(2);
  await expect(chooser).toContainText('最后修改');
  await expect(chooser).toContainText('创建时间');
  await page.screenshot({ path: '.cache/linked-pdf-choice.png' });
  await chooser.getByRole('button').filter({ hasText: 'Annotated first' }).click();
  await expect(name).toHaveValue('Annotated first');
  await expect(chooser).toHaveCount(0);
  await page.evaluate(() => (window as any).openPdf('C:/Scores/Score.pdf'));
  await expect(chooser).toBeVisible();
  await chooser.getByRole('button', { name: '取消', exact: true }).last().click();
  await expect(chooser).toHaveCount(0);
  await expect(name).toHaveValue('Annotated first');
  const other = await PDFDocument.create();
  other.addPage([400, 500]).drawText('Different PDF with the same name');
  await page.evaluate(
    (otherBytes) => (window as any).openPdf('D:/Different/Score.pdf', otherBytes),
    [...(await other.save())],
  );
  await expect(name).toHaveValue('Score');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  expect((await state()).length).toBe(3);
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('Different PDF');
});

test('legacy projects without a source path are indexed from embedded PDF bytes', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.pendingFiles = [];
    w.surfaceDesktop = {
      onFullscreen: () => () => {},
      toggleFullscreen: async () => false,
      documentOpen: {
        next: async () => w.pendingFiles.shift() ?? null,
        onRequest: (callback: () => void) => {
          w.openNotify = callback;
          return () => {};
        },
      },
    };
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const pdf = await PDFDocument.create();
  pdf.addPage([360, 480]);
  await page.evaluate(
    async (data) => {
      const s = await import('/src/workspaceStore.ts' as string);
      const { notebook, pdf } = await (
        await import('/src/pdf.ts' as string)
      ).importPdf(new Uint8Array(data), 'Legacy.pdf');
      delete notebook.sourceFingerprint;
      notebook.name = 'Legacy notes';
      await s.saveWorkspaceDocument(
        'legacy-pdf-project',
        notebook,
        s.defaultView,
        null,
        undefined,
        pdf,
        false,
      );
      await pdf.destroy();
      const w = window as any;
      w.pendingFiles.push({
        name: 'Original.pdf',
        path: 'C:/Original.pdf',
        bytes: new Uint8Array(data),
      });
      w.openNotify();
    },
    [...(await pdf.save())],
  );
  await expect(page.getByRole('textbox', { name: '文档名称', exact: true })).toHaveValue(
    'Legacy notes',
  );
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const meta = await page.evaluate(
    async () =>
      (await (await import('/src/workspaceStore.ts' as string)).listWorkspace()).documents[0],
  );
  expect(meta.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
});
