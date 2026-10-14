import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import assert from 'node:assert/strict';
const root = resolve('.'),
  profile = await mkdtemp(join(root, '.cache', 'native-hover-'));
const app = await electron.launch({
  executablePath: resolve(process.argv[2] || 'node_modules/electron/dist/electron.exe'),
  args: process.argv[2] ? [] : [root],
  env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
  timeout: 60000,
});
const report = { realPenHardware: false, osSyntheticPen: true, samples: [], dom: [], views: [] };
try {
  const page = await app.firstWindow();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const doc = await PDFDocument.create(),
    a = doc.addPage([600, 800]),
    b = doc.addPage([600, 800]);
  a.node.set(
    PDFName.of('Annots'),
    doc.context.obj([
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [100, 500, 300, 550],
          Dest: [b.ref, PDFName.of('Fit')],
        }),
      ),
    ]),
  );
  await page.locator('input[type=file]').setInputFiles({
    name: 'native-hover.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.evaluate(() => {
    window.__nativeSamples = [];
    window.__domSamples = [];
    window.surfaceDesktop.onNativePen((s) => window.__nativeSamples.push(s));
    addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType === 'pen')
          window.__domSamples.push({ buttons: e.buttons, pressure: e.pressure });
      },
      true,
    );
  });
  await app.evaluate(
    async ({ BrowserWindow }, { helper }) => {
      global.__penInjector = process.mainModule.require(helper)();
      const w = BrowserWindow.getAllWindows()[0];
      w.show();
      w.focus();
    },
    { helper: join(root, 'scripts', 'windows-pen-injector.cjs') },
  );
  const send = async (at, barrel, phase = 'hover') =>
    app.evaluate(
      ({ BrowserWindow, screen }, { at, barrel, phase }) => {
        const win = BrowserWindow.getAllWindows()[0],
          b = win.getContentBounds(),
          z = win.webContents.getZoomFactor(),
          point = screen.dipToScreenPoint({
            x: Math.round(b.x + at.x * z),
            y: Math.round(b.y + at.y * z),
          });
        global.__penInjector.send(point.x, point.y, barrel, phase);
        return global.__penInjector.inspect(point.x, point.y);
      },
      { at, barrel, phase },
    );
  for (const view of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    await page.getByRole('button', { name: '适合页面', exact: true }).click();
    const r = await page.locator('.paper,.reading-paper').first().boundingBox(),
      at = { x: r.x + (r.width * 200) / 600, y: r.y + (r.height * 275) / 800 };
    await page.getByRole('button', { name: '移动', exact: true }).click();
    console.log('position', {
      at,
      link: await page.locator('.pdf-document-link').first().boundingBox(),
    });
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    await send(at, false);
    console.log('target', await send(at, true));
    await expect(page.locator('.pen-interaction-active [data-pen-interactive=link]')).toHaveCount(
      1,
    );
    await expect(page.locator('[data-pen-interactive=link].pen-target-hover')).toHaveCount(1);
    await expect(page.locator('[data-pen-interactive=link]')).toHaveCSS(
      'outline-color',
      'rgb(245, 158, 11)',
    );
    await send(at, false);
    await expect(page.locator('.pen-interaction-active')).toHaveCount(0);
    report.views.push({ view, hoverHighlight: true, hoverEmphasis: true, release: true });
  }
  report.samples = await page.evaluate(() => window.__nativeSamples);
  report.dom = await page.evaluate(() => window.__domSamples);
  assert(report.samples.some((s) => s.barrel && !s.contact));
  assert(report.dom.some((s) => s.buttons === 0 && s.pressure === 0));
  await writeFile(join(root, '.cache', 'native-pen-hover.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  console.log('diagnostic', await pageDiagnostic());
  await app
    .evaluate(() => {
      global.__penInjector?.destroy();
      global.__penInjector = null;
    })
    .catch(() => {});
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
async function pageDiagnostic() {
  try {
    const p = await app.firstWindow();
    return await p.evaluate(() => ({
      samples: window.__nativeSamples,
      dom: window.__domSamples,
      active: document.querySelectorAll('.pen-interaction-active').length,
      point: (() => {
        const s = window.__nativeSamples?.find((s) => s.barrel);
        if (!s) return null;
        const e = document.elementFromPoint(s.x, s.y);
        const l = document.querySelector('.pdf-document-link');
        return {
          tag: e?.outerHTML.slice(0, 250),
          canvas: !!e?.closest('.canvas-container'),
          page: e?.closest('[data-page-id]')?.getAttribute('data-page-id'),
          modal: !!document.querySelector('[aria-modal="true"],.pen-tool-wheel'),
          links: document.querySelectorAll('.pdf-document-link').length,
          linkBox: l?.getBoundingClientRect().toJSON(),
        };
      })(),
    }));
  } catch {
    return null;
  }
}
