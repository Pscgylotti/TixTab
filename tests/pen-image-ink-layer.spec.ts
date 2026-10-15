import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
async function pen(
  page: Page,
  type: string,
  x: number,
  y: number,
  contact: boolean,
  buttons = contact ? 3 : 2,
) {
  await page.evaluate(
    ({ type, x, y, contact, buttons }) => {
      document.elementFromPoint(x, y)!.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerType: 'pen',
          pointerId: 88,
          clientX: x,
          clientY: y,
          button: type === 'pointerdown' ? 2 : -1,
          buttons,
          pressure: contact ? 0.6 : 0,
          isPrimary: true,
        }),
      );
    },
    { type, x, y, contact, buttons },
  );
}
for (const night of [false, true])
  for (const view of ['单页标注', '连续页面预览', '双页预览']) {
    test(`full-page image highlight stays transparent and ink selection stays operable: ${view}, night=${night}`, async ({
      page,
      context,
    }) => {
      await page.addInitScript(
        (night) => localStorage.setItem('surfacetab.night', String(night)),
        night,
      );
      await page.goto('/');
      const png = await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 600;
        c.height = 800;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#dfe7ed';
        ctx.fillRect(0, 0, 600, 800);
        return c.toDataURL();
      });
      const pdf = await PDFDocument.create(),
        image = await pdf.embedPng(png);
      pdf.addPage([600, 800]).drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
      pdf.addPage([600, 800]);
      const project = await page.evaluate(
        async (source) => {
          const { newNotebook, blankPage } = await import('/src/model.ts');
          const { encodeProject } = await import('/src/storage.ts');
          const n = newNotebook();
          n.source = new Uint8Array(source);
          n.pages = [
            { ...blankPage(), sourceIndex: 0, width: 600, height: 800 },
            { ...blankPage(), sourceIndex: 1, width: 600, height: 800 },
          ];
          n.pages[0].strokes = [
            {
              id: 'ink',
              tool: 'pen',
              color: '#d53025',
              size: 5,
              points: [
                [100, 150, 0.5],
                [180, 190, 0.7],
              ],
            },
          ];
          return encodeProject(n);
        },
        Array.from(await pdf.save()),
      );
      await page.locator('input[type=file]').setInputFiles({
        name: 'image-ink.tixtab',
        mimeType: 'application/json',
        buffer: Buffer.from(project),
      });
      await expect(page.locator('.busy-overlay')).toHaveCount(0);
      await page.getByRole('button', { name: view, exact: true }).click();
      await page.getByRole('button', { name: '适合页面', exact: true }).click();
      const paper = page.locator('.paper,.reading-paper').first(),
        bounds = (await paper.boundingBox())!;
      const at = (x: number, y: number) => ({
        x: bounds.x + (x * bounds.width) / 600,
        y: bounds.y + (y * bounds.height) / 800,
      });
      const start = at(70, 120),
        end = at(210, 220);
      await pen(page, 'pointermove', start.x, start.y, false);
      const target = page.locator('[data-pen-interactive=image]');
      await expect(target).toHaveCount(1);
      // Force native pressed/hover CSS: synthetic pen events alone do not enter :active.
      const cdp = await context.newCDPSession(page);
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const document = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector: '[data-pen-interactive=image]',
      });
      await cdp.send('CSS.forcePseudoState', {
        nodeId,
        forcedPseudoClasses: ['hover', 'active', 'focus-visible'],
      });
      await expect(target).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await pen(page, 'pointerdown', start.x, start.y, true);
      await pen(page, 'pointermove', end.x, end.y, true);
      await expect(page.locator('[data-ink-marquee]')).toBeVisible();
      await expect(page.locator('[data-ink-marquee]')).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)',
      );
      await pen(page, 'pointerup', end.x, end.y, false, 2);
      const selection = page.locator('.ink-selection-box');
      await expect(selection).toHaveAttribute('data-selected-strokes', '1');
      const box = (await selection.boundingBox())!;
      expect(
        await page.evaluate(
          ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.ink-selection-box'),
          { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        ),
      ).toBe(true);
      await expect(page.getByRole('dialog', { name: '原图', exact: true })).toHaveCount(0);
      await expect(page.getByRole('menu', { name: '笔侧键工具环' })).toHaveCount(0);
      // Once the barrel is released, the selected frame must still be movable.
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
      await pen(page, 'pointermove', end.x, end.y, false, 0);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10, { steps: 3 });
      await page.mouse.up();
      await expect.poll(async () => (await selection.boundingBox())?.x).toBeGreaterThan(box.x + 15);
    });
  }
