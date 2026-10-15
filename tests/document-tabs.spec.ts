import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
async function fixture(name: string, count = 3) {
  const d = await PDFDocument.create(),
    font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++)
    d.addPage([595, 842]).drawText(`${name} page ${i + 1}`, { x: 60, y: 740, font, size: 22 });
  return { name: `${name}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(await d.save()) };
}
async function idle(page: Page) {
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
}
async function stored(page: Page, name: string) {
  return page.evaluate(async (name) => {
    const store = await import('/src/workspaceStore.ts' as string);
    const { documents } = await store.listWorkspace();
    const meta = documents.find((d: { name: string }) => d.name === name);
    return meta ? (await store.loadWorkspaceDocument(meta.id, false)).notebook : null;
  }, name);
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await idle(page);
});
test('tab menu reveals inactive PDFs without loading them; paths survive reload and old tabs can associate an original', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).__revealed = [];
    (window as any).surfaceDesktop = {
      onFullscreen: () => () => {},
      getPdfFilePath: (file: File) => `C:/Papers/${file.name}`,
      revealPdf: async (request: any) => {
        (window as any).__revealed.push(request.path || 'picker');
        return { ok: true, path: request.path || 'C:/Recovered/Alpha.pdf' };
      },
    };
  });
  await page.reload();
  await idle(page);
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles(await fixture('Alpha'));
  await idle(page);
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles(await fixture('Beta'));
  await idle(page);
  const revealAlpha = async () => {
    await page.getByRole('tab', { name: 'Alpha', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '在文件夹中显示', exact: true }).click();
  };
  await revealAlpha();
  await expect
    .poll(() => page.evaluate(() => (window as any).__revealed))
    .toEqual(['C:/Papers/Alpha.pdf']);
  await expect(page.getByRole('tab', { name: 'Beta', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect((await stored(page, 'Alpha')).sourcePath).toBe('C:/Papers/Alpha.pdf');
  await page.reload();
  await idle(page);
  await revealAlpha();
  await expect
    .poll(() => page.evaluate(() => (window as any).__revealed))
    .toEqual(['C:/Papers/Alpha.pdf']);
  await page.evaluate(async () => {
    const store = await import('/src/workspaceStore.ts' as string);
    const meta = (await store.listWorkspace()).documents.find((d: any) => d.name === 'Alpha');
    await store.updateWorkspaceDocument(meta.id, { sourcePath: undefined });
  });
  await revealAlpha();
  await expect
    .poll(async () => (await stored(page, 'Alpha')).sourcePath)
    .toBe('C:/Recovered/Alpha.pdf');
  await page.getByRole('button', { name: '新建文档标签', exact: true }).click();
  await idle(page);
  await page.getByRole('tab', { selected: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '在文件夹中显示', exact: true })).toBeDisabled();
});

test('多文件拖入、标签切换保存视图和标注，关闭保留文档，重新打开与重启恢复', async ({ page }) => {
  await page.getByLabel('文档名称', { exact: true }).fill('initial');
  const a = await fixture('Alpha'),
    b = await fixture('Beta');
  await page.evaluate(
    ({ a, b }) => {
      const dt = new DataTransfer();
      for (const f of [a, b])
        dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'application/pdf' }));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, cancelable: true }));
    },
    { a: { name: a.name, bytes: [...a.buffer] }, b: { name: b.name, bytes: [...b.buffer] } },
  );
  await expect(page.locator('.pdf-drop-overlay')).toBeVisible();
  await page.evaluate(
    ({ a, b }) => {
      const dt = new DataTransfer();
      for (const f of [a, b])
        dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'application/pdf' }));
      const event = new DragEvent('drop', { dataTransfer: dt, cancelable: true });
      window.dispatchEvent(event);
      if (!event.defaultPrevented) throw Error('Drop navigation was not blocked');
    },
    { a: { name: a.name, bytes: [...a.buffer] }, b: { name: b.name, bytes: [...b.buffer] } },
  );
  await page.getByRole('button', { name: '打开为新标签页', exact: true }).click();
  await idle(page);
  await expect(page.locator('.pdf-drop-overlay')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.getByRole('tab', { name: 'Beta', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('button', { name: '放大', exact: true }).click();
  const zoom = await page.locator('.zoom-dock>span').textContent();
  await page.getByRole('button', { name: '加页', exact: true }).click();
  await page
    .getByRole('dialog', { name: '插入空白页', exact: true })
    .getByRole('button', { name: '插入页面', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Alpha', exact: true }).click();
  await idle(page);
  await expect(page.locator('.page-navigation')).toContainText('1 / 3');
  await page.getByRole('tab', { name: 'Beta', exact: true }).click();
  await idle(page);
  await expect(page.locator('.page-navigation')).toContainText('3 / 4');
  await expect(page.locator('.zoom-dock>span')).toHaveText(zoom!);
  await page.getByRole('button', { name: '关闭标签 Beta', exact: true }).click();
  await idle(page);
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect((await stored(page, 'Beta')).pages).toHaveLength(4);
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await page.getByRole('button', { name: '打开文档 Beta', exact: true }).click();
  await idle(page);
  await expect(page.getByRole('tab')).toHaveCount(3);
  await page.reload();
  await idle(page);
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.getByRole('tab', { name: 'Beta', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.page-navigation')).toContainText('3 / 4');
  await page.getByLabel('文档名称', { exact: true }).fill('Beta renamed');
  await expect(page.getByRole('tab', { name: 'Beta renamed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await page.getByRole('button', { name: '删除文档 Alpha', exact: true }).click();
  await page.getByRole('button', { name: '确认删除文档', exact: true }).click();
  await idle(page);
  await page.getByRole('button', { name: '关闭工作空间' }).click();
  await expect(page.getByRole('tab', { name: 'Alpha', exact: true })).toHaveCount(0);
});

test('多选导入隔离损坏文件，关闭最后标签保留原始文档', async ({ page }) => {
  await page
    .locator('input[type=file]')
    .setInputFiles([
      await fixture('First'),
      { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('invalid PDF') },
      await fixture('Last'),
    ]);
  await idle(page);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('.toast')).toContainText('broken.pdf');
  await expect(page.getByRole('tab', { name: 'Last', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  for (let i = 0; i < 2; i++) {
    await page.locator('.close-tab').last().click();
    await idle(page);
  }
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect((await stored(page, 'Last')).pages).toHaveLength(3);
  expect((await stored(page, 'First')).pages).toHaveLength(3);
});

test('收起底部工具移入状态栏，双页单步与双步、OCR、公式和夜间竖屏', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(await fixture('Controls', 6));
  await idle(page);
  await page.getByRole('button', { name: '双页预览', exact: true }).click();
  await page.getByRole('button', { name: '收起底部工具', exact: true }).click();
  await expect(page.locator('.canvas-container .insert-dock')).toHaveCount(0);
  await expect(page.locator('.statusbar .insert-dock')).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.statusbar .page-navigation')).toContainText('3 / 6');
  await page.getByRole('button', { name: '向后移动一页', exact: true }).click();
  await expect(page.locator('.statusbar .page-navigation')).toContainText('4 / 6');
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await expect(page.getByLabel('LaTeX · 可直接修改')).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  await expect(page.locator('.region-capture')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  for (const width of [560, 768, 960, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const label of ['框选 OCR', '下一页', '放大', '适合页面']) {
      const button = page.getByRole('button', { name: label, exact: true });
      await button.scrollIntoViewIfNeeded();
      const r = await button.boundingBox();
      expect(r!.x).toBeGreaterThanOrEqual(0);
      expect(r!.x + r!.width).toBeLessThanOrEqual(width);
    }
  }
  await page.setViewportSize({ width: 560, height: 1000 });
  await page.screenshot({ path: 'test-results/document-tabs-night-portrait.png' });
  await page.reload();
  await idle(page);
  await expect(page.getByRole('button', { name: '展开底部工具', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开底部工具', exact: true }).click();
  await expect(page.locator('.canvas-container .insert-dock')).toBeVisible();
});

test('自定义颜色应用于实际笔迹并保存常用色，校验输入和英文夜间面板', async ({ page }) => {
  await page.getByRole('button', { name: '自定义笔触颜色', exact: true }).click();
  await page.getByLabel('十六进制颜色', { exact: true }).fill('#12');
  await expect(page.getByRole('button', { name: '应用颜色' })).toBeDisabled();
  await page.getByLabel('十六进制颜色', { exact: true }).fill('#F012AB');
  await page.getByRole('button', { name: '保存常用颜色' }).click();
  await expect(page.getByRole('button', { name: '颜色 #f012ab', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '应用颜色' }).click();
  await page.locator('.page-editor').evaluate((el) => {
    el.setPointerCapture = () => {};
    const r = el.closest('.paper')!.getBoundingClientRect();
    const base = {
      bubbles: true,
      pointerType: 'pen',
      pointerId: 7,
      button: 0,
      buttons: 1,
      pressure: 0.5,
      clientY: r.top + 100,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: r.left + 100 }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: r.left + 180 }));
    el.dispatchEvent(
      new PointerEvent('pointerup', { ...base, clientX: r.left + 180, buttons: 0, pressure: 0 }),
    );
  });
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  const color = await page.evaluate(() => localStorage.getItem('surfacetab.inkColor'));
  expect(color).toBe('#f012ab');
  const n = await page.evaluate(async () => {
    const store = await import('/src/workspaceStore.ts' as string);
    return (await store.bootstrapWorkspace()).notebook;
  });
  expect(n.pages[0].strokes[0].color).toBe('#f012ab');
  await page.reload();
  await idle(page);
  await page.getByRole('button', { name: '自定义笔触颜色', exact: true }).click();
  await expect(page.getByLabel('十六进制颜色')).toHaveValue('#f012ab');
  await expect(page.getByRole('button', { name: '颜色 #f012ab', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ink-color-panel')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Experimental night mode', exact: true }).click();
  await page.setViewportSize({ width: 560, height: 1000 });
  await page.getByRole('button', { name: 'Custom ink color', exact: true }).click();
  const box = await page.locator('.ink-color-panel').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(560);
  await page.screenshot({ path: 'test-results/custom-ink-night-english.png' });
  await page.getByRole('button', { name: 'Remove color #f012ab', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Color #f012ab', exact: true })).toHaveCount(0);
});

test('拖动标签插入排序保持当前文档，取消不改变顺序，重启恢复', async ({ page }) => {
  await page
    .locator('input[type=file]')
    .setInputFiles(await Promise.all(['Alpha', 'Beta', 'Gamma'].map((n) => fixture(n))));
  await idle(page);
  const a = (await page.getByRole('tab', { name: 'Alpha', exact: true }).boundingBox())!;
  const c = (await page.locator('.document-tab').last().boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width - 3, a.y + a.height / 2, { steps: 6 });
  await expect(page.locator('[data-tab-insertion="3"]')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.getByRole('tab')).toHaveText(['Beta', 'Gamma', 'Alpha']);
  await expect(page.getByRole('tab', { name: 'Gamma', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const b = (await page.getByRole('tab', { name: 'Beta', exact: true }).boundingBox())!;
  await page.mouse.move(b.x + 10, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width, b.y + 10);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByRole('tab')).toHaveText(['Beta', 'Gamma', 'Alpha']);
  await page.reload();
  await idle(page);
  await expect(page.getByRole('tab')).toHaveText(['Beta', 'Gamma', 'Alpha']);
});

test('长按菜单批量关闭保留编辑内容，右键和键盘菜单可用', async ({ page }) => {
  await page
    .locator('input[type=file]')
    .setInputFiles(await Promise.all(['Alpha', 'Beta', 'Gamma'].map((n) => fixture(n))));
  await idle(page);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  const b = (await page.getByRole('tab', { name: 'Beta', exact: true }).boundingBox())!;
  await page.mouse.move(b.x + 15, b.y + 15);
  await page.mouse.down();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByRole('tab', { name: 'Gamma', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('menuitem', { name: '关闭右侧所有标签', exact: true }).click();
  await idle(page);
  await expect(page.getByRole('tab')).toHaveText(['Alpha', 'Beta']);
  await expect(page.getByRole('tab', { name: 'Beta', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect((await stored(page, 'Gamma')).pages).toHaveLength(3);
  await page.getByRole('tab', { name: 'Alpha', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '关闭其它标签', exact: true }).click();
  await idle(page);
  await expect(page.getByRole('tab')).toHaveText(['Alpha']);
  await page.getByRole('tab').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: '关闭其它标签', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: '关闭当前标签', exact: true }).click();
  await idle(page);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Alpha', exact: true })).toHaveCount(0);
  expect((await stored(page, 'Alpha')).pages).toHaveLength(3);
});

test('真实触屏长按拖动排序，普通滑动不切换或重排', async ({ page }) => {
  await page
    .locator('input[type=file]')
    .setInputFiles(await Promise.all(['Alpha', 'Beta', 'Gamma'].map((n) => fixture(n))));
  await idle(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const a = (await page.getByRole('tab', { name: 'Alpha', exact: true }).boundingBox())!;
  const c = (await page.locator('.document-tab').last().boundingBox())!;
  const point = { x: a.x + 15, y: a.y + 15 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await expect(page.getByRole('menu')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: c.x + c.width - 3, y: point.y }],
  });
  await expect(page.locator('[data-tab-insertion="3"]')).toHaveCount(1);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByRole('tab')).toHaveText(['Beta', 'Gamma', 'Alpha']);
  await expect(page.getByRole('menu')).toHaveCount(0);
  const b = (await page.getByRole('tab', { name: 'Beta', exact: true }).boundingBox())!;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: b.x + 30, y: b.y + 15 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: b.x + 5, y: b.y + 15 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByRole('tab')).toHaveText(['Beta', 'Gamma', 'Alpha']);
  await expect(page.getByRole('tab', { name: 'Gamma', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('标签菜单适配英文夜间与折叠竖屏', async ({ page }) => {
  await page
    .locator('input[type=file]')
    .setInputFiles(await Promise.all(['Alpha', 'Beta'].map((n) => fixture(n))));
  await idle(page);
  await page.getByRole('button', { name: '收起顶部区域', exact: true }).click();
  await page.evaluate(() => {
    localStorage.setItem('surfacetab.locale', 'en');
    localStorage.setItem('surfacetab.night', 'true');
  });
  await page.reload();
  await idle(page);
  await page.setViewportSize({ width: 600, height: 900 });
  await page.getByRole('tab', { name: 'Alpha', exact: true }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Tab actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Close other tabs', exact: true })).toBeVisible();
  const r = (await menu.boundingBox())!;
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.x + r.width).toBeLessThanOrEqual(600);
  await page.screenshot({ path: '.cache/031-tab-menu-portrait.png' });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});
