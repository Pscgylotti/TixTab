import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');

async function swipe(page: Page, dx: number, dy = 0, cancel = false) {
  await page.locator('.presentation-view').evaluate(
    (el, { dx, dy, cancel }) => {
      const view = el.querySelector<HTMLElement>('.surface,.reading-view')!;
      view.setPointerCapture = () => {};
      const base = {
        pointerId: 91,
        pointerType: 'touch',
        clientX: 600,
        clientY: 450,
        bubbles: true,
        cancelable: true,
      };
      view.dispatchEvent(new PointerEvent('pointerdown', base));
      view.dispatchEvent(
        new PointerEvent('pointermove', { ...base, clientX: 600 + dx, clientY: 450 + dy }),
      );
      view.dispatchEvent(
        new PointerEvent(cancel ? 'pointercancel' : 'pointerup', {
          ...base,
          clientX: 600 + dx,
          clientY: 450 + dy,
        }),
      );
    },
    { dx, dy, cancel },
  );
}

for (const mode of ['single', 'continuous', 'dual'] as const) {
  test(`${mode}: centered read-only fullscreen, gestures and original view restoration`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 5; i++)
      pdf.addPage([600, 800]).drawText(`Presentation ${i + 1}`, { x: 60, y: 700, size: 28, font });
    await page.locator('input[type=file]').setInputFiles({
      name: 'Presentation.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    });
    await expect(page.getByRole('textbox', { name: '文档名称', exact: true })).toHaveValue(
      'Presentation',
    );
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await page
      .getByRole('button', {
        name: mode === 'single' ? '单页标注' : mode === 'dual' ? '双页预览' : '连续页面预览',
        exact: true,
      })
      .click();
    const editor = page.locator(mode === 'single' ? '#root .surface' : '#root .reading-view');
    await editor.evaluate((el) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -Math.log(1.5 / Number((el as HTMLElement).dataset.viewZoom)) / 0.008,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        }),
      );
    });
    await expect
      .poll(async () => Number(await editor.getAttribute('data-view-zoom')))
      .toBeCloseTo(1.5);
    if (mode === 'single') {
      await editor.evaluate((el) =>
        el.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 35, deltaY: 90 }),
        ),
      );
      await expect
        .poll(async () => Number(await editor.getAttribute('data-pan-y')))
        .toBeLessThan(-80);
    } else
      await editor.evaluate((el) => {
        el.scrollTop = 180;
      });
    const position = () =>
      editor.evaluate(
        (el, mode) =>
          mode === 'single'
            ? [Number((el as HTMLElement).dataset.panX), Number((el as HTMLElement).dataset.panY)]
            : [el.scrollLeft, el.scrollTop],
        mode,
      );
    const before = await position();
    const enter = page.getByRole('button', { name: '展示全屏', exact: true });
    const quick = (await page
      .getByRole('button', { name: '页面快捷操作', exact: true })
      .boundingBox())!;
    const button = (await enter.boundingBox())!;
    const keyboard = (await page
      .getByRole('button', { name: '屏幕键盘', exact: true })
      .boundingBox())!;
    expect(button.x).toBeGreaterThan(quick.x);
    expect(button.x + button.width).toBeLessThanOrEqual(keyboard.x);
    await enter.click();
    const display = page.locator('.presentation-view');
    await expect(display).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await expect(page.locator('#root')).toHaveAttribute('inert', '');
    await expect(enter).toBeHidden();
    expect(await display.boundingBox()).toEqual({ x: 0, y: 0, width: 1440, height: 960 });
    await expect(display.locator('.pdf-layer,.reading-pdf').first()).toBeVisible();
    const surface = display.locator('.surface,.reading-view');
    const fit = Number(await surface.getAttribute('data-view-zoom'));
    await surface.evaluate((el, fit) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -Math.log(4) / 0.008,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        }),
      );
    }, fit);
    await expect
      .poll(async () => Number(await display.getAttribute('data-view-zoom')))
      .toBeCloseTo(fit * 4);
    await swipe(page, -120);
    if (mode !== 'continuous') await expect(display).toHaveAttribute('data-page-index', '0');
    await surface.evaluate((el) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: Math.log(4) / 0.008,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        }),
      );
    });
    await expect
      .poll(async () => Number(await display.getAttribute('data-view-zoom')))
      .toBeCloseTo(fit);
    // A completed pinch must never become a page-turn swipe.
    await surface.evaluate((el) => {
      el.setPointerCapture = () => {};
      const event = (type: string, id: number, x: number) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: 'touch',
            clientX: x,
            clientY: 400,
            bubbles: true,
            cancelable: true,
          }),
        );
      event('pointerdown', 40, 500);
      event('pointerdown', 41, 700);
      event('pointermove', 40, 450);
      event('pointermove', 41, 750);
      event('pointerup', 40, 450);
      event('pointerup', 41, 750);
    });
    await expect
      .poll(async () => Number(await display.getAttribute('data-view-zoom')))
      .toBeCloseTo(fit * 1.5);
    await surface.evaluate((el) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: Math.log(1.5) / 0.008,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        }),
      );
    });
    await expect
      .poll(async () => Number(await display.getAttribute('data-view-zoom')))
      .toBeCloseTo(fit);
    if (mode !== 'continuous') {
      const papers = display.locator('.paper,.reading-paper');
      const rects = await papers.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        }),
      );
      expect(Math.abs((rects[0].x + rects.at(-1)!.right) / 2 - 720)).toBeLessThan(2);
      await swipe(page, -200, 0, true);
      await expect(display).toHaveAttribute('data-page-index', '0');
      await swipe(page, -200, 260);
      await expect(display).toHaveAttribute('data-page-index', '0');
      await swipe(page, -200);
      await expect(display).toHaveAttribute('data-page-index', mode === 'dual' ? '2' : '1');
      expect(
        await display.locator('.presentation-stage').evaluate((el) => el.getAnimations().length),
      ).toBe(1);
      await page.keyboard.press('ArrowRight');
      await expect(display).toHaveAttribute('data-page-index', mode === 'dual' ? '4' : '2');
      await page.keyboard.press('ArrowLeft');
      await expect(display).toHaveAttribute('data-page-index', mode === 'dual' ? '2' : '1');
      if (mode === 'dual') {
        await page.keyboard.press('ArrowRight');
        await expect(display.locator('.reading-paper')).toHaveCount(1);
        await page.keyboard.press('ArrowRight');
        await expect(display).toHaveAttribute('data-page-index', '4');
      }
    } else {
      const scroll = display.locator('.reading-view');
      await swipe(page, 0, -550);
      await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
      await page.mouse.move(700, 400);
      await page.mouse.wheel(0, 1300);
      await expect
        .poll(async () => Number(await display.getAttribute('data-page-index')))
        .toBeGreaterThan(0);
      expect(await display.locator('.reading-card').count()).toBeLessThan(5);
    }
    await page.keyboard.press('Delete');
    await page.keyboard.press('Control+z');
    await display.dblclick({ position: { x: 200, y: 200 } });
    await expect(display).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await expect(enter).toBeVisible();
    await expect
      .poll(async () => Number(await editor.getAttribute('data-view-zoom')))
      .toBeCloseTo(1.5);
    await expect.poll(position).toEqual(before);
    const notebook = await page.evaluate(
      async () =>
        (await (await import('/src/workspaceStore.ts' as string)).bootstrapWorkspace()).notebook,
    );
    expect(notebook.pages).toHaveLength(5);
    expect(notebook.pages.flatMap((p: any) => p.strokes)).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}

test('presentation preserves an existing window fullscreen and exits on touch double tap or host exit', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let active = true;
    const subscribers = new Set<(value: boolean) => void>();
    (window as any).__fullscreenWrites = [];
    (window as any).__hostExit = () => {
      active = false;
      subscribers.forEach((fn) => fn(false));
    };
    (window as any).surfaceDesktop = {
      fullscreenState: async (value?: boolean) => {
        if (value !== undefined) {
          active = value;
          (window as any).__fullscreenWrites.push(value);
          subscribers.forEach((fn) => fn(active));
        }
        return active;
      },
      onFullscreen: (fn: (value: boolean) => void) => {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
    };
  });
  await page.goto('/');
  const enter = page.getByRole('button', { name: '展示全屏', exact: true });
  await enter.click();
  await swipe(page, 0);
  await swipe(page, 0);
  await expect(page.locator('.presentation-view')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__fullscreenWrites)).toEqual([]);
  await enter.click();
  await expect(page.locator('.presentation-view')).toBeVisible();
  await page.evaluate(() => (window as any).__hostExit());
  await expect(page.locator('.presentation-view')).toHaveCount(0);
  await enter.click();
  await expect.poll(() => page.evaluate(() => (window as any).__fullscreenWrites)).toEqual([true]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.presentation-view')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__fullscreenWrites)).toEqual([true, false]);
});
