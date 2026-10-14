import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { requireComparable, demandModel } from './performance-demand.mjs';
const out = 'docs/performance/2026-10-13-pdf-idle',
  sha = (b) => createHash('sha256').update(b).digest('hex');
const evidence = [],
  entries = [],
  sources = {},
  runtime = {},
  reports = [];
const decision = JSON.parse(await readFile('.cache/scheduler-idle-decision.json'));
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
  const frozen = `.cache/performance-scheduler-idle-${group}-v2`;
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
    const name = `scheduler-idle-${group}-${n}`,
      raw = await readFile('.cache/' + name + '.json'),
      r = JSON.parse(raw);
    reports.push(r);
    requireComparable([r]);
    assert.equal(r.rows.length, 15);
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
  const quality = JSON.parse(await readFile(`.cache/scheduler-idle-quality-${group}.json`));
  assert.equal(
    quality.sourceManifestSha256,
    sha(await readFile(join(frozen, 'SOURCE-MANIFEST.json'))),
  );
  await archive(
    `quality/${group}.json.gz`,
    await readFile(`.cache/scheduler-idle-quality-${group}.json`),
  );
  for (const c of quality.checks)
    for (const image of c.images)
      await archive(
        `quality/${group}-pixels/${image.file}.gz`,
        await readFile(`.cache/scheduler-idle-quality-${group}-pixels/${image.file}`),
      );
  await archive(
    `native/${group}.json.gz`,
    await readFile(`.cache/scheduler-idle-native-${group}-v2.json`),
  );
}
requireComparable(reports);
assert.deepEqual(
  sources.before.filter(([p, h]) => new Map(sources.candidate).get(p) !== h).map(([p]) => p),
  ['src/pdfRenderCache.ts'],
);
for (const [file, hash] of sources[decision.productionSide])
  assert.equal(sha(await readFile(file)), hash, file);
for (const group of ['before', 'candidate'])
  for (const [file, hash] of runtime[group])
    if (new Map(runtime[group === 'before' ? 'candidate' : 'before']).get(file) !== hash) {
      assert(!file.endsWith('.wasm') && !file.startsWith('dist/models/'));
      await archive(
        `changed-runtime/${group}/${file}.gz`,
        await readFile(`.cache/performance-scheduler-idle-${group}-v2/${file}`),
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
  'scripts/build-pdf-idle-control.mjs',
  'scripts/verify-night-matrix.mjs',
  'scripts/compare-pdf-quality.mjs',
  'scripts/verify-pdf-idle-native.mjs',
  'scripts/verify-render-archive.mjs',
  'scripts/verify-object-workflow.mjs',
  'scripts/compare-workflows.mjs',
  'scripts/archive-pdf-idle.mjs',
  'scripts/verify-pdf-idle-archive.mjs',
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
  'scheduler-idle-unit-before.log',
  'scheduler-idle-unit-candidate.log',
  'scheduler-idle-unit-before-v2.log',
  'scheduler-idle-unit-candidate-v2.log',
  'scheduler-idle-types.log',
  'scheduler-idle-types-v2.log',
  'scheduler-idle-build-before.log',
  'scheduler-idle-build-candidate.log',
  'scheduler-idle-build-before-v2.log',
  'scheduler-idle-build-candidate-v2.log',
  'scheduler-idle-quality-before.log',
  'scheduler-idle-quality-candidate.log',
  'scheduler-idle-quality-comparison.log',
  'scheduler-idle-quality-comparison.json',
  'scheduler-idle-native-initial.mjs',
  'scheduler-idle-native-before.log',
  'scheduler-idle-native-before-v2.log',
  'scheduler-idle-native-candidate-v2.log',
  'scheduler-idle-output-quality-v2.json',
  'scheduler-idle-output-quality-v2.log',
  'run-scheduler-idle.ps1',
  'scheduler-idle-decision.json',
  'scheduler-idle-demand.json',
  'summarize-scheduler-idle.mjs',
  'scheduler-idle-restoration.json',
  'scheduler-idle-restored-unit.log',
  'scheduler-idle-restored-types.log',
])
  await archive('evidence/' + file + '.gz', await readFile('.cache/' + file));
for (const ext of ['json', 'md'])
  await archive(
    'comparison.' + ext,
    await readFile('.cache/scheduler-idle-comparison.' + ext),
    false,
  );
await archive('README.md', await readFile('.cache/scheduler-idle-README.md'), false);
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
