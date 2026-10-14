import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { requireComparable, demandModel } from './performance-demand.mjs';
const out = 'docs/performance/2026-10-13-foreground-lifecycle',
  sha = (b) => createHash('sha256').update(b).digest('hex');
const evidence = [],
  entries = [],
  sources = {},
  runtime = {},
  reports = [];
const decision = JSON.parse(await readFile('.cache/foreground-lifecycle-decision.json'));
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
  const frozen = `.cache/performance-foreground-lifecycle-${group}`;
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
    const name = `foreground-lifecycle-${group}-${n}`,
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
  const quality = JSON.parse(await readFile(`.cache/foreground-lifecycle-quality-${group}.json`));
  assert.equal(
    quality.sourceManifestSha256,
    sha(await readFile(join(frozen, 'SOURCE-MANIFEST.json'))),
  );
  await archive(
    `quality/${group}.json.gz`,
    await readFile(`.cache/foreground-lifecycle-quality-${group}.json`),
  );
  for (const c of quality.checks)
    for (const image of c.images)
      await archive(
        `quality/${group}-pixels/${image.file}.gz`,
        await readFile(`.cache/foreground-lifecycle-quality-${group}-pixels/${image.file}`),
      );
}
requireComparable(reports);
assert.deepEqual(
  sources.before.filter(([p, h]) => new Map(sources.candidate).get(p) !== h).map(([p]) => p),
  ['src/useForegroundViewport.ts'],
);
for (const [file, hash] of sources[decision.productionSide])
  assert.equal(sha(await readFile(file)), hash, file);
for (const group of ['before', 'candidate'])
  for (const [file, hash] of runtime[group])
    if (new Map(runtime[group === 'before' ? 'candidate' : 'before']).get(file) !== hash) {
      assert(!file.endsWith('.wasm') && !file.startsWith('dist/models/'));
      await archive(
        `changed-runtime/${group}/${file}.gz`,
        await readFile(`.cache/performance-foreground-lifecycle-${group}/${file}`),
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
  'scripts/verify-night-matrix.mjs',
  'scripts/compare-pdf-quality.mjs',
  'scripts/verify-render-archive.mjs',
  'scripts/verify-reading-scale-output.mjs',
  'scripts/compare-workflows.mjs',
  'tests/foreground-measurement.spec.ts',
  'tests/foreground-lifecycle.spec.ts',
  'scripts/verify-foreground-lifecycle-native.mjs',
  'tests/foreground-culling.spec.ts',
  'scripts/archive-foreground-lifecycle.mjs',
  'scripts/verify-foreground-lifecycle-archive.mjs',
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
  'foreground-lifecycle-before-test.log',
  'foreground-lifecycle-candidate-test.log',
  'foreground-lifecycle-native.log',
  'foreground-lifecycle-types.log',
  'foreground-lifecycle-before-build.log',
  'foreground-lifecycle-candidate-build.log',
  'foreground-lifecycle-before-native-v2.json',
  'foreground-lifecycle-before-native-v2.log',
  'foreground-lifecycle-candidate-native-v2.json',
  'foreground-lifecycle-candidate-native-v2.log',
  'foreground-lifecycle-native-v1.mjs',
  'foreground-lifecycle-before-native-v1.json',
  'foreground-lifecycle-before-native-v1.log',
  'foreground-lifecycle-candidate-native-v1.json',
  'foreground-lifecycle-candidate-native-v1.log',
  'foreground-lifecycle-native-v2-initial.mjs',
  'foreground-lifecycle-before-native-v2-initial-failure.log',
  'foreground-lifecycle-idle.json',
  'foreground-lifecycle-quality-before.log',
  'foreground-lifecycle-quality-candidate.log',
  'foreground-lifecycle-quality-comparison.json',
  'foreground-lifecycle-quality-comparison.log',
  'foreground-lifecycle-output-quality.json',
  'foreground-lifecycle-output-quality.log',
  'run-foreground-lifecycle.ps1',
  'foreground-lifecycle-decision.json',
  'foreground-lifecycle-demand.json',
  'summarize-foreground-lifecycle.mjs',
  'foreground-lifecycle-production.json',
  'foreground-lifecycle-final-browser.log',
  'foreground-lifecycle-final-types.log',
  'decide-foreground-lifecycle.mjs',
  'prepare-foreground-lifecycle-archive.mjs',
])
  await archive('evidence/' + file + '.gz', await readFile('.cache/' + file));
async function results(dir, prefix = '', base = dir.split('/').at(-1)) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, e.name),
      name = prefix + e.name;
    if (e.isDirectory()) await results(file, name + '/', base);
    else if (e.isFile())
      await archive('evidence/results/' + base + '/' + name + '.gz', await readFile(file));
  }
}
for (const dir of [
  'foreground-lifecycle-native-results',
  'foreground-lifecycle-before-test-results',
  'foreground-lifecycle-candidate-test-results',
  'foreground-lifecycle-final-results',
])
  await results('.cache/' + dir);
for (const ext of ['json', 'md'])
  await archive(
    'comparison.' + ext,
    await readFile('.cache/foreground-lifecycle-comparison.' + ext),
    false,
  );
await archive('README.md', await readFile('.cache/foreground-lifecycle-README.md'), false);
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
