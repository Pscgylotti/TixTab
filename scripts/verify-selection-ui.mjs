import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
export async function verifySelectionUi(page) {
  const before = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 1440, height: 960 });
  if ((await page.locator('html').getAttribute('data-night')) === 'true')
    await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  const keyboard = page.getByRole('button', { name: '关闭屏幕键盘', exact: true });
  if (await keyboard.count()) await keyboard.click();
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('competitive', { x: 230, y: 440, size: 24, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'selection-layout.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  const select = async () => {
    const point = await page
      .locator('.textLayer span')
      .first()
      .evaluate((el) => {
        const r = document.createRange();
        r.setStart(el.firstChild, 2);
        r.setEnd(el.firstChild, 3);
        const b = r.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      });
    await page.mouse.dblclick(point.x, point.y);
    await page.locator('.selection-flyout').waitFor();
  };
  const geometry = async () => {
    await page.waitForFunction(() => {
      const p = document.querySelector('.selection-flyout')?.getBoundingClientRect(),
        r = getSelection()?.rangeCount
          ? getSelection().getRangeAt(0).getBoundingClientRect()
          : null;
      return (
        p &&
        r &&
        p.x >= 0 &&
        p.y >= 0 &&
        p.right <= innerWidth &&
        p.bottom <= innerHeight &&
        !(p.x < r.right && p.right > r.x && p.y < r.bottom && p.bottom > r.y)
      );
    });
  };
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await select();
  await geometry();
  assert.equal(await page.locator('.selection-flyout').getAttribute('data-placement'), 'left');
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('书写惯用手').selectOption('left');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await select();
  await geometry();
  assert.equal(await page.locator('.selection-flyout').getAttribute('data-placement'), 'right');
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await page.getByRole('button', { name: '翻译后端设置', exact: true }).click();
  await page.getByLabel('翻译后端类型').selectOption('llm');
  const controls = await page.locator('.selection-flyout :is(button,a,select)').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return [r.width, r.height];
    }),
  );
  assert.ok(
    controls.every(([w, h]) => w >= 44 && h >= 44),
    'All flyout buttons, links and selects must have 44px touch targets',
  );
  await page.setViewportSize({ width: 560, height: 900 });
  await geometry();
  await page.locator('.translation-footer .primary').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => getSelection()?.toString()), 'competitive');
  await page.screenshot({ path: 'test-results/packaged-selection-portrait.png' });
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await select();
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await geometry();
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await page.locator('.touch-keyboard').waitFor();
  await page.waitForFunction(() => {
    const p = document.querySelector('.selection-flyout').getBoundingClientRect(),
      k = document.querySelector('.touch-keyboard').getBoundingClientRect();
    return !(p.x < k.right && p.right > k.x && p.y < k.bottom && p.bottom > k.y);
  });
  await page.screenshot({ path: 'test-results/packaged-selection-night-keyboard.png' });
  await page.getByRole('button', { name: '关闭屏幕键盘' }).click();
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  assert.equal(await page.getByLabel('Writing hand').inputValue(), 'left');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Select text', exact: true }).click();
  await select();
  await geometry();
  assert.equal(await page.locator('.selection-flyout').getAttribute('data-writing-hand'), 'left');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.getByRole('button', { name: 'Close text tools' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Writing hand').selectOption('right');
  await page.getByLabel('界面语言 / Interface language').selectOption('zh-CN');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.setViewportSize(before);
  console.log(
    'Packaged adaptive selection / hand persistence / 44px controls / portrait / keyboard avoidance / English night reload: verified',
  );
}
