import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
async function pdf(name: string, count: number) {
  const document = await PDFDocument.create(),
    font = await document.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= count; i++)
    document.addPage([400, 550]).drawText(`${name} page ${i}`, { x: 40, y: 450, font, size: 20 });
  return { name: `${name}.pdf`, bytes: [...(await document.save())], type: 'application/pdf' };
}
async function drop(
  page: Page,
  files: { name: string; bytes: number[]; type: string }[],
  selector = '.paper',
) {
  await page
    .locator(selector)
    .first()
    .evaluate((element, files) => {
      const data = new DataTransfer();
      for (const file of files)
        data.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          clientX: rect.x + rect.width * 0.3,
          clientY: rect.y + rect.height * 0.35,
        }),
      );
    }, files);
}
test('.tixtab project drag import restores editable objects and saves the new extension', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const notebook = {
    version: 1,
    name: 'TixTab project',
    source: null,
    pages: [
      {
        id: 'format-page',
        sourceIndex: null,
        width: 400,
        height: 550,
        paper: 'lines',
        strokes: [],
        images: [],
      },
    ],
  };
  await drop(page, [
    {
      name: 'Project.tixtab',
      type: 'application/json',
      bytes: [...new TextEncoder().encode(JSON.stringify(notebook))],
    },
  ]);
  await expect(page.getByLabel('文档名称', { exact: true })).toHaveValue('TixTab project');
  await expect(page.locator('input[type=file][accept=".pdf,.tixtab"]')).toHaveCount(1);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('TixTab project.tixtab');
});
test('PDF drop asks before opening, inserts specified pages in order, undo/redo restores sources and export', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await drop(page, [await pdf('First', 3)]);
  await expect(page.getByRole('dialog', { name: '导入 PDF', exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByLabel('插入当前文档的当前页之后', { exact: true }).check();
  await page.getByLabel('插入全部页面', { exact: true }).uncheck();
  await page.getByLabel('页码范围 · First.pdf', { exact: true }).fill('9');
  await page.getByRole('button', { name: '插入页面', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('页码范围无效');
  await page.getByLabel('页码范围 · First.pdf', { exact: true }).fill('3, 1');
  await page.getByRole('button', { name: '插入页面', exact: true }).click();
  await expect(page.locator('.page-navigation > span')).toContainText('2 / 3');
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('First page 3');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('First page 1');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.page-navigation > span')).toContainText('1 / 1');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await page.getByRole('button', { name: '第 2 页', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('First page 3');
  await drop(page, [await pdf('Second', 2)]);
  await page.getByLabel('插入当前文档的当前页之后', { exact: true }).check();
  await page.getByRole('button', { name: '插入页面', exact: true }).click();
  await expect(page.locator('.page-navigation > span')).toContainText('3 / 5');
  await expect(page.locator('.textLayer')).toContainText('Second page 1');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.page-navigation > span')).toContainText('/ 3');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PDF', exact: true }).click();
  const download = await pending;
  const { readFile } = await import('node:fs/promises');
  expect((await PDFDocument.load(await readFile((await download.path())!))).getPageCount()).toBe(5);
});
test('image and SVG drops preserve vector display, insert multiple objects and support grouped undo', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 60;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'red';
    context.fillRect(0, 0, 80, 60);
    return [...Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), (c) => c.charCodeAt(0))];
  });
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><script>throw 1</script><rect width="200" height="100" fill="blue"/></svg>';
  await drop(page, [
    { name: 'Red.png', type: 'image/png', bytes: png },
    { name: 'Vector.svg', type: 'image/svg+xml', bytes: [...new TextEncoder().encode(svg)] },
  ]);
  await expect(page.locator('.placed-object')).toHaveCount(2);
  await expect(page.locator('.placed-object img').nth(1)).toHaveAttribute(
    'src',
    /^data:image\/svg\+xml;base64,/,
  );
  expect(
    await page
      .locator('.placed-object img')
      .nth(1)
      .evaluate((el) => atob((el as HTMLImageElement).src.split(',')[1]).includes('<script')),
  ).toBe(false);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.placed-object')).toHaveCount(0);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.placed-object')).toHaveCount(2);
  await page.locator('.placed-object').last().click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.placed-object')).toHaveCount(1);
  await drop(page, [await pdf('Cancel', 2)]);
  await page
    .getByRole('dialog', { name: '导入 PDF', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await expect(page.locator('.page-navigation > span')).toContainText('1 / 1');
  await expect(page.locator('.placed-object')).toHaveCount(1);
});
