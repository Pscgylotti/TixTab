import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    output: { type: 'string' },
    recovery: { type: 'boolean', default: false },
  },
});
if (!values['app-dir'] || !values.output) throw Error('Supply frozen --app-dir and new --output');
const require = createRequire(import.meta.url),
  ts = require('typescript');
const source = await readFile(resolve(values['app-dir'], 'source/src/ink.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const oracle = { exports: {} };
new Function('exports', 'require', compiled)(oracle.exports, require);
const profile = await mkdtemp(join(tmpdir(), 'tixtab-formula-ink-'));
const app = await electron.launch({
  args: [resolve(values['app-dir'])],
  env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
});
const checks = [],
  errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  if (values.recovery)
    await page.evaluate(() => {
      const add = HTMLCanvasElement.prototype.addEventListener;
      window.formulaRecoveryTargets = [];
      HTMLCanvasElement.prototype.addEventListener = function (type, listener, options) {
        if (type === 'contextlost') window.formulaRecoveryTargets.push(this);
        return add.call(this, type, listener, options);
      };
    });
  const pane = page.getByRole('dialog', { name: '手写公式', exact: true });
  const open = async () => {
    if (values.recovery) await page.evaluate(() => (window.formulaRecoveryTargets = []));
    await page.getByRole('button', { name: '公式', exact: true }).click();
    await expect(page.getByLabel('LaTeX · 可直接修改')).toBeEnabled();
  };
  const close = () => pane.getByRole('button', { name: '关闭', exact: true }).click();
  const draft = () =>
    page.evaluate(
      () =>
        new Promise((done, reject) => {
          const request = indexedDB.open('keyval-store');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result,
              store = db.transaction('keyval', 'readonly').objectStore('keyval');
            const keys = store.openCursor();
            let value;
            keys.onerror = () => {
              db.close();
              reject(keys.error);
            };
            keys.onsuccess = () => {
              const cursor = keys.result;
              if (cursor) {
                if (String(cursor.key).startsWith('tixtab.formula.draft.v1:')) value = cursor.value;
                cursor.continue();
              } else {
                db.close();
                done(value);
              }
            };
          };
        }),
    );
  const verify = async (name, count) => {
    await expect.poll(async () => (await draft())?.strokes.length).toBe(count);
    const saved = await draft();
    const paths = saved.strokes.map((s) => ({
      path: oracle.exports.finalInkPath(s),
      color: s.color,
      alpha: s.tool === 'highlighter' ? 0.28 : s.tool === 'pencil' ? 0.65 : 1,
    }));
    const pixels = await page.locator('.formula-canvas').evaluate((canvas, paths) => {
      const reference = document.createElement('canvas');
      reference.width = 960;
      reference.height = canvas.height;
      const ctx = reference.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 960, canvas.height);
      for (const s of paths) {
        ctx.fillStyle = s.color;
        ctx.globalAlpha = s.alpha;
        ctx.fill(new Path2D(s.path));
      }
      const read = (source) => {
        const c = document.createElement('canvas');
        c.width = 960;
        c.height = canvas.height;
        const r = c.getContext('2d', { willReadFrequently: true });
        r.drawImage(source, 0, 0);
        return r.getImageData(0, 0, c.width, c.height).data;
      };
      const a = read(canvas),
        b = read(reference);
      let different = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) different++;
      return { different, width: canvas.width, height: canvas.height };
    }, paths);
    expect(pixels.different, name).toBe(0);
    checks.push({ name, count, ...pixels });
  };
  const pen = (count, eraser = false, cancel = false, low = false) =>
    page.locator('.formula-canvas').evaluate(
      (canvas, { count, eraser, cancel, low }) => {
        canvas.setPointerCapture = () => {};
        const r = canvas.getBoundingClientRect();
        for (let i = 0; i < count; i++)
          for (const [type, x, y, pressure] of [
            ['pointerdown', 60 + i * 4, low ? 460 : 70 + i * 2, 0.2],
            ['pointermove', 130 + i * 4, low ? 540 : 100 + i * 2, 0.8],
            [cancel ? 'pointercancel' : 'pointerup', 160 + i * 4, low ? 560 : 130 + i * 2, 0.6],
          ])
            canvas.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                pointerId: 7,
                pointerType: 'pen',
                button: eraser ? 5 : 0,
                buttons: eraser ? 32 : 1,
                pressure,
                clientX: r.x + (x / 960) * r.width,
                clientY: r.y + (y / canvas.height) * r.height,
              }),
            );
      },
      { count, eraser, cancel, low },
    );
  const recover = async (count) => {
    if (values.recovery)
      for (const target of ['visible', 'committed']) {
        await page.locator('.formula-canvas').evaluate(async (visible, target) => {
          const bases = window.formulaRecoveryTargets.filter((c) => !c.isConnected);
          if (bases.length !== 1) throw Error('Ambiguous committed formula canvas');
          const c = target === 'visible' ? visible : bases[0];
          c.dispatchEvent(new Event('contextlost'));
          c.width = c.width;
          c.dispatchEvent(new Event('contextrestored'));
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        }, target);
        await verify(`restored-${target}-context-${count}`, count);
      }
  };
  await open();
  await verify('blank', 0);
  await pen(20);
  await verify('twenty-appends', 20);
  await recover(20);
  await pen(1, false, true);
  await verify('cancel-active', 20);
  await close();
  await open();
  await verify('restored', 20);
  await pane.getByRole('button', { name: '公式设置', exact: true }).click();
  await page.getByLabel('多行手写公式', { exact: true }).check();
  await pane.getByRole('button', { name: '公式设置', exact: true }).click();
  await expect(page.locator('.formula-canvas')).toHaveAttribute('height', '640');
  await verify('multiline-resize', 20);
  await pen(1, false, false, true);
  await verify('multiline-append', 21);
  await recover(21);
  await pen(1, true, false, true);
  await expect.poll(async () => (await draft())?.strokes.length).toBeLessThan(21);
  await verify('erase', (await draft()).strokes.length);
  await pane.getByRole('button', { name: '清空画板', exact: true }).click();
  await verify('clear', 0);
  await close();
  await open();
  await verify('clear-restored', 0);
  expect(errors).toEqual([]);
  const report = {
    schema: 1,
    kind: 'native-formula-ink-quality',
    checks,
    errors,
    sourceManifestSha256: createHash('sha256')
      .update(await readFile(resolve(values['app-dir'], 'SOURCE-MANIFEST.json')))
      .digest('hex'),
    gpu: await app.evaluate(({ app }) => app.getGPUFeatureStatus()),
    limitations: [
      'Synthetic pen events; exact canvas pixel oracle and saved vectors, not physical pen latency or real microphone/AI accuracy.',
      ...(values.recovery
        ? [
            'Context lifecycle notifications and erased pixels are simulated, not a physical GPU reset.',
          ]
        : []),
    ],
  };
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(
    JSON.stringify({
      passed: true,
      checks: checks.length,
      sourceManifestSha256: report.sourceManifestSha256,
    }),
  );
} finally {
  await app.close();
}
