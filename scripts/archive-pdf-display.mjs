import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { requireComparable, demandModel } from './performance-demand.mjs';

const out = 'docs/performance/2026-10-13-pdf-display';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const evidence = [],
  entries = [],
  sources = {},
  runtime = {},
  reports = [];
const decision = JSON.parse(await readFile('.cache/pdf-display-decision.json'));
assert(['before', 'candidate'].includes(decision.productionSide));
await mkdir(out);
async function archive(file, raw, compressed = true) {
  const bytes = compressed ? gzipSync(raw, { level: 9 }) : raw;
  await mkdir(dirname(join(out, file)), { recursive: true });
  await writeFile(join(out, file), bytes, { flag: 'wx' });
  evidence.push({
    file,
    bytes: bytes.length,
    sha256: sha(bytes),
    ...(compressed ? { rawSha256: sha(raw) } : {}),
  });
}
for (const group of ['before', 'candidate']) {
  const frozen = `.cache/performance-pdf-display-${group}`;
  sources[group] = JSON.parse(await readFile(join(frozen, 'SOURCE-MANIFEST.json')));
  for (const [name, file] of [
    ['source-manifest', 'SOURCE-MANIFEST.json'],
    ['control', 'control-description.json'],
  ])
    await archive(group + '-' + name + '.json', await readFile(join(frozen, file)), false);
  for (const [file, hash] of sources[group]) {
    const raw = await readFile(join(frozen, 'source', file));
    assert.equal(sha(raw), hash, file);
    await archive(`source-snapshots/${group}/${file}.gz`, raw);
  }
  for (let n = 1; n <= 6; n++) {
    const name = `pdf-display-${group}-${n}`,
      raw = await readFile('.cache/' + name + '.json'),
      r = JSON.parse(raw);
    reports.push(r);
    requireComparable([r]);
    assert.equal(r.rows.length, 16);
    assert.equal(demandModel(r).unmatchedProcessIntervals, 0);
    if (runtime[group]) assert.deepEqual(runtime[group], r.buildManifest);
    else runtime[group] = r.buildManifest;
    const bytes = gzipSync(raw, { level: 9 }),
      file = `${group}-${n}.json.gz`;
    await writeFile(join(out, file), bytes, { flag: 'wx' });
    entries.push({
      file,
      sha256: sha(bytes),
      reportSha256: sha(raw),
      buildSha256: r.buildSha256,
      harnessSha256: r.harnessSha256,
    });
    await archive(`logs/${group}-${n}.log.gz`, await readFile('.cache/' + name + '.log'));
    for (const a of r.objectDownloads) {
      const b = await readFile(a.path);
      assert.equal(sha(b), a.sha256);
      await archive('outputs/' + basename(a.path) + '.gz', b);
    }
  }
  for (const [file, hash] of runtime[group])
    assert.equal(sha(await readFile(join(frozen, file))), hash, file);
  const quality = JSON.parse(await readFile(`.cache/pdf-display-quality-${group}.json`));
  assert.equal(
    quality.sourceManifestSha256,
    sha(await readFile(join(frozen, 'SOURCE-MANIFEST.json'))),
  );
  await archive(
    `quality/${group}.json.gz`,
    await readFile(`.cache/pdf-display-quality-${group}.json`),
  );
  for (const c of quality.checks)
    for (const image of c.images)
      await archive(
        `quality/${group}-pixels/${image.file}.gz`,
        await readFile(`.cache/pdf-display-quality-${group}-pixels/${image.file}`),
      );
}
requireComparable(reports);
const diff = [...new Set([...sources.before, ...sources.candidate].map(([p]) => p))]
  .filter((p) => new Map(sources.before).get(p) !== new Map(sources.candidate).get(p))
  .sort();
assert.deepEqual(
  diff,
  [
    'src/night.css',
    'src/PageThumbnail.tsx',
    'src/pdfBitmapDisplay.ts',
    'src/pdfCompletion.test.ts',
    'src/PdfDetailLayer.tsx',
    'src/pdfRenderCache.test.ts',
    'src/pdfRenderCache.ts',
    'src/pdfScheduler.test.ts',
    'src/PdfSurface.tsx',
    'src/ReadingView.tsx',
    'src/usePdfBitmapDisplay.ts',
  ].sort(),
);
for (const [file, hash] of sources[decision.productionSide])
  assert.equal(sha(await readFile(file)), hash, file);
for (const group of ['before', 'candidate'])
  for (const [file, hash] of runtime[group])
    if (new Map(runtime[group === 'before' ? 'candidate' : 'before']).get(file) !== hash) {
      assert(!file.endsWith('.wasm') && !file.startsWith('dist/models/'));
      await archive(
        `changed-runtime/${group}/${file}.gz`,
        await readFile(`.cache/performance-pdf-display-${group}/${file}`),
      );
    }
for (const file of [
  'scripts/benchmark-workflow.mjs',
  'scripts/performance-settle.mjs',
  'scripts/performance-demand.mjs',
  'scripts/performance-fixture.mjs',
  'scripts/object-workflow.mjs',
  'scripts/prepare-object-edit-fixture.mjs',
  'scripts/prepare-performance-matrix.mjs',
  'scripts/performance-matrix-fixture.mjs',
  'scripts/build-foreground-lifecycle-control.mjs',
  'scripts/build-pdf-display-control.mjs',
  'scripts/verify-night-matrix.mjs',
  'scripts/compare-pdf-quality.mjs',
  'scripts/verify-render-archive.mjs',
  'scripts/verify-reading-scale-output.mjs',
  'scripts/compare-workflows.mjs',
  'scripts/archive-pdf-display.mjs',
  'scripts/verify-pdf-display-archive.mjs',
  'tests/pdf-bitmap-display.spec.ts',
  'tests/reading-bitmap-scale.spec.ts',
  'tests/foreground-culling.spec.ts',
])
  await archive('evidence/sources/' + file + '.gz', await readFile(file));
for (const profile of ['scanned', 'vector', 'objects'])
  for (const ext of ['tixtab', 'tixtab.json'])
    await archive(
      `fixtures/matrix/${profile}.${ext}.gz`,
      await readFile(`.cache/performance-inputs-night-matrix/${profile}.${ext}`),
    );
for (const ext of ['tixtab', 'tixtab.json'])
  await archive(
    `fixtures/objects.${ext}.gz`,
    await readFile(`.cache/performance-inputs-object-edit/objects.${ext}`),
  );
for (const file of [
  'pdf-display-build-before.log',
  'pdf-display-build-candidate.log',
  'pdf-display-source-diff.json',
  'pdf-display-types.log',
  'pdf-display-unit.log',
  'pdf-display-browser.log',
  'pdf-display-test-initial.spec.ts',
  'pdf-display-browser-fixed.log',
  'pdf-display-native.log',
  'pdf-display-native-bound.log',
  'pdf-display-quality-before.log',
  'pdf-display-quality-candidate.log',
  'pdf-display-quality-comparison.json',
  'pdf-display-quality-comparison.log',
  'pdf-display-output-quality.json',
  'pdf-display-output-quality.log',
  'pdf-display-output-quality-primary.json',
  'pdf-display-output-quality-primary.log',
  'pdf-display-demand.json',
  'pdf-display-demand-confirm.json',
  'pdf-display-demand-combined.json',
  'pdf-display-decision.json',
  'pdf-display-production.json',
  'summarize-pdf-display.mjs',
  'pdf-display-decision.log',
  'decide-pdf-display.mjs',
  'archive-pdf-display-initial.mjs',
  'pdf-display-archive-initial-syntax.log',
  'pdf-display-archive-format.log',
  'summarize-pdf-display-confirm.mjs',
  'summarize-pdf-display-combined.mjs',
  'run-pdf-display-series.ps1',
  'run-pdf-display-confirm.ps1',
  'pdf-display-final-types.log',
  'pdf-display-foreground-native.log',
])
  await archive('evidence/' + file + '.gz', await readFile('.cache/' + file));
async function results(dir, prefix = '', base = basename(dir)) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, e.name),
      name = prefix + e.name;
    if (e.isDirectory()) await results(file, name + '/', base);
    else if (e.isFile())
      await archive('evidence/results/' + base + '/' + name + '.gz', await readFile(file));
  }
}
for (const dir of [
  'pdf-display-browser-results',
  'pdf-display-browser-fixed-results',
  'pdf-display-native-results',
  'pdf-display-native-bound-results',
  'pdf-display-foreground-native-results',
])
  await results('.cache/' + dir);
for (const [destination, suffix] of [
  ['-primary', ''],
  ['-confirm', '-confirm'],
  ['', '-combined'],
])
  for (const ext of ['json', 'md'])
    await archive(
      'comparison' + destination + '.' + ext,
      await readFile('.cache/pdf-display-comparison' + suffix + '.' + ext),
      false,
    );
await archive('README.md', await readFile('.cache/pdf-display-README.md'), false);
await writeFile(join(out, 'SOURCE-MANIFEST.json'), JSON.stringify(sources, null, 2) + '\n', {
  flag: 'wx',
});
await writeFile(
  join(out, 'MANIFEST.json'),
  JSON.stringify(
    {
      schema: 1,
      entries,
      evidence,
      decision,
      sourceManifestSha256: sha(await readFile(join(out, 'SOURCE-MANIFEST.json'))),
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    out,
    reports: entries.length,
    evidence: evidence.length,
    sourceFiles: sources.before.length + sources.candidate.length,
  }),
);
