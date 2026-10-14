import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const sharp = createRequire(import.meta.url)('sharp');
const { values } = parseArgs({
  options: {
    archive: { type: 'string' },
    'frozen-prefix': { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.archive || !values.output) throw Error('Supply archive and fresh output');
const root = resolve(values.archive),
  sha = (b) => createHash('sha256').update(b).digest('hex');
const unpack = async (file) => gunzipSync(await readFile(join(root, file)));
function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + '\n' + r.stderr);
  console.log(r.stdout.trim());
}
run('scripts/verify-render-archive.mjs', [
  '--archive',
  root,
  '--changed-source',
  'src/ObjectLayer.tsx',
  ...(values['frozen-prefix'] ? ['--frozen-prefix', values['frozen-prefix']] : []),
]);
const manifest = JSON.parse(await readFile(join(root, 'MANIFEST.json'))),
  temp = await mkdtemp(join(tmpdir(), 'tixtab-preview-archive-'));
await mkdir(join(temp, 'src'));
await mkdir(join(temp, 'outputs'));
for (const name of ['model.ts', 'zoteroSource.ts'])
  await writeFile(
    join(temp, 'src', name),
    await unpack('source-snapshots/candidate/src/' + name + '.gz'),
  );
for (const ext of ['tixtab', 'tixtab.json'])
  await writeFile(join(temp, 'objects.' + ext), await unpack('fixtures/objects.' + ext + '.gz'));
const reports = [];
for (const entry of manifest.entries) {
  const report = JSON.parse(await unpack(entry.file));
  reports.push('--report', join(root, entry.file));
  for (const artifact of report.objectDownloads) {
    const name = basename(artifact.path.replaceAll('\\', '/')),
      bytes = await unpack('outputs/' + name + '.gz');
    assert.equal(sha(bytes), artifact.sha256);
    await writeFile(join(temp, 'outputs', name), bytes, { flag: 'wx' });
  }
}
run('scripts/verify-object-workflow.mjs', [
  ...reports,
  '--fixture-file',
  join(temp, 'objects.tixtab'),
  '--model',
  join(temp, 'src/model.ts'),
  '--artifact-dir',
  join(temp, 'outputs'),
  '--output',
  values.output,
]);
const fresh = JSON.parse(await readFile(values.output)),
  recorded = JSON.parse(await unpack('evidence/object-preview-output-quality-v2.json.gz'));
const withoutPath = ({ report, ...rest }) => rest;
assert.deepEqual(fresh.checks.map(withoutPath), recorded.checks.map(withoutPath));
assert.equal(
  fresh.harnessSha256,
  sha(await unpack('evidence/sources/scripts/verify-object-workflow.mjs.gz')),
);
assert.equal(fresh.fixtureSha256, sha(await unpack('fixtures/objects.tixtab.gz')));
const native = JSON.parse(await unpack('native/raster-quality/report.json.gz'));
assert(native.pass && native.contentPass);
assert.deepEqual(native.errors, []);
assert.equal(native.checks.length, 24);
assert.equal(
  native.harnessSha256,
  sha(await unpack('evidence/sources/scripts/verify-object-preview-native.mjs.gz')),
);
assert.equal(
  native.scenariosSha256,
  sha(await unpack('evidence/sources/scripts/object-preview-scenarios.mjs.gz')),
);
assert.equal(native.fixtureSha256, sha(await unpack('native/raster-quality/fixture.tixtab.gz')));
for (const [label, group] of [
  ['baseline', 'before'],
  ['candidate', 'candidate'],
])
  assert.equal(
    native.sources[label].sourceManifestSha256,
    sha(await readFile(join(root, group + '-source-manifest.json'))),
  );
let rasterPairs = 0;
for (const a of native.renders.baseline) {
  const b = native.renders.candidate.find((b) => b.id === a.id);
  assert.deepEqual(a.geometry, b.geometry);
  assert.deepEqual(a.root, b.root);
  assert.deepEqual(a.raster, b.raster);
  rasterPairs += a.raster.length;
  const x = await unpack('native/raster-quality/' + a.name + '.gz'),
    y = await unpack('native/raster-quality/' + b.name + '.gz');
  assert.equal(sha(x), a.sha256);
  assert.equal(sha(y), b.sha256);
  const p = await sharp(x).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    q = await sharp(y).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(p.info, q.info);
  assert(p.data.equals(q.data), a.id);
  const c = native.checks.find((c) => c.id === a.id);
  assert.equal(c.different, 0);
  assert.equal(c.max, 0);
  assert.equal(c.width, p.info.width);
  assert.equal(c.height, p.info.height);
}
assert.equal(rasterPairs, 120);
for (const group of ['before', 'candidate']) {
  const trace = await unpack(`diagnostics/${group}.trace.json.gz`),
    analysis = JSON.parse(await unpack(`diagnostics/${group}-analysis.json.gz`)),
    report = JSON.parse(await unpack(`diagnostics/${group}.json.gz`));
  assert.equal(analysis.traceSha256, sha(trace));
  assert.equal(
    analysis.harnessSha256,
    sha(await unpack('evidence/sources/scripts/analyze-workflow-trace.mjs.gz')),
  );
  const entry = manifest.entries.find((e) => e.file.startsWith(group + '-'));
  assert.equal(report.buildSha256, entry.buildSha256);
  assert.equal(report.harnessSha256, entry.harnessSha256);
}
console.log(
  JSON.stringify({
    passed: true,
    reconstructedWorkflows: fresh.checks.length,
    nativeSamePhasePixelPairs: native.checks.length,
    exactRasterPairs: rasterPairs,
    tracesBound: 2,
    limitation:
      'Fixed synthetic samples, simulated pointer input and resource proxies; no physical pen latency or energy claim.',
  }),
);
