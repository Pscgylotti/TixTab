import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { cpuIntervals, demandModel, requireComparable, quantiles } from './performance-demand.mjs';
const { values } = parseArgs({
  options: {
    archive: { type: 'string' },
    'before-app': { type: 'string' },
    'candidate-app': { type: 'string' },
  },
});
if (!values.archive)
  throw Error('Use --archive DIRECTORY [--before-app FROZEN_A --candidate-app FROZEN_B]');
const root = resolve(values.archive),
  sha = (b) => createHash('sha256').update(b).digest('hex');
const inside = (base, name) => {
  const path = resolve(base, name),
    local = relative(base, path);
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local));
  return path;
};
const manifest = JSON.parse(await readFile(join(root, 'MANIFEST.json'))),
  files = new Map();
assert.equal(manifest.kind, 'workflow-counter-recheck');
for (const entry of manifest.files) {
  assert.ok(!files.has(entry.file));
  const bytes = await readFile(inside(root, entry.file));
  assert.equal(sha(bytes), entry.sha256);
  assert.equal(bytes.length, entry.bytes);
  if (entry.rawSha256) {
    const raw = gunzipSync(bytes);
    assert.equal(sha(raw), entry.rawSha256);
    assert.equal(raw.length, entry.rawBytes);
  }
  files.set(entry.file, entry);
}
const raw = async (name) => {
  assert.ok(files.has(name));
  const b = await readFile(inside(root, name));
  return name.endsWith('.gz') ? gunzipSync(b) : b;
};
const json = async (name) => JSON.parse(await raw(name));
const sources = await json('sources.json');
for (const [file, hash] of Object.entries(sources))
  assert.equal(files.get(`sources/${file}.gz`).rawSha256, hash);
const harness = sha(
  Buffer.concat(
    await Promise.all(
      ['scripts/benchmark-workflow.mjs', 'scripts/performance-settle.mjs'].map((name) =>
        raw('sources/' + name + '.gz'),
      ),
    ),
  ),
);
const groups = { before: [], candidate: [] };
let runtimeFiles = 0;
for (const [group, names] of Object.entries(manifest.reports))
  for (const name of names) {
    const r = await json(name);
    requireComparable([r]);
    assert.equal(r.harnessSha256, harness);
    assert.equal(cpuIntervals(r.samples).filter((i) => i.unmatched).length, 0);
    assert.equal(sha(JSON.stringify(r.buildManifest)), r.buildSha256);
    assert.equal(r.buildSha256, manifest.builds[group]);
    assert.equal(
      r.rows.find((p) => p.name === 'formula-edit-and-save').completionAfter.counters.formulaWrites,
      group === 'before' ? 253 : 2,
    );
    groups[group].push(r);
    if (values[group + '-app'])
      for (const [file, hash] of r.buildManifest) {
        assert.equal(sha(await readFile(inside(resolve(values[group + '-app']), file))), hash);
        runtimeFiles++;
      }
  }
assert.equal(groups.before.length, 3);
assert.equal(groups.candidate.length, 3);
requireComparable([...groups.before, ...groups.candidate]);
// Retain every runtime file that differs between A/B, not just the main bundle.
for (const [group, reports] of Object.entries(groups)) {
  const other = new Map(groups[group === 'before' ? 'candidate' : 'before'][0].buildManifest);
  const changed = reports[0].buildManifest.filter(([name, hash]) => other.get(name) !== hash);
  assert.deepEqual(manifest.runtimeDifferences[group], changed);
  for (const [name, hash] of changed)
    assert.equal(files.get(`runtime-differences/${group}/${name}.gz`).rawSha256, hash);
}
const comparison = await json('comparison.json');
for (const [group, label] of [
  ['before', 'baseline'],
  ['candidate', 'candidate'],
]) {
  const reports = groups[group],
    recorded = comparison[label];
  assert.deepEqual(
    recorded.cpuSeconds,
    quantiles(reports.map((r) => demandModel(r).totalCpuSeconds)),
  );
  assert.deepEqual(recorded.elapsedMs, quantiles(reports.map((r) => demandModel(r).elapsedMs)));
  assert.deepEqual(
    recorded.phases.map((p) => p.name),
    reports[0].rows.map((p) => p.name),
  );
  for (const phase of recorded.phases) {
    const rows = reports.map((r) => r.rows.find((p) => p.name === phase.name));
    for (const key of ['cpuSeconds', 'wallMs', 'mainThreadSeconds'])
      assert.deepEqual(phase[key], quantiles(rows.map((r) => r[key])));
    for (const [key, field] of [
      ['frameP95Ms', 'p95'],
      ['frameP99Ms', 'p99'],
      ['frameMaxMs', 'max'],
    ])
      assert.deepEqual(phase[key], quantiles(rows.map((r) => r.framesMs[field])));
  }
}
console.log(
  JSON.stringify({
    passed: true,
    reports: 6,
    files: files.size,
    runtimeFiles,
    formulaWrites: [253, 2],
    cpuSeconds: [comparison.baseline.cpuSeconds.p50, comparison.candidate.cpuSeconds.p50],
  }),
);
