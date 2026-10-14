import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join, basename, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
const { values } = parseArgs({
  options: {
    archive: { type: 'string' },
    'frozen-prefix': { type: 'string' },
    'production-root': { type: 'string' },
  },
});
if (!values.archive)
  throw Error('Supply archive and optional actual frozen prefix / production root');
const root = resolve(values.archive),
  sha = (b) => createHash('sha256').update(b).digest('hex');
const inside = (base, file) => {
  const p = resolve(base, file),
    r = relative(base, p);
  assert(r && !r.startsWith('..') && !isAbsolute(r));
  return p;
};
const raw = (f) => readFile(inside(root, f)),
  unpack = async (f) => gunzipSync(await raw(f));
const manifest = JSON.parse(await raw('MANIFEST.json')),
  sources = JSON.parse(await raw('SOURCE-MANIFEST.json'));
function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + '\n' + r.stderr);
  return r.stdout.trim();
}
console.log(
  run('scripts/verify-render-archive.mjs', [
    '--archive',
    root,
    '--changed-source',
    'src/ReadingView.tsx',
  ]),
);
const temp = await mkdtemp(join(tmpdir(), 'tixtab-reading-scale-archive-'));
let runtimeFiles = 0,
  pixelPairs = 0,
  productionFiles = 0;
const reports = [];
for (const entry of manifest.entries) {
  const report = JSON.parse(await unpack(entry.file));
  reports.push(report);
  if (values['frozen-prefix']) {
    const group = entry.file.startsWith('before-') ? 'before' : 'candidate';
    for (const [file, hash] of report.buildManifest) {
      assert.equal(
        sha(await readFile(inside(resolve(values['frozen-prefix'] + '-' + group), file))),
        hash,
        file,
      );
      runtimeFiles++;
    }
  }
}
for (const group of ['before', 'candidate']) {
  const qualityBytes = await unpack(`quality/${group}.json.gz`),
    quality = JSON.parse(qualityBytes);
  assert.equal(quality.sourceManifestSha256, sha(await raw(group + '-source-manifest.json')));
  assert.equal(
    quality.harnessSha256,
    sha(await unpack('evidence/sources/scripts/verify-night-matrix.mjs.gz')),
  );
  await writeFile(join(temp, group + '.json'), qualityBytes);
  await mkdir(join(temp, group + '-pixels'));
  for (const c of quality.checks)
    for (const image of c.images)
      await writeFile(
        join(temp, group + '-pixels', image.file),
        await unpack(`quality/${group}-pixels/${image.file}.gz`),
        { flag: 'wx' },
      );
}
const freshQuality = join(temp, 'quality.json');
console.log(
  run('scripts/compare-pdf-quality.mjs', [
    '--baseline',
    join(temp, 'before.json'),
    '--candidate',
    join(temp, 'candidate.json'),
    '--output',
    freshQuality,
  ]),
);
const quality = JSON.parse(await readFile(freshQuality)),
  recorded = JSON.parse(await unpack('evidence/reading-scale-quality-comparison.json.gz'));
assert.deepEqual(quality, recorded);
pixelPairs = quality.checks.length;
assert.equal(
  quality.comparisonHarnessSha256,
  sha(await unpack('evidence/sources/scripts/compare-pdf-quality.mjs.gz')),
);
await mkdir(join(temp, 'src'));
await mkdir(join(temp, 'artifacts'));
for (const file of ['model.ts', 'zoteroSource.ts'])
  await writeFile(
    join(temp, 'src', file),
    await unpack(`source-snapshots/candidate/src/${file}.gz`),
  );
for (const ext of ['tixtab', 'tixtab.json'])
  await writeFile(join(temp, 'objects.' + ext), await unpack(`fixtures/objects.${ext}.gz`));
for (const report of reports)
  for (const artifact of report.objectDownloads) {
    const name = basename(artifact.path.replaceAll('\\', '/')),
      bytes = await unpack(`outputs/${name}.gz`);
    assert.equal(sha(bytes), artifact.sha256);
    await writeFile(join(temp, 'artifacts', name), bytes, { flag: 'wx' });
  }
const freshOutput = join(temp, 'outputs.json');
console.log(
  run('scripts/verify-reading-scale-output.mjs', [
    ...manifest.entries.flatMap((e) => ['--report', join(root, e.file)]),
    '--fixture-file',
    join(temp, 'objects.tixtab'),
    '--model',
    join(temp, 'src/model.ts'),
    '--artifact-dir',
    join(temp, 'artifacts'),
    '--output',
    freshOutput,
  ]),
);
const output = JSON.parse(await readFile(freshOutput)),
  recordedOutput = JSON.parse(await unpack('evidence/reading-scale-output-quality-v2.json.gz'));
for (const key of ['fixtureSha256', 'modelSha256', 'harnessSha256'])
  assert.equal(output[key], recordedOutput[key]);
assert.equal(
  output.harnessSha256,
  sha(await unpack('evidence/sources/scripts/verify-reading-scale-output.mjs.gz')),
);
const withoutPath = ({ report, ...rest }) => rest;
assert.deepEqual(output.checks.map(withoutPath), recordedOutput.checks.map(withoutPath));
let tracesVerified = 0;
for (const [tag, group] of [
  ['before', 'before'],
  ['candidate', 'candidate'],
  ['initial', 'before'],
]) {
  const diagnostic = JSON.parse(await unpack(`diagnostics/${tag}.json.gz`));
  assert.equal(
    diagnostic.buildSha256,
    reports.find((r) => r.label.includes(group + '-')).buildSha256,
  );
  const harness = await Promise.all(
    diagnostic.harnessFiles.map((f) =>
      tag === 'initial' && f === 'scripts/benchmark-workflow.mjs'
        ? unpack('diagnostics/initial-benchmark.mjs.gz')
        : unpack(`evidence/sources/${f}.gz`),
    ),
  );
  assert.equal(diagnostic.harnessSha256, sha(Buffer.concat(harness)));
  const trace = await unpack(`diagnostics/${tag}.trace.json.gz`);
  const analysis = JSON.parse(await unpack(`diagnostics/${tag}-analysis.json.gz`));
  assert.equal(analysis.traceSha256, sha(trace));
  assert.equal(
    analysis.harnessSha256,
    sha(await unpack('evidence/sources/scripts/analyze-workflow-trace.mjs.gz')),
  );
  assert.equal(analysis.phase, tag === 'initial' ? 'facing-zoom' : 'reading-zoom-settle-cycle');
  if (tag !== 'initial') {
    const facing = JSON.parse(await unpack(`diagnostics/${tag}-facing-analysis.json.gz`));
    assert.equal(facing.traceSha256, sha(trace));
    assert.equal(facing.harnessSha256, analysis.harnessSha256);
    assert.equal(facing.phase, 'facing-zoom');
  }
  for (const artifact of diagnostic.objectDownloads) {
    const name = basename(artifact.path.replaceAll('\\', '/'));
    assert.equal(sha(await unpack(`diagnostics/outputs/${name}.gz`)), artifact.sha256);
  }
  if (values['frozen-prefix'])
    for (const [file, hash] of diagnostic.buildManifest) {
      assert.equal(
        sha(await readFile(inside(resolve(values['frozen-prefix'] + '-' + group), file))),
        hash,
        file,
      );
      runtimeFiles++;
    }
  tracesVerified++;
}
const locations = JSON.parse(await unpack('evidence/reading-scale-source-locations.json.gz'));
assert.equal(locations.records.length, 4);
for (const r of locations.records) {
  assert(['before', 'candidate'].includes(r.group));
  const bytes = await unpack(`changed-runtime/${r.group}/${r.file}.gz`);
  assert.equal(sha(bytes), r.sha256);
  assert.equal(
    new Map(reports.find((x) => x.label.includes(r.group + '-')).buildManifest).get(r.file),
    r.sha256,
  );
  const line = bytes.toString('utf8').split('\n')[r.lineZeroBased];
  assert.equal(
    line.slice(Math.max(0, r.columnZeroBased - 100), r.columnZeroBased + 450),
    r.excerpt,
  );
  assert(r.excerpt.includes(r.label));
}
if (values['production-root'])
  for (const [file, hash] of sources[manifest.decision.productionSide]) {
    assert.equal(sha(await readFile(inside(resolve(values['production-root']), file))), hash, file);
    productionFiles++;
  }
console.log(
  JSON.stringify({
    passed: true,
    reports: reports.length,
    runtimeFiles,
    pixelPairs,
    outputChecks: output.checks.length,
    tracesVerified,
    productionSide: manifest.decision.productionSide,
    productionFiles,
  }),
);
