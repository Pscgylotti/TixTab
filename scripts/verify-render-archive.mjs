import { readFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { requireComparable, demandModel, quantiles, cpuIntervals } from './performance-demand.mjs';

const { values } = parseArgs({
  options: {
    archive: { type: 'string' },
    'frozen-prefix': { type: 'string' },
    'production-editor': { type: 'string' },
    'production-source': { type: 'string', multiple: true },
    'changed-source': { type: 'string' },
  },
});
if (!values.archive) throw Error('Use --archive DIRECTORY [--frozen-prefix .cache/BUILD_PREFIX]');
const root = resolve(values.archive);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (base, name) => {
  const path = resolve(base, name),
    local = relative(base, path);
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local), `Unsafe archive path ${name}`);
  return path;
};
const read = (file) => readFile(inside(root, file));
const manifest = JSON.parse(await read('MANIFEST.json'));
const sourcesBytes = await read('SOURCE-MANIFEST.json');
assert.equal(sha(sourcesBytes), manifest.sourceManifestSha256);
const sources = JSON.parse(sourcesBytes),
  artifacts = new Map();
for (const entry of manifest.evidence) {
  assert.ok(!artifacts.has(entry.file));
  const bytes = await read(entry.file);
  assert.equal(sha(bytes), entry.sha256, entry.file);
  if (entry.rawSha256) assert.equal(sha(gunzipSync(bytes)), entry.rawSha256, entry.file);
  artifacts.set(entry.file, entry);
}
const reports = { before: [], candidate: [] };
let buildFilesVerified = 0,
  sourceFilesVerified = 0;
for (const entry of manifest.entries) {
  const bytes = await read(entry.file);
  assert.equal(sha(bytes), entry.sha256);
  const raw = gunzipSync(bytes);
  assert.equal(sha(raw), entry.reportSha256);
  const report = JSON.parse(raw);
  const harnessFiles = (
    report.harnessFiles ?? ['scripts/benchmark-workflow.mjs', 'scripts/performance-settle.mjs']
  ).map((file) => `evidence/sources/${file}.gz`);
  assert.ok(
    harnessFiles.every((file) => artifacts.has(file)),
    'Missing measured harness source',
  );
  const harnessHash = sha(
    Buffer.concat(
      await Promise.all(harnessFiles.map(async (file) => gunzipSync(await read(file)))),
    ),
  );
  assert.equal(report.buildSha256, entry.buildSha256);
  assert.equal(report.harnessSha256, entry.harnessSha256);
  assert.equal(report.harnessSha256, harnessHash);
  if (report.harnessFiles) {
    assert.equal(cpuIntervals(report.samples).filter((i) => i.unmatched).length, 0);
    assert.equal(report.counterWarmup.stablePairs, 2);
    assert.ok(report.counterWarmup.samples.at(-1).at < report.samples[0].at);
    assert.equal(
      cpuIntervals(report.counterWarmup.samples.slice(-3)).every((i) => !i.unmatched),
      true,
    );
  }
  assert.equal(sha(JSON.stringify(report.buildManifest)), report.buildSha256);
  assert.match(entry.file, /^(before|candidate)-\d+\.json\.gz$/);
  const group = entry.file.startsWith('before-') ? 'before' : 'candidate';
  reports[group].push(report);
  if (values['frozen-prefix']) {
    const frozen = resolve(values['frozen-prefix'] + '-' + group);
    for (const [file, hash] of report.buildManifest) {
      assert.equal(sha(await readFile(inside(frozen, file))), hash, `${group}/${file}`);
      buildFilesVerified++;
    }
  }
}
requireComparable([...reports.before, ...reports.candidate]);
for (const [group, files] of Object.entries(sources)) {
  assert.ok(group === 'before' || group === 'candidate');
  for (const [file, hash] of files) {
    const snapshot = artifacts.get(`source-snapshots/${group}/${file}.gz`);
    if (snapshot) assert.equal(snapshot.rawSha256, hash);
    else {
      assert.ok(values['frozen-prefix'], 'Full source snapshots or --frozen-prefix are required');
      const frozen = resolve(values['frozen-prefix'] + '-' + group + '/source');
      assert.equal(sha(await readFile(inside(frozen, file))), hash);
    }
    sourceFilesVerified++;
  }
}
const comparison = JSON.parse(await read('comparison.json'));
for (const [group, label] of [
  ['before', 'baseline'],
  ['candidate', 'candidate'],
]) {
  const rows = reports[group],
    recorded = comparison[label];
  assert.equal(new Set(rows.map((r) => r.buildSha256)).size, 1);
  assert.deepEqual(recorded.cpuSeconds, quantiles(rows.map((r) => demandModel(r).totalCpuSeconds)));
  assert.deepEqual(recorded.elapsedMs, quantiles(rows.map((r) => demandModel(r).elapsedMs)));
  for (const phase of recorded.phases) {
    const measured = rows.map((r) => r.rows.find((row) => row.name === phase.name));
    for (const key of ['cpuSeconds', 'wallMs', 'mainThreadSeconds'])
      assert.deepEqual(phase[key], quantiles(measured.map((row) => row[key])));
    for (const [key, source] of [
      ['frameP95Ms', 'p95'],
      ['frameP99Ms', 'p99'],
      ['frameMaxMs', 'max'],
    ])
      assert.deepEqual(phase[key], quantiles(measured.map((row) => row.framesMs[source])));
  }
}
if (values['production-editor'])
  assert.equal(
    sha(await readFile(resolve(values['production-editor']))),
    new Map(sources.candidate).get('src/PageEditor.tsx'),
  );
if (values['changed-source']) {
  const candidate = new Map(sources.candidate);
  assert.deepEqual(
    sources.before.filter(([file, hash]) => candidate.get(file) !== hash).map(([file]) => file),
    [values['changed-source']],
  );
  assert.deepEqual(
    sources.before.map(([file]) => file),
    sources.candidate.map(([file]) => file),
  );
}
for (const file of values['production-source'] ?? [])
  assert.equal(sha(await readFile(resolve(file))), new Map(sources.candidate).get(file), file);
console.log(
  JSON.stringify({
    passed: true,
    archive: root,
    reports: reports.before.length + reports.candidate.length,
    evidence: artifacts.size,
    sourceFilesVerified,
    buildFilesVerified,
    productionChecked: !!values['production-editor'] || !!values['production-source']?.length,
  }),
);
