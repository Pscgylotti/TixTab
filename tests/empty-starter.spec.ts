import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
async function pdf(name: string) {
  const doc = await PDFDocument.create();
  doc.addPage([400, 550]);
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) };
}
test('successful first import replaces starter; multiple PDFs have exactly their own tabs after restart', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page
    .locator('input[type=file][accept=".pdf,.tixtab"]')
    .setInputFiles([await pdf('one.pdf'), await pdf('two.pdf')]);
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab')).toHaveText(['one', 'two']);
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(2);
});
test('failed PDF import preserves starter and edited notebook is not replaced', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const files = page.locator('input[type=file][accept=".pdf,.tixtab"]');
  await files.setInputFiles({
    name: 'bad.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('invalid'),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(1);
  const paper = (await page.locator('.page-editor').boundingBox())!;
  await page.mouse.move(paper.x + 35, paper.y + 35);
  await page.mouse.down();
  await page.mouse.move(paper.x + 75, paper.y + 75, { steps: 5 });
  await page.mouse.up();
  await files.setInputFiles(await pdf('keep-ink.pdf'));
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab').first().click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  const saved = JSON.parse(await fs.readFile((await (await download).path())!, 'utf8'));
  expect(saved.pages[0].strokes).toHaveLength(1);
});

test('slow replacement commit cannot be followed by a stale starter autosave', async ({ page }) => {
  const file = await pdf('slow-save.pdf');
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    let sawPdf = false;
    let holdingAutosave = true;
    const timeout = window.setTimeout.bind(window),
      clear = window.clearTimeout.bind(window);
    const autosaves = new Map<number, () => void>();
    window.setTimeout = (handler, delay, ...args) => {
      if (delay !== 450 || !holdingAutosave || typeof handler !== 'function')
        return timeout(handler, delay, ...args);
      const id = timeout(() => {}, 60000);
      autosaves.set(id, () => handler(...args));
      return id;
    };
    window.clearTimeout = (id) => {
      if (id !== undefined) autosaves.delete(id);
      clear(id);
    };
    Object.assign(window, { staleStarterWrites: 0 });
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'sources') {
        if (value.source instanceof Uint8Array) {
          sawPdf = true;
          holdingAutosave = false;
          for (const [id, save] of autosaves) {
            clear(id);
            timeout(save, 30);
          }
          autosaves.clear();
          // Keep the import awaiting its persistence completion across an autosave deadline.
          const transaction = this.transaction,
            done = transaction.oncomplete;
          if (done)
            transaction.oncomplete = (event) =>
              setTimeout(() => done.call(transaction, event), 800);
        } else if (sawPdf) (window as any).staleStarterWrites++;
      }
      return put.call(this, value, key);
    };
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles(file);
  await expect(page.getByRole('tab', { name: 'slow-save', exact: true })).toBeVisible();
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  expect(await page.evaluate(() => (window as any).staleStarterWrites)).toBe(0);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'slow-save', exact: true })).toBeVisible();
  await expect(page.locator('.page-navigation')).toContainText('1 / 1');
});
