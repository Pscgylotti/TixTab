import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, scale } =
  createRequire(import.meta.url)('pdf-lib');
import fs from 'node:fs/promises';
import path from 'node:path';
async function pen(
  page: Page,
  points: { x: number; y: number; pressure: number }[],
  eraser = false,
  cancel = false,
) {
  await page.locator('.page-editor').evaluate(
    (el, { points, eraser, cancel }) => {
      // Synthetic protocol coverage only. Hardware mapping is tested separately on the Surface.
      el.setPointerCapture = () => {};
      const r = el.closest('.paper')!.getBoundingClientRect();
      const events = points.map((p) => ({
        pointerId: 9,
        pointerType: 'pen',
        clientX: r.left + (p.x / 595.28) * r.width,
        clientY: r.top + (p.y / 841.89) * r.height,
        pressure: p.pressure,
        buttons: eraser ? 32 : 1,
        button: eraser ? 5 : 0,
        bubbles: true,
      }));
      el.dispatchEvent(new PointerEvent('pointerdown', events[0]));
      for (const event of events.slice(1)) el.dispatchEvent(new PointerEvent('pointermove', event));
      el.dispatchEvent(
        new PointerEvent(cancel ? 'pointercancel' : 'pointerup', {
          ...events.at(-1),
          pressure: 0,
          buttons: 0,
        }),
      );
    },
    { points, eraser, cancel },
  );
}
async function project(page: Page) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  const downloaded = await downloadPromise;
  expect(downloaded.suggestedFilename()).toMatch(/\.tixtab$/);
  return JSON.parse(await fs.readFile((await downloaded.path())!, 'utf8'));
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
});

test('键盘设置默认收起，Shift 符号角标与竖线输入一致', async ({ page }) => {
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByLabel('LaTeX · 可直接修改').fill('');
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await expect(page.getByLabel('键盘大小')).toHaveCount(0);
  await expect(page.locator('.hg-button[data-skbtn="6"]')).toHaveAttribute(
    'data-shift-preview',
    '^',
  );
  await expect(page.locator('.hg-button').filter({ hasText: /^\\$/ })).toHaveAttribute(
    'data-shift-preview',
    '|',
  );
  await page.locator('.hg-button[data-skbtn="{shift}"]').click();
  await page.locator('.hg-button[data-skbtn="|"]').click();
  await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('|');
  await page.locator('.hg-button[data-skbtn="^"]').click();
  await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('|^');
  await page.getByRole('button', { name: '键盘设置', exact: true }).click();
  await expect(page.getByLabel('键盘大小')).toBeVisible();
  await page.getByLabel('键盘大小').fill('650');
  await page.getByRole('button', { name: '键盘设置', exact: true }).click();
  await expect(page.getByLabel('键盘大小')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭屏幕键盘' }).click();
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await expect(page.getByLabel('键盘大小')).toHaveCount(0);
});

test('笔与鼠标从 competitive 首字母内部拖选，不漏首字符，缩放及双页均正确', async ({ page }) => {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([595, 842]);
  p.drawText('competitive environment', { x: 70, y: 700, size: 25, font });
  doc.addPage([595, 842]);
  await page.locator('input[type=file]').setInputFiles({
    name: 'competitive.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '选文', exact: true }).click();
  for (const mode of ['单页标注', '双页预览', '连续页面预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    for (const zoom of [0, 1]) {
      if (zoom) await page.getByRole('button', { name: '放大', exact: true }).click();
      await expect(page.locator('.textLayer').first()).toContainText('competitive environment');
      const box = await page
        .locator('.textLayer span')
        .first()
        .evaluate((el) => {
          const text = el.firstChild!;
          const r = document.createRange();
          r.setStart(text, 0);
          r.setEnd(text, 1);
          const first = r.getBoundingClientRect();
          r.setStart(text, 10);
          r.setEnd(text, 11);
          const last = r.getBoundingClientRect();
          return {
            x: first.left + first.width * 0.8,
            y: first.top + first.height * 0.5,
            end: last.left + last.width * 0.7,
          };
        });
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      await page.mouse.move(box.end, box.y, { steps: 8 });
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('competitive');
      await page.getByRole('button', { name: '关闭划词工具' }).click();
      await page
        .locator('.textLayer')
        .first()
        .evaluate((el, box) => {
          el.setPointerCapture = () => {};
          const pointer = (type: string, x: number) =>
            el.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerType: 'pen',
                pointerId: 11,
                button: 0,
                buttons: type === 'pointerup' ? 0 : 1,
                clientX: x,
                clientY: box.y,
              }),
            );
          pointer('pointerdown', box.x);
          pointer('pointermove', box.end);
          pointer('pointerup', box.end);
        }, box);
      await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('competitive');
      await page.getByRole('button', { name: '关闭划词工具' }).click();
    }
  }
});

test('工作空间分组、文档切换位置、搜索置顶、导出与删除管理', async ({ page }) => {
  await page.getByLabel('文档名称', { exact: true }).fill('研究 A');
  await pen(page, [
    { x: 100, y: 100, pressure: 0.4 },
    { x: 200, y: 150, pressure: 0.7 },
  ]);
  await page.getByRole('button', { name: '插入空白页', exact: true }).click();
  await page.getByRole('button', { name: '放大', exact: true }).click();
  const zoom = await page.locator('.zoom-dock>span').textContent();
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await page.getByRole('button', { name: '新建分组', exact: true }).click();
  await page.getByLabel('新的名称').fill('论文');
  await page.getByRole('button', { name: '保存名称' }).click();
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '工作空间管理' })).toHaveCount(0);
  await page.getByLabel('文档名称', { exact: true }).fill('研究 B');
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await expect(page.locator('.workspace-document')).toHaveCount(2);
  await page.getByRole('button', { name: '置顶 研究 A', exact: true }).click();
  await expect(page.locator('.workspace-document').first()).toContainText('研究 A');
  await page.getByLabel('文档分组 研究 B').selectOption({ label: '论文' });
  await page.getByLabel('搜索文档').fill('B');
  await expect(page.locator('.workspace-document')).toHaveCount(1);
  await page.getByRole('button', { name: '重命名文档 研究 B' }).click();
  await page.getByLabel('新的名称').fill('阅读 B');
  await page.getByRole('button', { name: '保存名称' }).click();
  await page.getByLabel('搜索文档').fill('');
  await page.getByRole('button', { name: '打开文档 研究 A', exact: true }).click();
  await expect(page.locator('.page-navigation')).toContainText('2 / 2');
  await expect(page.locator('.zoom-dock>span')).toHaveText(zoom!);
  const n = await project(page);
  expect(n.pages).toHaveLength(2);
  expect(n.pages[0].strokes).toHaveLength(1);
  await page.getByRole('button', { name: '管理工作空间' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出工程 阅读 B' }).click();
  const downloaded = await downloadPromise;
  expect(downloaded.suggestedFilename()).toBe('阅读 B.tixtab');
  expect(JSON.parse(await fs.readFile((await downloaded.path())!, 'utf8')).name).toBe('阅读 B');
  await page.getByRole('button', { name: '删除文档 阅读 B' }).click();
  await page.getByRole('button', { name: '确认删除文档', exact: true }).click();
  await expect(page.locator('.workspace-document')).toHaveCount(1);
  await page.getByLabel('文档分组 研究 A').selectOption({ label: '论文' });
  await page.getByRole('button', { name: '移除分组 论文' }).click();
  await expect(page.getByLabel('文档分组 研究 A')).toHaveValue('');
  await page.setViewportSize({ width: 960, height: 1280 });
  await page.screenshot({ path: 'test-results/workspace-library-portrait.png' });
  await page.getByRole('button', { name: '关闭工作空间' }).click();
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.getByLabel('文档名称', { exact: true })).toHaveValue('研究 A');
});

test('工作空间旧自动保存迁移、导入保留旧文档、逐页增量保存', async ({ page }) => {
  const writes = await page.evaluate(async () => {
    const store = await import('/src/workspaceStore.ts' as string),
      model = await import('/src/model.ts' as string);
    const n = model.newNotebook();
    n.name = '增量';
    n.source = new Uint8Array(2_000_000);
    n.pages = Array.from({ length: 20 }, () => model.blankPage());
    const id = model.uid(),
      first = await store.saveWorkspaceDocument(id, n);
    const edited = {
      ...n,
      pages: n.pages.map((p: unknown, i: number) =>
        i === 5 ? { ...(p as object), paper: 'lines' } : p,
      ),
    };
    const second = await store.saveWorkspaceDocument(id, edited),
      third = await store.saveWorkspaceDocument(id, edited, { index: 6, zoom: 1.2, mode: 'dual' });
    try {
      await store.saveWorkspaceDocument(id, {
        ...edited,
        scene: { impossible: () => {} },
        pages: edited.pages.map((p: object, i: number) => (i === 5 ? { ...p, paper: 'dots' } : p)),
      });
    } catch {}
    const restored = await store.loadWorkspaceDocument(id),
      removed = { ...restored.notebook, pages: restored.notebook.pages.slice(1) };
    await store.saveWorkspaceDocument(id, removed);
    const loaded = await store.loadWorkspaceDocument(id);
    await store.deleteWorkspaceDocument(id);
    return {
      first,
      second,
      third,
      pages: loaded.notebook.pages.length,
      changedPaper: loaded.notebook.pages[4].paper,
      source: loaded.notebook.source.length,
    };
  });
  expect(writes).toEqual({
    first: { pageWrites: 20, sourceWrites: 1 },
    second: { pageWrites: 1, sourceWrites: 0 },
    third: { pageWrites: 0, sourceWrites: 0 },
    pages: 19,
    changedPaper: 'lines',
    source: 2000000,
  });
  await page.evaluate(async () => {
    const { autosave } = await import('/src/storage.ts' as string),
      { newNotebook } = await import('/src/model.ts' as string);
    const n = newNotebook();
    n.name = '旧笔记';
    await autosave(n);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('surfacetab-workspaces', 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['documents', 'pages', 'sources', 'preferences'], 'readwrite');
      for (const name of ['documents', 'pages', 'sources', 'preferences'])
        tx.objectStore(name).clear();
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.getByLabel('文档名称', { exact: true })).toHaveValue('旧笔记');
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  await page.locator('input[type=file]').setInputFiles({
    name: '保留.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await expect(page.locator('.workspace-document')).toHaveCount(2);
  await expect(page.locator('.workspace-document-list')).toContainText('旧笔记');
  await expect(page.locator('.workspace-document-list')).toContainText('保留');
});
test('竖屏工具完整可见，顶部与工具栏独立收起并记住状态', async ({ page }) => {
  for (const viewport of [
    { width: 560, height: 900 },
    { width: 768, height: 1024 },
    { width: 960, height: 1280 },
    { width: 1440, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('button', { name: '管理工作空间' })).toBeVisible();
    if (viewport.width <= 1000) await expect(page.locator('.sidebar')).toHaveCount(0);
    await expect(page.locator('.toolbar')).toBeVisible();
    const broken = await page.evaluate(() => {
      const selectors =
        '.topbar button,.workspace-heading button,.toolbar button,.toolbar input,.insert-dock button,.zoom-dock button,.page-navigation button,.statusbar button';
      return [...document.querySelectorAll<HTMLElement>(selectors)]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return false;
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return (
            r.left < 0 ||
            r.right > innerWidth + 1 ||
            r.top < 0 ||
            r.bottom > innerHeight + 1 ||
            (!el.contains(hit) && !(el instanceof HTMLButtonElement && el.disabled))
          );
        })
        .map((el) => el.getAttribute('aria-label') || el.textContent || el.title);
    });
    expect(broken, `${viewport.width}px obscured controls`).toEqual([]);
    const height = await page.locator('.canvas-container').evaluate((el) => el.clientHeight);
    await page.getByRole('button', { name: '收起顶部区域', exact: true }).click();
    await page.getByRole('button', { name: '收起工具栏', exact: true }).click();
    await expect(page.locator('.toolbar')).toBeHidden();
    expect(
      await page.locator('.canvas-container').evaluate((el) => el.clientHeight),
    ).toBeGreaterThan(height + 60);
    await page.reload();
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '展开顶部区域', exact: true })).toBeVisible();
    await expect(page.locator('.toolbar')).toBeHidden();
    await page.getByRole('button', { name: '展开顶部区域', exact: true }).click();
    await page.getByRole('button', { name: '展开工具栏', exact: true }).click();
    await expect(page.getByRole('slider', { name: '笔触粗细' })).toBeVisible();
  }
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.getByRole('button', { name: '展开页面栏', exact: true }).click();
  await expect(page.getByRole('button', { name: '插入空白页', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '收起页面栏', exact: true }).click();
  await page.screenshot({ path: 'test-results/portrait-compact.png' });
});
test('压感、背面笔擦、撤销重做、取消笔划与自动恢复', async ({ page }) => {
  await pen(page, [
    { x: 120, y: 240, pressure: 0.1 },
    { x: 160, y: 240, pressure: 0.4 },
    { x: 220, y: 240, pressure: 0.9 },
  ]);
  let n = await project(page);
  expect(n.pages[0].strokes).toHaveLength(1);
  for (const [i, value] of [0.1, 0.4, 0.9].entries())
    expect(n.pages[0].strokes[0].points[i][2]).toBeCloseTo(value, 5);
  await pen(
    page,
    [
      { x: 180, y: 220, pressure: 0.5 },
      { x: 180, y: 270, pressure: 0.5 },
    ],
    true,
  );
  n = await project(page);
  expect(n.pages[0].strokes).toHaveLength(0);
  await expect(page.getByRole('button', { name: '钢笔', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await project(page)).pages[0].strokes).toHaveLength(1);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect((await project(page)).pages[0].strokes).toHaveLength(0);
  await pen(
    page,
    [
      { x: 100, y: 280, pressure: 0.4 },
      { x: 200, y: 280, pressure: 0.8 },
    ],
    false,
    true,
  );
  expect((await project(page)).pages[0].strokes).toHaveLength(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  expect((await project(page)).pages[0].strokes).toHaveLength(1);
});
test('真实 PDF 打开、插页删页、矢量标注导出与工程重开', async ({ page }) => {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595.28, 841.89]);
  p.drawText('TixTab PDF test', { x: 50, y: 760, font, size: 24 });
  p.drawRectangle({ x: 100, y: 500, width: 150, height: 100, color: rgb(0.3, 0.5, 0.8) });
  await page.locator('input[type=file]').setInputFiles({
    name: 'fixture.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.locator('.statusbar')).toContainText('就绪');
  await pen(page, [
    { x: 100, y: 200, pressure: 0.2 },
    { x: 260, y: 200, pressure: 0.9 },
  ]);
  await page.getByRole('button', { name: '插入空白页', exact: true }).click();
  await expect(page.getByRole('button', { name: '第 2 页', exact: true })).toBeVisible();
  const saved = await project(page);
  expect(saved.pages).toHaveLength(2);
  expect(saved.source).toBeTruthy();
  const exportPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PDF', exact: true }).click();
  const output = await exportPromise;
  const outputDoc = await PDFDocument.load(await fs.readFile((await output.path())!));
  expect(outputDoc.getPageCount()).toBe(2);
  await page.getByRole('button', { name: '删除当前页', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除当前页', exact: true }).click();
  expect((await project(page)).pages).toHaveLength(1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await project(page)).pages).toHaveLength(2);
  await page.locator('input[type=file]').setInputFiles({
    name: 'fixture.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  expect((await project(page)).pages[0].strokes).toHaveLength(1);
});
test('复杂 PDF 连续缩放保留背景，结束后高清补绘', async ({ page }) => {
  const doc = await PDFDocument.create(),
    p = doc.addPage([595.28, 841.89]);
  for (let i = 0; i < 4000; i++)
    p.drawRectangle({
      x: (i * 17) % 595,
      y: (i * 13) % 841,
      width: 3,
      height: 3,
      color: rgb(0.3, 0.5, 0.8),
    });
  await page.locator('input[type=file]').setInputFiles({
    name: 'complex.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.locator('.statusbar')).toContainText('高清 · 就绪');
  const before = await page.locator('.pdf-layer').evaluate((c: HTMLCanvasElement) => ({
    width: c.width,
    height: c.height,
    pixel: Array.from(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data).filter(
      (v, i) => i % 4 !== 3 && v < 240,
    ).length,
  }));
  expect(before.pixel).toBeGreaterThan(1000);
  await page.locator('.surface').evaluate((el) => {
    for (let i = 0; i < 14; i++)
      el.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -12,
          ctrlKey: true,
          clientX: 800,
          clientY: 500,
          bubbles: true,
          cancelable: true,
        }),
      );
  });
  const immediate = await page
    .locator('.pdf-layer')
    .evaluate((c: HTMLCanvasElement) => ({ width: c.width, height: c.height }));
  expect(immediate.width).toBe(before.width);
  expect(immediate.height).toBe(before.height);
  await expect(page.locator('.statusbar')).toContainText('高清');
  await page.waitForTimeout(700);
  expect(
    await page.locator('.pdf-layer').evaluate((c: HTMLCanvasElement) => c.width * c.height),
  ).toBeLessThan(6_020_000);
  await expect(page.locator('.preview-toggle')).toHaveCount(0);
  expect(
    await page.locator('.pdf-layer').evaluate((c: HTMLCanvasElement) => c.width),
  ).toBeGreaterThan(500);
});
test('旋转裁切 PDF 导出保持视觉坐标', async ({ page }) => {
  const doc = await PDFDocument.create();
  for (const angle of [0, 90, 180, 270]) {
    const p = doc.addPage([400, 600]);
    p.setCropBox(20, 40, 300, 500);
    p.setRotation(degrees(angle));
    p.drawRectangle({ x: 40, y: 70, width: 70, height: 120, color: rgb(0.9, 0.2, 0.1) });
    p.drawRectangle({ x: 170, y: 350, width: 60, height: 100, color: rgb(0.1, 0.4, 0.9) });
  }
  const source = Array.from(await doc.save());
  const matches = await page.evaluate(async (bytes) => {
    // Exercise the same import/export functions used by the application against actual PDF.js pixels.
    const { importPdf, exportPdf, loadPdf } = await import('/src/pdf.ts' as string);
    const { notebook, pdf } = await importPdf(new Uint8Array(bytes), 'rotated.pdf');
    const output = await loadPdf(await exportPdf(notebook));
    const results = [];
    for (let i = 1; i <= 4; i++) {
      const canvases = [];
      for (const d of [pdf, output]) {
        const p = await d.getPage(i),
          vp = p.getViewport({ scale: 1 }),
          c = document.createElement('canvas');
        c.width = vp.width;
        c.height = vp.height;
        await p.render({ canvas: c, viewport: vp }).promise;
        canvases.push(c);
      }
      const a = canvases[0]
          .getContext('2d')!
          .getImageData(0, 0, canvases[0].width, canvases[0].height).data,
        b = canvases[1]
          .getContext('2d')!
          .getImageData(0, 0, canvases[1].width, canvases[1].height).data;
      let difference = 0;
      for (let j = 0; j < a.length; j++) difference += Math.abs(a[j] - b[j]);
      results.push(difference / a.length);
    }
    await pdf.destroy();
    await output.destroy();
    return results;
  }, source);
  expect(
    matches.every((n) => n < 0.1),
    JSON.stringify(matches),
  ).toBe(true);
});
test('公式手动输入与插入，草图编辑器可用，保存界面截图', async ({ page }) => {
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '手写公式' })).toBeVisible();
  await page.getByLabel('LaTeX · 可直接修改').fill('x^2 + y^2 = 1');
  await expect(page.locator('.katex')).toBeVisible();
  await page.getByRole('button', { name: '插入当前页', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await project(page)).pages[0].images[0].latex).toBe('x^2 + y^2 = 1');
  await page.getByRole('button', { name: '草图', exact: true }).click();
  await expect(page.locator('.excalidraw')).toBeVisible();
  await page.locator('.sketch-modal').getByRole('button', { name: '关闭', exact: true }).click();
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  await page.screenshot({ path: 'test-results/workspace.png', fullPage: true });
});
test('连续和双页预览、PDF 选文、笔侧键与翻译浮窗', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++)
    doc.addPage([595, 842]).drawText(`Surface page ${i}`, { x: 50, y: 700, size: 24, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'reading.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await expect(page.locator('.reading-card[data-page-index="0"]')).toBeVisible();
  expect(await page.locator('.reading-card').count()).toBeLessThanOrEqual(3);
  await page.getByRole('button', { name: '双页预览', exact: true }).click();
  await expect(page.locator('.reading-card')).toHaveCount(2);
  await page
    .locator('.reading-card')
    .first()
    .getByRole('button', { name: '在此页标注', exact: true })
    .click();
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await expect(page.locator('.textLayer').first()).toContainText('Surface page 1');
  await page
    .locator('.textLayer span')
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
  await page.locator('.reading-view').evaluate((el) => {
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerType: 'pen',
        pointerId: 8,
        buttons: 2,
        button: 2,
        clientX: 500,
        clientY: 420,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.getByRole('menu', { name: '笔侧键工具环' })).toBeVisible();
  await page
    .getByRole('menu', { name: '笔侧键工具环' })
    .getByRole('button', { name: '划词工具', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: '划词工具' })).toBeVisible();
  expect((await project(page)).pages[0].strokes).toHaveLength(0);
  await page
    .getByRole('dialog', { name: '划词工具' })
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect(page.locator('.translation-source')).toHaveText('Surface page 1');
  await page.getByRole('button', { name: '翻译后端设置' }).click();
  await page.getByLabel('翻译后端类型').selectOption('web');
  await page.getByLabel('翻译接口地址').fill('invalid');
  await expect(page.locator('.translation-footer')).toContainText('请填写有效接口地址');
  await page.getByLabel('翻译接口地址').fill('http://127.0.0.1:8765/translate');
  let requested = '';
  await page.route('http://127.0.0.1:8765/translate', async (route) => {
    requested = route.request().postData() || '';
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ translatedText: 'Surface 第 1 页' }),
    });
  });
  await page
    .locator('.translation-footer')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect(page.locator('.translation-result')).toHaveText('Surface 第 1 页');
  expect(JSON.parse(requested).text).toBe('Surface page 1');
  await expect(page.locator('.selection-actions a')).toHaveCount(0);
  await page.setViewportSize({ width: 560, height: 900 });
  const box = await page.locator('.selection-flyout').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(560);
  await page.screenshot({ path: 'test-results/translation-portrait.png' });
  expect(errors).toEqual([]);
});
test('实际草图插入可见、矢量显示、移动缩放、再次编辑和 Delete 撤销', async ({ page }) => {
  await page.getByRole('button', { name: '移动', exact: true }).click();
  await page.locator('.surface').hover({ position: { x: 80, y: 80 } });
  await page.mouse.wheel(700, 700);
  await page.getByRole('button', { name: '草图', exact: true }).click();
  await page.getByRole('radio', { name: '矩形', exact: true }).locator('..').click();
  let r = (await page.locator('.excalidraw canvas').last().boundingBox())!;
  await page.mouse.move(r.x + 300, r.y + 180);
  await page.mouse.down();
  await page.mouse.move(r.x + 550, r.y + 350, { steps: 12 });
  await page.mouse.up();
  await page.getByRole('dialog').getByRole('button', { name: '插入当前页', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.placed-object img')).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.placed-object img').evaluate((i: HTMLImageElement) => i.naturalWidth),
    )
    .toBeGreaterThan(0);
  const original = (await project(page)).pages[0].images[0];
  expect(original.displayData).toMatch(/^data:image\/svg/);
  expect(original.scene.elements).toHaveLength(1);
  const rasterWidth = await page.evaluate(async (data) => {
    const i = new Image();
    i.src = data;
    await i.decode();
    return i.naturalWidth;
  }, original.data);
  expect(rasterWidth).toBeGreaterThan(original.width * 4);
  r = (await page.locator('.placed-object').boundingBox())!;
  expect(r.width).toBeGreaterThan(150);
  expect(r.x).toBeGreaterThan(0);
  expect(r.x + r.width).toBeLessThan(1440);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + 50, r.y + r.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  const moved = (await project(page)).pages[0].images[0];
  expect(moved.x).toBeGreaterThan(original.x);
  expect(moved.y).toBeGreaterThan(original.y);
  const handle = (await page.getByRole('button', { name: '缩放对象右下角' }).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 45, handle.y + handle.height / 2 + 30, {
    steps: 8,
  });
  await page.mouse.up();
  const resized = (await project(page)).pages[0].images[0];
  expect(resized.width).toBeGreaterThan(moved.width);
  expect(resized.width / resized.height).toBeCloseTo(original.width / original.height);
  await page.keyboard.press('Control+z');
  expect((await project(page)).pages[0].images[0].width).toBeCloseTo(moved.width);
  await page.keyboard.press('Control+y');
  await page.getByRole('button', { name: '编辑选中草图' }).click();
  await page.getByRole('radio', { name: '椭圆', exact: true }).locator('..').click();
  r = (await page.locator('.excalidraw canvas').last().boundingBox())!;
  await page.mouse.move(r.x + 600, r.y + 200);
  await page.mouse.down();
  await page.mouse.move(r.x + 700, r.y + 300, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: '更新草图', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  let n = await project(page);
  expect(n.pages[0].images).toHaveLength(1);
  expect(n.pages[0].images[0].id).toBe(original.id);
  expect(n.pages[0].images[0].scene.elements).toHaveLength(2);
  expect(n.pages[0].images[0].x).toBeCloseTo(resized.x);
  await page.keyboard.press('Delete');
  expect((await project(page)).pages[0].images).toHaveLength(0);
  await page.keyboard.press('Control+z');
  expect((await project(page)).pages[0].images).toHaveLength(1);
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByLabel('LaTeX · 可直接修改').fill('x^2+y^2=1');
  await page.getByRole('button', { name: '插入当前页', exact: true }).click();
  await page.getByRole('button', { name: '编辑选中公式', exact: true }).click();
  await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('x^2+y^2=1');
  await page.getByLabel('LaTeX · 可直接修改').fill('E=mc^2');
  await page.getByRole('button', { name: '更新公式' }).click();
  n = await project(page);
  expect(n.pages[0].images).toHaveLength(2);
  expect(n.pages[0].images[1].latex).toBe('E=mc^2');
  await page.keyboard.press('Delete');
  expect((await project(page)).pages[0].images).toHaveLength(1);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  expect((await project(page)).pages[0].images).toHaveLength(2);
  await page.screenshot({ path: 'test-results/objects-sharp.png' });
});
test('真实缩略图、双页按钮步长与双指移动不翻页', async ({ page }) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 5; i++)
    doc.addPage([595, 842]).drawRectangle({
      x: 50,
      y: 200,
      width: 300,
      height: 400,
      color: rgb(0.2, 0.3 + i * 0.1, 0.6),
    });
  await page.locator('input[type=file]').setInputFiles({
    name: 'five.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator('.page-thumbnail canvas')
        .first()
        .evaluate((c: HTMLCanvasElement) => c.width),
    )
    .toBeGreaterThan(1);
  expect(
    await page
      .locator('.page-thumbnail canvas')
      .first()
      .evaluate(
        (c: HTMLCanvasElement) =>
          [...c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data].filter((v) => v < 200)
            .length,
      ),
  ).toBeGreaterThan(500);
  await page.getByRole('button', { name: '双页预览', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.page-navigation')).toContainText('3');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.page-navigation')).toContainText('5');
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(page.locator('.page-navigation')).toContainText('3');
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  const swipe = async (selector: string, dx: number, pinch = false) =>
    page.locator(selector).evaluate(
      (el, { dx, pinch }) => {
        el.setPointerCapture = () => {};
        const r = el.getBoundingClientRect(),
          x = r.x + r.width / 2,
          y = r.y + r.height / 2;
        const dispatch = (type: string, pointerId: number, clientX: number, clientY: number) =>
          el.dispatchEvent(
            new PointerEvent(type, {
              pointerId,
              pointerType: 'touch',
              clientX,
              clientY,
              buttons: type === 'pointerup' ? 0 : 1,
              bubbles: true,
              cancelable: true,
            }),
          );
        dispatch('pointerdown', 21, x - 80, y);
        dispatch('pointerdown', 22, x + 80, y);
        for (let i = 1; i <= 8; i++) {
          dispatch('pointermove', 21, x - 80 + (dx * i) / 8, y);
          dispatch('pointermove', 22, x + 80 + ((pinch ? -dx : dx) * i) / 8, y);
        }
        dispatch('pointerup', 21, x - 80 + dx, y);
        dispatch('pointerup', 22, x + 80 + (pinch ? -dx : dx), y);
      },
      { dx, pinch },
    );
  await swipe('.surface', -100);
  await expect(page.locator('.page-navigation')).toContainText('3');
  await swipe('.surface', 100);
  await expect(page.locator('.page-navigation')).toContainText('3');
  await swipe('.surface', -100, true);
  await expect(page.locator('.page-navigation')).toContainText('3');
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await expect(page.locator('.reading-pages')).toHaveCSS('gap', '8px');
  await swipe('.reading-view', -100);
  await expect(page.locator('.page-navigation')).toContainText('3');
});
test('非等比 PDF 文本高亮和双击落点对齐，复制可用，远程翻译真实回退本地', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([595, 842]);
  p.pushOperators(pushGraphicsState(), scale(0.6, 1));
  p.drawText('alpha bravo charlie', { x: 80, y: 700, size: 30, font });
  p.pushOperators(popGraphicsState());
  await page.locator('input[type=file]').setInputFiles({
    name: 'text.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('alpha bravo charlie');
  const expectedWidth = font.widthOfTextAtSize('alpha bravo charlie', 30) * 0.6,
    bravoX =
      48 + (font.widthOfTextAtSize('alpha ', 30) + font.widthOfTextAtSize('bravo', 30) / 2) * 0.6;
  for (const delta of [0, 50, -100]) {
    if (delta) {
      await page.locator('.surface').evaluate(
        (el, deltaY) =>
          el.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY,
              ctrlKey: true,
              clientX: 900,
              clientY: 450,
              bubbles: true,
              cancelable: true,
            }),
          ),
        delta,
      );
    }
    const paper = (await page.locator('.paper').boundingBox())!,
      span = (await page.locator('.textLayer span').first().boundingBox())!,
      zoom = paper.width / 595;
    expect(Math.abs(span.width / zoom - expectedWidth)).toBeLessThan(1);
    expect(Math.abs((span.x - paper.x) / zoom - 48)).toBeLessThan(0.5);
    await page.mouse.dblclick(paper.x + bravoX * zoom, span.y + span.height / 2);
    await expect.poll(() => page.evaluate(() => getSelection()?.toString().trim())).toBe('bravo');
    await page.getByRole('button', { name: '关闭划词工具' }).click();
  }
  await page
    .locator('.textLayer span')
    .first()
    .evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      getSelection()!.addRange(r);
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async () => {
        throw new Error('permission denied');
      },
    });
  });
  await page.getByRole('button', { name: '复制选区', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('alpha bravo charlie');
  await page
    .getByRole('dialog', { name: '划词工具' })
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await page.getByRole('button', { name: '翻译后端设置' }).click();
  await page.getByLabel('翻译后端类型').selectOption('google');
  await expect(page.getByLabel('翻译接口地址')).toHaveValue(
    'https://translation.googleapis.com/language/translate/v2',
  );
  await page.getByLabel('翻译 API Key').fill('test-key');
  await page.route('https://translation.googleapis.com/**', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { translations: [{ translatedText: '你好 &amp; 世界' }] } }),
    }),
  );
  await page
    .locator('.translation-footer')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect(page.locator('.translation-result')).toHaveText('你好 & 世界');
  await page.getByLabel('翻译后端类型').selectOption('web');
  await page.getByLabel('翻译接口地址').fill('http://127.0.0.1:8765/translate');
  await page.route('http://127.0.0.1:8765/translate', (r) => r.abort('failed'));
  await page
    .locator('.translation-footer')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect(page.locator('.translation-status')).toContainText('已回退', { timeout: 30000 });
  await expect(page.locator('.translation-result')).not.toBeEmpty();
});

test('排版换行合并后发送翻译，同一跨行句子本地翻译一致', async ({ page }) => {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([595, 842]);
  p.drawText('The book is on', { x: 50, y: 700, size: 24, font });
  p.drawText('the table.', { x: 50, y: 670, size: 24, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'wrapped.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('the table.');
  await page.locator('.textLayer').evaluate((el) => {
    const spans = el.querySelectorAll('span');
    const r = document.createRange();
    r.setStart(spans[0].firstChild!, 0);
    r.setEnd(spans[spans.length - 1].firstChild!, spans[spans.length - 1].textContent!.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await page
    .getByRole('dialog', { name: '划词工具' })
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await page.getByRole('button', { name: '翻译后端设置' }).click();
  await page.getByLabel('翻译后端类型').selectOption('web');
  await page.getByLabel('翻译接口地址').fill('http://127.0.0.1:8765/translate');
  let sent = '';
  await page.route('http://127.0.0.1:8765/translate', (r) => {
    sent = r.request().postDataJSON().text;
    return r.fulfill({ json: { translatedText: '书放在桌子上' } });
  });
  await page
    .locator('.translation-footer')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect(page.locator('.translation-result')).toHaveText('书放在桌子上');
  expect(sent).toBe('The book is on the table.');
  const result = await page.evaluate(async () => {
    const { localTranslate } = await import('/src/translate.ts' as string);
    const a = await localTranslate('The book is on\nthe table.', 'zh-CN', () => {});
    const b = await localTranslate('The book is on the table.', 'zh-CN', () => {});
    return [a.text, b.text];
  });
  expect(result[0]).toBe(result[1]);
  expect(result[0]).not.toContain('\n');
});

test('连续与双页支持鼠标拖动、触摸拖动、缩放与适合页面', async ({ page }) => {
  for (let i = 0; i < 3; i++)
    await page.getByRole('button', { name: '插入空白页', exact: true }).click();
  await page.getByRole('button', { name: '第 1 页', exact: true }).click();
  await page.getByRole('button', { name: '移动', exact: true }).click();
  for (const mode of ['连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await page.waitForTimeout(150);
    const before = await page
      .locator('.reading-card')
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);
    await page.locator('.reading-view').evaluate((el) =>
      el.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -240,
          ctrlKey: true,
          clientX: el.getBoundingClientRect().x + el.clientWidth / 2,
          clientY: 400,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await expect
      .poll(() =>
        page
          .locator('.reading-card')
          .first()
          .evaluate((el) => el.getBoundingClientRect().width),
      )
      .toBeGreaterThan(before * 2);
    const scrolled = await page.locator('.reading-view').evaluate((el) => el.scrollLeft);
    const bounds = (await page.locator('.reading-view').boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 180);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 - 80, bounds.y + 120, { steps: 5 });
    await page.mouse.up();
    expect(await page.locator('.reading-view').evaluate((el) => el.scrollLeft)).toBeGreaterThan(
      scrolled + 40,
    );
    const current = await page.locator('.reading-view').evaluate((el) => el.scrollTop);
    await page.locator('.reading-view').evaluate((el) => {
      el.setPointerCapture = () => {};
      const r = el.getBoundingClientRect();
      for (const [type, y] of [
        ['pointerdown', 200],
        ['pointermove', 140],
        ['pointerup', 140],
      ] as const)
        el.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 55,
            pointerType: 'touch',
            clientX: r.x + 200,
            clientY: r.y + y,
            bubbles: true,
          }),
        );
    });
    expect(await page.locator('.reading-view').evaluate((el) => el.scrollTop)).toBeGreaterThan(
      current + 40,
    );
    await page.getByRole('button', { name: '适合页面', exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator('.reading-card')
          .first()
          .evaluate((el) => el.getBoundingClientRect().width),
      )
      .toBeLessThan(before * 1.1);
  }
});

test('尾部橡皮先高亮，松手一次删除，取消保留，撤销恢复', async ({ page }) => {
  await pen(page, [
    { x: 100, y: 200, pressure: 0.4 },
    { x: 300, y: 200, pressure: 0.7 },
  ]);
  await pen(page, [
    { x: 100, y: 260, pressure: 0.4 },
    { x: 300, y: 260, pressure: 0.7 },
  ]);
  const erase = (type: string, y: number) =>
    page.locator('.page-editor').evaluate(
      (el, { type, y }) => {
        el.setPointerCapture = () => {};
        const r = el.closest('.paper')!.getBoundingClientRect();
        el.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 10,
            pointerType: 'pen',
            clientX: r.x + (200 / 595.28) * r.width,
            clientY: r.y + (y / 841.89) * r.height,
            button: 5,
            buttons: type === 'pointerup' ? 0 : 32,
            pressure: 0.5,
            bubbles: true,
          }),
        );
      },
      { type, y },
    );
  await erase('pointerdown', 180);
  await erase('pointermove', 280);
  await expect(page.locator('.page-editor')).toHaveAttribute('data-pending-erase', '2');
  expect((await project(page)).pages[0].strokes).toHaveLength(2);
  await erase('pointercancel', 280);
  await expect(page.locator('.page-editor')).toHaveAttribute('data-pending-erase', '0');
  expect((await project(page)).pages[0].strokes).toHaveLength(2);
  await erase('pointerdown', 180);
  await erase('pointermove', 280);
  await erase('pointerup', 280);
  expect((await project(page)).pages[0].strokes).toHaveLength(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await project(page)).pages[0].strokes).toHaveLength(2);
});

test('预定义命令随公式保存，重开可编辑；悬浮键盘输入和尺寸记忆', async ({ page }) => {
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await page.locator('.macro-library summary').click();
  await page
    .getByLabel('预定义命令', { exact: true })
    .fill('{"\\\\RR":"\\\\mathbb{R}","\\\\vect":"\\\\mathbf{#1}"}');
  await page.getByRole('button', { name: '保存预定义命令', exact: true }).click();
  await page.getByLabel('LaTeX · 可直接修改').fill('\\RR + \\vect{x}');
  await expect(page.locator('.katex-error')).toHaveCount(0);
  await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveAttribute('inputmode', 'none');
  await page.getByLabel('LaTeX · 可直接修改').focus();
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await page.locator('.hg-button[data-skbtn="+"]').click();
  await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('\\RR + \\vect{x}+');
  await expect(page.getByLabel('键盘大小')).toHaveCount(0);
  await page.getByRole('button', { name: '键盘设置', exact: true }).click();
  await page.getByLabel('键盘大小').fill('600');
  await page.getByRole('button', { name: '键盘设置', exact: true }).click();
  await expect(page.getByLabel('键盘大小')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '悬浮屏幕键盘' })).toHaveCSS('width', '600px');
  await page.getByRole('button', { name: '关闭屏幕键盘' }).click();
  await page.getByRole('button', { name: '插入当前页', exact: true }).click();
  let saved = await project(page);
  expect(saved.pages[0].images[0].macros['\\RR']).toBe('\\mathbb{R}');
  await page.getByRole('button', { name: '编辑选中公式' }).click();
  await expect(page.locator('.katex-error')).toHaveCount(0);
  await page
    .getByRole('dialog', { name: '手写公式' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.reload();
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await page.locator('.macro-library summary').click();
  await expect(page.getByLabel('预定义命令', { exact: true })).toContainText('mathbb');
});

test('长按缩略图拖动排序、页面管理删除和撤销', async ({ page }) => {
  for (let i = 0; i < 2; i++)
    await page.getByRole('button', { name: '插入空白页', exact: true }).click();
  const original = await project(page),
    active = original.pages[2].id;
  await page.getByRole('button', { name: '第 1 页', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '下移', exact: true }).click();
  let moved = await project(page);
  expect(moved.pages[1].id).toBe(original.pages[0].id);
  expect(moved.pages[2].id).toBe(active);
  const first = (await page.getByRole('button', { name: '第 1 页', exact: true }).boundingBox())!,
    third = (await page.getByRole('button', { name: '第 3 页', exact: true }).boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, first.y + 30);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.move(third.x + third.width / 2, third.y + third.height - 10, { steps: 10 });
  await expect(page.locator('.page-insertion-line')).toHaveAttribute('data-insertion-index', '3');
  await expect(page.locator('.drop-target')).toHaveCount(0);
  await page.mouse.up();
  moved = await project(page);
  expect(moved.pages[2].id).toBe(original.pages[1].id);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await project(page)).pages[0].id).toBe(original.pages[1].id);
  await page.getByRole('button', { name: '第 1 页', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除当前页', exact: true }).click();
  expect((await project(page)).pages).toHaveLength(2);
});

test('扫描页框选 OCR 可复制翻译，远程 OCR 回退真实本地；Piper 中英离线合成', async ({ page }) => {
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 160;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 800, 160);
    ctx.fillStyle = 'black';
    ctx.font = '46px Arial';
    ctx.fillText('The book is on the table.', 25, 100);
    return c.toDataURL();
  });
  const doc = await PDFDocument.create(),
    p = doc.addPage([595, 842]),
    img = await doc.embedPng(data);
  p.drawImage(img, { x: 40, y: 600, width: 500, height: 100 });
  await page.locator('input[type=file]').setInputFiles({
    name: 'scan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const r = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.06, r.y + r.height * 0.16);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.93, r.y + r.height * 0.3, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: '识别文字（OCR）', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '区域识别' })).toBeVisible();
  await page.getByLabel('OCR 后端').selectOption('web');
  await page.route('http://127.0.0.1:8765/ocr', (r) => r.abort());
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(page.getByLabel('识别结果 · 可修改')).toHaveValue(/The book is on the table/, {
    timeout: 30000,
  });
  await expect(page.locator('.ocr-task-status')).toContainText('已回退');
  await page.getByRole('button', { name: '翻译 / 朗读', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '划词工具' })).toBeVisible();
  const result = await page.evaluate(async () => {
    const { localSpeech, releaseTts } = await import('/src/tts.ts' as string);
    const results = [];
    for (const text of ['Hello world.', '你好，欢迎阅读。']) {
      const r = await localSpeech(text, () => {});
      const bytes = new Uint8Array(await r.audio.arrayBuffer());
      results.push({ size: bytes.length, header: new TextDecoder().decode(bytes.slice(0, 4)) });
    }
    releaseTts();
    return results;
  });
  for (const resultItem of result) {
    expect(resultItem.size).toBeGreaterThan(10000);
    expect(resultItem.header).toBe('RIFF');
  }
});

test('公式画板松笔后缓存保留笔迹，取消和清空同步显示', async ({ page }) => {
  await page.getByRole('button', { name: '公式', exact: true }).click();
  const canvas = page.locator('.formula-canvas'),
    r = (await canvas.boundingBox())!;
  const dark = () =>
    canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement,
        data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4)
        if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) count++;
      return count;
    });
  expect(await dark()).toBe(0);
  await page.mouse.move(r.x + r.width * 0.2, r.y + r.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.5, r.y + r.height * 0.6, { steps: 12 });
  await page.mouse.up();
  expect(await dark()).toBeGreaterThan(500);
  const before = await dark();
  await canvas.evaluate((el) => {
    el.setPointerCapture = () => {};
    const r = el.getBoundingClientRect();
    const event = (type: string) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          pointerType: 'pen',
          pointerId: 99,
          button: 0,
          buttons: 1,
          clientX: r.x + r.width * 0.7,
          clientY: r.y + r.height * 0.5,
          pressure: 0.8,
          bubbles: true,
        }),
      );
    event('pointerdown');
    event('pointermove');
    event('pointercancel');
  });
  expect(await dark()).toBe(before);
  await page.getByRole('button', { name: '清空画板', exact: true }).click();
  expect(await dark()).toBe(0);
});
