import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, PDFName, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
async function point(page: Page, selector: string, x: number, y: number) {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + (box.width * x) / 600, y: box.y + (box.height * y) / 800 };
}
async function pen(
  page: Page,
  type: string,
  position: { x: number; y: number },
  contact = false,
  buttons = 2,
  button = contact ? 0 : 2,
) {
  await page.evaluate(
    ({ type, position, contact, buttons, button }) => {
      document.elementFromPoint(position.x, position.y)!.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerType: 'pen',
          pointerId: 77,
          clientX: position.x,
          clientY: position.y,
          button,
          buttons,
          pressure: contact ? 0.6 : 0,
          isPrimary: true,
        }),
      );
    },
    { type, position, contact, buttons, button },
  );
}
async function openFixture(page: Page) {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 768;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#e64a35';
    ctx.fillRect(0, 0, 1024, 768);
    return c.toDataURL();
  });
  const doc = await PDFDocument.create(),
    a = doc.addPage([600, 800]),
    b = doc.addPage([600, 800]),
    font = await doc.embedFont(StandardFonts.Helvetica),
    image = await doc.embedPng(png);
  a.drawImage(image, { x: 200, y: 400, width: 180, height: 135 });
  a.drawText('arXiv:2607.12358', { x: 60, y: 700, size: 16, font });
  a.drawText('author@example.org', { x: 60, y: 660, size: 16, font });
  a.drawText('Reference', { x: 60, y: 620, size: 16, font });
  a.node.set(
    PDFName.of('Annots'),
    doc.context.obj([
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [60, 615, 140, 640],
          Dest: [b.ref, PDFName.of('Fit')],
        }),
      ),
    ]),
  );
  await page.locator('input[type=file]').setInputFiles({
    name: 'interactions.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
}
test('held side button reveals image/arXiv/email/reference targets across tools; blank contact opens ring', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openFixture(page);
  const p = await point(page, '.pdf-layer', 290, 330);
  await pen(page, 'pointerdown', p);
  await expect(page.getByRole('menu', { name: '笔侧键工具环' })).toHaveCount(0);
  await expect(page.locator('[data-pen-interactive=image]')).toHaveCount(1);
  await expect(
    page.locator('.pen-interaction-active [href="https://arxiv.org/abs/2607.12358"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('.pen-interaction-active [href="mailto:author@example.org"]'),
  ).toHaveCount(1);
  await pen(page, 'pointerdown', p, true, 3);
  await pen(page, 'pointerup', p, false, 0);
  const modal = page.getByRole('dialog', { name: '原图', exact: true });
  await expect(modal).toBeVisible();
  await pen(page, 'pointerup', p, false, 0);
  await expect
    .poll(() => modal.locator('canvas').evaluate((c: HTMLCanvasElement) => [c.width, c.height]))
    .toEqual([1024, 768]);
  await expect(modal).toBeVisible();
  await page.getByRole('button', { name: '关闭原图' }).click();
  await page.evaluate(() => {
    const w = window as any;
    w.testOpened = [];
    w.surfaceDesktop = {
      ...w.surfaceDesktop,
      openDocumentUrl: async (url: string) => {
        w.testOpened.push(url);
      },
    };
  });
  for (const url of ['https://arxiv.org/abs/2607.12358', 'mailto:author@example.org']) {
    await pen(page, 'pointermove', p);
    const link = page.locator(`[data-pen-interactive=link][href="${url}"]`);
    await expect(link).toBeVisible();
    const box = (await link.boundingBox())!,
      at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await pen(page, 'pointerdown', at, true, 3);
    await pen(page, 'pointerup', at, false, 0);
  }
  expect(await page.evaluate(() => (window as any).testOpened)).toEqual([
    'https://arxiv.org/abs/2607.12358',
    'mailto:author@example.org',
  ]);
  await pen(page, 'pointermove', p);
  const reference = page.getByRole('button', { name: '跳转到引用' });
  await expect(reference).toBeVisible();
  const r = (await reference.boundingBox())!;
  await pen(page, 'pointerdown', { x: r.x + 10, y: r.y + 5 }, true, 3);
  await pen(page, 'pointerup', { x: r.x + 10, y: r.y + 5 }, false, 0);
  await expect(page.locator('.paper')).toHaveAttribute('data-pdf-source', '1');
  await pen(page, 'pointerup', p, false, 0);
  await expect(page.locator('.pdf-image-interactions')).toHaveCount(0);
  const blank = await point(page, '.pdf-layer', 300, 300);
  await pen(page, 'pointerdown', blank, true, 3);
  await pen(page, 'pointerup', blank, false, 0);
  await expect(page.getByRole('menu', { name: '笔侧键工具环' })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const view of ['单页标注', '连续页面预览', '双页预览']) {
  test(`chorded barrel/tip events activate once and highlight until barrel release: ${view}`, async ({
    page,
  }) => {
    await openFixture(page);
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.getByRole('button', { name: '选文', exact: true }).click();
    await page.evaluate(() => {
      const w = window as any;
      w.testOpened = [];
      w.surfaceDesktop = {
        ...w.surfaceDesktop,
        openDocumentUrl: async (url: string) => w.testOpened.push(url),
      };
    });
    const at = await point(page, '.paper,.reading-paper', 95, 94);
    // One browser task: contact before highlight effects can load any metadata.
    await page.evaluate((at) => {
      const target = document.elementFromPoint(at.x, at.y)!;
      for (const [type, button, buttons, pressure] of [
        ['pointerdown', 2, 2, 0],
        ['pointermove', 0, 3, 0.6],
        ['pointermove', -1, 3, 0.6],
      ] as const)
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: 'pen',
            pointerId: 77,
            clientX: at.x,
            clientY: at.y,
            button,
            buttons,
            pressure,
          }),
        );
    }, at);
    await expect
      .poll(() => page.evaluate(() => (window as any).testOpened))
      .toEqual(['https://arxiv.org/abs/2607.12358']);
    await expect(page.getByRole('menu', { name: '笔侧键工具环' })).toHaveCount(0);
    // Tip lifts while barrel remains held: this is another move, not pointerup.
    await pen(page, 'pointermove', at, false, 2, 0);
    await expect(
      page.locator('.pen-interaction-active [href="mailto:author@example.org"]'),
    ).toHaveCount(1);
    await pen(page, 'pointercancel', at, false, 0);
    await expect(page.locator('.pen-interaction-active')).toHaveCount(0);
    // Hover movement alone must also detect a held barrel button.
    const imageAt = await point(page, '.paper,.reading-paper', 290, 330);
    await pen(page, 'pointermove', imageAt, false, 2, -1);
    await expect(page.locator('[data-pen-interactive=image]')).toHaveCount(1);
    await pen(page, 'pointermove', imageAt, true, 3, 0);
    const modal = page.getByRole('dialog', { name: '原图', exact: true });
    await expect(modal).toBeVisible();
    await expect
      .poll(() => modal.locator('canvas').evaluate((c: HTMLCanvasElement) => [c.width, c.height]))
      .toEqual([1024, 768]);
    await pen(page, 'pointerup', imageAt, false, 0);
    await page.getByRole('button', { name: '关闭原图' }).click();
    await pen(page, 'pointermove', at, false, 2, -1);
    await expect(page.locator('.pen-interaction-active')).toHaveCount(1);
    await pen(page, 'pointerup', at, false, 0, 2);
    await expect(page.locator('.pen-interaction-active')).toHaveCount(0);
    // Some drivers first report the barrel on tip contact, with right-button
    // identity and pressure but no separate left-button bit.
    await pen(page, 'pointerdown', at, true, 2, 2);
    await pen(page, 'pointermove', at, true, 2, -1);
    await expect
      .poll(() => page.evaluate(() => (window as any).testOpened))
      .toEqual(['https://arxiv.org/abs/2607.12358', 'https://arxiv.org/abs/2607.12358']);
    await expect(page.getByRole('menu', { name: '笔侧键工具环' })).toHaveCount(0);
    await pen(page, 'pointermove', at, false, 0, 2);
    await expect(page.locator('.pen-interaction-active')).toHaveCount(0);
  });
}
