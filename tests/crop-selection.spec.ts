import { test, expect, type Page, type CDPSession } from '@playwright/test';
test.use({ hasTouch: true });
async function openCrop(page: Page) {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.locator('.paper').evaluate(async (element) => {
    const c = document.createElement('canvas');
    c.width = 500;
    c.height = 300;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#397bc4';
    ctx.fillRect(0, 0, 500, 300);
    const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!))),
      data = new DataTransfer();
    data.items.add(new File([blob], 'crop.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await page.getByRole('button', { name: '裁剪图片', exact: true }).click();
  await page.getByLabel('裁剪宽度', { exact: true }).fill('40');
  await page.getByLabel('裁剪高度', { exact: true }).fill('40');
  await page.getByLabel('裁剪左侧', { exact: true }).fill('20');
  await page.getByLabel('裁剪顶部', { exact: true }).fill('20');
}
async function pointer(
  cdp: CDPSession,
  kind: string,
  action: 'down' | 'move' | 'up',
  x: number,
  y: number,
) {
  if (kind === 'touch')
    await cdp.send('Input.dispatchTouchEvent', {
      type: action === 'down' ? 'touchStart' : action === 'move' ? 'touchMove' : 'touchEnd',
      touchPoints: action === 'up' ? [] : [{ id: 1, x, y, radiusX: 2, radiusY: 2, force: 0.5 }],
    });
  else
    await cdp.send('Input.dispatchMouseEvent', {
      type: action === 'down' ? 'mousePressed' : action === 'move' ? 'mouseMoved' : 'mouseReleased',
      pointerType: kind,
      x,
      y,
      button: 'left',
      buttons: action === 'up' ? 0 : 1,
      clickCount: action === 'move' ? 0 : 1,
    });
}
for (const kind of ['mouse', 'pen', 'touch']) {
  test(`${kind}: crop interior moves, edges resize, outside drag reselects, clicks preserve the selection`, async ({
    page,
  }) => {
    await openCrop(page);
    const cdp = await page.context().newCDPSession(page),
      source = page.locator('.image-crop-source');
    const viewport = page.locator('.surface');
    const positionBefore = await viewport.evaluate((el) => [
      el.getAttribute('data-pan-x'),
      el.getAttribute('data-pan-y'),
      el.getAttribute('data-view-zoom'),
    ]);
    const box = (await source.boundingBox())!;
    const at = (x: number, y: number) => [box.x + box.width * x, box.y + box.height * y] as const;
    const drag = async (x: number, y: number, nextX: number, nextY: number) => {
      await pointer(cdp, kind, 'down', ...at(x, y));
      for (let i = 1; i <= 5; i++)
        await pointer(
          cdp,
          kind,
          'move',
          ...at(x + ((nextX - x) * i) / 5, y + ((nextY - y) * i) / 5),
        );
      await pointer(cdp, kind, 'up', ...at(nextX, nextY));
    };
    const rect = async () =>
      Promise.all(
        ['裁剪左侧', '裁剪顶部', '裁剪宽度', '裁剪高度'].map(async (name) =>
          Number(await page.getByLabel(name, { exact: true }).inputValue()),
        ),
      );
    await drag(0.4, 0.4, 0.55, 0.5);
    await expect.poll(rect).toEqual([35, 30, 40, 40]);
    await drag(0.55, 0.5, 0.55, 0.5);
    await expect.poll(rect).toEqual([35, 30, 40, 40]);
    await drag(0.55, 0.5, 1.2, 1.2);
    await expect.poll(rect).toEqual([60, 60, 40, 40]);
    await page.getByLabel('裁剪左侧', { exact: true }).fill('20');
    await page.getByLabel('裁剪顶部', { exact: true }).fill('20');
    const handle = (await page.locator('[data-crop-handle=e]').boundingBox())!;
    const hx = handle.x + handle.width / 2,
      hy = handle.y + handle.height / 2;
    await pointer(cdp, kind, 'down', hx, hy);
    await pointer(cdp, kind, 'move', hx + box.width * 0.1, hy);
    await pointer(cdp, kind, 'up', hx + box.width * 0.1, hy);
    await expect.poll(rect).toEqual([20, 20, 50, 40]);
    await drag(0.05, 0.05, 0.15, 0.15);
    await expect.poll(rect).toEqual([5, 5, 10, 10]);
    // Handles must leave the center of a small crop available for movement.
    await drag(0.1, 0.1, 0.2, 0.2);
    await expect.poll(rect).toEqual([15, 15, 10, 10]);
    await drag(0.8, 0.8, 0.8, 0.8);
    await expect.poll(rect).toEqual([15, 15, 10, 10]);
    expect(
      await viewport.evaluate((el) => [
        el.getAttribute('data-pan-x'),
        el.getAttribute('data-pan-y'),
        el.getAttribute('data-view-zoom'),
      ]),
    ).toEqual(positionBefore);
    await page.getByRole('button', { name: '应用裁剪', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '裁剪图片', exact: true })).toHaveCount(0);
    await expect
      .poll(() =>
        page.locator('.placed-object img').evaluate(async (image: HTMLImageElement) => {
          await image.decode();
          return [image.naturalWidth, image.naturalHeight];
        }),
      )
      .toEqual([50, 30]);
  });
}
test('cancelled crop movement restores the previous selection', async ({ page }) => {
  await openCrop(page);
  const source = page.locator('.image-crop-source');
  await source.evaluate((element) => {
    element.addEventListener(
      'pointerdown',
      (e) => {
        (window as any).cropPointer = (e as PointerEvent).pointerId;
      },
      true,
    );
  });
  const box = (await source.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await expect(page.getByLabel('裁剪左侧', { exact: true })).toHaveValue('40');
  await source.evaluate((element) =>
    element.dispatchEvent(
      new PointerEvent('pointercancel', { pointerId: (window as any).cropPointer, bubbles: true }),
    ),
  );
  await page.mouse.up();
  await expect(page.getByLabel('裁剪左侧', { exact: true })).toHaveValue('20');
  await expect(page.getByLabel('裁剪顶部', { exact: true })).toHaveValue('20');
  await expect(page.getByLabel('裁剪宽度', { exact: true })).toHaveValue('40');
});
