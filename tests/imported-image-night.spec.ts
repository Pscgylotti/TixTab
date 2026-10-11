import { test, expect } from '@playwright/test';

test('night dims imported and legacy pictures without inversion in all layouts and thumbnails, while adapting formula, sketches and ink', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.paper').waitFor();
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 80;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ef4141';
    ctx.fillRect(0, 0, 120, 80);
    return c.toDataURL();
  });
  const images = [
    { id: 'new', kind: 'image' },
    { id: 'legacy', kind: 'sketch' },
    { id: 'sketch', kind: 'sketch', scene: { elements: [] } },
    { id: 'formula', kind: 'formula', latex: 'x' },
  ].map((i, n) => ({
    ...i,
    data,
    x: 50 + (n % 2) * 220,
    y: 150 + Math.floor(n / 2) * 150,
    width: 120,
    height: 80,
  }));
  const first = {
    id: 'one',
    sourceIndex: null,
    width: 595,
    height: 842,
    paper: 'plain',
    images,
    strokes: [
      {
        id: 'ink',
        tool: 'pen',
        color: '#23324d',
        size: 3,
        points: [
          [20, 20, 0.5],
          [150, 20, 0.5],
        ],
      },
    ],
  };
  await page.locator('input[type=file][accept=".pdf,.surfacetab"]').setInputFiles({
    name: 'Pictures.surfacetab',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        name: 'Pictures',
        source: null,
        pages: [first, { ...first, id: 'two', images: [], strokes: [] }],
      }),
    ),
  });
  await expect(page.locator('.placed-object')).toHaveCount(4);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  const filters = async (selector: string) =>
    page
      .locator(selector)
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).filter));
  for (const view of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    const selector = view === '单页标注' ? '.placed-object img' : '.reading-content > img';
    await expect(page.locator(selector)).toHaveCount(4);
    const colors = await filters(selector);
    expect(colors.slice(0, 2)).toEqual(['brightness(0.62)', 'brightness(0.62)']);
    expect(colors.slice(2).every((filter) => filter.includes('invert'))).toBe(true);
    await expect(page.locator('.page-thumbnail image')).toHaveCount(4);
    const mini = await filters('.page-thumbnail image');
    expect(mini.slice(0, 2)).toEqual(['brightness(0.62)', 'brightness(0.62)']);
    expect(mini.slice(2).every((filter) => filter.includes('invert'))).toBe(true);
    expect((await filters('.thumbnail-ink'))[0]).toContain('invert');
    expect((await filters('.page-thumbnail > svg')).every((filter) => filter === 'none')).toBe(
      true,
    );
    await page.getByRole('button', { name: '查看原色', exact: true }).click();
    expect((await filters(selector)).slice(0, 2)).toEqual(['none', 'none']);
    expect((await filters('.page-thumbnail image')).slice(0, 2)).toEqual(['none', 'none']);
    await page.getByRole('button', { name: '恢复夜间颜色', exact: true }).click();
  }
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  await page.screenshot({ path: 'test-results/imported-pictures-night.png' });
  await page.reload();
  await expect(page.locator('.placed-object img')).toHaveCount(4);
  expect((await filters('.placed-object img')).slice(0, 2)).toEqual([
    'brightness(0.62)',
    'brightness(0.62)',
  ]);
  await page.getByRole('button', { name: '对象', exact: true }).click();
  await page.locator('[data-object-id="new"]').click();
  await expect(page.getByRole('button', { name: '编辑选中图片', exact: true })).toBeVisible();
});
