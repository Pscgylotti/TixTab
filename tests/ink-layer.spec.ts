import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
async function load(page: Page, mode: string) {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 100;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(0, 0, 100, 100);
    return c.toDataURL();
  });
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles({
    name: 'Ink layers.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        name: 'Ink layers',
        source: null,
        pages: Array.from({ length: 2 }, (_, n) => ({
          id: `p${n}`,
          sourceIndex: null,
          width: 600,
          height: 900,
          paper: 'plain',
          images: [{ id: `i${n}`, kind: 'image', data, x: 100, y: 100, width: 100, height: 100 }],
          strokes: [150, 170].map((y, i) => ({
            id: `s${n}${i}`,
            tool: 'pen',
            color: '#ff0000',
            size: 30,
            points: [
              [110, y, 1],
              [190, y, 1],
            ],
          })),
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
async function project(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  return JSON.parse(await fs.readFile((await (await pending).path())!, 'utf8'));
}
function editor(page: Page) {
  return page.locator('.page-editor').first();
}
async function visiblePixel(page: Page, y: number) {
  const r = (await editor(page).boundingBox())!;
  const png = await page.screenshot({
    clip: {
      x: Math.floor(r.x + (r.width * 150) / 600),
      y: Math.floor(r.y + (r.height * y) / 900),
      width: 3,
      height: 3,
    },
    scale: 'css',
  });
  return page.evaluate(async (base64) => {
    const i = new Image();
    i.src = 'data:image/png;base64,' + base64;
    await i.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 3;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(i, 0, 0);
    return [...ctx.getImageData(1, 1, 1, 1).data].slice(0, 3);
  }, png.toString('base64'));
}
for (const mode of ['single', 'continuous', 'dual'])
  test(`${mode}: entire handwriting group moves above/below objects, actual pixels and restart agree`, async ({
    page,
  }) => {
    await load(page, mode);
    await expect.poll(() => visiblePixel(page, 150)).toEqual([255, 0, 0]);
    await editor(page).locator('.placed-object').click();
    await page.getByRole('button', { name: '排列顺序', exact: true }).click();
    await page.getByRole('button', { name: '置于顶层', exact: true }).click();
    await expect.poll(() => visiblePixel(page, 150)).toEqual([0, 0, 255]);
    await expect.poll(() => visiblePixel(page, 170)).toEqual([0, 0, 255]);
    expect((await project(page)).pages[0].inkLayer).toBe(0);
    await page.keyboard.press('Control+z');
    await expect.poll(() => visiblePixel(page, 150)).toEqual([255, 0, 0]);
    await page.getByRole('button', { name: '选择手写层', exact: true }).click();
    await page.getByRole('button', { name: '置于底层', exact: true }).click();
    await expect.poll(() => visiblePixel(page, 170)).toEqual([0, 0, 255]);
    await page.keyboard.press('Control+]');
    await expect.poll(() => visiblePixel(page, 170)).toEqual([255, 0, 0]);
    const saved = await project(page);
    expect(saved.pages[0].strokes).toHaveLength(2);
    expect(saved.pages[0].inkLayer).toBe(1);
    await expect(page.locator('.save-state')).toContainText('已自动保存');
    await page.reload();
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await expect.poll(() => visiblePixel(page, 150)).toEqual([255, 0, 0]);
    if (mode !== 'single')
      await expect(page.locator('.reading-view')).toHaveClass(new RegExp(`reading-${mode}`));
  });
test('ink exports, capture, chat attachment and thumbnail all respect the single handwriting layer', async ({
  page,
}) => {
  await load(page, 'single');
  await editor(page).locator('.placed-object').click();
  await page.getByRole('button', { name: '排列顺序', exact: true }).click();
  await page.getByRole('button', { name: '置于顶层', exact: true }).click();
  const saved = await project(page);
  const result = await page.evaluate(async (notebook) => {
    const { capturePage } = await import('/src/capturePage.ts' as string),
      { pageChatContext } = await import('/src/chatContext.ts' as string),
      { exportPdf, loadPdf } = await import('/src/pdf.ts' as string);
    const p = notebook.pages[0];
    const pixel = async (data: string, x: number, y: number) => {
      const i = new Image();
      i.src = data;
      await i.decode();
      const c = document.createElement('canvas');
      c.width = i.width;
      c.height = i.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(i, 0, 0);
      return [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
    };
    const output = await loadPdf(await exportPdf(notebook)),
      pdfpage = await output.getPage(1),
      viewport = pdfpage.getViewport({ scale: 1 }),
      canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await pdfpage.render({ canvas, viewport }).promise;
    const pdfPixel = [...canvas.getContext('2d')!.getImageData(150, 150, 1, 1).data].slice(0, 3);
    await output.destroy();
    const capture = await capturePage(p, null, { x: 0, y: 0, width: p.width, height: p.height });
    const chat = await pageChatContext(p, null, 1, 'image', new AbortController().signal);
    const thumbnail = document.querySelector('.page-thumbnail svg') as SVGElement;
    const serializer = new XMLSerializer();
    const svg = serializer
      .serializeToString(thumbnail)
      .replace('<svg', '<svg width="600" height="900"');
    return {
      pdf: pdfPixel,
      capture: await pixel(capture, 375, 375),
      chat: await pixel(chat.image!, 255, 255),
      thumbnail: await pixel(
        'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg))),
        150,
        150,
      ),
    };
  }, saved);
  for (const color of Object.values(result)) {
    expect(color[2]).toBeGreaterThan(245);
    expect(color[0]).toBeLessThan(10);
    expect(color[1]).toBeLessThan(10);
  }
});
