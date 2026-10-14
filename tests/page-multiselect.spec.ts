import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
async function saved(page: Page) {
  const pending = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
}
test('keyboard multi-selection copies mixed PDF/blank pages across documents as one undoable batch', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const input = await PDFDocument.create(),
    font = await input.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++)
    input.addPage([400 + i * 50, 600]).drawText(`Source ${i}`, { font, x: 25, y: 550 });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const project = await page.evaluate(
    async (encoded) => {
      const { newNotebook, blankPage } = await import('/src/model.ts' as string),
        { encodeProject } = await import('/src/storage.ts' as string);
      const n = newNotebook();
      n.name = 'Multi source';
      n.source = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      n.pages = [
        { ...blankPage(400, 600), sourceIndex: 0 },
        blankPage(210, 297),
        { ...blankPage(500, 600), sourceIndex: 2 },
        { ...blankPage(450, 600), sourceIndex: 1 },
      ];
      for (let i = 0; i < n.pages.length; i++) {
        n.pages[i].reviews = [
          { id: `r${i}`, text: `Review ${i}`, region: { x: 10, y: 10, width: 20, height: 20 } },
        ];
        n.pages[i].strokes = [
          {
            id: `s${i}`,
            tool: 'pen',
            color: '#334455',
            size: 2,
            points: [
              [20, 20, 0.5],
              [40, 40, 0.8],
            ],
          },
        ];
      }
      return encodeProject(n);
    },
    Buffer.from(await input.save()).toString('base64'),
  );
  await page.locator('input[type=file]').setInputFiles({
    name: 'multi.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(project),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const mode = page.getByRole('button', { name: '页面选择模式', exact: true });
  const modeBounds = (await mode.boundingBox())!,
    foldBounds = (await page
      .getByRole('button', { name: '收起页面栏', exact: true })
      .boundingBox())!;
  expect(modeBounds.x).toBeLessThan(foldBounds.x);
  await mode.click();
  const list = page.getByRole('listbox', { name: '选择页面' });
  await list.press('Enter');
  await list.press('Shift+ArrowDown');
  await list.press('Shift+ArrowDown');
  await expect(list.locator('[aria-selected=true]')).toHaveCount(3);
  await list.press('Shift+ArrowUp');
  await expect(list.locator('[aria-selected=true]')).toHaveCount(2);
  await list.press('ArrowDown');
  await list.press('Enter');
  await expect(list.locator('[aria-selected=true]')).toHaveCount(3);
  await expect(page.locator('.page-navigation')).toContainText('1 / 4');
  await list.press('Control+c');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('已复制 3 页');
  await page.getByRole('button', { name: '新建文档标签', exact: true }).click();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭标签 Multi source', exact: true }).click();
  await page.getByRole('button', { name: '粘贴页面', exact: true }).click();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.locator('.page-navigation')).toContainText('2 / 4');
  const result = await saved(page);
  expect(result.pages.slice(1).map((p: any) => p.width)).toEqual([400, 210, 500]);
  expect(result.pages.slice(1).map((p: any) => p.reviews[0].text)).toEqual([
    'Review 0',
    'Review 1',
    'Review 2',
  ]);
  expect(result.pages[1].strokes[0].id).not.toBe('s0');
  expect(result.pages.slice(1).map((p: any) => p.sourceIndex)).toEqual([0, null, 1]);
  expect((await PDFDocument.load(Buffer.from(result.source, 'base64'))).getPageCount()).toBe(2);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.page-navigation')).toContainText('/ 1');
  await page.keyboard.press('Control+y');
  await expect(page.locator('.page-navigation')).toContainText('/ 4');
});
test('mouse/touch paint selection stays virtualized and Escape restores normal page browsing', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const project = await page.evaluate(async () => {
    const { newNotebook, blankPage } = await import('/src/model.ts' as string);
    const n = newNotebook();
    n.pages = Array.from({ length: 200 }, () => blankPage(600, 400));
    return JSON.stringify(n);
  });
  await page.locator('input[type=file]').setInputFiles({
    name: 'many.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(project),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '页面选择模式', exact: true }).click();
  const list = page.getByRole('listbox', { name: '选择页面' });
  const actions = page.getByRole('group', { name: '页面批量选择' });
  await actions.getByRole('button', { name: '全选', exact: true }).click();
  await expect(page.locator('.sidebar-heading .count')).toContainText('200 / 200');
  await actions.getByRole('button', { name: '全不选', exact: true }).click();
  await expect(page.locator('.sidebar-heading .count')).toContainText('0 / 200');
  await expect(list).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.sidebar-heading .count')).toContainText('1 / 200');
  await actions.getByRole('button', { name: '全不选', exact: true }).click();
  await actions.getByRole('button', { name: '反选', exact: true }).click();
  await expect(page.locator('.sidebar-heading .count')).toContainText('200 / 200');
  await actions.getByRole('button', { name: '全不选', exact: true }).click();
  const point = async (n: number) => {
    const r = (await list.getByRole('option', { name: `第 ${n} 页`, exact: true }).boundingBox())!;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const first = await point(1),
    third = await point(3);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(third.x, third.y, { steps: 8 });
  await page.mouse.up();
  await expect(list.locator('[aria-selected=true]')).toHaveCount(3);
  await list.getByRole('option', { name: '第 2 页', exact: true }).click();
  await expect(list.locator('[aria-selected=true]')).toHaveCount(2);
  const client = await contextSession(page),
    fourth = await point(4),
    fifth = await point(5);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...fourth, id: 1 }],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...fifth, id: 1 }],
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(list.locator('[aria-selected=true]')).toHaveCount(4);
  expect(await list.locator('.page-card').count()).toBeLessThan(20);
  await list.focus();
  await list.press('Shift+End');
  await expect(list.getByRole('option', { name: '第 200 页', exact: true })).toBeVisible();
  expect(await list.locator('.page-card').count()).toBeLessThan(20);
  await list.press('Escape');
  await expect(page.getByRole('button', { name: '页面选择模式', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.locator('.page-card').last().click();
  await expect(page.locator('.page-navigation')).toContainText('200 / 200');
});
async function contextSession(page: Page) {
  return page.context().newCDPSession(page);
}
