import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const root = 'docs/performance/2026-10-13-night-gpu-fastpath',
  mode = process.argv[2] ?? 'verify',
  sha = (b) => createHash('sha256').update(b).digest('hex');
async function walk(path) {
  const files = [];
  for (const e of await readdir(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    if (e.isDirectory()) files.push(...(await walk(p)));
    else if (e.isFile()) files.push(p.replaceAll('\\', '/'));
  }
  return files;
}
if (mode === 'create') {
  await mkdir(root);
  await mkdir(root + '/blobs');
  const files = [];
  for (const e of await readdir('.cache', { withFileTypes: true })) {
    if (
      /^(night-gpu-validated-|night-gpu-edge-|night-gpu-(before|candidate)-[123]\.|night-gpu-(resource-summary|comparison|series-inputs))/.test(
        e.name,
      )
    )
      files.push(...(e.isDirectory() ? await walk('.cache/' + e.name) : ['.cache/' + e.name]));
  }
  for (const side of ['final-before', 'final-candidate', 'edge-before', 'edge-candidate'])
    files.push(...(await walk('.cache/performance-night-gpu-' + side)));
  files.push(
    'scripts/verify-night-gpu-fastpath.mjs',
    'scripts/verify-night-gpu-edges.mjs',
    'scripts/verify-night-matrix.mjs',
    'scripts/compare-pdf-quality.mjs',
    'scripts/archive-night-gpu-fastpath.mjs',
    '.cache/run-night-gpu-edge-quality.ps1',
    '.cache/run-night-gpu-edge-once.ps1',
    '.cache/preflight-night-gpu-edge-once.mjs',
    '.cache/summarize-night-gpu-edge-once.mjs',
  );
  const prior = JSON.parse(await readFile('.cache/night-gpu-series-inputs.json'));
  for (const [p, h] of prior.harnessFiles) {
    assert.equal(sha(await readFile(p)), h, p);
    files.push(p);
  }
  const inventory = [],
    seen = new Set();
  for (const path of [...new Set(files)].sort()) {
    const raw = await readFile(path),
      hash = sha(raw);
    if (!seen.has(hash)) {
      await writeFile(`${root}/blobs/${hash}.gz`, gzipSync(raw), { flag: 'wx' });
      seen.add(hash);
    }
    inventory.push({ path, sha256: hash, bytes: raw.length });
  }
  await writeFile(
    root + '/manifest.json',
    JSON.stringify(
      {
        schema: 1,
        files: inventory,
        harnessSha256: prior.harnessSha256,
        limits:
          'Full-picture exact GPU repair plus fractional-border experiment. Old six-run workflow never activated GPU. One A/B run for expanded border path; no repeated statistics or energy claims. Expanded path not retained in production. Navigation additions are outside these measured frozen builds.',
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
}
assert(['create', 'verify'].includes(mode));
const manifest = JSON.parse(await readFile(root + '/manifest.json')),
  blobs = new Map();
for (const row of manifest.files) {
  if (!blobs.has(row.sha256)) {
    const raw = gunzipSync(await readFile(`${root}/blobs/${row.sha256}.gz`));
    assert.equal(sha(raw), row.sha256);
    blobs.set(row.sha256, raw);
  }
  assert.equal(blobs.get(row.sha256).length, row.bytes);
}
const files = new Map(manifest.files.map((r) => [r.path, r])),
  get = (p) => {
    assert(files.has(p), p);
    return blobs.get(files.get(p).sha256);
  },
  json = (p) => JSON.parse(get(p));
assert.equal(
  sha(await readFile(new URL(import.meta.url))),
  files.get('scripts/archive-night-gpu-fastpath.mjs').sha256,
  'Use the archived verifier revision',
);
for (const side of ['final-before', 'final-candidate', 'edge-before', 'edge-candidate']) {
  const base = '.cache/performance-night-gpu-' + side;
  for (const [p, h] of json(base + '/SOURCE-MANIFEST.json'))
    assert.equal(sha(get(base + '/source/' + p)), h, p);
}
let rawPairs = 0,
  appPairs = 0,
  gpuChecks = 0;
for (const row of manifest.files.filter((r) =>
  /^\.cache\/night-gpu-(validated|edge)-(random|boundary|fallback)\.json$/.test(r.path),
)) {
  const report = json(row.path),
    dir = row.path.replace(/\.json$/, '') + '-pixels';
  for (const check of report.checks) {
    const [a, b] = await Promise.all(
      check.images.map(async (image) => {
        const raw = get(dir + '/' + image.file);
        assert.equal(sha(raw), image.pngSha256);
        return sharp(raw).ensureAlpha().raw().toBuffer();
      }),
    );
    assert(a.equals(b), row.path + ' pixels changed');
    assert.equal(check.different, 0);
    rawPairs++;
    if (check.images[1].backend === 'webgl2') gpuChecks++;
  }
}
for (const prefix of ['night-gpu-validated-app', 'night-gpu-edge-app']) {
  const a = json('.cache/' + prefix + '-before.json'),
    b = json('.cache/' + prefix + '-candidate.json');
  assert.equal(a.checks.length, b.checks.length);
  // The independent comparison tool already stores exact per-canvas checks;
  // bind its verdict and both image manifests, then decode every image here.
  const comparison = json('.cache/' + prefix + '-comparison.json');
  assert.equal(comparison.pass, true);
  for (let i = 0; i < a.checks.length; i++) {
    const ac = a.checks[i],
      bc = b.checks[i];
    for (const key of ['workload', 'view', 'appearance']) assert.equal(ac[key], bc[key]);
    assert.equal(ac.images.length, bc.images.length);
    for (let j = 0; j < ac.images.length; j++) {
      const rgba = [];
      for (const [side, image] of [
        ['before', ac.images[j]],
        ['candidate', bc.images[j]],
      ]) {
        const raw = get('.cache/' + prefix + '-' + side + '-pixels/' + image.file);
        assert.equal(sha(raw), image.pngSha256);
        const decoded = await sharp(raw).ensureAlpha().raw().toBuffer();
        assert.equal(sha(decoded), image.rgbaSha256);
        rgba.push(decoded);
      }
      assert(rgba[0].equals(rgba[1]), prefix + ' actual PDF pixels changed');
      appPairs++;
    }
  }
  assert.equal(
    comparison.checks.length,
    a.checks.reduce((n, c) => n + c.images.length, 0),
  );
}
const onceA = json('.cache/night-gpu-edge-before-once.json'),
  onceB = json('.cache/night-gpu-edge-candidate-once.json');
assert.equal(onceA.rows.at(-1).completionAfter.counters.nightGpuConversions, 0);
assert(onceB.rows.at(-1).completionAfter.counters.nightGpuConversions > 0);
console.log(
  JSON.stringify({
    verified: true,
    files: manifest.files.length,
    uniqueBlobs: blobs.size,
    strictRawPairs: rawPairs,
    gpuChecks,
    appPairs,
    limits: manifest.limits,
  }),
);
