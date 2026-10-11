import assert from 'node:assert/strict';
import { verifyNightUi } from './verify-night-ui.mjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
/** Exercise the packaged UI without a development server or application internals. */
export async function verifyUiFeatures(page) {
  const closeKeyboard = page.getByRole('button', { name: '关闭屏幕键盘', exact: true });
  if (await closeKeyboard.count()) await closeKeyboard.click();
  const closeFormula = page
    .getByRole('dialog', { name: '手写公式' })
    .getByRole('button', { name: '关闭', exact: true });
  if (await closeFormula.count()) await closeFormula.click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('heading', { name: 'Paper and pen' }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  const pdfPage = doc.addPage([595, 842]);
  pdfPage.drawText('Packaged viewport detail check', { x: 70, y: 700, size: 24, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'details.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.locator('.surface').evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new WheelEvent('wheel', {
        ctrlKey: true,
        deltaY: -2000,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page.locator('.pdf-detail-tile[data-ready=true]').first().waitFor();
  const pixels = await page.locator('.pdf-detail-layer').getAttribute('data-pixels');
  assert.ok(Number(pixels) > 0 && Number(pixels) <= 6_000_000);
  assert.equal(await page.locator('.preview-toggle').count(), 0);
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 50;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 50, 50);
    return c.toDataURL();
  });
  const images = [
    { id: 'a', x: 100, y: 100 },
    { id: 'b', x: 220, y: 160 },
    { id: 'c', x: 400, y: 400 },
  ].map((i) => ({ ...i, width: 60, height: 50, kind: 'sketch', data: png }));
  await page.locator('input[type=file]').setInputFiles({
    name: 'groups.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        name: '中文 group check',
        source: null,
        pages: [
          {
            id: 'p',
            sourceIndex: null,
            width: 595.28,
            height: 841.89,
            paper: 'plain',
            images,
            strokes: [],
          },
        ],
      }),
    ),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await page.getByRole('button', { name: 'Fit page', exact: true }).click();
  const paper = await page.locator('.paper').boundingBox(),
    point = (x, y) => ({
      x: paper.x + (x / 595.28) * paper.width,
      y: paper.y + (y / 841.89) * paper.height,
    });
  const from = point(70, 70),
    to = point(310, 250);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  assert.equal(await page.locator('.object-selection').getAttribute('data-selected-count'), '2');
  await page.screenshot({ path: 'test-results/packaged-marquee-english.png' });
  const before = await page.locator('[data-object-id=a]').boundingBox(),
    a = point(130, 125),
    b = point(160, 155);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  const after = await page.locator('[data-object-id=a]').boundingBox();
  assert.ok(after.x > before.x + 10);
  await page.keyboard.press('Delete');
  assert.equal(await page.locator('.placed-object').count(), 1);
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('.placed-object').count(), 3);
  await page.waitForFunction(() =>
    document.querySelector('.save-state')?.textContent.includes('Saved automatically'),
  );
  await page.reload();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(
    await page.getByLabel('Document name', { exact: true }).inputValue(),
    '中文 group check',
  );
  assert.equal(await page.locator('.placed-object').count(), 3);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('zh-CN');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  console.log(
    'Packaged English persistence / viewport tiles / marquee group move + delete + undo: verified',
  );
  await verifyNightUi(page);
}
