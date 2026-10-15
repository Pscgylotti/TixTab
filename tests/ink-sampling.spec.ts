import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

for (const view of ['单页标注', '连续页面预览', '双页预览'])
  test(`pen raw/coalesced input keeps every unique trajectory point in saved ink: ${view}`, async ({
    page,
    context,
  }) => {
    await page.goto('/');
    const project = await page.evaluate(async () => {
      const { newNotebook, blankPage } = await import('/src/model.ts');
      const n = newNotebook();
      n.pages = [0, 1].map(() => ({ ...blankPage(), width: 600, height: 800 }));
      return JSON.stringify(n);
    });
    await page.locator('input[type=file]').setInputFiles({
      name: 'raw.tixtab',
      mimeType: 'application/json',
      buffer: Buffer.from(project),
    });
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    const firstId = JSON.parse(project).pages[0].id;
    await expect(page.locator(`.paper[data-page-id="${firstId}"]`)).toBeVisible();
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    const editor = page.locator('.page-editor').first();
    const box = (await editor.boundingBox())!;
    // Keep native pen input away from the blank-page "Open PDF" welcome button.
    const x = box.x + box.width / 4,
      y = box.y + box.height * 0.75;
    await editor.evaluate((el) =>
      el.addEventListener(
        'pointerdown',
        (e) => {
          (window as any).__samplingPen = { id: (e as PointerEvent).pointerId, time: e.timeStamp };
        },
        { once: true },
      ),
    );
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      pointerType: 'pen',
      force: 0.2,
    });
    await page.evaluate(
      ({ x, y }) => {
        const root = document.querySelector('.page-editor')!;
        const pen = (window as any).__samplingPen;
        const positions = [
          [0, 3],
          [0, 6],
          [0, 9],
          [0, 12],
          [3, 15],
          [6, 15],
          [9, 12],
          [9, 9],
          [9, 6],
          [9, 3],
          [9, 0],
        ];
        const samples = positions.map(([dx, dy], i) => {
          const event = new PointerEvent('pointermove', {
            bubbles: true,
            pointerType: 'pen',
            pointerId: pen.id,
            buttons: 1,
            pressure: 0.2 + i * 0.01,
            clientX: x + dx,
            clientY: y + dy,
          });
          Object.defineProperty(event, 'timeStamp', { value: pen.time + i + 1 });
          return event;
        });
        for (const type of ['pointerrawupdate', 'pointermove']) {
          const event = new PointerEvent(type, {
            bubbles: true,
            pointerType: 'pen',
            pointerId: pen.id,
            buttons: 1,
            pressure: 0.3,
            clientX: x + 9,
            clientY: y,
          });
          Object.defineProperty(event, 'getCoalescedEvents', { value: () => samples });
          root.dispatchEvent(event);
        }
      },
      { x, y },
    );
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: x + 9,
      y,
      button: 'left',
      buttons: 0,
      pointerType: 'pen',
      force: 0,
    });
    const downloaded = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    const file = await downloaded;
    const saved = JSON.parse(await fs.readFile((await file.path())!, 'utf8'));
    const strokes = saved.pages.flatMap((p: any) => p.strokes);
    expect(strokes).toHaveLength(1);
    expect(strokes[0].points).toHaveLength(12);
    const points = strokes[0].points;
    expect(Math.max(...points.map((p: number[]) => p[1]))).toBeGreaterThan(
      points[0][1] + (10 * 600) / box.width,
    );
    expect(points.at(-1)[2]).toBeCloseTo(0.3);
  });
