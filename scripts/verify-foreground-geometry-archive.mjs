import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join, basename, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { demandModel, quantiles } from './performance-demand.mjs';
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
    'src/useForegroundViewport.ts',
  ]),
);
const temp = await mkdtemp(join(tmpdir(), 'tixtab-foreground-geometry-archive-'));
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
  recorded = JSON.parse(await unpack('evidence/foreground-geometry-quality-comparison.json.gz'));
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
  recordedOutput = JSON.parse(await unpack('evidence/foreground-geometry-output-quality.json.gz'));
for (const key of ['fixtureSha256', 'modelSha256', 'harnessSha256'])
  assert.equal(output[key], recordedOutput[key]);
assert.equal(
  output.harnessSha256,
  sha(await unpack('evidence/sources/scripts/verify-reading-scale-output.mjs.gz')),
);
const withoutPath = ({ report, ...rest }) => rest;
assert.deepEqual(output.checks.map(withoutPath), recordedOutput.checks.map(withoutPath));
let geometryChecks = 0;
for (const [side, view, paper] of [
  ['reference', 8, 16],
  ['candidate', 1, 8],
]) {
  const files = manifest.evidence.filter(
    (e) =>
      e.file.startsWith('evidence/results/foreground-geometry-proof-' + side + '-results/') &&
      e.file.endsWith('/geometry-reads.json.gz'),
  );
  assert.equal(files.length, 1);
  const proof = JSON.parse(await unpack(files[0].file));
  assert.deepEqual(proof.initial.reads, { view: paper, paper });
  assert.equal(proof.results.length, 4);
  for (const result of proof.results) {
    assert.deepEqual(result.reads, { view, paper: 8 });
    assert.deepEqual(result.missing, []);
    geometryChecks++;
  }
  assert.deepEqual(proof.teardown, { view: 0, paper: 0 });
}
const nativeFiles = manifest.evidence.filter((e) =>
  e.file.startsWith('evidence/results/foreground-geometry-native-results/'),
);
const native = JSON.parse(
  await unpack(nativeFiles.find((e) => e.file.endsWith('/pixel-comparisons.json.gz')).file),
);
assert.equal(native.length, 10);
assert(native.every((x) => x.maximum <= 1 && x.overOne === 0));
const transient = JSON.parse(
  await unpack(nativeFiles.find((e) => e.file.endsWith('/transient-coverage.json.gz')).file),
);
assert.equal(transient.length, 48);
assert(transient.every((x) => !x.missingInk && !x.missingObjects.length));
for (const [tag, rounds] of [
  ['primary', [1, 2, 3]],
  ['confirm', [4, 5, 6]],
]) {
  const recorded = JSON.parse(
    await unpack(`evidence/foreground-geometry-${tag}-comparison.json.gz`),
  );
  for (const [group, label] of [
    ['before', 'baseline'],
    ['candidate', 'candidate'],
  ]) {
    const selected = reports.filter((r) =>
      rounds.some((n) => r.label === `foreground-geometry-${group}-${n}`),
    );
    assert.equal(selected.length, 3);
    assert.deepEqual(
      recorded[label].cpuSeconds,
      quantiles(selected.map((r) => demandModel(r).totalCpuSeconds)),
    );
    for (const phase of recorded[label].phases) {
      const rows = selected.map((r) => r.rows.find((x) => x.name === phase.name));
      for (const key of ['cpuSeconds', 'wallMs', 'mainThreadSeconds'])
        assert.deepEqual(phase[key], quantiles(rows.map((r) => r[key])));
      for (const [key, p] of [
        ['frameP95Ms', 'p95'],
        ['frameP99Ms', 'p99'],
        ['frameMaxMs', 'max'],
      ])
        assert.deepEqual(phase[key], quantiles(rows.map((r) => r.framesMs[p])));
    }
  }
}
let lateRefChecks = 0;
for (const [tag, group] of [
  ['reference', 'before'],
  ['candidate', 'candidate'],
]) {
  const files = manifest.evidence.filter(
    (e) =>
      e.file.startsWith(`evidence/results/foreground-geometry-late-${tag}-results/`) &&
      e.file.endsWith('/late-ref.json.gz'),
  );
  assert.equal(files.length, 1);
  const probe = JSON.parse(await unpack(files[0].file));
  assert.equal(probe.sourceSha256, new Map(sources[group]).get('src/useForegroundViewport.ts'));
  assert.deepEqual(probe.initial, {});
  assert.deepEqual(probe.result.clips, {});
  assert.deepEqual(probe.result.reads, { view: 0, paper: 0 });
  lateRefChecks++;
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
    geometryChecks,
    nativePixelChecks: native.length,
    firstFrameChecks: transient.length,
    lateRefChecks,
    productionSide: manifest.decision.productionSide,
    productionFiles,
  }),
);
