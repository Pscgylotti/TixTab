import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';

const { values } = parseArgs({
  options: {
    archive: { type: 'string' },
    'frozen-prefix': { type: 'string' },
    output: { type: 'string' },
    experiment: { type: 'string', default: 'object-png' },
    'changed-source': { type: 'string', default: 'src/objectGroup.ts' },
    'native-ink': { type: 'boolean', default: false },
  },
});
if (!values.archive || !values.output) throw Error('Supply archive and fresh output');
assert.match(values.experiment, /^[a-z-]+$/);
const root = resolve(values.archive),
  sha = (b) => createHash('sha256').update(b).digest('hex');
function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw Error(`${script}: ${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
console.log(
  run('scripts/verify-render-archive.mjs', [
    '--archive',
    root,
    '--changed-source',
    values['changed-source'],
    ...(values['frozen-prefix'] ? ['--frozen-prefix', values['frozen-prefix']] : []),
  ]),
);
const raw = (file) => readFile(join(root, file));
const unpack = async (file) => gunzipSync(await raw(file));
const manifest = JSON.parse(await raw('MANIFEST.json'));
const temp = await mkdtemp(join(tmpdir(), 'tixtab-object-archive-'));
const artifacts = join(temp, 'artifacts');
await mkdir(artifacts);
for (const path of ['src/model.ts', 'src/zoteroSource.ts']) {
  await mkdir(join(temp, 'src'), { recursive: true });
  await writeFile(join(temp, path), await unpack(`source-snapshots/candidate/${path}.gz`));
}
for (const extension of ['tixtab', 'tixtab.json'])
  await writeFile(
    join(temp, 'objects.' + extension),
    await unpack(`fixtures/objects.${extension}.gz`),
  );
const reportArgs = [],
  reportChecks = [];
for (const entry of manifest.entries) {
  const report = JSON.parse(await unpack(entry.file));
  reportArgs.push('--report', join(root, entry.file));
  for (const artifact of report.objectDownloads) {
    const name = basename(artifact.path.replaceAll('\\', '/'));
    const bytes = await unpack(`outputs/${name}.gz`);
    assert.equal(sha(bytes), artifact.sha256);
    await writeFile(join(artifacts, name), bytes, { flag: 'wx' });
  }
  reportChecks.push(report);
}
console.log(
  run('scripts/verify-object-workflow.mjs', [
    ...reportArgs,
    '--fixture-file',
    join(temp, 'objects.tixtab'),
    '--model',
    join(temp, 'src/model.ts'),
    '--artifact-dir',
    artifacts,
    '--output',
    values.output,
  ]),
);
const quality = JSON.parse(await readFile(values.output));
const recorded = JSON.parse(
  await unpack(`evidence/${values.experiment}-output-quality-v2.json.gz`),
);
assert.equal(quality.fixtureSha256, recorded.fixtureSha256);
assert.equal(quality.modelSha256, recorded.modelSha256);
assert.equal(quality.harnessSha256, recorded.harnessSha256);
assert.equal(
  quality.harnessSha256,
  sha(await unpack('evidence/sources/scripts/verify-object-workflow.mjs.gz')),
);
const withoutPath = ({ report, ...rest }) => rest;
assert.deepEqual(quality.checks.map(withoutPath), recorded.checks.map(withoutPath));
const native = JSON.parse(
  await unpack(
    values['native-ink']
      ? `evidence/${values.experiment}-native.json.gz`
      : 'evidence/object-png-native-formal.json.gz',
  ),
);
assert.equal(
  native.harnessSha256,
  sha(
    await unpack(
      values['native-ink']
        ? 'evidence/sources/scripts/verify-ink-native.mjs.gz'
        : 'evidence/sources/scripts/verify-object-png-native.mjs.gz',
    ),
  ),
);
assert.equal(native.sourceManifestSha256, sha(await raw('candidate-source-manifest.json')));
if (values['native-ink']) {
  assert.equal(native.checks.length, 12);
  assert(native.checks.every((c) => c.different === 0));
  assert.deepEqual(native.errors, []);
  assert.equal(native.oracleSha256, sha(await unpack('source-snapshots/before/src/ink.ts.gz')));
  assert.equal(new Set(quality.checks.map((c) => c.pngSha256)).size, 1);
  assert.equal(new Set(quality.checks.map((c) => c.straightRgbaSha256)).size, 1);
} else {
  assert.equal(native.checks.length, 27);
  assert(native.checks.every((c) => c.different === 0 && c.max === 0));
  assert.equal(native.encoded.alphaDifferences, 0);
  assert.equal(native.encoded.premultipliedDifferences, 0);
  assert(native.encoded.maxDifference <= 1);
  for (const [group, side] of [
    ['before', 'before'],
    ['candidate', 'candidate'],
  ]) {
    const checks = quality.checks.filter((c) => c.report.includes(group + '-'));
    assert.equal(checks.length, 3);
    assert(checks.every((c) => c.pngSha256 === native.pngHashes[side]));
    assert(checks.some((c) => c.projectSha256 === native.source[side].sha256));
  }
}
let tracesBound = 0;
for (const [tag, group] of [
  ['before', 'before'],
  ['candidate', 'candidate'],
]) {
  const trace = await unpack(`diagnostics/${tag}.trace.json.gz`);
  const analysis = JSON.parse(await unpack(`diagnostics/${tag}-analysis.json.gz`));
  const report = JSON.parse(await unpack(`diagnostics/${tag}.json.gz`));
  assert.equal(analysis.traceSha256, sha(trace));
  assert.equal(
    analysis.harnessSha256,
    sha(await unpack('evidence/sources/scripts/analyze-workflow-trace.mjs.gz')),
  );
  assert.equal(
    report.buildSha256,
    reportChecks.find((r) => r.label.includes(group + '-')).buildSha256,
  );
  assert.equal(report.harnessSha256, reportChecks[0].harnessSha256);
  tracesBound++;
}
console.log(
  JSON.stringify({
    passed: true,
    reconstructedWorkflows: quality.checks.length,
    nativeRenderChecks: native.checks.length,
    tracesBound,
    limitation: values['native-ink']
      ? 'Fixed path/pixel/geometry checks; no energy claim.'
      : 'Raw straight-alpha PNG differences remain recorded; no energy claim.',
  }),
);
