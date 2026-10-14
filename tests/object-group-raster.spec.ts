import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function load(page: Page) {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="110" height="70"><circle cx="40.375" cy="32.125" r="29.25" fill="#d94963" fill-opacity=".43"/><path d="M 1.125 68.25 Q 51.375 -8.125 107.875 61.5" fill="none" stroke="#285a87" stroke-width="2.375"/></svg>';
  const displayData = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const images = ['sketch', 'formula', 'text'].map((kind, i) => ({
    id: `object-${i}`,
    kind,
    x: 90 + i * 120,
    y: 100 + i * 40,
    width: 110,
    height: 70,
    data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=',
    displayData,
    ...(kind === 'sketch' ? { scene: { elements: [] } } : {}),
    ...(kind === 'formula' ? { latex: 'x^2' } : {}),
    ...(kind === 'text'
      ? { textBox: { content: 'note', fontSize: 18, color: '#285a87', bold: false } }
      : {}),
  }));
  await page.locator('input[type=file]').setInputFiles({
    name: 'raster.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        name: 'raster',
        source: null,
        pages: [0, 1].map((i) => ({
          id: `p${i}`,
          sourceIndex: null,
          width: 595,
          height: 842,
          paper: 'plain',
          strokes: [],
          images: i ? [] : images,
        })),
      }),
    ),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '对象', exact: true }).click();
  const r = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(r.x + (60 / 595) * r.width, r.y + (60 / 842) * r.height);
  await page.mouse.down();
  await page.mouse.move(r.x + (470 / 595) * r.width, r.y + (280 / 842) * r.height, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.object-selection')).toHaveAttribute('data-selected-count', '3');
  return images;
}
async function project(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  const download = await pending;
  return JSON.parse(await readFile((await download.path())!, 'utf8'));
}

test('group PNG keeps exact transparent edge pixels and editable originals', async ({ page }) => {
  const images = await load(page);
  await page.getByRole('button', { name: '组合选中对象', exact: true }).click();
  await expect(page.locator('.object-layer')).toHaveAttribute('data-total-objects', '1');
  const saved = await project(page),
    group = saved.pages[0].images[0];
  expect(group.group.objects.map((i: any) => i.kind)).toEqual(images.map((i) => i.kind));
  expect(group.group.objects[0].scene).toEqual(images[0].scene);
  expect(group.group.objects[1].latex).toBe('x^2');
  const result = await page.evaluate(async (group) => {
    const decode = async (src: string) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return image;
    };
    // Independent original synchronous canvas route; compare decoded RGBA,
    // rather than requiring the two PNG encoders to use identical compression.
    const reference = document.createElement('canvas'),
      actual = document.createElement('canvas');
    const scale = Math.min(
      4,
      Math.sqrt(8_000_000 / (group.width * group.height)),
      8192 / Math.max(group.width, group.height),
    );
    reference.width = actual.width = Math.ceil(group.width * scale);
    reference.height = actual.height = Math.ceil(group.height * scale);
    reference
      .getContext('2d')!
      .drawImage(await decode(group.displayData), 0, 0, reference.width, reference.height);
    const png = await decode(group.data);
    actual.getContext('2d')!.drawImage(png, 0, 0);
    const a = reference
      .getContext('2d')!
      .getImageData(0, 0, reference.width, reference.height).data;
    const b = actual.getContext('2d')!.getImageData(0, 0, actual.width, actual.height).data;
    let different = 0,
      partialAlpha = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) different++;
      if (i % 4 === 3 && a[i] > 0 && a[i] < 255) partialAlpha++;
    }
    return {
      different,
      partialAlpha,
      dimensions: [png.naturalWidth, png.naturalHeight],
      expected: [reference.width, reference.height],
    };
  }, group);
  expect(result.different).toBe(0);
  expect(result.partialAlpha).toBeGreaterThan(1000);
  expect(result.dimensions).toEqual(result.expected);
});

test('PNG and reader failures keep originals and permit retry', async ({ page }) => {
  const images = await load(page);
  await page.evaluate(() => {
    const scope = window as any;
    scope.originalGroupToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = (callback) => callback(null);
  });
  const button = page.getByRole('button', { name: '组合选中对象', exact: true });
  await button.click();
  await expect(page.getByText('组合失败，原对象已保留。', { exact: true })).toBeVisible();
  expect((await project(page)).pages[0].images).toEqual(images);
  await page.evaluate(() => {
    const scope = window as any;
    HTMLCanvasElement.prototype.toBlob = scope.originalGroupToBlob;
    scope.originalGroupReader = FileReader;
    scope.FileReader = class {
      onerror?: () => void;
      readAsDataURL() {
        queueMicrotask(() => this.onerror?.());
      }
    };
  });
  await button.click();
  await expect(button).toBeEnabled();
  await expect(page.getByText('组合失败，原对象已保留。', { exact: true })).toBeVisible();
  expect((await project(page)).pages[0].images).toEqual(images);
  await page.evaluate(() => {
    (window as any).FileReader = (window as any).originalGroupReader;
  });
  await button.click();
  await expect(page.locator('.object-layer')).toHaveAttribute('data-total-objects', '1');
});

test('a delayed group result cannot overwrite the page selected meanwhile', async ({ page }) => {
  const images = await load(page);
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (blob) {
      this.addEventListener(
        'loadend',
        () => {
          (window as any).groupReadDone = true;
        },
        { once: true },
      );
      read.call(this, blob);
    };
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      original.call(
        this,
        (blob) => {
          (window as any).releaseGroupPng = () => callback(blob);
        },
        ...args,
      );
    };
  });
  await page.getByRole('button', { name: '组合选中对象', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseGroupPng))
    .toBe('function');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.page-navigation > span')).toHaveText('2 / 2');
  await page.evaluate(() => (window as any).releaseGroupPng());
  await expect.poll(() => page.evaluate(() => (window as any).groupReadDone)).toBe(true);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(page.locator('.object-layer')).toHaveAttribute('data-total-objects', '0');
  const saved = await project(page);
  expect(saved.pages[0].images).toEqual(images);
  expect(saved.pages[1].images).toEqual([]);
});
