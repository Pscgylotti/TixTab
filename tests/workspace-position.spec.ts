import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');

for (const mode of ['single', 'continuous', 'dual'] as const) {
  test(`${mode}: tab switch and reload restore reading offsets and workspace pen size`, async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let n = 0; n < 12; n++)
      pdf.addPage([600, 800]).drawText(`Position page ${n + 1}`, { x: 40, y: 700, font });
    const buffer = Buffer.from(await pdf.save());
    for (const name of ['Position B', 'Position A']) {
      await page
        .locator('input[type=file]')
        .setInputFiles({ name: `${name}.pdf`, mimeType: 'application/pdf', buffer });
      await expect(page.getByRole('textbox', { name: '文档名称', exact: true })).toHaveValue(name);
      await expect(page.locator('.busy-overlay')).toHaveCount(0);
    }
    await page
      .getByRole('button', {
        name: mode === 'single' ? '单页标注' : mode === 'continuous' ? '连续页面预览' : '双页预览',
        exact: true,
      })
      .click();
    const root = page.locator(mode === 'single' ? '.surface' : '.reading-view');
    await root.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -Math.log(1.5 / Number((el as HTMLElement).dataset.viewZoom)) / 0.008,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
    });
    await expect.poll(() => root.getAttribute('data-view-zoom')).toBe('1.5');
    if (mode === 'single') {
      await root.evaluate((el) =>
        el.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 35, deltaY: 90 }),
        ),
      );
      await expect
        .poll(async () => Number(await root.getAttribute('data-pan-y')))
        .toBeLessThan(-80);
    } else {
      await root.evaluate((el, mode) => {
        el.scrollTop = mode === 'continuous' ? 5100 : 200;
        el.scrollLeft = 50;
      }, mode);
      await expect
        .poll(() => root.evaluate((el) => el.scrollTop))
        .toBe(mode === 'continuous' ? 5100 : 200);
    }
    const position = () =>
      root.evaluate(
        (el, mode) =>
          mode === 'single'
            ? {
                x: Number((el as HTMLElement).dataset.panX),
                y: Number((el as HTMLElement).dataset.panY),
              }
            : { x: el.scrollLeft, y: el.scrollTop },
        mode,
      );
    const expected = await position();
    const size = page.getByRole('slider', { name: '笔触粗细', exact: true });
    await size.focus();
    await size.press('End');
    const expectedSize = await size.getAttribute('aria-valuetext');
    await page.getByRole('button', { name: '荧光笔', exact: true }).click();
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    await expect(size).toHaveAttribute('aria-valuetext', expectedSize!);
    await page.getByRole('tab', { name: 'Position B', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '文档名称', exact: true })).toHaveValue(
      'Position B',
    );
    await page.getByRole('tab', { name: 'Position A', exact: true }).click();
    await expect.poll(position).toEqual(expected);
    await page.reload();
    await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
    await expect.poll(position).toEqual(expected);
    await expect(size).toHaveAttribute('aria-valuetext', expectedSize!);
  });
}
