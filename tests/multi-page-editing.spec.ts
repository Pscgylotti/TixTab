import { test, expect, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs/promises';

async function load(page: Page) {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 80;
    c.getContext('2d')!.fillRect(0, 0, 80, 80);
    return c.toDataURL();
  });
  await page.locator('input[type=file][accept=".pdf,.surfacetab"]').setInputFiles({
    name: 'Editable pages.surfacetab',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        name: 'Editable pages',
        source: null,
        pages: Array.from({ length: 8 }, (_, n) => ({
          id: `p${n}`,
          sourceIndex: null,
          width: 600,
          height: 900,
          paper: 'plain',
          strokes: [],
          images: [
            {
              id: `i${n}`,
              data,
              kind: 'formula',
              latex: `x_${n}`,
              x: 100,
              y: 100,
              width: 80,
              height: 80,
            },
          ],
        })),
      }),
    ),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
}
async function project(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  return JSON.parse(await fs.readFile((await (await pending).path())!, 'utf8'));
}
async function pen(page: Page, editor: Locator) {
  const r = (await editor.boundingBox())!,
    cdp = await page.context().newCDPSession(page);
  const y = r.y + r.height * 0.4,
    x = r.x + r.width * 0.3;
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    pointerType: 'pen',
    button: 'left',
    buttons: 1,
    x,
    y,
    force: 0.25,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    pointerType: 'pen',
    button: 'left',
    buttons: 1,
    x: x + r.width * 0.2,
    y,
    force: 0.8,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    pointerType: 'pen',
    button: 'left',
    buttons: 0,
    x: x + r.width * 0.2,
    y,
    force: 0,
  });
  await cdp.detach();
}
const editorAt = (page: Page, n: number) =>
  page.locator(`.reading-card[data-page-index="${n}"] .page-editor`);
for (const mode of ['continuous', 'dual']) {
  test(`${mode}: ink and pressure work after restart; eraser commits on release; objects stay editable`, async ({
    page,
  }) => {
    await load(page);
    await page.getByRole('button', { name: '第 3 页', exact: true }).click();
    await page
      .getByRole('button', { name: mode === 'dual' ? '双页预览' : '连续页面预览', exact: true })
      .click();
    const root = page.locator('.reading-view');
    await expect(root).toHaveClass(new RegExp(`reading-${mode}`));
    await pen(page, editorAt(page, 2));
    let n = await project(page);
    expect(n.pages[2].strokes).toHaveLength(1);
    expect(n.pages[2].strokes[0].points).toHaveLength(2);
    expect(n.pages[2].strokes[0].points[0][2]).toBeCloseTo(0.25, 5);
    expect(n.pages[2].strokes[0].points[1][2]).toBeCloseTo(0.8, 5);
    expect(n.pages[2].strokes[0].points[0][0]).toBeCloseTo(180, 0);
    await expect(page.locator('.save-state')).toContainText('已自动保存');
    await page.reload();
    await expect(root).toHaveClass(new RegExp(`reading-${mode}`));
    await expect(page.locator('.page-navigation > span')).toHaveText('3 / 8');
    await pen(page, editorAt(page, 2));
    expect((await project(page)).pages[2].strokes).toHaveLength(2);
    const editor = editorAt(page, 2);
    const erase = (type: string) =>
      editor.evaluate((el, type) => {
        el.setPointerCapture = () => {};
        const r = el.getBoundingClientRect();
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerType: 'pen',
            pointerId: 12,
            button: 5,
            buttons: type === 'pointerup' ? 0 : 32,
            pressure: 0.5,
            clientX: r.x + r.width * 0.4,
            clientY: r.y + r.height * 0.4,
          }),
        );
      }, type);
    await erase('pointerdown');
    await expect(editor).toHaveAttribute('data-pending-erase', '2');
    expect((await project(page)).pages[2].strokes).toHaveLength(2);
    await erase('pointercancel');
    expect((await project(page)).pages[2].strokes).toHaveLength(2);
    await erase('pointerdown');
    await erase('pointerup');
    expect((await project(page)).pages[2].strokes).toHaveLength(0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    expect((await project(page)).pages[2].strokes).toHaveLength(2);
    // The right-hand page must remain in the same spread, with its own edit target.
    if (mode === 'continuous')
      await page.getByRole('button', { name: '第 4 页', exact: true }).click();
    await page.getByRole('button', { name: '对象', exact: true }).click();
    const object = editorAt(page, 3).locator('.placed-object');
    await object.click();
    await expect(editorAt(page, 3).locator('.object-selection')).toHaveCount(1);
    const before = (await project(page)).pages[3].images[0];
    const r = (await object.boundingBox())!;
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + 18, r.y + r.height / 2 + 12, { steps: 5 });
    await page.mouse.up();
    n = await project(page);
    expect(n.pages[3].images[0].x).toBeGreaterThan(before.x + 10);
    expect(n.pages[2].images[0].x).toBe(100);
    const handle = editorAt(page, 3).locator('.object-handle.se');
    const corner = (await handle.boundingBox())!;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + corner.width / 2 + 12, corner.y + corner.height / 2 + 12);
    await page.mouse.up();
    expect((await project(page)).pages[3].images[0].width).toBeGreaterThan(80);

    await page.getByRole('button', { name: '编辑选中公式', exact: true }).click();
    await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('x_3', { timeout: 30000 });
    await page.getByLabel('LaTeX · 可直接修改').fill('y_3');
    await page.getByRole('button', { name: '更新公式', exact: true }).click();
    await expect(root).toHaveClass(new RegExp(`reading-${mode}`));
    n = await project(page);
    expect(n.pages[3].images[0].latex).toBe('y_3');
    expect(n.pages[2].images[0].latex).toBe('x_2');
    await object.click();
    await page.keyboard.press('Delete');
    n = await project(page);
    expect(n.pages[3].images).toHaveLength(0);
    expect(n.pages[2].images).toHaveLength(1);
    await editorAt(page, 3).click({ position: { x: 60, y: 100 } });
    await page.getByRole('button', { name: '文本框', exact: true }).click();
    await page.getByLabel('文本框内容', { exact: true }).fill('Right page');
    await page.getByRole('button', { name: '插入当前页', exact: true }).click();
    await expect(editorAt(page, 3).locator('.placed-object')).toHaveCount(1);
    await editorAt(page, 3).evaluate((el) => {
      const data = new DataTransfer();
      data.setData('text/plain', 'Pasted on right');
      el.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      );
    });
    await expect(editorAt(page, 3).locator('.placed-object')).toHaveCount(2);
    await expect(root).toHaveClass(new RegExp(`reading-${mode}`));
    if (mode === 'dual') await expect(page.locator('.page-navigation > span')).toHaveText('3 / 8');
  });
}
test('view switches preserve a non-first page, then scrolling and page entry still track correctly', async ({
  page,
}) => {
  await load(page);
  await page.getByRole('button', { name: '第 5 页', exact: true }).click();
  for (const name of [
    '双页预览',
    '连续页面预览',
    '双页预览',
    '连续页面预览',
    '单页标注',
    '连续页面预览',
  ]) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.page-navigation > span')).toHaveText('5 / 8');
    if (name === '连续页面预览') {
      await expect(editorAt(page, 4)).toBeInViewport();
      await expect
        .poll(() => page.locator('.reading-view').evaluate((el) => el.scrollTop))
        .toBeGreaterThan(500);
    }
    await page.waitForTimeout(120);
    await expect(page.locator('.page-navigation > span')).toHaveText('5 / 8');
  }
  await page.locator('.reading-view').evaluate((el) => {
    el.scrollTop += 750;
  });
  await expect.poll(() => page.locator('.page-navigation > span').innerText()).not.toBe('5 / 8');
  await page.getByRole('button', { name: '第 7 页', exact: true }).click();
  await expect(page.locator('.page-navigation > span')).toHaveText('7 / 8');
  await page.getByRole('button', { name: '双页预览', exact: true }).click();
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await expect(page.locator('.page-navigation > span')).toHaveText('7 / 8');
  await expect(editorAt(page, 6)).toBeInViewport();
});
