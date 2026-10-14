import { test, expect, type Page } from '@playwright/test';

const formula = (page: Page) => page.getByRole('dialog', { name: '手写公式', exact: true });
const source = (page: Page) => page.getByLabel('LaTeX · 可直接修改');
async function open(page: Page) {
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await expect(source(page)).toBeEnabled();
}
async function close(page: Page) {
  await formula(page).getByRole('button', { name: '关闭', exact: true }).click();
}
async function ink(page: Page) {
  return page.locator('.formula-canvas').evaluate((el: HTMLCanvasElement) => el.toDataURL());
}
async function draw(page: Page) {
  await page.locator('.formula-canvas').evaluate((el: HTMLCanvasElement) => {
    el.setPointerCapture = () => {};
    const r = el.getBoundingClientRect();
    for (const [type, dx] of [
      ['pointerdown', 50],
      ['pointermove', 110],
      ['pointerup', 160],
    ] as const) {
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 3,
          pointerType: 'pen',
          button: 0,
          buttons: 1,
          pressure: 0.6,
          clientX: r.x + dx,
          clientY: r.y + r.height * 0.7,
        }),
      );
    }
  });
}
test('formula draft restores vector handwriting, source, caret and multiline after close and restart; clearing persists', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await open(page);
  await formula(page).getByRole('button', { name: '公式设置', exact: true }).click();
  await page.getByLabel('多行手写公式', { exact: true }).check();
  await formula(page).getByRole('button', { name: '公式设置', exact: true }).click();
  const blank = await ink(page);
  await source(page).fill('a+\\frac{1}{2}+b');
  await source(page).evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(2, 2);
    el.blur();
  });
  await draw(page);
  const handwriting = await ink(page);
  expect(handwriting).not.toBe(blank);
  await close(page);
  await open(page);
  expect(await ink(page)).toBe(handwriting);
  await expect(source(page)).toHaveValue('a+\\frac{1}{2}+b');
  await expect(page.locator('.latex-persistent-caret')).toHaveAttribute('data-position', '2');
  // Reload with the editor still open, exercising the pagehide flush and workspace recovery.
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await open(page);
  await expect(page.locator('.formula-canvas')).toHaveAttribute('height', '640');
  expect(await ink(page)).toBe(handwriting);
  await expect(source(page)).toHaveValue('a+\\frac{1}{2}+b');
  await expect(page.locator('.latex-persistent-caret')).toHaveAttribute('data-position', '2');
  await page.getByRole('button', { name: '清空画板', exact: true }).click();
  await source(page).fill('');
  await close(page);
  await open(page);
  expect(await ink(page)).toBe(blank);
  await expect(source(page)).toHaveValue('');
});

test('restored visible and committed canvas contexts replay the saved handwriting', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.evaluate(() => {
    const create = document.createElement.bind(document);
    (window as any).formulaCanvases = [];
    document.createElement = ((...args: Parameters<typeof create>) => {
      const el = create(...args);
      if (el instanceof HTMLCanvasElement) (window as any).formulaCanvases.push(el);
      return el;
    }) as typeof document.createElement;
  });
  await open(page);
  await formula(page).getByRole('button', { name: '公式设置', exact: true }).click();
  await page.getByLabel('多行手写公式', { exact: true }).check();
  await formula(page).getByRole('button', { name: '公式设置', exact: true }).click();
  await expect(page.locator('.formula-canvas')).toHaveAttribute('height', '640');
  await draw(page);
  const expected = await ink(page);
  for (const target of ['visible', 'committed']) {
    await page.locator('.formula-canvas').evaluate((visible: HTMLCanvasElement, target) => {
      const bases = (window as any).formulaCanvases.filter(
        (c: HTMLCanvasElement) => !c.isConnected && c.width === 960 && c.height === visible.height,
      );
      if (bases.length !== 1) throw Error('Ambiguous committed formula canvas');
      const canvas = target === 'visible' ? visible : bases[0];
      // Exercise actual listener invalidation with erased pixels. This simulates
      // the lifecycle notifications, not a physical GPU/driver reset.
      canvas.dispatchEvent(new Event('contextlost'));
      canvas.width = canvas.width;
      canvas.dispatchEvent(new Event('contextrestored'));
    }, target);
    await expect.poll(() => ink(page)).toBe(expected);
  }
  await close(page);
  await open(page);
  expect(await ink(page)).toBe(expected);
});

test('document drafts and edits of existing formula objects remain separate', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByLabel('文档名称', { exact: true }).fill('草稿 A');
  await open(page);
  await source(page).fill('x^2');
  await draw(page);
  const original = await ink(page);
  await page.getByRole('button', { name: '插入当前页', exact: true }).click();
  await expect(formula(page)).toHaveCount(0);
  await page.getByRole('button', { name: '编辑选中公式', exact: true }).click();
  await expect(source(page)).toBeEnabled();
  await expect(source(page)).toHaveValue('x^2');
  expect(await ink(page)).not.toBe(original);
  await source(page).fill('x^3');
  await close(page);
  await page.getByRole('button', { name: '编辑选中公式', exact: true }).click();
  await expect(source(page)).toHaveValue('x^3');
  await close(page);
  await open(page);
  await expect(source(page)).toHaveValue('x^2');
  expect(await ink(page)).toBe(original);
  await close(page);
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await page.getByLabel('文档名称', { exact: true }).fill('草稿 B');
  await open(page);
  await expect(source(page)).toHaveValue('');
  await source(page).fill('y=1');
  await close(page);
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await page.getByRole('button', { name: '打开文档 草稿 A', exact: true }).click();
  await open(page);
  await expect(source(page)).toHaveValue('x^2');
  expect(await ink(page)).toBe(original);
});
