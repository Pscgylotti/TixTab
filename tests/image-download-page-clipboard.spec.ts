import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url),
  { PDFDocument, StandardFonts } = require('pdf-lib'),
  sharp = require('sharp');
async function fixture(name = 'Images', count = 2) {
  const d = await PDFDocument.create(),
    font = await d.embedFont(StandardFonts.Helvetica);
  const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#e02040' } })
    .png()
    .toBuffer();
  const image = await d.embedPng(png);
  for (let i = 0; i < count; i++) {
    const p = d.addPage([400, 600]);
    p.drawText(`${name} ${i + 1}`, { x: 30, y: 540, font, size: 20 });
    p.drawImage(image, { x: 50, y: 300, width: 120, height: 90 });
    p.drawImage(image, { x: 220, y: 150, width: 100, height: 75 });
  }
  return { name: name + '.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await d.save()) };
}
async function idle(page: Page) {
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
}
async function saved(page: Page, name: string) {
  return page.evaluate(async (name) => {
    const s = await import('/src/workspaceStore.ts' as string),
      meta = (await s.listWorkspace()).documents.find((d: any) => d.name === name);
    return meta ? (await s.loadWorkspaceDocument(meta.id, false)).notebook : null;
  }, name);
}
test('OCR screenshot downloads its exact PNG; original-image download keeps native pixels and colors in night mode', async ({
  page,
}) => {
  await page.goto('/');
  await idle(page);
  await page.locator('input[type=file]').setInputFiles(await fixture());
  await idle(page);
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const r = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.15, r.y + r.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.55, r.y + r.height * 0.5, { steps: 6 });
  await page.mouse.up();
  const capture = page.getByRole('dialog', { name: '截图预览', exact: true });
  await expect(capture).toBeVisible();
  const original = await capture.locator('img').getAttribute('src');
  const left = (await capture
      .getByRole('button', { name: '下载图片', exact: true })
      .boundingBox())!,
    right = (await capture.getByRole('button', { name: '复制图片', exact: true }).boundingBox())!;
  expect(left.x).toBeLessThan(right.x);
  const pending = page.waitForEvent('download');
  await capture.getByRole('button', { name: '下载图片', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('TixTab-capture.png');
  expect(await readFile((await download.path())!)).toEqual(
    Buffer.from(original!.split(',')[1], 'base64'),
  );
  await capture.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '移动', exact: true }).click();
  await page.waitForTimeout(250);
  const point = await page.locator('.paper').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + (r.width * 100) / 400, y: r.top + (r.height * 255) / 600 };
  });
  await page.mouse.dblclick(point.x, point.y);
  const modal = page.getByRole('dialog', { name: '原图', exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('button', { name: '下载图片', exact: true })).toBeEnabled();
  const pendingImage = page.waitForEvent('download');
  await modal.getByRole('button', { name: '下载图片', exact: true }).click();
  const image = await pendingImage;
  const bytes = await readFile((await image.path())!);
  const meta = await sharp(bytes).metadata();
  expect([meta.width, meta.height]).toEqual([32, 24]);
  const pixels = await sharp(bytes).raw().toBuffer();
  expect([...pixels.subarray(0, 3)]).toEqual([224, 32, 64]);
});

test('copy a PDF page across tabs with editable annotations and isolated worker lifecycle; paste/undo/clear', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    const Native = Worker;
    (window as any).__pageWorkers = { created: 0, terminated: 0 };
    window.Worker = class extends Native {
      private tracked: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.tracked = String(url).includes('pageTransfer.worker');
        if (this.tracked) (window as any).__pageWorkers.created++;
      }
      terminate() {
        if (this.tracked) (window as any).__pageWorkers.terminated++;
        super.terminate();
      }
    };
  });
  const source = await fixture('Source');
  await page.goto('/');
  await idle(page);
  const project = await page.evaluate(async (encoded) => {
    const { newNotebook } = await import('/src/model.ts' as string),
      { encodeProject } = await import('/src/storage.ts' as string);
    const n = newNotebook();
    n.name = 'Annotated';
    n.source = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const p = n.pages[0];
    p.width = 400;
    p.height = 600;
    p.sourceIndex = 0;
    p.strokes = [
      {
        id: 'ink',
        tool: 'pen',
        color: '#aa2233',
        size: 2,
        points: [
          [10, 10, 0.5],
          [30, 30, 0.8],
        ],
      },
    ];
    p.reviews = [
      { id: 'note', text: 'Review carried', region: { x: 20, y: 30, width: 80, height: 40 } },
    ];
    p.images = [
      {
        id: 'formula',
        kind: 'formula',
        latex: 'x^2',
        data: (() => {
          const c = document.createElement('canvas');
          c.width = 50;
          c.height = 30;
          c.getContext('2d')!.fillText('x', 5, 20);
          const data = c.toDataURL();
          c.width = c.height = 1;
          return data;
        })(),
        x: 50,
        y: 50,
        width: 50,
        height: 30,
      },
    ];
    return encodeProject(n);
  }, source.buffer.toString('base64'));
  await page.locator('input[type=file]').setInputFiles({
    name: 'Annotated.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(project),
  });
  await idle(page);
  await expect(page.getByRole('tab', { name: 'Annotated', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '复制页面到剪贴板', exact: true }).click();
  await idle(page);
  await expect(page.getByRole('button', { name: '粘贴页面', exact: true })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles(await fixture('Target'));
  await idle(page);
  await page.getByRole('button', { name: '关闭标签 Annotated', exact: true }).click();
  await idle(page);
  await page.getByRole('button', { name: '粘贴页面', exact: true }).click();
  await idle(page);
  await expect(page.locator('.page-navigation')).toContainText('2 / 3');
  await expect.poll(async () => (await saved(page, 'Target'))?.pages.length).toBe(3);
  const target = await saved(page, 'Target'),
    copied = target.pages[1];
  expect(copied.strokes[0].id).not.toBe('ink');
  expect(copied.reviews[0].text).toBe('Review carried');
  expect(copied.images[0].latex).toBe('x^2');
  expect(copied.id).not.toBe('format-page');
  await expect
    .poll(() => page.evaluate(() => (window as any).__pageWorkers))
    .toEqual({ created: 2, terminated: 2 });
  await page.keyboard.press('Control+z');
  await expect(page.locator('.page-navigation')).toContainText('/ 2');
  await page.keyboard.press('Control+y');
  await idle(page);
  await expect(page.locator('.page-navigation')).toContainText('2 / 3');
  const token = await page.evaluate(() => navigator.clipboard.readText());
  await page.evaluate((token) => {
    const data = new DataTransfer();
    data.setData('text/plain', token);
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }));
  }, token);
  await idle(page);
  await expect(page.locator('.page-navigation')).toContainText('3 / 4');
  await page.locator('.page-card.selected').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '清除页面剪贴板', exact: true }).click();
  await expect(page.getByRole('button', { name: '粘贴页面', exact: true })).toBeDisabled();
  await page.evaluate((token) => {
    const data = new DataTransfer();
    data.setData('text/plain', token);
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }));
  }, token);
  await expect(page.locator('.toast')).toContainText('页面剪贴板已失效');
  await expect(page.locator('.page-navigation')).toContainText('3 / 4');

  expect(
    await page.evaluate(async () =>
      (await import('/src/pageClipboard.ts' as string)).pageClipboardStats(),
    ),
  ).toEqual({ entries: 0, bytes: 0 });
});

test('extra image tool exports current/all/range PNGs to the selected folder', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__savedImages = [];
    window.surfaceDesktop = {
      onFullscreen: () => () => {},
      imageExport: {
        run: async (request: any) => {
          if (request.action === 'choose')
            return { ok: true, token: 'folder', directory: 'test-images' };
          if (request.action === 'write') {
            (window as any).__savedImages.push({ name: request.name, bytes: [...request.bytes] });
            return { ok: true };
          }
          return { ok: true };
        },
      },
    } as any;
  });
  await page.goto('/');
  await idle(page);
  await page.locator('input[type=file]').setInputFiles(await fixture());
  await idle(page);
  const tools = (await page.getByRole('button', { name: '额外工具', exact: true }).boundingBox())!,
    chat = (await page
      .getByRole('button', { name: '打开 ChatGPT 聊天', exact: true })
      .boundingBox())!;
  expect(tools.x).toBeLessThan(chat.x);
  await page.getByRole('button', { name: '额外工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '提取图片', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '提取图片', exact: true });
  await expect(dialog).toBeVisible();
  for (const [scope, count] of [
    ['current', 2],
    ['all', 4],
    ['range', 2],
  ] as const) {
    await page.evaluate(() => ((window as any).__savedImages = []));
    await dialog.getByLabel('页面范围', { exact: true }).selectOption(scope);
    if (scope === 'range') await dialog.getByLabel('指定页码').fill('2');
    await expect(dialog.getByLabel('范围内位图数量')).toHaveText(`范围内位图：${count}`);
    expect(
      await page.evaluate(
        async () => (await import('/src/pdfiumRaster.ts')).getPdfiumStats().decoderWorkers,
      ),
    ).toBe(0);
    await dialog.getByRole('button', { name: '选择目录并提取', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('图片提取完成。');
    const saved = await page.evaluate(() => (window as any).__savedImages);
    expect(saved).toHaveLength(count);
    for (const image of saved) {
      const meta = await sharp(Buffer.from(image.bytes)).metadata();
      expect([meta.width, meta.height]).toEqual([32, 24]);
      if (scope === 'range') expect(image.name).toMatch(/^page-2-/);
    }
  }
  await page.screenshot({ path: '.cache/image-export-ui.png' });
});

test('batch export releases each canvas and its decoder worker; cancellation leaves no further writes', async ({
  page,
}) => {
  await page.goto('/');
  const file = await fixture('Memory', 5);
  const result = await page.evaluate(
    async (bytes) => {
      const { loadPdf, destroyPdf } = await import('/src/pdf.ts' as string),
        { exportBitmapImages } = await import('/src/imageExport.ts' as string);
      const Native = Worker;
      let created = 0,
        terminated = 0;
      window.Worker = class extends Native {
        constructor(u: string | URL, o?: WorkerOptions) {
          super(u, o);
          created++;
        }
        terminate() {
          terminated++;
          super.terminate();
        }
      };
      const pdf = await loadPdf(new Uint8Array(bytes));
      const { getPdfiumStats } = await import('/src/pdfiumRaster.ts');
      const pages = Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        sourceIndex: i,
        width: 400,
        height: 600,
        paper: 'plain',
        strokes: [],
        images: [],
      }));
      let written = 0,
        closed = 0,
        active = 0,
        peak = 0;
      const abort = new AbortController();
      const sink = {
        directory: 'memory',
        write: async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 1));
          written++;
          active--;
        },
        close: async () => {
          closed++;
        },
      };
      const done = await exportBitmapImages(
        pages,
        pdf,
        [0, 1, 2, 3, 4],
        sink,
        abort.signal,
        () => {},
      );
      const ownership = { created, terminated, decoders: getPdfiumStats().decoderWorkers };
      let stopped = false;
      const cancel = new AbortController();
      let afterStop = 0;
      try {
        await exportBitmapImages(
          pages,
          pdf,
          [0, 1, 2, 3, 4],
          {
            directory: 'cancel',
            write: async () => {
              afterStop++;
              cancel.abort();
            },
            close: async () => {
              closed++;
            },
          },
          cancel.signal,
          () => {},
        );
      } catch (e) {
        stopped = cancel.signal.aborted;
      }
      await destroyPdf(pdf);
      for (let i = 0; i < 100 && getPdfiumStats().pending; i++)
        await new Promise((r) => setTimeout(r, 10));
      const stats = getPdfiumStats();
      window.Worker = Native;
      return {
        done,
        written,
        closed,
        active,
        peak,
        ownership,
        stats,
        stopped,
        afterStop,
        created,
        terminated,
      };
    },
    [...file.buffer],
  );
  expect(result.done).toEqual({ total: 10, saved: 10, skipped: 0 });
  expect(result.ownership).toEqual({ created: 2, terminated: 1, decoders: 0 });
  expect(result.peak).toBe(1);
  expect(result.active).toBe(0);
  expect(result.closed).toBe(2);
  expect(result.stopped).toBe(true);
  expect(result.afterStop).toBe(1);
  expect(result.created - result.terminated).toBe(1);
  expect(result.stats).toMatchObject({
    workers: 1,
    decoderWorkers: 0,
    documents: 0,
    sessions: 0,
    pending: 0,
  });
});

test('focused thumbnail Ctrl+C copies its blank paper into another PDF without changing source bytes', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await idle(page);
  const project = JSON.stringify({
    version: 1,
    name: 'Blank source',
    source: null,
    pages: [
      {
        id: 'red',
        sourceIndex: null,
        width: 300,
        height: 500,
        strokes: [],
        images: [],
        paper: 'dots',
        paperColor: '#ff0000',
      },
      {
        id: 'blue',
        sourceIndex: null,
        width: 400,
        height: 600,
        strokes: [],
        images: [],
        paper: 'grid',
        paperColor: '#0000ff',
      },
    ],
  });
  await page.locator('input[type=file]').setInputFiles({
    name: 'blank.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(project),
  });
  await idle(page);
  await page.getByRole('button', { name: '第 2 页', exact: true }).focus();
  await page.keyboard.press('Control+c');
  await idle(page);
  await expect(page.getByRole('button', { name: '粘贴页面', exact: true })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles(await fixture('BlankTarget'));
  await idle(page);
  const before = await saved(page, 'BlankTarget');
  await page.getByRole('button', { name: '粘贴页面', exact: true }).click();
  await idle(page);
  await expect.poll(async () => (await saved(page, 'BlankTarget'))?.pages.length).toBe(3);
  const after = await saved(page, 'BlankTarget');
  expect(after.source).toEqual(before.source);
  expect(after.pages[1]).toMatchObject({
    sourceIndex: null,
    width: 400,
    height: 600,
    paper: 'grid',
    paperColor: '#0000ff',
  });
  expect(after.pages[1].id).not.toBe('blue');
});
