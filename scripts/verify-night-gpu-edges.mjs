import { _electron as electron } from '@playwright/test';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    'candidate-worker': { type: 'string' },
    'oracle-worker': { type: 'string' },
    output: { type: 'string' },
    pattern: { type: 'string', default: 'random' },
    'force-cpu': { type: 'boolean', default: false },
  },
});
for (const key of ['app-dir', 'candidate-worker', 'oracle-worker', 'output'])
  assert(values[key], key);
const ts = createRequire(import.meta.url)('typescript');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const frozen = resolve(values['app-dir']),
  output = resolve(values.output),
  assetDir = output.replace(/\.json$/, '') + '-pixels';
await mkdir(assetDir);
const sources = {},
  sourceHashes = {};
let instrumented;
for (const [name, path] of Object.entries({
  './pdfNightColors': join(frozen, 'source/src/pdfNightColors.ts'),
  oracle: resolve(values['oracle-worker']),
  worker: resolve(values['candidate-worker']),
  './nightGpuPolicy': join(dirname(resolve(values['candidate-worker'])), 'nightGpuPolicy.ts'),
})) {
  const raw = await readFile(path);
  sourceHashes[name] = sha(raw);
  let text = raw.toString('utf8');
  if (name === 'worker') {
    if (!text.includes("backend: gpuOutput ? 'gpu' : 'cpu'")) {
      const computation =
        'const output = convertOnGpu(bitmap, polygons, opaque) ?? convertOnCpu(bitmap, polygons);';
      const message = 'scope.postMessage({ id, bitmap: output }, [output]);';
      assert.equal(text.split(computation).length, 2);
      assert.equal(text.split(message).length, 2);
      // Only expose which already-existing path produced the bitmap. Math and
      // raster operations are unchanged; save the exact instrumented source too.
      text = text.replace(
        computation,
        'const gpuOutput = convertOnGpu(bitmap, polygons, opaque);\n    const output = gpuOutput ?? convertOnCpu(bitmap, polygons);',
      );
      text = text.replace(
        message,
        "scope.postMessage({ id, bitmap: output, validationBackend: gpuOutput ? 'webgl2' : 'cpu' }, [output]);",
      );
    }
    if (values['force-cpu'])
      text =
        "const __getContext = OffscreenCanvas.prototype.getContext; OffscreenCanvas.prototype.getContext = function(type,...args) { return type === 'webgl2' ? null : __getContext.call(this,type,...args); };\n" +
        text;
    instrumented = text;
  }
  const compiled = ts.transpileModule(text, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(
    compiled.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ?? [],
    [],
    'Worker source must compile without diagnostic recovery',
  );
  sources[name] = compiled.outputText;
}
await writeFile(join(assetDir, 'instrumented-worker.ts'), instrumented, { flag: 'wx' });
const profile = await mkdtemp(join(tmpdir(), 'tixtab-night-gpu-quality-'));
const app = await electron.launch({
  args: [frozen],
  env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert(['random', 'boundary'].includes(values.pattern));
  const rows = await page.evaluate(
    async ({ sources, pattern }) => {
      const make = (entry) => {
        const code = `const sources=${JSON.stringify(sources)},modules={};function load(name){if(modules[name])return modules[name];const exports=modules[name]={};new Function('exports','require',sources[name])(exports,load);return exports;}load(${JSON.stringify(entry)});`;
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })),
          worker = new Worker(url);
        URL.revokeObjectURL(url);
        return worker;
      };
      const before = make('oracle'),
        candidate = make('worker');
      const request = async (worker, data) => {
        const rgba = new Uint8ClampedArray(data.width * data.height * 4);
        let state = (((data.seed + 1) * 2654435761) ^ (data.width * 2246822519)) | 0;
        for (let i = 0; i < rgba.length; i++) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          rgba[i] = state >>> 24;
        }
        if (pattern === 'boundary')
          for (let i = 0; i < rgba.length; i += 4) {
            const pixel = (i >>> 2) + data.seed * 50021;
            const delta = (pixel >>> 8) % 65,
              base = Math.min(255 - delta, pixel & 255);
            const colors = [base, base + Math.floor(delta / 2), base + delta];
            const permutations = [
              [0, 1, 2],
              [0, 2, 1],
              [1, 0, 2],
              [1, 2, 0],
              [2, 0, 1],
              [2, 1, 0],
            ];
            const order = permutations[(pixel >>> 14) % 6];
            for (let c = 0; c < 3; c++) rgba[i + c] = colors[order[c]];
          }
        if (data.opaque) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
        const bitmap = await createImageBitmap(new ImageData(rgba, data.width, data.height));
        const result = await new Promise((yes, no) => {
          const timer = setTimeout(() => no(Error('Night worker deadline')), 10000);
          worker.onerror = (e) => {
            clearTimeout(timer);
            no(Error(e.message));
          };
          worker.onmessage = ({ data }) => {
            clearTimeout(timer);
            data.error ? no(Error(data.error)) : yes(data);
          };
          worker.postMessage({ id: 1, bitmap, polygons: data.polygons, opaque: data.opaque }, [
            bitmap,
          ]);
        });
        const canvas = new OffscreenCanvas(data.width, data.height),
          ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(result.bitmap, 0, 0);
        result.bitmap.close();
        const pixels = ctx.getImageData(0, 0, data.width, data.height).data;
        const digest = await crypto.subtle.digest('SHA-256', pixels);
        const rgbaSha256 = Array.from(new Uint8Array(digest), (v) =>
          v.toString(16).padStart(2, '0'),
        ).join('');
        const png = new Uint8Array(
          await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
        );
        return {
          pixels,
          rgbaSha256,
          pngBase64: btoa(Array.from(png, (v) => String.fromCharCode(v)).join('')),
          backend:
            result.validationBackend ??
            (result.backend === 'gpu' ? 'webgl2' : result.backend === 'cpu' ? 'cpu' : 'oracle'),
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
      geometries.push(
        [[0, 0, 258.25, 0, 258.25, 192.75, 0, 192.75]],
        [[0.25, 0.75, 258.75, 0.75, 258.75, 192.25, 0.25, 192.25]],
        [[0, 0, 255, 0, 255, 193, 0, 193]],
      );
      const rows = [];
      try {
        for (const opaque of [true, false])
          for (const [geometry, polygons] of geometries.entries())
            for (const width of [257, 259])
              for (let repeat = 0; repeat < 3; repeat++) {
                const data = { width, height: 193, opaque, polygons, seed: repeat * 53 };
                const a = await request(before, data),
                  b = await request(candidate, data);
                let different = 0,
                  maximum = 0,
                  overOne = 0;
                for (let i = 0; i < a.pixels.length; i++) {
                  const d = Math.abs(a.pixels[i] - b.pixels[i]);
                  if (d) different++;
                  if (d > 1) overOne++;
                  maximum = Math.max(maximum, d);
                }
                rows.push({
                  opaque,
                  geometry,
                  width,
                  height: data.height,
                  repeat,
                  different,
                  maximum,
                  overOne,
                  images: [
                    { backend: a.backend, rgbaSha256: a.rgbaSha256, pngBase64: a.pngBase64 },
                    { backend: b.backend, rgbaSha256: b.rgbaSha256, pngBase64: b.pngBase64 },
                  ],
                });
              }
      } finally {
        before.terminate();
        candidate.terminate();
      }
      return rows;
    },
    { sources, pattern: values.pattern },
  );
  for (let n = 0; n < rows.length; n++)
    for (let side = 0; side < 2; side++) {
      const image = rows[n].images[side],
        raw = Buffer.from(image.pngBase64, 'base64');
      delete image.pngBase64;
      image.file = `${n}-${side}.png`;
      image.pngSha256 = sha(raw);
      await writeFile(join(assetDir, image.file), raw, { flag: 'wx' });
    }
  const report = {
    schema: 1,
    pattern: values.pattern,
    forceCpu: values['force-cpu'],
    appDir: frozen,
    sourceManifestSha256: sha(await readFile(join(frozen, 'SOURCE-MANIFEST.json'))),
    sourceHashes,
    instrumentedSha256: sha(instrumented),
    harnessSha256: sha(await readFile(new URL(import.meta.url))),
    checks: rows,
    limits:
      'Actual Electron worker pixel comparison, 84 opaque/transparent cases including rounded PDF borders with fractional/clipped/overlapping picture masks. GPU result metadata is instrumented without altering color math. Not a packaged application matrix, driver fault test, resource or energy measurement.',
  };
  await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' });
  const result = {
    strictPass: rows.every((r) => r.different === 0),
    checks: rows.length,
    gpuChecks: rows.filter((r) => r.images[1].backend === 'webgl2').length,
    maximum: Math.max(...rows.map((r) => r.maximum)),
    opaqueMaximum: Math.max(...rows.filter((r) => r.opaque).map((r) => r.maximum)),
    differentChecks: rows.filter((r) => r.different > 0).length,
  };
  console.log(JSON.stringify(result));
  assert.equal(rows.length, 84);
  assert.equal(
    result.gpuChecks,
    values['force-cpu'] ? 0 : 18,
    'Expected full-picture opaque GPU path and exact CPU fallbacks',
  );
  for (const row of rows)
    assert.equal(
      row.images[1].backend,
      !values['force-cpu'] && row.opaque && [1, 4, 5].includes(row.geometry) ? 'webgl2' : 'cpu',
    );
  assert(
    result.strictPass,
    'GPU display pixels differ from CPU reference; raw report and PNGs preserved',
  );
} finally {
  await app.close();
}
