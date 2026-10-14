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
    'oracle-worker': { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values['app-dir'] || !values['oracle-worker'] || !values.output)
  throw Error('Supply frozen app, independent original worker and fresh output');
const require = createRequire(import.meta.url),
  ts = require('typescript');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const frozen = resolve(values['app-dir']);
const sources = {},
  sourceHashes = {};
for (const [name, path] of Object.entries({
  './pdfNightColors': join(frozen, 'source/src/pdfNightColors.ts'),
  './pdfNightMask': join(frozen, 'source/src/pdfNightMask.ts'),
  worker: join(frozen, 'source/src/pdfNight.worker.ts'),
  oracle: resolve(values['oracle-worker']),
})) {
  const bytes = await readFile(path);
  sourceHashes[name] = sha(bytes);
  sources[name] = ts.transpileModule(bytes.toString('utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const profile = await mkdtemp(join(tmpdir(), 'tixtab-night-mask-'));
const app = await electron.launch({
  args: [frozen],
  env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  const checks = await page.evaluate(async (sources) => {
    const makeWorker = (entry) => {
      const code = `const sources=${JSON.stringify(sources)},modules={};function load(name){if(modules[name])return modules[name];const exports=modules[name]={};new Function('exports','require',sources[name])(exports,load);return exports;}load(${JSON.stringify(entry)});`;
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      return worker;
    };
    const before = makeWorker('oracle'),
      candidate = makeWorker('worker');
    const request = async (worker, data) => {
      const rgba = new Uint8ClampedArray(data.width * data.height * 4);
      for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 97 + (i >>> 7) * 31 + data.seed) % 256;
      const bitmap = await createImageBitmap(new ImageData(rgba, data.width, data.height));
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Night worker deadline')), 10000);
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(Error(e.message));
        };
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          data.error ? reject(Error(data.error)) : resolve(data);
        };
        worker.postMessage({ id: 1, bitmap, polygons: data.polygons }, [bitmap]);
      });
      const canvas = new OffscreenCanvas(data.width, data.height),
        ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(result.bitmap, 0, 0);
      result.bitmap.close();
      return {
        pixels: ctx.getImageData(0, 0, data.width, data.height).data,
        hit: result.maskCacheHit ?? false,
      };
    };
    const geometries = [
      [],
      [[-2, -2, 260, -2, 260, 196, -2, 196]],
      [[-20.25, 20.375, 180.125, -17.25, 279.875, 171.125, 31.5, 205.375]],
      [
        [10.125, 30.25, 140.875, 7.125, 170.25, 178.375, 40.5, 165.875],
        [70.375, 60.125, 249.875, 37.5, 273.125, 211.25, 83.25, 180.125],
      ],
    ];
    const checks = [];
    try {
      for (const [geometry, polygons] of geometries.entries())
        for (const width of [257, 259])
          for (let repeat = 0; repeat < 3; repeat++) {
            const data = { width, height: 193, polygons, seed: repeat * 53 };
            const a = await request(before, data),
              b = await request(candidate, data);
            let different = 0;
            for (let i = 0; i < a.pixels.length; i++) if (a.pixels[i] !== b.pixels[i]) different++;
            checks.push({ geometry, width, height: data.height, repeat, different, hit: b.hit });
          }
    } finally {
      before.terminate();
      candidate.terminate();
    }
    return checks;
  }, sources);
  expect(checks).toHaveLength(24);
  expect(checks.every((check) => check.different === 0)).toBe(true);
  // Both dimensions miss independently; changed pixel contents still reuse the same exact mask.
  for (const check of checks) expect(check.hit).toBe(check.geometry > 0 && check.repeat > 0);
  await writeFile(
    resolve(values.output),
    JSON.stringify(
      {
        schema: 1,
        appDir: frozen,
        sourceManifestSha256: sha(await readFile(join(frozen, 'SOURCE-MANIFEST.json'))),
        sourceHashes,
        harnessSha256: sha(await readFile(new URL(import.meta.url))),
        checks,
        limits:
          'Real Electron worker/offscreen raster comparison against the original worker, including fractional rotated/overlapping/clipped edges and transparent input. Sources are transpiled from frozen snapshots; bundled application canvas coverage is verified separately. This is a quality test, not a timing/energy measurement.',
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: checks.length,
      hits: checks.filter((c) => c.hit).length,
    }),
  );
} finally {
  await app.close();
}
