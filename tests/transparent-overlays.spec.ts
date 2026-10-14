import { test, expect, type Page } from '@playwright/test';
async function load(page: Page) {
  await page.goto('/');
  const project = await page.evaluate(async () => {
    const { newNotebook, blankPage } = await import('/src/model.ts' as string);
    const n = newNotebook();
    n.name = 'Overlays';
    n.pages = Array.from({ length: 2 }, () => ({ ...blankPage(600, 800), paper: 'plain' }));
    const c = document.createElement('canvas');
    c.width = c.height = 50;
    c.getContext('2d')!.fillStyle = '#d62828';
    c.getContext('2d')!.fillRect(0, 0, 50, 50);
    n.pages[0].images = [
      { id: 'red', data: c.toDataURL(), x: 100, y: 250, width: 100, height: 100, kind: 'image' },
    ];
    return JSON.stringify(n);
  });
  await page.locator('input[type=file]').setInputFiles({
    name: 'overlay.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(project),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
}
for (const night of [false, true])
  for (const view of ['单页标注', '连续页面预览', '双页预览'])
    test(`object/ink/capture overlays preserve underlying pixels: ${view}, night=${night}`, async ({
      page,
    }) => {
      await load(page);
      if (night) await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
      await page.getByRole('button', { name: view, exact: true }).click();
      await page.getByRole('button', { name: '适合页面', exact: true }).click();
      const r = (await page.locator('.paper,.reading-paper').first().boundingBox())!;
      const at = (x: number, y: number) => ({
        x: r.x + (x * r.width) / 600,
        y: r.y + (y * r.height) / 800,
      });
      const pixel = at(150, 300),
        clip = { x: Math.round(pixel.x), y: Math.round(pixel.y), width: 5, height: 5 };
      await page.mouse.move(5, 5);
      const original = await page.screenshot({ clip });
      const compare = async (selector: string) => {
        await expect(page.locator(selector)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        expect(await page.screenshot({ clip })).toEqual(original);
      };
      await page.getByRole('button', { name: '对象', exact: true }).click();
      const a = at(80, 220),
        b = at(240, 390);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 3 });
      await compare('.object-marquee');
      await page.mouse.up();
      await compare('.object-selection');
      await page.getByRole('button', { name: '钢笔', exact: true }).click();
      await page.keyboard.down('Alt');
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 3 });
      await compare('.ink-marquee');
      await page.mouse.up();
      await page.keyboard.up('Alt');
      await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
      await compare('.region-capture');
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 3 });
      await compare('.capture-box');
      await page.mouse.up();
      await expect(page.locator('.capture-preview-image')).toBeVisible();
    });
