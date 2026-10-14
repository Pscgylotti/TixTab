import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { requireComparable, demandModel } from './performance-demand.mjs';
const parent = 'docs/performance/2026-10-13-foreground-lifecycle',
  out = parent + '/diagnostics/idle-frames';
await mkdir(dirname(out), { recursive: true });
await mkdir(out);
const sha = (b) => createHash('sha256').update(b).digest('hex'),
  files = [],
  records = [];
const parentManifest = await readFile(parent + '/MANIFEST.json'),
  parentSources = await readFile(parent + '/SOURCE-MANIFEST.json');
const pm = JSON.parse(parentManifest),
  sources = JSON.parse(parentSources);
async function save(file, raw, compressed = true) {
  const bytes = compressed ? gzipSync(raw, { level: 9 }) : raw;
  await mkdir(dirname(join(out, file)), { recursive: true });
  await writeFile(join(out, file), bytes, { flag: 'wx' });
  files.push({
    file,
    sha256: sha(bytes),
    bytes: bytes.length,
    ...(compressed ? { rawSha256: sha(raw) } : {}),
  });
}
for (const group of ['before', 'candidate']) {
  const raw = await readFile(`.cache/lifecycle-idle-${group}-trace.json`),
    r = JSON.parse(raw);
  const originalEntry = pm.entries.find((e) => e.file === group + '-1.json.gz');
  const original = JSON.parse(gunzipSync(await readFile(join(parent, originalEntry.file))));
  assert.equal(r.buildSha256, original.buildSha256);
  assert.equal(r.harnessSha256, original.harnessSha256);
  assert.equal(r.fixture.sha256, original.fixture.sha256);
  assert.equal(r.rows.length, 16);
  assert.equal(demandModel(r).unmatchedProcessIntervals, 0);
  requireComparable([r]);
  await save(group + '/report.json.gz', raw);
  await save(
    group + '/trace.json.gz',
    await readFile(`.cache/lifecycle-idle-${group}-trace.trace.json`),
  );
  await save(group + '/run.log.gz', await readFile(`.cache/lifecycle-idle-${group}-trace.log`));
  for (const phase of ['idle-tail', 'facing-zoom'])
    for (const kind of ['gc', 'analysis'])
      for (const ext of ['json', 'log'])
        await save(
          `${group}/${phase}-${kind}.${ext}.gz`,
          await readFile(
            `.cache/lifecycle-idle-${group}-${phase}-${kind}${kind === 'gc' ? '-v2' : ''}.${ext}`,
          ),
        );
  for (const artifact of r.objectDownloads) {
    const bytes = await readFile(artifact.path);
    assert.equal(sha(bytes), artifact.sha256);
    await save('outputs/' + basename(artifact.path) + '.gz', bytes);
  }
  for (const phase of ['idle-tail', 'facing-zoom'])
    for (const ext of ['json', 'log'])
      await save(
        `initial-gc/${group}-${phase}.${ext}.gz`,
        await readFile(`.cache/lifecycle-idle-${group}-${phase}-gc-v1.${ext}`),
      );
  records.push({
    group,
    buildSha256: r.buildSha256,
    harnessSha256: r.harnessSha256,
    sourceManifest: sources[group],
  });
}
for (const file of [
  'scripts/benchmark-workflow.mjs',
  'scripts/performance-settle.mjs',
  'scripts/performance-demand.mjs',
  'scripts/performance-fixture.mjs',
  'scripts/object-workflow.mjs',
  'scripts/analyze-workflow-trace.mjs',
  'scripts/analyze-workflow-gc.mjs',
  'scripts/trace-intervals.mjs',
  'scripts/trace-intervals.test.mjs',
  'scripts/archive-lifecycle-idle.mjs',
  'scripts/verify-lifecycle-idle-archive.mjs',
])
  await save('sources/' + file + '.gz', await readFile(file));
for (const file of [
  'lifecycle-idle-summary.json',
  'lifecycle-idle-summary.log',
  'summarize-lifecycle-idle.mjs',
  'lifecycle-idle-source-locations.json',
  'lifecycle-idle-source-locations.log',
  'lifecycle-idle-locations.mjs',
  'lifecycle-idle-initial-intervals.mjs',
  'lifecycle-idle-initial-interval-tests.log',
  'lifecycle-idle-interval-tests.log',
  'lifecycle-idle-interval-tests-final.log',
  'lifecycle-idle-initial-gc.mjs',
  'lifecycle-idle-union-v1.mjs',
  'lifecycle-idle-summary-v1.json',
])
  await save('evidence/' + file + '.gz', await readFile('.cache/' + file));
await save('README.md', await readFile('.cache/lifecycle-idle-README.md'), false);
await writeFile(
  out + '/MANIFEST.json',
  JSON.stringify(
    {
      schema: 1,
      parent: '../..',
      parentManifestSha256: sha(parentManifest),
      parentSourceManifestSha256: sha(parentSources),
      records,
      files,
      limits:
        'Independent traced diagnostics only; do not merge with ordinary resource runs or treat wall unions as CPU/energy.',
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify({ out, files: files.length, reports: records.length }));
