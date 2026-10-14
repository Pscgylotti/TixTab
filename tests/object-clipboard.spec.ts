import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';

async function load(page: Page, mode: string) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 50;
    c.getContext('2d')!.fillRect(0, 0, 50, 50);
    return c.toDataURL();
  });
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles({
    name: 'clipboard.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        name: 'Clipboard',
        source: null,
        pages: Array.from({ length: 4 }, (_, n) => ({
          id: `p${n}`,
          sourceIndex: null,
          width: 600,
          height: 900,
          paper: 'plain',
          strokes: [],
          images: [
            {
              id: `a${n}`,
              kind: 'sketch',
              scene: { elements: [] },
              data,
              x: 100,
              y: 100,
              width: 60,
              height: 50,
            },
            {
              id: `b${n}`,
              kind: 'formula',
              latex: '\\RR',
              macros: { '\\RR': '\\mathbb{R}' },
              data,
              x: 220,
              y: 160,
              width: 60,
              height: 50,
            },
            {
              id: `c${n}`,
              kind: 'text',
              textBox: { content: '中文 & <hello>', fontSize: 18, color: '#112233', bold: true },
              data,
              x: 400,
              y: 400,
              width: 80,
              height: 50,
            },
          ],
        })),
      }),
    ),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  if (mode !== 'single')
    await page
      .getByRole('button', { name: mode === 'dual' ? '双页预览' : '连续页面预览', exact: true })
      .click();
  await page.getByRole('button', { name: '对象', exact: true }).click();
}
function editor(page: Page, n = 0) {
  return page
    .locator(n === 0 ? '.page-editor' : `.reading-card[data-page-index="${n}"] .page-editor`)
    .first();
}
async function selectGroup(page: Page, n = 0) {
  const r = (await editor(page, n).boundingBox())!;
  await page.mouse.move(r.x + (r.width * 70) / 600, r.y + (r.height * 70) / 900);
  await page.mouse.down();
  await page.mouse.move(r.x + (r.width * 320) / 600, r.y + (r.height * 260) / 900, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.object-selection')).toHaveAttribute('data-selected-count', '2');
}
async function project(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.tixtab$/);
  return JSON.parse(await fs.readFile((await download.path())!, 'utf8'));
}
for (const mode of ['single', 'continuous', 'dual'])
  test(`${mode}: real clipboard multi-object copy, cut, paste, arrange and undo`, async ({
    page,
  }) => {
    await load(page, mode);
    await selectGroup(page);
    await page.keyboard.press('Control+c');
    const clipboard = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find((i) => i.types.includes('text/html'))!;
      return {
        text: await navigator.clipboard.readText(),
        html: await (await item.getType('text/html')).text(),
      };
    });
    expect(clipboard.html).toContain('data-tixtab-objects');
    expect(clipboard.text).toContain('\\RR');
    await page.keyboard.press('Control+v');
    await expect(editor(page).locator('.placed-object')).toHaveCount(5);
    await expect(page.locator('.object-selection')).toHaveAttribute('data-selected-count', '2');
    let saved = await project(page);
    const originals = saved.pages[0].images.slice(0, 3),
      copies = saved.pages[0].images.slice(3);
    expect(copies[0].scene).toEqual({ elements: [] });
    expect(copies[1].macros).toEqual({ '\\RR': '\\mathbb{R}' });
    expect(copies[1].x - copies[0].x).toBeCloseTo(120);
    expect(copies[1].y - copies[0].y).toBeCloseTo(60);
    expect(copies.map((i: { id: string }) => i.id)).not.toEqual(
      originals.slice(0, 2).map((i: { id: string }) => i.id),
    );
    await page.getByRole('button', { name: '排列顺序', exact: true }).click();
    await page.getByRole('button', { name: '置于底层', exact: true }).click();
    saved = await project(page);
    expect(saved.pages[0].images.slice(0, 2).map((i: { id: string }) => i.id)).toEqual(
      copies.map((i: { id: string }) => i.id),
    );
    await page.keyboard.press('Control+z');
    expect((await project(page)).pages[0].images.slice(3).map((i: { id: string }) => i.id)).toEqual(
      copies.map((i: { id: string }) => i.id),
    );
    await page.keyboard.press('Control+x');
    await expect(editor(page).locator('.placed-object')).toHaveCount(3);
    await page.keyboard.press('Control+z');
    await expect(editor(page).locator('.placed-object')).toHaveCount(5);
    await page.keyboard.press('Control+v');
    await expect(editor(page).locator('.placed-object')).toHaveCount(7);
    await page.evaluate(() => navigator.clipboard.writeText('Before object button copy'));
    await page.getByRole('button', { name: '复制选中对象', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('\\RR');
    await page.getByRole('button', { name: '粘贴对象', exact: true }).click();
    await expect(editor(page).locator('.placed-object')).toHaveCount(9);
    // A text field receives normal text, never another object insertion.
    await page.getByRole('button', { name: '取消对象选择', exact: true }).click();
    if (mode !== 'single')
      await expect(page.locator('.reading-view')).toHaveClass(new RegExp(`reading-${mode}`));
  });
test('dual: copied editable text pastes onto right page; normal text replaces object clipboard', async ({
  page,
}) => {
  await load(page, 'dual');
  await editor(page).locator('.placed-object').nth(2).click();
  await page.keyboard.press('Control+c');
  const right = editor(page, 1),
    r = (await right.boundingBox())!;
  await page.mouse.click(r.x + r.width * 0.55, r.y + r.height * 0.6);
  await page.keyboard.press('Control+v');
  await expect(right.locator('.placed-object')).toHaveCount(4);
  const saved = await project(page);
  expect(saved.pages[0].images).toHaveLength(3);
  expect(saved.pages[1].images[3].textBox.content).toBe('中文 & <hello>');
  await page.getByRole('button', { name: '编辑选中文本框', exact: true }).click();
  const field = page.getByLabel('文本框内容', { exact: true });
  await field.focus();
  await field.press('Control+a');
  await page.keyboard.press('Control+v');
  await expect(field).toHaveValue('中文 & <hello>');
  await page.getByRole('button', { name: '保存文本框', exact: true }).click();
  await expect(page.getByLabel('文本框内容', { exact: true })).toHaveCount(0);
  await page.evaluate(() => navigator.clipboard.writeText('External new text'));
  await page.keyboard.press('Control+v');
  await expect(right.locator('.placed-object')).toHaveCount(5);
  expect((await project(page)).pages[1].images[4].textBox.content).toBe('External new text');
});
test('clipboard failure keeps cut objects and keyboard stacking supports undo', async ({
  page,
}) => {
  await load(page, 'single');
  await selectGroup(page);
  await page.keyboard.press('Control+Shift+]');
  expect((await project(page)).pages[0].images.map((i: { id: string }) => i.id)).toEqual([
    'c0',
    'a0',
    'b0',
  ]);
  await page.keyboard.press('Control+z');
  expect((await project(page)).pages[0].images.map((i: { id: string }) => i.id)).toEqual([
    'a0',
    'b0',
    'c0',
  ]);
  await page.evaluate(() => {
    document.execCommand = () => false;
    Object.defineProperty(navigator.clipboard, 'write', {
      value: async () => {
        throw new Error('denied');
      },
    });
  });
  await page.keyboard.press('Control+x');
  await expect(page.locator('.object-clipboard-error')).toContainText('已保留');
  expect((await project(page)).pages[0].images).toHaveLength(3);
});
test('object stacking changes visible PDF export colors', async ({ page }) => {
  await load(page, 'single');
  const fixture = await project(page);
  const colors = await page.evaluate(() =>
    ['#ff0000', '#0000ff'].map((color) => {
      const c = document.createElement('canvas');
      c.width = c.height = 50;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 50, 50);
      return c.toDataURL();
    }),
  );
  fixture.pages[0].images = fixture.pages[0].images.slice(0, 2).map((i: object, n: number) => ({
    ...i,
    data: colors[n],
    x: 100,
    y: 100,
    width: 100,
    height: 100,
  }));
  fixture.pages = fixture.pages.slice(0, 1);
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles({
    name: 'overlap.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '对象', exact: true }).click();
  const pixel = async () => {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 PDF', exact: true }).click();
    const bytes = Array.from(await fs.readFile((await (await pending).path())!));
    return page.evaluate(async (bytes) => {
      const { loadPdf } = await import('/src/pdf.ts' as string);
      const pdf = await loadPdf(new Uint8Array(bytes));
      const p = await pdf.getPage(1),
        viewport = p.getViewport({ scale: 1 });
      const c = document.createElement('canvas');
      c.width = viewport.width;
      c.height = viewport.height;
      await p.render({ canvas: c, viewport }).promise;
      const rgb = Array.from(c.getContext('2d')!.getImageData(150, 150, 1, 1).data).slice(0, 3);
      await pdf.destroy();
      return rgb;
    }, bytes);
  };
  expect(await pixel()).toEqual([0, 0, 255]);
  await editor(page).locator('.placed-object').last().click();
  await page.getByRole('button', { name: '排列顺序', exact: true }).click();
  await page.getByRole('button', { name: '置于底层', exact: true }).click();
  expect(await pixel()).toEqual([255, 0, 0]);
});
