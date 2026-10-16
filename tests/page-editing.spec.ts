import { test, expect, type Page as BrowserPage } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { createPdfEditor } = require('../electron/pdf-editor.cjs');
async function fixture() {
  const d = await PDFDocument.create(),
    font = await d.embedFont(StandardFonts.Helvetica);
  for (const [w, h] of [
    [400, 600],
    [800, 500],
    [300, 300],
  ]) {
    const p = d.addPage([w, h]);
    p.drawText('Native editable text', { x: 40, y: h - 60, font, size: 16 });
    const image = await d.embedPng(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    p.drawImage(image, { x: 40, y: h - 240, width: 160, height: 80 });
  }
  return Buffer.from(await d.save());
}
async function open(page: BrowserPage) {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'mixed-edit.pdf',
      mimeType: 'application/pdf',
      buffer: await fixture(),
    });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.locator('.page-card')).toHaveCount(3);
}
test('native PDF editor uses actual short-lived backend, edits content, and undo reloads PDF', async ({
  page,
}) => {
  const owner = {},
    editor = createPdfEditor({
      runtime: resolve('.cache/pdf-editor-runtime'),
      backend: resolve('backend'),
      temporary: resolve('.cache/pdf-editor-ipc'),
    });
  let failPreview = true;
  await page.exposeFunction('pdfEditorRun', async (request: any) => {
    if (request.action === 'preview' && failPreview) {
      failPreview = false;
      return { ok: false, error: 'busy' };
    }
    if (request.source) request.source = new Uint8Array(request.source);
    const result = await editor.run(owner, request);
    if (result.data?.source) result.data.source = Array.from(result.data.source);
    return result;
  });
  await page.addInitScript(() => {
    Object.assign(window, {
      surfaceDesktop: {
        onFullscreen: () => () => {},
        pdfEditor: {
          run: async (request: any) => {
            const result = await (window as any).pdfEditorRun({
              ...request,
              source: request.source ? Array.from(request.source) : undefined,
            });
            if (result.data?.source) result.data.source = new Uint8Array(result.data.source);
            return result;
          },
        },
      },
    });
  });
  try {
    await open(page);
    for (const view of ['单页标注', '连续页面预览', '双页预览']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      await page.getByRole('button', { name: 'PDF 元素', exact: true }).click();
      // Object editing is the default; text content and images are the second mode.
      if (view === '单页标注')
        await page.getByRole('button', { name: '编辑文字内容', exact: true }).click();
      const native = page.getByRole('button', { name: '编辑原生文本', exact: true }).first();
      await expect(native).toBeVisible();
      await native.click();
      const dialog = page.getByRole('dialog', { name: '编辑 PDF 原生元素' });
      await dialog.getByRole('textbox', { name: '文本内容' }).fill('Changed');
      if (view === '单页标注') {
        await expect(dialog.locator('.native-dialog-preview-status')).toContainText(
          '上一项 PDF 编辑尚未结束',
        );
        await expect
          .poll(() =>
            dialog
              .locator('.native-dialog-preview canvas')
              .evaluate((c: HTMLCanvasElement) => c.width),
          )
          .toBeGreaterThan(10);
        await dialog
          .locator('.native-dialog-preview-status')
          .getByRole('button', { name: '重试', exact: true })
          .click();
        await expect(dialog.locator('.native-dialog-preview-status')).toHaveCount(0);
      }
      await expect
        .poll(() =>
          page
            .locator('.native-pdf-preview canvas')
            .first()
            .evaluate((c: HTMLCanvasElement) => c.width)
            .catch(() => 0),
        )
        .toBeGreaterThan(10);
      await expect(dialog.locator('.native-dialog-preview canvas')).toBeVisible();
      await expect(
        page.getByText('暂存预览失败，请检查编辑参数后重试。', { exact: true }),
      ).toHaveCount(0);
      await dialog.getByRole('button', { name: '暂存修改', exact: true }).click();
      await expect(page.getByRole('button', { name: '应用 PDF 编辑', exact: true })).toBeVisible();
      await expect
        .poll(() =>
          page
            .locator('.native-pdf-preview canvas')
            .first()
            .evaluate((c: HTMLCanvasElement) => c.width)
            .catch(() => 0),
        )
        .toBeGreaterThan(10);
      await page.getByRole('button', { name: '应用 PDF 编辑', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.native-pdf-element[title="Changed"]')).toHaveCount(1);
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await expect(page.locator('.native-pdf-element[title="Native editable text"]')).toHaveCount(
        1,
      );
      await page.getByRole('button', { name: '编辑原生图片', exact: true }).first().click();
      await dialog.getByRole('button', { name: '删除', exact: true }).click();
      await page.getByRole('button', { name: '应用 PDF 编辑', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: '编辑原生图片', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await expect(page.getByRole('button', { name: '编辑原生图片', exact: true })).toHaveCount(1);
    }
  } finally {
    editor.dispose();
  }
});
test('review anchors, side cards, dual hover, mixed sizes and scoped rotate/crop/export/undo', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: '便签', exact: true }).click();
  const paper = await page.locator('.paper').boundingBox();
  if (!paper) throw Error('paper');
  await page.mouse.move(paper.x + paper.width * 0.15, paper.y + paper.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(paper.x + paper.width * 0.6, paper.y + paper.height * 0.3, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '移动', exact: true })).toHaveClass(
    /selected|active/,
  );
  await expect(page.locator('.review-anchor')).toHaveCount(1);
  const anchor = await page.locator('.review-anchor').boundingBox();
  expect(anchor!.x).toBeCloseTo(paper.x + paper.width * 0.15, 0);
  expect(anchor!.y).toBeCloseTo(paper.y + paper.height * 0.2, 0);
  const screenStyle = await page.locator('.review-anchor').evaluate((el) => {
    const css = getComputedStyle(el),
      r = el.getBoundingClientRect();
    const scale = r.width / (el as HTMLElement).offsetWidth;
    return {
      border: parseFloat(css.borderTopWidth) * scale,
      radius: parseFloat(css.borderRadius) * scale,
    };
  });
  await expect(page.locator('.review-anchor .review-region-frame rect')).toHaveAttribute(
    'stroke-width',
    '1.5',
  );
  await expect(page.locator('.review-anchor .review-region-frame rect')).toHaveAttribute(
    'vector-effect',
    'non-scaling-stroke',
  );
  expect(screenStyle.radius).toBeCloseTo(5, 0);
  await page.getByRole('textbox', { name: '便签内容' }).fill('Review annotation 测试');
  await page.getByRole('button', { name: '关闭便签', exact: true }).click();
  await expect(page.locator('.review-card')).toHaveCount(0);
  await page.locator('.review-anchor').hover();
  await expect(page.locator('.review-card')).toHaveCount(0);
  await page.locator('.review-anchor').click();
  await expect(page.getByRole('textbox', { name: '便签内容' })).toHaveValue(
    'Review annotation 测试',
  );
  const beforeMove = (await page.locator('.review-anchor').boundingBox())!;
  await page.mouse.move(beforeMove.x + 20, beforeMove.y + beforeMove.height / 2);
  await page.mouse.down();
  await page.mouse.move(beforeMove.x + 50, beforeMove.y + beforeMove.height / 2 + 25, { steps: 5 });
  await page.mouse.up();
  expect((await page.locator('.review-anchor').boundingBox())!.x).toBeCloseTo(beforeMove.x + 30, 0);
  const corner = (await page.locator('.review-resize-handle.se').boundingBox())!;
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 + 30, corner.y + corner.height / 2 + 20, {
    steps: 5,
  });
  await page.mouse.up();
  expect((await page.locator('.review-anchor').boundingBox())!.width).toBeCloseTo(
    beforeMove.width + 30,
    0,
  );
  await page.getByRole('button', { name: '关闭便签', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await page.locator('.review-anchor').boundingBox())!.width).toBeCloseTo(
    beforeMove.width,
    0,
  );
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await page.locator('.review-anchor').boundingBox())!.x).toBeCloseTo(beforeMove.x, 0);
  await page.getByRole('button', { name: '双页预览', exact: true }).click();
  await expect(page.locator('.review-card')).toHaveCount(0);
  await page.locator('.review-anchor').hover();
  await expect(page.locator('.review-card')).toHaveCount(1);
  await expect(page.locator('.review-anchor')).toHaveClass(/highlighted/);
  await page.locator('.review-anchor').click();
  await expect(page.getByRole('textbox', { name: '便签内容' })).toHaveValue(
    'Review annotation 测试',
  );
  await page.getByRole('button', { name: '关闭便签', exact: true }).click();
  await page.mouse.move(10, 10);
  await expect(page.locator('.review-card')).toHaveCount(0);
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  await page.locator('.page-card').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '旋转页面', exact: true }).click();
  const rotate = page.getByRole('dialog', { name: '旋转页面' });
  await rotate.getByRole('combobox', { name: '作用范围' }).selectOption('range');
  await rotate.getByRole('textbox', { name: '页码范围' }).fill('1, 3');
  await rotate.getByRole('button', { name: '顺时针 90°', exact: true }).click();
  await rotate.getByRole('button', { name: '应用修改' }).click();
  await expect(rotate).toHaveCount(0);
  await expect
    .poll(async () => {
      const r = await page.locator('.paper').boundingBox();
      return r!.width / r!.height;
    })
    .toBeCloseTo(1.5, 2);
  await expect(page.locator('.review-anchor')).toHaveCount(1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect
    .poll(async () => {
      const r = await page.locator('.paper').boundingBox();
      return r!.width / r!.height;
    })
    .toBeCloseTo(2 / 3, 2);
  await page.locator('.page-card').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '裁剪页面', exact: true }).click();
  const crop = page.getByRole('dialog', { name: '裁剪页面' });
  await crop.getByRole('combobox', { name: '作用范围' }).selectOption('all');
  await crop.getByRole('button', { name: '在页面上框选裁剪区域' }).click();
  const edge = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(edge.x - 12, edge.y + edge.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width * 0.8, edge.y + edge.height * 0.8, { steps: 5 });
  await page.mouse.up();
  await expect(crop).toBeVisible();
  expect(
    Number(await crop.getByRole('spinbutton', { name: '左侧裁剪 (%)', exact: true }).inputValue()),
  ).toBe(0);
  expect(
    Number(await crop.getByRole('spinbutton', { name: '右侧裁剪 (%)', exact: true }).inputValue()),
  ).toBeCloseTo(20, 0);
  await crop.getByRole('spinbutton', { name: '左侧裁剪 (%)', exact: true }).fill('10');
  await crop.getByRole('spinbutton', { name: '上方裁剪 (%)', exact: true }).fill('10');
  await crop.getByRole('button', { name: '应用修改' }).click();
  await expect(crop).toHaveCount(0);
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await expect(page.locator('.reading-card')).toHaveCount(3);
  const ratios = await page.locator('.reading-paper').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return r.width / r.height;
    }),
  );
  expect(ratios[0]).toBeCloseTo(2 / 3, 2);
  expect(ratios[1]).toBeCloseTo(1.6, 2);
  expect(ratios[2]).toBeCloseTo(1, 2);
  await page.locator('.page-card').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '拆分 / 提取 PDF', exact: true }).click();
  const split = page.getByRole('dialog', { name: '拆分 / 提取 PDF' });
  await split.getByRole('combobox', { name: '作用范围' }).selectOption('all');
  await split.getByRole('combobox', { name: '拆分方式' }).selectOption('each');
  const downloaded = page.waitForEvent('download');
  await split.getByRole('button', { name: '导出', exact: true }).click();
  const file = await downloaded;
  await mkdir('.cache/page-editing', { recursive: true });
  await file.saveAs('.cache/page-editing/pages.zip');
  const bytes = await readFile('.cache/page-editing/pages.zip');
  expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
  expect(bytes.readUInt16LE(bytes.length - 12)).toBe(3);
  await page.screenshot({ path: '.cache/page-editing/continuous-reviews.png' });
});
test('crop samples the chosen PDF page, previews real content, and clockwise/counterclockwise buttons accumulate', async ({
  page,
}) => {
  await open(page);
  await page.locator('.page-card').nth(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '裁剪页面', exact: true }).click();
  const crop = page.getByRole('dialog', { name: '裁剪页面' });
  await expect(crop.getByRole('combobox', { name: '作用范围' })).toHaveValue('current');
  await crop.getByRole('button', { name: '在页面上框选裁剪区域' }).click();
  await expect(crop).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '框选裁剪区域' })).toBeVisible();
  const box = (await page.locator('.paper').boundingBox())!;
  expect(box.width / box.height).toBeCloseTo(1.6, 2);
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.8, { steps: 5 });
  await page.mouse.up();
  await expect(crop).toBeVisible();
  expect(
    Number(await crop.getByRole('spinbutton', { name: '左侧裁剪 (%)', exact: true }).inputValue()),
  ).toBeCloseTo(15, 0);
  expect(
    Number(await crop.getByRole('spinbutton', { name: '上方裁剪 (%)', exact: true }).inputValue()),
  ).toBeCloseTo(20, 0);
  await expect
    .poll(() =>
      crop.locator('.crop-result-preview canvas').evaluate((el: HTMLCanvasElement) => el.width),
    )
    .toBeGreaterThan(1);
  await crop.getByRole('button', { name: '在页面上框选裁剪区域' }).click();
  const edge = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(edge.x - 12, edge.y + edge.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width * 0.8, edge.y + edge.height * 0.8, { steps: 5 });
  await page.mouse.up();
  await expect(crop).toBeVisible();
  expect(
    Number(await crop.getByRole('spinbutton', { name: '左侧裁剪 (%)', exact: true }).inputValue()),
  ).toBe(0);
  expect(
    Number(await crop.getByRole('spinbutton', { name: '右侧裁剪 (%)', exact: true }).inputValue()),
  ).toBeCloseTo(20, 0);
  await crop.getByRole('spinbutton', { name: '左侧裁剪 (%)', exact: true }).fill('10');
  await crop.getByRole('spinbutton', { name: '右侧裁剪 (%)', exact: true }).fill('15');
  await crop.getByRole('spinbutton', { name: '上方裁剪 (%)', exact: true }).fill('20');
  await crop.getByRole('spinbutton', { name: '下方裁剪 (%)', exact: true }).fill('20');
  await crop.getByRole('button', { name: '应用修改' }).click();
  await expect(crop).toHaveCount(0);
  await expect
    .poll(async () => {
      const r = (await page.locator('.paper').boundingBox())!;
      return r.width / r.height;
    })
    .toBeCloseTo(2, 2);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.locator('.page-card').nth(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '旋转页面', exact: true }).click();
  const rotate = page.getByRole('dialog', { name: '旋转页面' });
  await expect(rotate.getByRole('button', { name: '应用修改' })).toBeDisabled();
  await rotate.getByRole('button', { name: '逆时针 90°', exact: true }).click();
  await expect(rotate.locator('.page-edit-preview-paper')).toHaveCSS(
    'transform',
    'matrix(0, -1, 1, 0, 0, 0)',
  );
  await rotate.getByRole('button', { name: '顺时针 90°', exact: true }).click();
  await expect(rotate.getByRole('button', { name: '应用修改' })).toBeDisabled();
  await rotate.getByRole('button', { name: '逆时针 90°', exact: true }).click();
  await rotate.getByRole('button', { name: '应用修改' }).click();
  await expect(rotate).toHaveCount(0);
  await expect
    .poll(async () => {
      const r = (await page.locator('.paper').boundingBox())!;
      return r.width / r.height;
    })
    .toBeCloseTo(0.625, 2);
});
test('review editing is tool-gated; fixed-size cards drag across anchors and clip below application chrome', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: '便签', exact: true }).click();
  const paper = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(paper.x + paper.width * 0.3, paper.y + paper.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(paper.x + paper.width * 0.6, paper.y + paper.height * 0.5, { steps: 4 });
  await page.mouse.up();
  const card = page.locator('.review-card'),
    anchor = page.locator('.review-anchor');
  await page.getByLabel('便签内容').fill('Read-only review');
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  await expect(card.locator('textarea')).toHaveCount(0);
  await expect(page.locator('.review-resize-handle')).toHaveCount(0);
  await expect(anchor.locator('rect')).toHaveAttribute('stroke-width', '0.75');
  const before = (await anchor.boundingBox())!;
  await page.mouse.move(before.x + 10, before.y + 10);
  await page.mouse.down();
  await page.mouse.move(before.x + 50, before.y + 20, { steps: 4 });
  await page.mouse.up();
  expect((await anchor.boundingBox())!.x).toBeCloseTo(before.x, 0);
  await expect(card.locator('textarea')).toHaveCount(0);
  await page.getByRole('button', { name: '移动', exact: true }).click();
  await anchor.click();
  await expect(card.locator('textarea')).toBeVisible();
  await expect(page.locator('.review-resize-handle')).toHaveCount(4);
  const start = (await card.boundingBox())!,
    a = (await anchor.boundingBox())!;
  const target = a.x - 260;
  await page.mouse.move(start.x + 60, start.y + 20);
  await page.mouse.down();
  await page.mouse.move(target + 60, start.y + 20, { steps: 8 });
  await page.mouse.up();
  expect((await card.boundingBox())!.x).toBeCloseTo(target, 0);
  expect((await card.boundingBox())!.width).toBeCloseTo(240, 0);
  const points = await page
    .locator('.review-connector line')
    .evaluate((line) => ['x1', 'x2'].map((key) => Number(line.getAttribute(key))));
  expect(points[0]).toBeGreaterThan(points[1]);
  const parent = await page
    .locator('.review-side-overlay')
    .evaluate((el) => el.parentElement!.className);
  expect(parent).toBe('canvas-container');
  const moved = (await card.boundingBox())!,
    canvas = (await page.locator('.canvas-container').boundingBox())!;
  await page.mouse.move(moved.x + 60, moved.y + 20);
  await page.mouse.down();
  await page.mouse.move(moved.x + 60, canvas.y + 4, { steps: 6 });
  await page.mouse.up();
  const overlaps = await page.evaluate(
    ({ x, y }) =>
      document.elementsFromPoint(x, y).some((el) => el.closest('.review-card,.review-connector')),
    { x: moved.x + 40, y: canvas.y - 5 },
  );
  expect(overlaps).toBe(false);
  await page.screenshot({ path: '.cache/page-editing/review-tool-gated.png' });
});
