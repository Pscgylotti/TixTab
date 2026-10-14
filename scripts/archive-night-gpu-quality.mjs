import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const { values } = parseArgs({ options: { mode: { type: 'string', default: 'verify' } } });
assert(['create', 'verify'].includes(values.mode));
const root = resolve('docs/performance/2026-10-13-night-gpu-quality');
const parent = resolve('docs/performance/2026-10-13-pdf-concurrency-ui');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const safe = (file) => {
  const target = resolve(root, file),
    r = relative(root, target);
  assert(r && !r.startsWith('..') && !isAbsolute(r));
  return target;
};
if (values.mode === 'create') {
  await mkdir(root, { recursive: true });
  assert.deepEqual(await readdir(root), ['README.md']);
  const manifest = {
    schema: 1,
    readmeSha256: sha(await readFile(join(root, 'README.md'))),
    parentManifestSha256: sha(await readFile(join(parent, 'MANIFEST.json'))),
    verdict:
      'GPU original and rounding-only variants fail strict transparent quality; no resource/energy claim or production fix',
    evidence: [],
  };
  async function add(file, bytes) {
    const packed = gzipSync(bytes, { level: 9 }),
      path = safe(file + '.gz');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, packed, { flag: 'wx' });
    manifest.evidence.push({ file: file + '.gz', sha256: sha(packed), rawSha256: sha(bytes) });
  }
  for (const [slot, name] of [
    ['initial', 'v1'],
    ['round', 'round'],
  ]) {
    for (const ext of ['json', 'log'])
      await add(`${slot}/report.${ext}`, await readFile(`.cache/night-gpu-quality-${name}.${ext}`));
    for (const file of await readdir(`.cache/night-gpu-quality-${name}-pixels`))
      await add(
        `${slot}/pixels/${file}`,
        await readFile(`.cache/night-gpu-quality-${name}-pixels/${file}`),
      );
  }
  for (const [file, input] of [
    ['sources/worker-original.ts', '.cache/pdf-concurrency-live-source/src/pdfNight.worker.ts'],
    ['sources/worker-round.ts', '.cache/night-gpu-round-worker.ts'],
    [
      'sources/worker-oracle.ts',
      '.cache/performance-pdf-concurrency-ui-before/source/src/pdfNight.worker.ts',
    ],
    [
      'sources/pdfNightColors.ts',
      '.cache/performance-pdf-concurrency-ui-before/source/src/pdfNightColors.ts',
    ],
    ['tools/verify-night-gpu-quality.mjs', 'scripts/verify-night-gpu-quality.mjs'],
    ['tools/prepare-night-gpu-round.mjs', '.cache/prepare-night-gpu-round.mjs'],
    ['tools/archive-night-gpu-quality.mjs', 'scripts/archive-night-gpu-quality.mjs'],
    ['preflight-failure.log', '.cache/night-gpu-initial-quality.log'],
  ])
    await add(file, await readFile(input));
  await writeFile(join(root, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ created: true, evidence: manifest.evidence.length }));
} else {
  const manifest = JSON.parse(await readFile(join(root, 'MANIFEST.json')));
  assert.equal(manifest.readmeSha256, sha(await readFile(join(root, 'README.md'))));
  assert.equal(manifest.parentManifestSha256, sha(await readFile(join(parent, 'MANIFEST.json'))));
  const raw = new Map();
  for (const e of manifest.evidence) {
    const packed = await readFile(safe(e.file));
    assert.equal(sha(packed), e.sha256);
    const bytes = gunzipSync(packed);
    assert.equal(sha(bytes), e.rawSha256);
    raw.set(e.file.replace(/\.gz$/, ''), bytes);
  }
  assert.deepEqual(
    raw.get('tools/archive-night-gpu-quality.mjs'),
    await readFile('scripts/archive-night-gpu-quality.mjs'),
  );
  let pairs = 0;
  const results = {};
  for (const slot of ['initial', 'round']) {
    const r = JSON.parse(raw.get(slot + '/report.json'));
    assert.equal(r.checks.length, 48);
    assert.equal(r.sourceHashes.oracle, sha(raw.get('sources/worker-oracle.ts')));
    assert.equal(
      r.sourceHashes.worker,
      sha(raw.get(`sources/worker-${slot === 'initial' ? 'original' : 'round'}.ts`)),
    );
    assert.equal(r.sourceHashes['./pdfNightColors'], sha(raw.get('sources/pdfNightColors.ts')));
    assert.equal(r.harnessSha256, sha(raw.get('tools/verify-night-gpu-quality.mjs')));
    assert.equal(r.instrumentedSha256, sha(raw.get(slot + '/pixels/instrumented-worker.ts')));
    for (const check of r.checks) {
      const pixels = [];
      assert.equal(check.images[1].backend, 'webgl2');
      for (const image of check.images) {
        const bytes = raw.get(`${slot}/pixels/${image.file}`);
        assert.equal(sha(bytes), image.pngSha256);
        const decoded = await sharp(bytes)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        assert.equal(decoded.info.width, check.width);
        assert.equal(decoded.info.height, check.height);
        assert.equal(sha(decoded.data), image.rgbaSha256);
        pixels.push(decoded.data);
      }
      let different = 0,
        maximum = 0,
        overOne = 0;
      for (let i = 0; i < pixels[0].length; i++) {
        const d = Math.abs(pixels[0][i] - pixels[1][i]);
        if (d) different++;
        if (d > 1) overOne++;
        maximum = Math.max(maximum, d);
      }
      assert.deepEqual(
        { different, maximum, overOne },
        { different: check.different, maximum: check.maximum, overOne: check.overOne },
      );
      pairs++;
    }
    results[slot] = {
      gpuChecks: r.checks.length,
      maximum: Math.max(...r.checks.map((c) => c.maximum)),
      opaqueMaximum: Math.max(...r.checks.filter((c) => c.opaque).map((c) => c.maximum)),
      strictPass: r.checks.every((c) => c.different === 0),
    };
    assert(!results[slot].strictPass);
  }
  assert.equal(results.initial.maximum, 37);
  assert.equal(results.round.maximum, 26);
  assert.equal(results.round.opaqueMaximum, 0);
  console.log(
    JSON.stringify({ verified: true, evidence: manifest.evidence.length, pairs, results }),
  );
}
