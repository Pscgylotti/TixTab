import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
async function project(page: Page) {
  const wait = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  return JSON.parse(await fs.readFile((await (await wait).path())!, 'utf8'));
}
test('thumbnail insertion indicator, adjacent ordering, escape and auto-scroll cancellation', async ({
  page,
}) => {
  await page.goto('/');
  const fixture = await page.evaluate(async () => {
    const { newNotebook, blankPage } = await import('/src/model.ts' as string);
    const n = newNotebook();
    n.name = 'Reorder';
    n.pages = Array.from({ length: 16 }, (_, i) => ({ ...blankPage(600, 800), id: 'page-' + i }));
    return JSON.stringify(n);
  });
  await page.locator('input[type=file]').setInputFiles({
    name: 'reorder.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(fixture),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const card = (n: number) => page.getByRole('button', { name: `第 ${n} 页`, exact: true });
  const first = (await card(1).boundingBox())!,
    second = (await card(2).boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await expect(page.getByRole('menu', { name: '管理第 1 页' })).toBeVisible();
  await page.mouse.move(second.x + second.width / 2, second.y + second.height - 4, { steps: 5 });
  await expect(page.locator('.page-insertion-line')).toHaveAttribute('data-insertion-index', '2');
  await expect(card(1)).toHaveClass(/dragging/);
  await page.mouse.up();
  expect((await project(page)).pages.slice(0, 3).map((p: { id: string }) => p.id)).toEqual([
    'page-1',
    'page-0',
    'page-2',
  ]);
  await expect(page.locator('.page-card.selected')).toHaveAttribute('data-page-index', '1');
  const selected = (await card(2).boundingBox())!;
  await page.mouse.move(selected.x + selected.width / 2, selected.y + selected.height / 2);
  await page.mouse.down();
  await expect(page.getByRole('menu', { name: '管理第 2 页' })).toBeVisible();
  await page.mouse.move(first.x + 10, first.y + 5, { steps: 4 });
  await expect(page.locator('.page-insertion-line')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.page-insertion-line')).toHaveCount(0);
  expect((await project(page)).pages.slice(0, 3).map((p: { id: string }) => p.id)).toEqual([
    'page-1',
    'page-0',
    'page-2',
  ]);
  const list = page.locator('.page-list'),
    bounds = (await list.boundingBox())!,
    start = (await card(2).boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await expect(page.getByRole('menu', { name: '管理第 2 页' })).toBeVisible();
  const old = await list.evaluate((el) => el.scrollTop);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 5, { steps: 4 });
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(old + 220);
  await page.evaluate(() => dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await expect(page.locator('.page-insertion-line')).toHaveCount(0);
  expect((await project(page)).pages.slice(0, 3).map((p: { id: string }) => p.id)).toEqual([
    'page-1',
    'page-0',
    'page-2',
  ]);
});
