import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const sharp = createRequire(import.meta.url)('sharp');

test('image edge stretching, rotation, reversible crop and persisted editable metadata', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.locator('.paper').evaluate(async (element) => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 100;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = 'blue';
    ctx.fillRect(100, 0, 100, 100);
    const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!)));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'stretch.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  const image = page.getByLabel('图片对象', { exact: true });
  await expect(image).toHaveCount(1);
  const before = (await image.boundingBox())!;
  const handle = page.getByRole('button', { name: '拉伸图片右边', exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const stretched = (await image.boundingBox())!;
  expect(stretched.width).toBeGreaterThan(before.width + 50);
  expect(stretched.height).toBeCloseTo(before.height, 0);
  await page.getByRole('button', { name: '顺时针旋转图片', exact: true }).click();
  const rotated = (await image.boundingBox())!;
  expect(rotated.width).toBeCloseTo(stretched.height, 0);
  expect(rotated.height).toBeCloseTo(stretched.width, 0);
  await page.getByRole('button', { name: '裁剪图片', exact: true }).click();
  await page.getByLabel('裁剪宽度', { exact: true }).fill('50');
  await page.getByRole('button', { name: '应用裁剪', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '裁剪图片', exact: true })).toHaveCount(0);
  const afterCrop = (await image.boundingBox())!;
  expect(afterCrop.width).toBeCloseTo(rotated.width, 0);
  expect(afterCrop.height).toBeCloseTo(rotated.height / 2, 0);
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const saved = await page.evaluate(async () => {
    const { bootstrapWorkspace } = await import('/src/workspaceStore.ts' as string);
    const { encodeObjects, decodeObjects } = await import('/src/objectClipboard.ts' as string);
    const notebook = (await bootstrapWorkspace()).notebook;
    const p = notebook.pages[0],
      image = p.images[0];
    const copy = decodeObjects(encodeObjects(p, [image.id]));
    const bitmap = await createImageBitmap(await (await fetch(image.data)).blob());
    const size = [bitmap.width, bitmap.height];
    bitmap.close();
    return {
      rotation: image.rotation,
      rect: image.crop.rect,
      size,
      copied: copy.objects[0].crop.rect,
    };
  });
  expect(saved.rotation).toBe(90);
  expect(saved.size).toEqual([100, 100]);
  expect(saved.rect).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
  expect(saved.copied).toEqual(saved.rect);
  await page.getByRole('button', { name: '对象', exact: true }).click();
  await image.click();
  await page.getByRole('button', { name: '裁剪图片', exact: true }).click();
  await expect(page.getByLabel('裁剪宽度', { exact: true })).toHaveValue('50');
  await page.getByRole('button', { name: '恢复完整图片', exact: true }).click();
  await page.getByRole('button', { name: '应用裁剪', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '裁剪图片', exact: true })).toHaveCount(0);
  expect((await image.boundingBox())!.height).toBeCloseTo(rotated.height, 0);
  for (const mode of ['连续页面预览', '双页预览', '单页标注']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await expect(page.locator('.placed-object img').first()).toHaveCSS('object-fit', 'fill');
  }
});

test('crop preserves transparency and night snapshots and releases bitmap buffers', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { cropPlacedImage } = await import('/src/imageCrop.ts' as string);
    const { renderColorKey } = await import('/src/colorKey.ts' as string);
    const { validNotebook, blankPage } = await import('/src/model.ts' as string);
    const { capturePage } = await import('/src/capturePage.ts' as string);
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 20;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 40, 20);
    ctx.fillStyle = 'blue';
    ctx.fillRect(10, 0, 30, 20);
    const original = c.toDataURL('image/png');
    const controller = new AbortController();
    const data = await renderColorKey(original, '#ffffff', 3, controller.signal);
    const image = {
      id: 'image',
      kind: 'image',
      data,
      x: 0,
      y: 0,
      width: 80,
      height: 40,
      colorKey: { original, color: '#ffffff', tolerance: 3 },
    };
    let closed = 0;
    const real = createImageBitmap;
    window.createImageBitmap = async (...args: any[]) => {
      const b = await (real as any)(...args);
      const close = b.close.bind(b);
      b.close = () => {
        closed++;
        close();
      };
      return b;
    };
    const cropped = await cropPlacedImage(
      image,
      { x: 0, y: 0, width: 0.5, height: 1 },
      controller.signal,
    );
    const snapshot = await cropPlacedImage(
      { ...image, colorKey: undefined, scratchPage: true, nightData: original },
      { x: 0.5, y: 0, width: 0.5, height: 1 },
      controller.signal,
    );
    window.createImageBitmap = real;
    const bmp = await createImageBitmap(await (await fetch(cropped.data)).blob());
    c.width = bmp.width;
    c.height = bmp.height;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const alpha = [ctx.getImageData(1, 1, 1, 1).data[3], ctx.getImageData(15, 1, 1, 1).data[3]];
    const p = { ...blankPage(), images: [cropped] };
    const capture = await capturePage(p, null, { x: 0, y: 0, width: 40, height: 40 }, { scale: 1 });
    const captured = await createImageBitmap(await (await fetch(capture)).blob());
    c.width = 40;
    c.height = 40;
    ctx.drawImage(captured, 0, 0);
    captured.close();
    const pixel = Array.from(ctx.getImageData(30, 10, 1, 1).data);
    const { exportPdf } = await import('/src/pdfExport.ts' as string);
    const { loadPdf } = await import('/src/pdf.ts' as string);
    const pdf = await loadPdf(
      await exportPdf({
        version: 1,
        name: 'export',
        source: null,
        pages: [{ ...p, images: [{ ...cropped, width: 80, height: 40 }] }],
      }),
    );
    try {
      const first = await pdf.getPage(1);
      const viewport = first.getViewport({ scale: 1 });
      c.width = Math.ceil(viewport.width);
      c.height = Math.ceil(viewport.height);
      await first.render({ canvas: c, viewport }).promise;
      const exported = Array.from(ctx.getImageData(70, 10, 1, 1).data);
      return {
        closed,
        alpha,
        pixel,
        exported,
        night: !!snapshot.nightData,
        valid: validNotebook({ version: 1, name: 'test', source: null, pages: [p] }),
      };
    } finally {
      await pdf.destroy();
    }
  });
  expect(result).toEqual({
    closed: 3,
    alpha: [0, 255],
    pixel: [0, 0, 255, 255],
    exported: [0, 0, 255, 255],
    night: true,
    valid: true,
  });
});

test('cropped image pixels stretch with the frame in single, continuous and spread layouts', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.locator('.paper').evaluate(async (element) => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 100;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 200, 100);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!)));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'crop.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  const image = page.getByLabel('图片对象', { exact: true });
  await page.getByRole('button', { name: '裁剪图片', exact: true }).click();
  await page.getByLabel('裁剪宽度', { exact: true }).fill('50');
  await page.getByRole('button', { name: '应用裁剪', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '裁剪图片', exact: true })).toHaveCount(0);
  for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await page.getByRole('button', { name: '对象', exact: true }).click();
    await image.click();
    const before = (await image.boundingBox())!;
    const h = (await page
      .getByRole('button', { name: '拉伸图片右边', exact: true })
      .boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + 55, h.y + h.height / 2, { steps: 5 });
    await page.mouse.up();
    const after = (await image.boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width + 40);
    expect(after.height).toBeCloseTo(before.height, 0);
    await expect(image.locator('img')).toHaveCSS('object-fit', 'fill');
    // Hide selection handles so they cannot cover the sampled edge pixels.
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    // Test actual rendered pixels near the stretched edge, not just frame geometry.
    const { data, info } = await sharp(await image.screenshot())
      .raw()
      .toBuffer({ resolveWithObject: true });
    const at = (Math.floor(info.height * 0.3) * info.width + 5) * info.channels;
    expect(data[at]).toBeGreaterThan(220);
    expect(data[at + 1]).toBeLessThan(40);
    expect(data[at + 2]).toBeLessThan(40);
  }
});
