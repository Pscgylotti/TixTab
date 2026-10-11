import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createRequire } from 'node:module';
const sharp = createRequire(import.meta.url)('sharp');
async function noWhiteBlocks(page, path) {
  const { data, info } = await sharp(await page.screenshot({ path }))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let longest = 0;
  const vertical = new Uint32Array(info.width);
  for (let y = 0; y < info.height; y++) {
    let run = 0;
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels,
        light = data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200;
      run = light ? run + 1 : 0;
      vertical[x] = light ? vertical[x] + 1 : 0;
      longest = Math.max(longest, run, vertical[x]);
    }
  }
  assert.ok(longest < 80, `Night UI has a white raster/gradient/border spanning ${longest}px`);
}
export async function verifyNightUi(page) {
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 60;
    const x = c.getContext('2d');
    x.fillStyle = 'red';
    x.fillRect(0, 0, 60, 60);
    return c.toDataURL();
  });
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    image = await pdf.embedPng(png),
    p = pdf.addPage([600, 800]);
  p.drawText('Night mode packaged check', { x: 60, y: 700, size: 24, font });
  p.drawRectangle({ x: 60, y: 600, width: 100, height: 40, color: rgb(0, 0, 0) });
  p.drawImage(image, { x: 200, y: 400, width: 150, height: 150 });
  await page.locator('input[type=file]').setInputFiles({
    name: 'night-package.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  const sidebarWasCollapsed =
    (await page.getByRole('button', { name: '展开页面栏', exact: true }).count()) > 0;
  if (sidebarWasCollapsed)
    await page.getByRole('button', { name: '展开页面栏', exact: true }).click();
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await page.waitForFunction(() =>
    ['.reading-pdf', '.page-thumbnail canvas'].every((selector) => {
      const c = document.querySelector(selector);
      return c?.width > 100 && c.getContext('2d').getImageData(0, 0, 1, 1).data[0] === 255;
    }),
  );
  // Hold the real render scheduler as during a long pen interaction. This
  // exposes stale day canvases even when the worker normally finishes quickly.
  await page.evaluate(() =>
    document.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 98765 })),
  );
  try {
    await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.night === 'true' &&
        document.querySelector('.reading-content')?.dataset.pdfNight === 'true',
    );
    const stale = await page
      .locator('.reading-pdf,.page-thumbnail canvas,.pdf-detail-tile canvas')
      .evaluateAll((canvases) =>
        canvases
          .filter((c) => c.width > 1 && c.getContext('2d').getImageData(0, 0, 1, 1).data[0] === 255)
          .map((c) => getComputedStyle(c).visibility),
      );
    assert.ok(stale.length >= 2, 'Must exercise a painted day reading page and thumbnail');
    assert.ok(
      stale.every((visibility) => visibility === 'hidden'),
      'Pending night conversion must not show stale white PDF pixels',
    );
    await page.screenshot({ path: 'test-results/packaged-night-pending.png' });
  } finally {
    await page.evaluate(() =>
      document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 98765 })),
    );
  }
  await page.waitForFunction(() => {
    const c = document.querySelector('.reading-pdf');
    return (
      c?.width > 100 &&
      c.getContext('2d').getImageData(0, 0, 1, 1).data[0] === 28 &&
      getComputedStyle(c).visibility === 'visible'
    );
  });
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  await page.waitForFunction(() => {
    const c = document.querySelector('.pdf-layer');
    return c?.width > 100 && c.getContext('2d').getImageData(0, 0, 1, 1).data[0] === 28;
  });
  if (sidebarWasCollapsed)
    await page.getByRole('button', { name: '收起页面栏', exact: true }).click();
  console.log(
    'Packaged night switch / pending reading and thumbnail conversion: no stale white canvases',
  );
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.locator('.formula-canvas').waitFor();
  assert.equal(
    await page.locator('.formula-drawing').evaluate((el) => getComputedStyle(el).borderTopColor),
    'rgb(74, 87, 112)',
  );
  await noWhiteBlocks(page, 'test-results/packaged-night-formula-surfaces.png');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '草图', exact: true }).click();
  await page.locator('.excalidraw.theme--dark').waitFor();
  await page.getByRole('button', { name: '保存草图并关闭', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await page.locator('.workspace-manager').waitFor();
  await page.locator('.workspace-document').first().waitFor();
  assert.equal(
    await page.locator('.workspace-manager').evaluate((el) => getComputedStyle(el).colorScheme),
    'dark',
  );
  assert.equal(
    await page
      .locator('.workspace-document-actions select')
      .first()
      .evaluate((el) => getComputedStyle(el).colorScheme),
    'dark',
  );
  const laterSkin = await page.addStyleTag({
    content:
      ':root[data-night=true]{--library-panel:white;--library-card:white;--library-nav:white;--library-input:white}',
  });
  const lightWorkspace = () =>
    page.locator('.workspace-manager').evaluate((root) =>
      [root, ...root.querySelectorAll('*')].flatMap((el) => {
        const s = getComputedStyle(el),
          r = el.getBoundingClientRect(),
          v = s.backgroundColor.match(/[\d.]+/g)?.map(Number);
        return r.width > 6 &&
          r.height > 6 &&
          r.right > 0 &&
          r.bottom > 0 &&
          r.left < innerWidth &&
          r.top < innerHeight &&
          s.visibility !== 'hidden' &&
          v &&
          v.slice(0, 3).every((n) => n > 170) &&
          (v.length < 4 || v[3] > 0.3)
          ? [`${el.tagName}.${el.className}: ${s.backgroundColor}`]
          : [];
      }),
    );
  assert.deepEqual(await lightWorkspace(), [], 'Night workspace must have no light UI surfaces');
  await page.getByRole('button', { name: '新建分组', exact: true }).click();
  await page.getByLabel('新的名称').fill('Night preview');
  assert.deepEqual(await lightWorkspace(), [], 'Night workspace name field must stay dark');
  await page.screenshot({ path: 'test-results/packaged-night-workspace.png' });
  await noWhiteBlocks(page, 'test-results/packaged-night-workspace-after-editors.png');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.workspace-document-actions button').last().click();
  await page.getByRole('alertdialog').waitFor();
  assert.deepEqual(
    await lightWorkspace(),
    [],
    'Night workspace delete confirmation must stay dark',
  );
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await laterSkin.evaluate((el) => el.remove());
  await page.getByRole('button', { name: '关闭工作空间', exact: true }).click();
  console.log(
    'Packaged night workspace / inputs / delete confirmation / isolated palette / native controls: verified',
  );
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const paper = await page.locator('.paper').boundingBox();
  const stage = await page.locator('.canvas-container').boundingBox();
  const right = Math.min(paper.x + paper.width * 0.9, stage.x + stage.width - 30),
    left = Math.max(paper.x + paper.width * 0.7, stage.x + 30);
  const top = Math.max(paper.y + paper.height * 0.25, stage.y + 30),
    bottom = Math.min(paper.y + paper.height * 0.4, stage.y + stage.height - 30);
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('img', { name: '选中区域', exact: true }).waitFor();
  const original = await page
    .getByRole('img', { name: '选中区域', exact: true })
    .evaluate(async (img) => {
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      return Array.from(x.getImageData(c.width / 2, c.height / 2, 1, 1).data).slice(0, 3);
    });
  assert.deepEqual(original, [255, 255, 255], 'OCR inputs must keep original colors');
  await noWhiteBlocks(page, 'test-results/packaged-night-ocr-surfaces.png');
  await page
    .getByRole('dialog', { name: '区域识别' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  console.log(
    'Packaged night formula border / lazy styles / OCR preview pixels and original input: verified',
  );
  const chrome = await page.evaluate(() => {
    const keyboard = getComputedStyle(document.querySelector('.keyboard-toggle'));
    const swatch = getComputedStyle(document.querySelector('.color-swatch'));
    return {
      keyboardBackground: keyboard.backgroundColor,
      keyboardBorder: keyboard.borderTopColor,
      swatchBorder: swatch.borderTopColor,
      swatchColor: swatch.backgroundColor,
    };
  });
  for (const color of [chrome.keyboardBackground, chrome.keyboardBorder, chrome.swatchBorder])
    assert.ok(
      color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .every((v) => Number(v) < 128),
      `Unexpected light night chrome: ${color}`,
    );
  await page.locator('.color-swatch').first().hover();
  assert.equal(
    await page
      .locator('.color-swatch')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    chrome.swatchColor,
    'Hover must preserve the ink color',
  );
  await page.mouse.move(0, 0);
  const keyboardWasOpen = await page.locator('.touch-keyboard').isVisible();
  if (!keyboardWasOpen) await page.locator('.keyboard-toggle').click();
  // Real Windows Electron canvases: neutral text edges must remain neutral.
  // Includes partially covered edge pixels, rather than only black/white centers.
  const edges = await page.locator('.pdf-layer').evaluate((c) => {
    const x = Math.floor((55 * c.width) / 600),
      y = Math.floor((72 * c.height) / 800),
      w = Math.floor((380 * c.width) / 600),
      h = Math.floor((34 * c.height) / 800);
    const data = c.getContext('2d').getImageData(x, y, w, h).data;
    let colored = 0,
      antialiased = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 30 && data[i] < 228) antialiased++;
      if (Math.abs(data[i + 1] - data[i] - 4) > 1 || Math.abs(data[i + 2] - data[i] - 11) > 1)
        colored++;
    }
    return { colored, antialiased };
  });
  assert.equal(edges.colored, 0, 'Night text must not retain Windows RGB subpixel fringes');
  assert.ok(edges.antialiased > 50, 'Grayscale antialiasing must remain present');
  console.log('Packaged night grayscale text edges:', edges);
  await page.locator('.touch-keyboard .hg-button').first().waitFor();
  const keyColor = await page
    .locator('.touch-keyboard .hg-button')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.ok(
    keyColor
      .match(/[\d.]+/g)
      .slice(0, 3)
      .every((v) => Number(v) < 128),
    `Unexpected light night key: ${keyColor}`,
  );
  await page.screenshot({ path: 'test-results/packaged-night-keyboard.png' });
  if (!keyboardWasOpen) await page.locator('.keyboard-toggle').click();
  assert.deepEqual(
    await page
      .locator('.pdf-layer')
      .evaluate((c) =>
        Array.from(
          c.getContext('2d').getImageData((250 * c.width) / 600, (330 * c.height) / 800, 1, 1).data,
        ).slice(0, 3),
      ),
    [158, 0, 0],
  );
  assert.equal(typeof (await page.evaluate(() => window.surfaceDesktop.getOnBattery())), 'boolean');
  await page.getByRole('button', { name: '移动', exact: true }).click();
  await page.getByRole('button', { name: '查看原图 1', exact: true }).click();
  await page.waitForFunction(() => {
    const c = document.querySelector('.original-image-content canvas');
    return (
      c?.width > 100 &&
      c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data[0] === 255
    );
  });
  await page.getByRole('button', { name: '关闭原图', exact: true }).click();
  await page.getByRole('button', { name: '查看原色', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.pdf-layer').getContext('2d').getImageData(0, 0, 1, 1).data[0] ===
      255,
  );
  await page.getByRole('button', { name: '恢复夜间颜色', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('渲染与能耗', { exact: true }).selectOption('eco');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({ path: 'test-results/packaged-night-eco.png' });
  await page.reload();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('html').getAttribute('data-night'), 'true');
  assert.equal(await page.locator('html').getAttribute('data-eco'), 'true');
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('渲染与能耗', { exact: true }).selectOption('auto');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  console.log(
    'Packaged night worker / bitmap hue / original preview / dark keyboard and swatch / battery bridge / eco persistence: verified',
  );
}
