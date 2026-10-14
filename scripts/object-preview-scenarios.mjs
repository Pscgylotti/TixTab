import { createRequire } from 'node:module';
import { expect } from '@playwright/test';
import { waitForPerformanceSettled } from './performance-settle.mjs';
const sharp = createRequire(import.meta.url)('sharp');
const svgUrl = (xml) => 'data:image/svg+xml;base64,' + Buffer.from(xml).toString('base64');
export async function previewFixture() {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="96"><circle cx="43.25" cy="45.125" r="36.375" fill="#d95569" fill-opacity=".43"/><path d="M2.125 90.25 Q67.375 -6.125 125.875 78.5" fill="none" stroke="#285a87" stroke-width="2.375"/></svg>';
  const png =
    'data:image/png;base64,' + (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');
  const formula = svgUrl(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><text x="4" y="45" font-size="29" fill="#29497e">x² + y = 1</text><path d="M5 58 H110" stroke="#d93b64" stroke-width="1.5"/></svg>',
  );
  const text = svgUrl(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><text x="1.25" y="34.125" font-size="21" fill="#30222e">Fractional</text><text x="1.25" y="64.125" font-size="21" fill="#30222e">Aa 123 笔</text></svg>',
  );
  const children = [
    { id: 'g-a', kind: 'image', data: png, x: 0, y: 0, width: 68, height: 50 },
    {
      id: 'g-b',
      kind: 'formula',
      data: png,
      displayData: formula,
      latex: 'x^2+y=1',
      x: 35,
      y: 22,
      width: 70,
      height: 48,
    },
  ];
  const images = [
    { id: 'a', kind: 'image', data: png, x: 75.25, y: 90.125, width: 110.5, height: 72.25 },
    {
      id: 'b',
      kind: 'formula',
      data: png,
      displayData: formula,
      latex: 'x^2+y=1',
      x: 130.125,
      y: 118.375,
      width: 105.25,
      height: 66.5,
    },
    {
      id: 'c',
      kind: 'text',
      data: png,
      displayData: text,
      textBox: { content: 'Fractional Aa 123 笔', fontSize: 21, color: '#30222e', bold: false },
      x: 215.5,
      y: 150.25,
      width: 120.75,
      height: 82.375,
    },
    {
      id: 'd',
      kind: 'sketch',
      data: png,
      displayData: svgUrl(svg),
      scene: { elements: [] },
      x: 280.75,
      y: 175.625,
      width: 105,
      height: 70.75,
    },
    {
      id: 'g',
      kind: 'image',
      data: png,
      group: { width: 110, height: 75, objects: children },
      x: 395.125,
      y: 225.5,
      width: 110.25,
      height: 75.125,
    },
  ];
  const notebook = {
    version: 1,
    name: 'Object preview quality',
    source: null,
    pages: [0, 1].map((n) => ({
      id: `preview-page-${n}`,
      sourceIndex: null,
      width: 595,
      height: 842,
      paper: 'plain',
      inkLayer: 2,
      strokes: [
        {
          id: `ink-${n}`,
          tool: 'pencil',
          color: '#256ca5',
          size: 8,
          points: [
            [45, 185, 0.2],
            [170, 203, 0.8],
            [350, 227, 0.5],
            [500, 245, 0.7],
          ],
        },
      ],
      images: images.map((i) => ({ ...i, x: i.x - n * 5.5, y: i.y - n * 8 })),
    })),
  };
  return { notebook, bytes: Buffer.from(JSON.stringify(notebook)) };
}
export async function previewReady(page) {
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await waitForPerformanceSettled(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.querySelectorAll('.placed-object img')].map((i) => i.decode()));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}
export async function loadPreviewFixture(page, fixture, path) {
  await page.locator('input[accept=".pdf,.tixtab"]').setInputFiles(
    path ?? {
      name: 'preview.tixtab',
      mimeType: 'application/json',
      buffer: fixture.bytes,
    },
  );
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  await page.getByRole('button', { name: '适合页面', exact: true }).click();
  await page.getByRole('button', { name: '对象', exact: true }).click();
  await previewReady(page);
}
export async function selectPreviewObjects(page, ids = ['a', 'c', 'g']) {
  await page.keyboard.press('Escape');
  for (let n = 0; n < ids.length; n++) {
    await page
      .locator(`.page-editor [data-object-id="${ids[n]}"]`)
      .first()
      .evaluate((el, shift) => {
        el.setPointerCapture = () => {};
        const r = el.getBoundingClientRect();
        const opts = {
          bubbles: true,
          pointerId: 81,
          pointerType: 'pen',
          button: 0,
          buttons: 1,
          pressure: 0.6,
          shiftKey: shift,
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height / 2,
        };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
      }, n > 0);
  }
  await expect(page.locator('.object-selection')).toHaveAttribute(
    'data-selected-count',
    String(ids.length),
  );
  await previewReady(page);
}
export async function beginObjectPreview(page, resize = false) {
  const box = await page.locator('.object-selection').evaluate((el) => ({
    x: parseFloat(el.style.left),
    y: parseFloat(el.style.top),
    width: parseFloat(el.style.width),
    height: parseFloat(el.style.height),
  }));
  const from = resize ? [box.x + box.width, box.y + box.height] : [350, 120];
  const to = resize ? [from[0] + 18.125, from[1] + 12.625] : [from[0] + 12.5, from[1] + 9.25];
  await page.locator(resize ? '.object-handle.se' : '.object-selection').evaluate(
    async (el, { from, to }) => {
      el.setPointerCapture = () => {};
      const root = el.closest('.page-editor');
      const emit = (type, x, y) => {
        const r = root.getBoundingClientRect();
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 89,
            pointerType: 'pen',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
            pressure: 0.6,
            clientX: r.x + (x / 595) * r.width,
            clientY: r.y + (y / 842) * r.height,
          }),
        );
      };
      window.__objectPreviewEnd = (type) => emit(type, ...to);
      emit('pointerdown', ...from);
      for (let n = 1; n <= 8; n++) {
        emit(
          'pointermove',
          from[0] + ((to[0] - from[0]) * n) / 8,
          from[1] + ((to[1] - from[1]) * n) / 8,
        );
        await new Promise(requestAnimationFrame);
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    { from, to },
  );
  return { box, from, to };
}
export async function finishObjectPreview(page, type = 'pointerup') {
  await page.evaluate((type) => window.__objectPreviewEnd(type), type);
  await previewReady(page);
}
export async function objectGeometry(page) {
  return page
    .locator('.page-editor')
    .first()
    .locator('.placed-object')
    .evaluateAll((nodes) =>
      nodes.map((el) => ({
        id: el.dataset.objectId,
        x: parseFloat(el.style.left),
        y: parseFloat(el.style.top),
        width: parseFloat(el.style.width),
        height: parseFloat(el.style.height),
        zIndex: el.style.zIndex,
      })),
    );
}
export async function previewPixels(page) {
  const r = await page.locator('.page-editor').first().boundingBox(),
    v =
      page.viewportSize() ??
      (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const x = Math.max(0, r.x),
    y = Math.max(0, r.y),
    right = Math.min(v.width, r.x + r.width),
    bottom = Math.min(v.height, r.y + r.height);
  return page.screenshot({
    clip: { x, y, width: right - x, height: bottom - y },
    animations: 'disabled',
  });
}
export async function hidePreviewGuides(page) {
  await page.addStyleTag({
    content:
      '.object-selection{border-color:transparent!important}.object-handle{opacity:0!important}.placed-object{outline-color:transparent!important}',
  });
}
