import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { requireComparable, demandModel } from './performance-demand.mjs';
const { values } = parseArgs({
  options: {
    archive: { type: 'string' },
    'frozen-prefix': { type: 'string' },
    'production-root': { type: 'string' },
  },
});
if (!values.archive) throw Error('Supply archive and optional actual frozen/production paths');
const root = resolve(values.archive),
  parent = resolve(root, '../..'),
  sha = (b) => createHash('sha256').update(b).digest('hex');
const inside = (base, file) => {
  const path = resolve(base, file),
    r = relative(base, path);
  assert(r && !r.startsWith('..') && !isAbsolute(r));
  return path;
};
const raw = (f) => readFile(inside(root, f)),
  unpack = async (f) => gunzipSync(await raw(f));
const manifest = JSON.parse(await raw('MANIFEST.json'));
assert.equal(manifest.parent, '../..');
const pmBytes = await readFile(join(parent, 'MANIFEST.json')),
  psBytes = await readFile(join(parent, 'SOURCE-MANIFEST.json'));
assert.equal(sha(pmBytes), manifest.parentManifestSha256);
assert.equal(sha(psBytes), manifest.parentSourceManifestSha256);
const pm = JSON.parse(pmBytes),
  sources = JSON.parse(psBytes);
const parentUnpack = async (file) => {
  const entry = pm.evidence.find((e) => e.file === file);
  assert(entry, file);
  const bytes = await readFile(inside(parent, file));
  assert.equal(sha(bytes), entry.sha256);
  const data = gunzipSync(bytes);
  assert.equal(sha(data), entry.rawSha256);
  return data;
};
const run = (script, args) => {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stdout + '\n' + r.stderr);
  return r.stdout.trim();
};
assert.equal(
  sha(await readFile('scripts/verify-foreground-lifecycle-archive.mjs')),
  sha(await parentUnpack('evidence/sources/scripts/verify-foreground-lifecycle-archive.mjs.gz')),
);
console.log(
  run('scripts/verify-foreground-lifecycle-archive.mjs', [
    '--archive',
    parent,
    ...(values['frozen-prefix'] ? ['--frozen-prefix', values['frozen-prefix']] : []),
    ...(values['production-root'] ? ['--production-root', values['production-root']] : []),
  ]),
);
for (const e of manifest.files) {
  const bytes = await raw(e.file);
  assert.equal(sha(bytes), e.sha256, e.file);
  if (e.rawSha256) assert.equal(sha(gunzipSync(bytes)), e.rawSha256, e.file);
}
const temp = await mkdtemp(join(tmpdir(), 'tixtab-idle-traces-'));
assert.deepEqual(
  manifest.records.map((r) => r.group),
  ['before', 'candidate'],
);
for (const file of ['scripts/trace-intervals.mjs', 'scripts/trace-intervals.test.mjs'])
  assert.equal(sha(await readFile(file)), sha(await unpack('sources/' + file + '.gz')));
console.log(run('--test', ['scripts/trace-intervals.test.mjs']));
let runtimeFiles = 0,
  analyses = 0;
const reports = [];
for (const entry of manifest.records) {
  const group = entry.group;
  assert(['before', 'candidate'].includes(group));
  const report = JSON.parse(await unpack(group + '/report.json.gz'));
  reports.push(report);
  assert.equal(report.buildSha256, entry.buildSha256);
  assert.equal(sha(JSON.stringify(report.buildManifest)), entry.buildSha256);
  assert.deepEqual(entry.sourceManifest, sources[group]);
  assert.equal(report.rows.length, 16);
  requireComparable([report]);
  assert.equal(demandModel(report).unmatchedProcessIntervals, 0);
  const pe = pm.entries.find((e) => e.file === group + '-1.json.gz'),
    pb = await readFile(join(parent, pe.file));
  assert.equal(sha(pb), pe.sha256);
  const pr = JSON.parse(gunzipSync(pb));
  assert.equal(report.buildSha256, pr.buildSha256);
  assert.equal(report.fixture.sha256, pr.fixture.sha256);
  const measured = await Promise.all(
    report.harnessFiles.map((f) => unpack('sources/' + f + '.gz')),
  );
  assert.equal(report.harnessSha256, sha(Buffer.concat(measured)));
  assert.equal(report.harnessSha256, pr.harnessSha256);
  if (values['frozen-prefix'])
    for (const [file, hash] of report.buildManifest) {
      assert.equal(
        sha(await readFile(inside(resolve(values['frozen-prefix'] + '-' + group), file))),
        hash,
      );
      runtimeFiles++;
    }
  const trace = await unpack(group + '/trace.json.gz'),
    tracePath = join(temp, group + '.trace.json');
  await writeFile(tracePath, trace);
  for (const phase of ['idle-tail', 'facing-zoom']) {
    const initial = JSON.parse(await unpack(`initial-gc/${group}-${phase}.json.gz`));
    assert.equal(initial.traceSha256, sha(trace));
    assert.equal(
      initial.harnessSha256,
      sha(await unpack('evidence/lifecycle-idle-initial-gc.mjs.gz')),
    );
    assert.equal(
      initial.intervalHarnessSha256,
      sha(await unpack('evidence/lifecycle-idle-union-v1.mjs.gz')),
    );
  }
  for (const phase of ['idle-tail', 'facing-zoom'])
    for (const kind of ['gc', 'analysis']) {
      const script =
        kind === 'gc' ? 'scripts/analyze-workflow-gc.mjs' : 'scripts/analyze-workflow-trace.mjs';
      assert.equal(sha(await readFile(script)), sha(await unpack('sources/' + script + '.gz')));
      if (kind === 'gc')
        assert.equal(
          sha(await readFile('scripts/trace-intervals.mjs')),
          sha(await unpack('sources/scripts/trace-intervals.mjs.gz')),
        );
      const output = join(temp, group + '-' + phase + '-' + kind + '.json');
      run(script, ['--trace', tracePath, '--phase', phase, '--output', output]);
      const fresh = JSON.parse(await readFile(output)),
        recorded = JSON.parse(await unpack(`${group}/${phase}-${kind}.json.gz`));
      assert.equal(recorded.traceSha256, sha(trace));
      const clean = ({ trace, ...rest }) => rest;
      assert.deepEqual(clean(fresh), clean(recorded));
      analyses++;
    }
  for (const artifact of report.objectDownloads) {
    const name = basename(artifact.path.replaceAll('\\', '/'));
    assert.equal(sha(await unpack('outputs/' + name + '.gz')), artifact.sha256);
  }
}
requireComparable(reports);
const locations = JSON.parse(await unpack('evidence/lifecycle-idle-source-locations.json.gz'));
assert.equal(locations.records.length, 4);
for (const r of locations.records) {
  const compiled = await parentUnpack(`changed-runtime/${r.group}/${r.file}.gz`);
  assert.equal(sha(compiled), r.sha256);
  assert.equal(
    new Map(reports.find((x) => x.label.includes(r.group + '-')).buildManifest).get(r.file),
    r.sha256,
  );
  const line = compiled.toString().split('\n')[r.lineZeroBased];
  assert.equal(
    line.slice(Math.max(0, r.columnZeroBased - 100), r.columnZeroBased + 450),
    r.excerpt,
  );
  assert(r.excerpt.includes(r.name));
}
await mkdir(join(temp, 'src'));
await mkdir(join(temp, 'outputs'));
for (const file of ['model.ts', 'zoteroSource.ts'])
  await writeFile(
    join(temp, 'src', file),
    await parentUnpack('source-snapshots/candidate/src/' + file + '.gz'),
  );
await writeFile(join(temp, 'fixture.tixtab'), await parentUnpack('fixtures/objects.tixtab.gz'));
await writeFile(
  join(temp, 'fixture.tixtab.json'),
  await parentUnpack('fixtures/objects.tixtab.json.gz'),
);
for (const report of reports)
  for (const artifact of report.objectDownloads) {
    const name = basename(artifact.path.replaceAll('\\', '/'));
    await writeFile(join(temp, 'outputs', name), await unpack('outputs/' + name + '.gz'), {
      flag: 'wx',
    });
  }
for (const group of ['before', 'candidate'])
  await writeFile(join(temp, group + '.json'), await unpack(group + '/report.json.gz'));
assert.equal(
  sha(await readFile('scripts/verify-reading-scale-output.mjs')),
  sha(await parentUnpack('evidence/sources/scripts/verify-reading-scale-output.mjs.gz')),
);
const output = join(temp, 'quality.json');
console.log(
  run('scripts/verify-reading-scale-output.mjs', [
    ...['before', 'candidate'].flatMap((g) => ['--report', join(temp, g + '.json')]),
    '--fixture-file',
    join(temp, 'fixture.tixtab'),
    '--model',
    join(temp, 'src/model.ts'),
    '--artifact-dir',
    join(temp, 'outputs'),
    '--output',
    output,
  ]),
);
console.log(
  JSON.stringify({
    passed: true,
    reports: reports.length,
    evidence: manifest.files.length,
    parentSourceFiles: Object.values(sources).reduce((sum, files) => sum + files.length, 0),
    runtimeFiles,
    analyses,
    compiledLocations: locations.records.length,
    outputChecks: JSON.parse(await readFile(output)).checks.length,
    parentCurrentProductionChecked: !!values['production-root'],
  }),
);
