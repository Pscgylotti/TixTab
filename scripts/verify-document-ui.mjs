import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
async function project(page) {
  return page.evaluate(async () => {
    const create = URL.createObjectURL,
      click = HTMLAnchorElement.prototype.click;
    let blob;
    URL.createObjectURL = (value) => {
      blob = value;
      return create(value);
    };
    HTMLAnchorElement.prototype.click = function () {};
    try {
      document.querySelector('button[aria-label="保存工程"]').click();
      if (!blob) throw Error('Project download was not created');
      return JSON.parse(await blob.text());
    } finally {
      URL.createObjectURL = create;
      HTMLAnchorElement.prototype.click = click;
    }
  });
}
export async function verifyDocumentUi(page) {
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  const closeKeyboard = page.getByRole('button', { name: '关闭屏幕键盘', exact: true });
  if (await closeKeyboard.count()) await closeKeyboard.click();
  const initial = await page.getByRole('tab').count(),
    files = [];
  for (const name of ['Tabs A', 'Tabs B']) {
    const d = await PDFDocument.create(),
      font = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 4; i++)
      d.addPage([595, 842]).drawText(`${name} ${i + 1}`, { x: 60, y: 740, font, size: 22 });
    files.push({ name: `${name}.pdf`, bytes: [...(await d.save())] });
  }
  await page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files)
      dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'application/pdf' }));
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, cancelable: true }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
  }, files);
  await page.getByRole('button', { name: '打开为新标签页', exact: true }).click();
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll('[role=tab]').length === expected &&
      !document.querySelector('.busy-overlay'),
    initial + 2,
  );
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('button', { name: '放大', exact: true }).click();
  const zoom = await page.locator('.zoom-dock>span').textContent();
  await page.getByRole('button', { name: '加页', exact: true }).click();
  await page.getByRole('tab', { name: 'Tabs A', exact: true }).click();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.match(await page.locator('.page-navigation').textContent(), /1\s*\/\s*4/);
  await page.getByRole('tab', { name: 'Tabs B', exact: true }).click();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.match(await page.locator('.page-navigation').textContent(), /3\s*\/\s*5/);
  assert.equal(await page.locator('.zoom-dock>span').textContent(), zoom);
  const expand = page.getByRole('button', { name: '展开工具栏', exact: true });
  if (await expand.count()) await expand.click();
  const collapseSidebar = page.getByRole('button', { name: '收起页面栏', exact: true });
  if (await collapseSidebar.isVisible()) await collapseSidebar.click();
  await page.getByRole('button', { name: '自定义笔触颜色', exact: true }).click();
  await page.getByLabel('十六进制颜色').fill('#17aabb');
  await page.getByRole('button', { name: '保存常用颜色', exact: true }).click();
  await page.getByRole('button', { name: '应用颜色', exact: true }).click();
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  await page.locator('.surface').evaluate((el) => {
    el.setPointerCapture = () => {};
    const r = el.querySelector('.paper').getBoundingClientRect(),
      base = {
        bubbles: true,
        pointerType: 'pen',
        pointerId: 8,
        button: 0,
        buttons: 1,
        pressure: 0.5,
        clientY: r.top + r.height / 2,
      };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: r.left + r.width / 3 }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: r.left + r.width / 2 }));
    el.dispatchEvent(
      new PointerEvent('pointerup', {
        ...base,
        clientX: r.left + r.width / 2,
        buttons: 0,
        pressure: 0,
      }),
    );
  });
  assert.equal((await project(page)).pages[2].strokes.at(-1).color, '#17aabb');
  await page.getByRole('button', { name: '收起底部工具', exact: true }).click();
  assert.equal(await page.locator('.canvas-container .insert-dock').count(), 0);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.setViewportSize({ width: 560, height: 1000 });
  for (const name of ['收起顶部区域', '收起工具栏']) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.isVisible()) await button.click();
  }
  assert.match(await page.locator('.app-shell').getAttribute('class'), /chrome-minimal/);
  assert.ok((await page.locator('.document-tabs').boundingBox()).height <= 36);
  assert.ok((await page.locator('.statusbar').boundingBox()).height <= 36);
  for (const name of ['框选 OCR', '公式', '下一页', '放大', '适合页面']) {
    const button = page.getByRole('button', { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    const r = await button.boundingBox();
    assert.ok(r.x >= 0 && r.x + r.width <= 560);
  }
  await page.screenshot({ path: 'test-results/packaged-document-tabs-night.png' });
  await page.getByRole('button', { name: '展开顶部区域', exact: true }).click();
  await page.getByRole('button', { name: '展开工具栏', exact: true }).click();
  await page.getByRole('button', { name: '关闭标签 Tabs A', exact: true }).click();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '管理工作空间', exact: true }).click();
  await page.getByRole('button', { name: '打开文档 Tabs A', exact: true }).click();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Tabs B', exact: true }).click();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.waitForFunction(() =>
    document.querySelector('.save-state')?.textContent.includes('已自动保存'),
  );
  await page.reload();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('tab').count(), initial + 2);
  assert.equal(
    await page.getByRole('tab', { name: 'Tabs B', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  assert.equal((await project(page)).pages[2].strokes.at(-1).color, '#17aabb');
  assert.equal(await page.evaluate(() => localStorage.getItem('surfacetab.inkColor')), '#17aabb');
  await page.getByRole('button', { name: '展开底部工具', exact: true }).click();
  await page.getByRole('button', { name: '自定义笔触颜色', exact: true }).click();
  assert.equal(await page.getByLabel('十六进制颜色').inputValue(), '#17aabb');
  await page.getByRole('button', { name: '关闭颜色设置', exact: true }).click();
  assert.equal(await page.evaluate(() => 'openEtymology' in (window.surfaceDesktop || {})), false);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  console.log(
    'Actual packaged document tabs: drag multi-import, view/ink retention, close/reopen/reload, status tools, saved custom colors/night portrait and removed etymology: passed',
  );
}
