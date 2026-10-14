import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const sharp = createRequire(import.meta.url)('sharp');

// Computed backgrounds miss white canvas/image pixels, gradients and filtered
// borders. Check the rendered pixels too; normal text has only short light runs.
async function expectNoWhiteBlocks(page: Page, path: string) {
  const screenshot = await page.screenshot({ path });
  const { data, info } = await sharp(screenshot)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let longest = 0;
  const vertical = new Uint32Array(info.width);
  for (let y = 0; y < info.height; y++) {
    let run = 0;
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      const light = data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200;
      run = light ? run + 1 : 0;
      vertical[x] = light ? vertical[x] + 1 : 0;
      longest = Math.max(longest, run, vertical[x]);
    }
  }
  expect(longest, 'No large white raster, gradient or border should remain').toBeLessThan(80);
}

test('saved night theme paints before the application module loads', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('surfacetab.night', 'true'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/src/main.tsx', async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto('/', { waitUntil: 'commit' });
    await expect(page.locator('html')).toHaveAttribute('data-night', 'true');
    await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(23, 27, 35)');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    await expectNoWhiteBlocks(page, 'test-results/night-before-app.png');
  } finally {
    release();
  }
  await expect(page.locator('.app-shell')).toBeVisible();
});

test('overflowing workspace keeps its own dark palette and native controls after later styles load', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('surfacetab.night', 'true'));
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.evaluate(async () => {
    const { createWorkspaceFolder, saveWorkspaceDocument } = await import(
      '/src/workspaceStore.ts' as string
    );
    const { newNotebook } = await import('/src/model.ts' as string);
    for (let i = 0; i < 20; i++) {
      await createWorkspaceFolder(`Folder ${i + 1}`);
      await saveWorkspaceDocument(`overflow-${i}`, { ...newNotebook(), name: `Document ${i + 1}` });
    }
  });
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await expect(page.locator('.workspace-document')).toHaveCount(21);
  // A later global skin must not reset the component's inherited palette.
  await page.addStyleTag({
    content:
      ':root[data-night=true]{--library-panel:white;--library-card:white;--library-nav:white;--library-input:white}',
  });
  for (const width of [1440, 560]) {
    await page.setViewportSize({ width, height: 960 });
    for (const selector of ['.workspace-library-content', '.workspace-library-body nav']) {
      expect(await page.locator(selector).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
        true,
      );
      await expect(page.locator(selector)).toHaveCSS(
        'scrollbar-color',
        'rgb(82, 97, 122) rgb(27, 34, 46)',
      );
      await page.locator(selector).evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
    }
    await expect(page.locator('.workspace-manager')).toHaveCSS('color-scheme', 'dark');
    await expect(page.locator('.workspace-document-actions select').last()).toHaveCSS(
      'color-scheme',
      'dark',
    );
    expect(await lightSurfaces(page, '.workspace-manager')).toEqual([]);
    await expectNoWhiteBlocks(page, `test-results/night-workspace-overflow-${width}.png`);
  }
});

test('night workspace stays dark after lazy editors load, including OCR image pixels', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  expect(
    await page.locator('.paper').evaluate((el) => getComputedStyle(el, '::after').backgroundImage),
  ).toContain('rgb(85, 96, 117)');
  await expect(page.locator('.paper')).toHaveCSS('background-image', 'none');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '横线', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  expect(
    await page.locator('.paper').evaluate((el) => getComputedStyle(el, '::after').backgroundImage),
  ).toContain('rgb(59, 67, 82)');
  await expect(page.locator('.paper')).toHaveCSS('background-image', 'none');
  for (const mode of ['连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await expect(page.locator('.reading-paper')).toHaveCSS('background-color', 'rgb(28, 32, 39)');
    await expectNoWhiteBlocks(page, `test-results/night-blank-${mode}.png`);
  }
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await expect(page.locator('.formula-canvas')).toBeVisible();
  await expect(page.locator('.formula-drawing')).toHaveCSS('border-top-color', 'rgb(74, 87, 112)');
  await expectNoWhiteBlocks(page, 'test-results/night-formula-surfaces.png');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '草图', exact: true }).click();
  await expect(page.locator('.excalidraw.theme--dark')).toBeVisible();
  await page.locator('.sketch-modal').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await expect(page.locator('.workspace-document')).toHaveCount(1);
  await page.getByRole('button', { name: '新建分组', exact: true }).click();
  for (const width of [1440, 560]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await lightSurfaces(page, '.workspace-manager')).toEqual([]);
    await expectNoWhiteBlocks(page, `test-results/night-library-after-editors-${width}.png`);
  }
  await page.getByRole('button', { name: '关闭工作空间', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const paper = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(paper.x + paper.width * 0.25, paper.y + paper.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(paper.x + paper.width * 0.75, paper.y + paper.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('button', { name: '识别文字（OCR）', exact: true }).click();
  const image = page.getByRole('img', { name: '选中区域', exact: true });
  await expect(image).toBeVisible();
  // Recognition must still receive the original bright pixels, despite the
  // dark visual preview. No recolored copy is allocated or sent to a model.
  expect(
    await image.evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(c.width / 2, c.height / 2, 1, 1).data).slice(0, 3);
    }),
  ).toEqual([255, 255, 255]);
  for (const width of [1440, 560]) {
    await page.setViewportSize({ width, height: 960 });
    await expectNoWhiteBlocks(page, `test-results/night-ocr-surfaces-${width}.png`);
  }
});

// Scan painted UI surfaces, including native form controls. Transparent surfaces
// inherit the container; document pixels are checked separately in night.spec.ts.
async function lightSurfaces(page: Page, scope: string) {
  return page.locator(scope).evaluate((root) =>
    [root, ...root.querySelectorAll('*')].flatMap((el) => {
      const s = getComputedStyle(el),
        r = el.getBoundingClientRect();
      const rgba = s.backgroundColor.match(/[\d.]+/g)?.map(Number);
      return r.width > 6 &&
        r.height > 6 &&
        r.right > 0 &&
        r.bottom > 0 &&
        r.left < innerWidth &&
        r.top < innerHeight &&
        s.visibility !== 'hidden' &&
        rgba &&
        rgba.slice(0, 3).every((v) => v > 170) &&
        (rgba.length < 4 || rgba[3] > 0.3)
        ? [`${el.tagName}.${el.className}: ${s.backgroundColor}`]
        : [];
    }),
  );
}

test('workspace night surfaces stay dark during switching, editing, hover and portrait layout', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.evaluate(async () => {
    const { setNight } = await import('/src/appearance.ts' as string);
    setNight(true);
  });
  expect(await lightSurfaces(page, '.app-shell')).toEqual([]);
  await page.evaluate(async () => {
    const { setNight } = await import('/src/appearance.ts' as string);
    setNight(false);
  });
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await expect(page.locator('.workspace-document')).toHaveCount(1);
  // Toggle synchronously and inspect the first frame, before old light colors
  // could finish a CSS background transition.
  await page.evaluate(async () => {
    const { setNight } = await import('/src/appearance.ts' as string);
    setNight(true);
  });
  expect(await lightSurfaces(page, '.workspace-manager')).toEqual([]);
  await page.getByRole('button', { name: '新建分组', exact: true }).click();
  await page.getByLabel('新的名称').fill('Night folder');
  expect(await lightSurfaces(page, '.workspace-manager')).toEqual([]);
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(page.locator('.workspace-empty')).toBeVisible();
  expect(await lightSurfaces(page, '.workspace-manager')).toEqual([]);
  await page.getByRole('button', { name: '全部文档', exact: false }).click();
  await page.locator('.workspace-open').hover();
  expect(await lightSurfaces(page, '.workspace-manager')).toEqual([]);
  await page.locator('.workspace-document-actions select').selectOption({ label: 'Night folder' });
  await page.getByRole('button', { name: /重命名文档/ }).click();
  await page.getByLabel('新的名称').fill('Night document');
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await page.getByRole('button', { name: '删除文档 Night document', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  for (const width of [1440, 560]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await lightSurfaces(page, '.workspace-manager')).toEqual([]);
    await page.screenshot({ path: `test-results/workspace-night-${width}.png` });
  }
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByLabel('搜索文档').fill('missing');
  await expect(page.locator('.workspace-empty')).toBeVisible();
  expect(await lightSurfaces(page, '.workspace-manager')).toEqual([]);
  await page.getByRole('button', { name: '关闭工作空间', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-night', 'true');
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await expect(page.locator('.workspace-document')).toHaveCount(1);
  expect(await lightSurfaces(page, '.workspace-manager')).toEqual([]);
  await page.evaluate(async () => {
    const { setNight } = await import('/src/appearance.ts' as string);
    setNight(false);
  });
  await expect(page.locator('.workspace-document')).toHaveCSS(
    'background-color',
    'rgb(247, 250, 255)',
  );
  await expect(page.locator('.workspace-library-content')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
});
