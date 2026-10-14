import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
async function fixture(page: Page) {
  await page.goto('/');
  const text = await page.evaluate(async () => {
    const { newNotebook, blankPage } = await import('/src/model.ts' as string);
    const n = newNotebook();
    n.name = 'Ink selection';
    n.pages = Array.from({ length: 3 }, () => ({ ...blankPage(), width: 600, height: 800 }));
    n.pages[0].strokes = [
      {
        id: 'first',
        tool: 'pen',
        color: '#102030',
        size: 4,
        points: [
          [100, 150, 0.2],
          [160, 160, 0.8],
        ],
      },
      {
        id: 'second',
        tool: 'highlighter',
        color: '#708090',
        size: 10,
        points: [
          [120, 190, 0.4],
          [180, 190, 0.4],
        ],
      },
      {
        id: 'outside',
        tool: 'pencil',
        color: '#556677',
        size: 3,
        points: [
          [420, 400, 0.3],
          [470, 400, 0.7],
        ],
      },
    ];
    return JSON.stringify(n);
  });
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'ink.tixtab', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
}
async function project(page: Page) {
  const pending = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const file = await pending;
  return JSON.parse(await fs.readFile((await file.path())!, 'utf8'));
}
async function at(page: Page, x: number, y: number) {
  const r = (await page.locator('.paper,.reading-paper').first().boundingBox())!;
  return { x: r.x + (r.width * x) / 600, y: r.y + (r.height * y) / 800 };
}
async function pen(page: Page, type: string, point: { x: number; y: number }, contact: boolean) {
  await page.evaluate(
    ({ type, point, contact }) => {
      document.elementFromPoint(point.x, point.y)!.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerType: 'pen',
          pointerId: 81,
          clientX: point.x,
          clientY: point.y,
          button: type === 'pointerdown' ? 2 : 0,
          buttons: contact ? 3 : 0,
          pressure: contact ? 0.6 : 0,
        }),
      );
    },
    { type, point, contact },
  );
}
for (const view of ['单页标注', '连续页面预览', '双页预览']) {
  test(`side-button drag selects editable strokes, frames/moves/copies/cuts/pastes/undoes: ${view}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await fixture(page);
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.getByRole('button', { name: '适合页面', exact: true }).click();
    const start = await at(page, 80, 130),
      end = await at(page, 210, 220);
    await pen(page, 'pointerdown', start, true);
    await expect(page.getByRole('menu', { name: '笔侧键工具环' })).toHaveCount(0);
    await pen(page, 'pointermove', end, true);
    await expect(page.locator('[data-ink-marquee]')).toBeVisible();
    await expect(page.locator('[data-ink-marquee]')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
    await pen(page, 'pointerup', end, false);
    const box = page.locator('.ink-selection-box');
    await expect(box).toHaveAttribute('data-selected-strokes', '2');
    await expect(box).toHaveCSS('border-top-style', 'solid');
    await expect(box).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.getByRole('menu', { name: '笔侧键工具环' })).toHaveCount(0);
    const before = await project(page);
    expect(before.pages[0].strokes).toHaveLength(3);
    const b = (await box.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2 + 20, { steps: 4 });
    await page.mouse.up();
    const moved = await project(page);
    expect(moved.pages[0].strokes[0].points[0][0]).toBeGreaterThan(100);
    expect(moved.pages[0].strokes[2]).toEqual(before.pages[0].strokes[2]);
    const handle = box.locator('[data-ink-resize="se"]');
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + 35, h.y + h.height / 2 + 35, { steps: 4 });
    await page.mouse.up();
    const resized = await project(page);
    expect(resized.pages[0].strokes[0].size).toBeGreaterThan(moved.pages[0].strokes[0].size);
    expect(resized.pages[0].strokes[0].points.map((p: number[]) => p[2])).toEqual([0.2, 0.8]);
    expect(resized.pages[0].strokes[2]).toEqual(moved.pages[0].strokes[2]);
    await page.keyboard.press('Control+z');
    expect((await project(page)).pages[0].strokes).toEqual(moved.pages[0].strokes);
    await page.keyboard.press('Control+y');
    expect((await project(page)).pages[0].strokes).toEqual(resized.pages[0].strokes);
    await page.keyboard.press('Control+c');
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await navigator.clipboard.read()).some((i) => i.types.includes('text/html')),
        ),
      )
      .toBe(true);
    await page.keyboard.press('Control+v');
    await expect(box).toHaveAttribute('data-selected-strokes', '2');
    await expect.poll(async () => (await project(page)).pages[0].strokes.length).toBe(5);
    const pasted = await project(page);
    expect(pasted.pages[0].strokes[3].id).not.toBe('first');
    expect(pasted.pages[0].strokes[3].points.map((p: number[]) => p[2])).toEqual([0.2, 0.8]);
    await page.keyboard.press('Control+x');
    await expect.poll(async () => (await project(page)).pages[0].strokes.length).toBe(3);
    await page.keyboard.press('Control+v');
    await expect.poll(async () => (await project(page)).pages[0].strokes.length).toBe(5);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await project(page)).pages[0].strokes.length).toBe(3);
  });
}
test('Alt+mouse selects ink; normal drawing and cancel preserve content; expanded toolbar is smaller', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '适合页面', exact: true }).click();
  const start = await at(page, 80, 130),
    end = await at(page, 210, 220);
  await page.keyboard.down('Alt');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(page.locator('.ink-selection-box')).toHaveAttribute('data-selected-strokes', '2');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ink-selection-box')).toHaveCount(0);
  await pen(page, 'pointerdown', start, true);
  await pen(page, 'pointermove', end, true);
  await pen(page, 'pointercancel', end, false);
  await expect(page.locator('[data-ink-marquee]')).toHaveCount(0);
  expect((await project(page)).pages[0].strokes).toHaveLength(3);
  await expect(page.locator('.toolbar .tool-button svg').first()).toHaveCSS('width', '17px');
  await expect(page.locator('.toolbar .tool-button span').first()).toHaveCSS('font-size', '10px');
  await expect(page.getByRole('button', { name: '钢笔', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

for (const view of ['单页标注', '连续页面预览', '双页预览'])
  test(`Alt-selected ink toolbar copy and cut write a fresh clipboard and preserve editable strokes: ${view}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await fixture(page);
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.getByRole('button', { name: '适合页面', exact: true }).click();
    const start = await at(page, 80, 130),
      end = await at(page, 210, 220);
    await page.keyboard.down('Alt');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await expect(page.locator('.ink-selection-box')).toHaveAttribute('data-selected-strokes', '2');
    await page.evaluate(() => navigator.clipboard.writeText('Before button copy'));
    const controls = page.getByRole('toolbar', { name: '笔迹选择', exact: true });
    await controls.getByRole('button', { name: '复制', exact: true }).click();
    await expect(controls.getByRole('status')).toContainText('已复制 2 条笔迹');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('[TixTab ink]');
    const html = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      return (await items[0].getType('text/html')).text();
    });
    expect(html).toContain('data-tixtab-ink');
    expect((await project(page)).pages[0].strokes).toHaveLength(3);
    await controls.getByRole('button', { name: '剪切', exact: true }).click();
    await expect.poll(async () => (await project(page)).pages[0].strokes.length).toBe(1);
    await page.keyboard.press('Control+v');
    await expect.poll(async () => (await project(page)).pages[0].strokes.length).toBe(3);
    // A denied clipboard write must never delete the selected source strokes.
    await page.evaluate(() => {
      document.execCommand = () => false;
      Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: async () => {
          throw new Error('denied');
        },
      });
    });
    await controls.getByRole('button', { name: '剪切', exact: true }).click();
    await expect(controls.getByRole('status')).toContainText('已保留');
    expect((await project(page)).pages[0].strokes).toHaveLength(3);
  });
