import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
const { values } = parseArgs({
  options: {
    executable: { type: 'string' },
    'app-dir': { type: 'string' },
    'oracle-source': { type: 'string', default: 'src/ink.ts' },
    output: { type: 'string', default: '.cache/ink-native.json' },
  },
});
const require = createRequire(import.meta.url),
  ts = require('typescript');
// Use the existing path generator as the independent full-replay oracle.
const oracleBytes = await readFile(values['oracle-source']);
const compiled = ts.transpileModule(oracleBytes.toString('utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function('exports', 'require', compiled)(module.exports, require);
const profile = await mkdtemp(join(tmpdir(), 'tixtab-ink-native-'));
const app = await electron.launch({
  ...(values.executable
    ? { executablePath: resolve(values.executable), args: [] }
    : { args: [values['app-dir'] ?? '.'] }),
  env: {
    ...process.env,
    SURFACETAB_DEV: '0',
    SURFACETAB_PROFILE: profile,
  },
});
const checks = [],
  errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
  const strokes = Array.from({ length: 500 }, (_, i) => ({
    id: `original-${i}`,
    tool: ['pen', 'highlighter', 'pencil', 'ballpoint'][i % 4],
    color: ['#1d6de4', '#d45716', '#47b365'][i % 3],
    size: 3 + (i % 9),
    points: Array.from({ length: 2 + (i % 8) }, (_, j) => [
      45 + (i % 100) * 4 + j * 2,
      90 + Math.floor(i / 100) * 80 + j * 4,
      0.1 + (j % 5) * 0.18,
    ]),
  }));
  await page.locator('input[accept=".pdf,.tixtab"]').setInputFiles({
    name: 'ink-native.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        name: 'native ink raster',
        source: null,
        pages: [
          {
            id: 'native',
            sourceIndex: null,
            width: 595.28,
            height: 841.89,
            paper: 'plain',
            strokes,
            images: [],
          },
        ],
      }),
    ),
  });
  await expect(page.getByRole('tab', { name: /native ink raster/ })).toBeVisible();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const destination = join(profile, 'oracle.tixtab');
  await app.evaluate(({ BrowserWindow }, path) => {
    BrowserWindow.getAllWindows()[0].webContents.session.on('will-download', (_, item) =>
      item.setSavePath(path),
    );
  }, destination);
  const verify = async (name) => {
    // Poll the native download, not Playwright's Chromium download event.
    await writeFile(destination, '');
    await page.keyboard.press('Control+s');
    let notebook;
    await expect
      .poll(async () => {
        try {
          notebook = JSON.parse(await readFile(destination, 'utf8'));
          return !!notebook.pages;
        } catch {
          return false;
        }
      })
      .toBe(true);
    const p = notebook.pages[0],
      paths = p.strokes.map((s) => ({
        path: module.exports.finalInkPath(s),
        color: s.color,
        alpha: s.tool === 'highlighter' ? 0.28 : s.tool === 'pencil' ? 0.65 : 1,
      }));
    const result = await page.locator('.ink-layer').evaluate(
      (el, { width, paths }) => {
        const reference = document.createElement('canvas');
        reference.width = el.width;
        reference.height = el.height;
        const ctx = reference.getContext('2d');
        ctx.setTransform(el.width / width, 0, 0, el.width / width, 0, 0);
        for (const s of paths) {
          ctx.fillStyle = s.color;
          ctx.globalAlpha = s.alpha;
          ctx.fill(new Path2D(s.path));
        }
        const pixels = (source) => {
          const copy = document.createElement('canvas');
          copy.width = source.width;
          copy.height = source.height;
          const read = copy.getContext('2d', { willReadFrequently: true });
          read.drawImage(source, 0, 0);
          return read.getImageData(0, 0, copy.width, copy.height).data;
        };
        const a = pixels(el),
          b = pixels(reference);
        let different = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) different++;
        return { different, width: el.width, height: el.height };
      },
      { width: p.width, paths },
    );
    checks.push({ name, strokes: p.strokes.length, ...result });
    expect(result.different, name).toBe(0);
  };
  const click = (name) => page.getByRole('button', { name, exact: true }).click();
  const pen = (eraser = false) =>
    page.locator('.page-editor').evaluate(async (el, eraser) => {
      el.setPointerCapture = () => {};
      const r = el.getBoundingClientRect();
      for (const [type, x] of [
        ['pointerdown', 50],
        ['pointermove', 180],
        ['pointerup', 200],
      ])
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerType: 'pen',
            pointerId: 8,
            button: eraser ? 5 : 0,
            buttons: eraser ? 32 : 1,
            pressure: 0.7,
            clientX: r.x + (x / 595.28) * r.width,
            clientY: r.y + (100 / 841.89) * r.height,
          }),
        );
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }, eraser);
  await click('钢笔');
  await verify('loaded');
  expect(checks.at(-1).strokes, 'Imported fixture must be present').toBe(500);
  for (const tool of ['钢笔', '圆珠笔', '铅笔', '荧光笔']) {
    await click(tool);
    await pen();
    await verify(`append-${tool}`);
  }
  await page.keyboard.press('Control+z');
  await verify('undo');
  await page.keyboard.press('Control+y');
  await verify('redo');
  await pen(true);
  await verify('erase');
  await click('实验性夜间模式');
  await verify('night-raster');
  await click('连续页面预览');
  await click('双页预览');
  await click('单页标注');
  await verify('view-remount');
  await pen();
  await verify('write-after-remount');
  await page.locator('.ink-layer').evaluate((c) => {
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    c.dispatchEvent(new Event('contextlost'));
    c.dispatchEvent(new Event('contextrestored'));
  });
  await verify('context-restoration-event');
  await page.screenshot({ path: values.output.replace(/\.json$/, '') + '-night.png' });
  const graphics = await app.evaluate(({ app }) => app.getGPUFeatureStatus());
  const applicationPath = await app.evaluate(({ app }) => app.getAppPath());
  const report = {
    checks,
    errors,
    graphics,
    profile,
    oracleSha256: createHash('sha256').update(oracleBytes).digest('hex'),
    sourceManifestSha256: values['app-dir']
      ? createHash('sha256')
          .update(await readFile(resolve(values['app-dir'], 'SOURCE-MANIFEST.json')))
          .digest('hex')
      : null,
    applicationSha256: applicationPath.endsWith('.asar')
      ? createHash('sha256')
          .update(await readFile(applicationPath))
          .digest('hex')
      : null,
    executableSha256: values.executable
      ? createHash('sha256')
          .update(await readFile(resolve(values.executable)))
          .digest('hex')
      : null,
    harnessSha256: createHash('sha256')
      .update(await readFile(new URL(import.meta.url)))
      .digest('hex'),
  };
  await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n');
  if (errors.length) throw Error(errors.join('; '));
  console.log(JSON.stringify(report));
} finally {
  await app.close();
}
