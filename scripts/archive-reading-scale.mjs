import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { requireComparable, demandModel } from './performance-demand.mjs';
const out = 'docs/performance/2026-10-13-reading-scale',
  sha = (b) => createHash('sha256').update(b).digest('hex');
const evidence = [],
  entries = [],
  sources = {},
  runtime = {},
  reports = [];
const decision = JSON.parse(await readFile('.cache/reading-scale-decision.json'));
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
  const frozen = `.cache/performance-reading-scale-${group}`;
  sources[group] = JSON.parse(await readFile(join(frozen, 'SOURCE-MANIFEST.json')));
  for (const [name, file] of [
    ['source-manifest', 'SOURCE-MANIFEST.json'],
    ['control', 'control-description.json'],
  ])
    await archive(group + '-' + name + '.json', await readFile(join(frozen, file)), false);
  for (const [file, hash] of sources[group]) {
    const raw = await readFile(join(frozen, 'source', file));
    assert.equal(sha(raw), hash);
    await archive(`source-snapshots/${group}/${file}.gz`, raw);
  }
  for (let n = 1; n <= 3; n++) {
    const name = `reading-scale-${group}-${n}`,
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
    assert.equal(sha(await readFile(join(frozen, file))), hash);
  const quality = JSON.parse(await readFile(`.cache/reading-scale-quality-${group}.json`));
  assert.equal(
    quality.sourceManifestSha256,
    sha(await readFile(join(frozen, 'SOURCE-MANIFEST.json'))),
  );
  await archive(
    `quality/${group}.json.gz`,
    await readFile(`.cache/reading-scale-quality-${group}.json`),
  );
  for (const c of quality.checks)
    for (const image of c.images)
      await archive(
        `quality/${group}-pixels/${image.file}.gz`,
        await readFile(`.cache/reading-scale-quality-${group}-pixels/${image.file}`),
      );
}
requireComparable(reports);
assert.deepEqual(
  sources.before.filter(([p, h]) => new Map(sources.candidate).get(p) !== h).map(([p]) => p),
  ['src/ReadingView.tsx'],
);
for (const [file, hash] of sources[decision.productionSide])
  assert.equal(sha(await readFile(file)), hash, file);
for (const group of ['before', 'candidate'])
  for (const [file, hash] of runtime[group])
    if (new Map(runtime[group === 'before' ? 'candidate' : 'before']).get(file) !== hash) {
      assert(!file.endsWith('.wasm') && !file.startsWith('dist/models/'));
      await archive(
        `changed-runtime/${group}/${file}.gz`,
        await readFile(`.cache/performance-reading-scale-${group}/${file}`),
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
  'scripts/build-reading-scale-control.mjs',
  'scripts/verify-night-matrix.mjs',
  'scripts/compare-pdf-quality.mjs',
  'scripts/verify-render-archive.mjs',
  'scripts/verify-reading-scale-output.mjs',
  'scripts/compare-workflows.mjs',
  'tests/reading-bitmap-scale.spec.ts',
  'tests/performance-completion.spec.ts',
  'tests/reading-ink-updates.spec.ts',
  'scripts/analyze-workflow-trace.mjs',
  'scripts/archive-reading-scale.mjs',
  'scripts/verify-reading-scale-archive.mjs',
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
  'reading-scale-browser-before.log',
  'reading-scale-before-failure.png',
  'reading-scale-before-error-context.md',
  'reading-scale-before-test.ts',
  'reading-scale-browser-candidate.log',
  'reading-scale-types.log',
  'reading-scale-build-before.log',
  'reading-scale-build-candidate.log',
  'reading-scale-quality-before.log',
  'reading-scale-quality-candidate.log',
  'reading-scale-quality-comparison.log',
  'reading-scale-quality-comparison.json',
  'reading-scale-output-quality-v2.json',
  'reading-scale-output-quality-v2.log',
  'reading-scale-output-checker-initial.log',
  'run-reading-scale.ps1',
  'reading-scale-decision.json',
  'reading-scale-demand.json',
  'summarize-reading-scale.mjs',
  'reading-scale-production.json',
  'reading-scale-source-locations.json',
  'decide-reading-scale.mjs',
  'reading-scale-candidate-test.ts',
  'reading-scale-restored-browser.log',
  'reading-scale-restored-types.log',
])
  await archive('evidence/' + file + '.gz', await readFile('.cache/' + file));
for (const group of ['before', 'candidate']) {
  const name = `reading-scale-${group}-trace`,
    r = JSON.parse(await readFile('.cache/' + name + '.json'));
  assert.equal(r.buildSha256, reports.find((x) => x.label.includes(group + '-')).buildSha256);
  assert.equal(r.harnessSha256, reports[0].harnessSha256);
  for (const ext of ['json', 'log', 'trace.json'])
    await archive(`diagnostics/${group}.${ext}.gz`, await readFile(`.cache/${name}.${ext}`));
  for (const artifact of r.objectDownloads) {
    const b = await readFile(artifact.path);
    assert.equal(sha(b), artifact.sha256);
    await archive('diagnostics/outputs/' + basename(artifact.path) + '.gz', b);
  }
  for (const ext of ['json', 'log'])
    await archive(
      `diagnostics/${group}-analysis.${ext}.gz`,
      await readFile(`.cache/reading-scale-${group}-zoom-analysis.${ext}`),
    );
  for (const ext of ['json', 'log'])
    await archive(
      `diagnostics/${group}-facing-analysis.${ext}.gz`,
      await readFile(`.cache/reading-scale-${group}-facing-analysis.${ext}`),
    );
}
const discovery = JSON.parse(await readFile('.cache/pdf-scheduling-trace-baseline.json'));
assert.equal(discovery.buildSha256, reports.find((x) => x.label.includes('before-')).buildSha256);
const oldBenchmark = await readFile('.cache/pdf-scheduling-baseline-benchmark.mjs');
assert.equal(
  discovery.harnessSha256,
  sha(
    Buffer.concat(
      await Promise.all(
        discovery.harnessFiles.map((f) =>
          f === 'scripts/benchmark-workflow.mjs' ? oldBenchmark : readFile(f),
        ),
      ),
    ),
  ),
);
await archive('diagnostics/initial-benchmark.mjs.gz', oldBenchmark);
for (const ext of ['json', 'log', 'trace.json'])
  await archive(
    `diagnostics/initial.${ext}.gz`,
    await readFile(`.cache/pdf-scheduling-trace-baseline.${ext}`),
  );
for (const artifact of discovery.objectDownloads) {
  const b = await readFile(artifact.path);
  assert.equal(sha(b), artifact.sha256);
  await archive('diagnostics/outputs/' + basename(artifact.path) + '.gz', b);
}
for (const ext of ['json', 'log'])
  await archive(
    `diagnostics/initial-analysis.${ext}.gz`,
    await readFile(`.cache/pdf-scheduling-baseline-facing-analysis.${ext}`),
  );
for (const ext of ['json', 'md'])
  await archive(
    'comparison.' + ext,
    await readFile('.cache/reading-scale-comparison.' + ext),
    false,
  );
await archive('README.md', await readFile('.cache/reading-scale-README.md'), false);
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
