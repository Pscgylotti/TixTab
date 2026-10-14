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
const raw = (f) => readFile(inside(root, f));
const unpack = async (f) => gunzipSync(await raw(f));
const manifest = JSON.parse(await raw('MANIFEST.json')),
  sources = JSON.parse(await raw('SOURCE-MANIFEST.json'));
function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + '\n' + r.stderr);
  return r.stdout.trim();
}
console.log(run('scripts/verify-render-archive.mjs', ['--archive', root]));
const changed = [...new Set([...sources.before, ...sources.candidate].map(([p]) => p))]
  .filter((p) => new Map(sources.before).get(p) !== new Map(sources.candidate).get(p))
  .sort();
assert.deepEqual(
  changed,
  [
    'src/night.css',
    'src/PageThumbnail.tsx',
    'src/pdfBitmapDisplay.ts',
    'src/pdfCompletion.test.ts',
    'src/PdfDetailLayer.tsx',
    'src/pdfRenderCache.test.ts',
    'src/pdfRenderCache.ts',
    'src/pdfScheduler.test.ts',
    'src/PdfSurface.tsx',
    'src/ReadingView.tsx',
    'src/usePdfBitmapDisplay.ts',
  ].sort(),
);
assert.equal(sources.before.length, 211);
assert.equal(sources.candidate.length, 213);
const temp = await mkdtemp(join(tmpdir(), 'tixtab-pdf-display-archive-'));
const reports = [];
let runtimeFiles = 0,
  productionFiles = 0;
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
assert.equal(reports.length, 12);
for (const [suffix, numbers] of [
  ['-primary', [1, 2, 3]],
  ['-confirm', [4, 5, 6]],
  ['', [1, 2, 3, 4, 5, 6]],
]) {
  const comparison = JSON.parse(await raw('comparison' + suffix + '.json'));
  for (const [side, label] of [
    ['before', 'baseline'],
    ['candidate', 'candidate'],
  ]) {
    const runs = reports.filter((r) => numbers.some((n) => r.label === `pdf-display-${side}-${n}`));
    const recorded = comparison[label];
    assert.equal(runs.length, numbers.length);
    assert.deepEqual(
      recorded.cpuSeconds,
      quantiles(runs.map((r) => demandModel(r).totalCpuSeconds)),
    );
    for (const phase of recorded.phases) {
      const rows = runs.map((r) => r.rows.find((row) => row.name === phase.name));
      for (const key of ['cpuSeconds', 'wallMs', 'mainThreadSeconds'])
        assert.deepEqual(phase[key], quantiles(rows.map((r) => r[key])));
      for (const [key, source] of [
        ['frameP95Ms', 'p95'],
        ['frameP99Ms', 'p99'],
        ['frameMaxMs', 'max'],
      ])
        assert.deepEqual(phase[key], quantiles(rows.map((r) => r.framesMs[source])));
    }
  }
  const demandSuffix =
    suffix === '-primary' ? '' : suffix === '-confirm' ? '-confirm' : '-combined';
  const demand = JSON.parse(
    await unpack('evidence/pdf-display-demand' + demandSuffix + '.json.gz'),
  );
  for (const side of ['before', 'candidate']) {
    const runs = numbers.map((n) => reports.find((r) => r.label === `pdf-display-${side}-${n}`));
    const measured = runs.map(demandModel);
    assert.deepEqual(demand[side].totalCpu, quantiles(measured.map((d) => d.totalCpuSeconds)));
    for (const [key, window, statistic] of [
      ['peak200', '200', 'max'],
      ['p99200', '200', 'p99'],
      ['peak1000', '1000', 'max'],
    ])
      assert.deepEqual(
        demand[side][key],
        quantiles(measured.map((d) => d.windows[window].coreEquivalent[statistic])),
      );
    assert.deepEqual(
      demand[side].memoryKb,
      quantiles(runs.map((r) => Math.max(...r.rows.map((x) => x.memoryWorkingSetKbPeak)))),
    );
    assert.deepEqual(
      demand[side].counters,
      runs.map((r) => r.rows.at(-1).completionAfter.counters),
    );
    assert.deepEqual(
      demand[side].pending,
      runs.map(() => 0),
    );
  }
}
for (const side of ['before', 'candidate']) {
  const bytes = await unpack(`quality/${side}.json.gz`),
    quality = JSON.parse(bytes);
  assert.equal(quality.sourceManifestSha256, sha(await raw(side + '-source-manifest.json')));
  assert.equal(
    quality.harnessSha256,
    sha(await unpack('evidence/sources/scripts/verify-night-matrix.mjs.gz')),
  );
  await writeFile(join(temp, side + '.json'), bytes);
  await mkdir(join(temp, side + '-pixels'));
  for (const c of quality.checks)
    for (const image of c.images)
      await writeFile(
        join(temp, side + '-pixels', image.file),
        await unpack(`quality/${side}-pixels/${image.file}.gz`),
        { flag: 'wx' },
      );
}
console.log(
  run('scripts/compare-pdf-quality.mjs', [
    '--baseline',
    join(temp, 'before.json'),
    '--candidate',
    join(temp, 'candidate.json'),
    '--output',
    join(temp, 'quality.json'),
  ]),
);
const quality = JSON.parse(await readFile(join(temp, 'quality.json')));
assert.deepEqual(
  quality,
  JSON.parse(await unpack('evidence/pdf-display-quality-comparison.json.gz')),
);
assert.equal(quality.checks.length, 369);
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
  for (const a of report.objectDownloads) {
    const name = basename(a.path.replaceAll('\\', '/')),
      bytes = await unpack(`outputs/${name}.gz`);
    assert.equal(sha(bytes), a.sha256);
    await writeFile(join(temp, 'artifacts', name), bytes, { flag: 'wx' });
  }
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
    join(temp, 'outputs.json'),
  ]),
);
const output = JSON.parse(await readFile(join(temp, 'outputs.json')));
const recordedOutput = JSON.parse(await unpack('evidence/pdf-display-output-quality.json.gz'));
for (const key of ['fixtureSha256', 'modelSha256', 'harnessSha256'])
  assert.equal(output[key], recordedOutput[key]);
const noPath = ({ report, ...rest }) => rest;
assert.deepEqual(output.checks.map(noPath), recordedOutput.checks.map(noPath));
const resultFiles = manifest.evidence.filter((e) =>
  e.file.startsWith('evidence/results/pdf-display-native-bound-results/'),
);
const bindings = resultFiles.filter((e) => e.file.endsWith('/binding.json.gz'));
assert.equal(bindings.length, 3);
let nativeBindings = 0;
for (const entry of bindings) {
  const binding = JSON.parse(await unpack(entry.file));
  assert(binding.native);
  assert.equal(
    binding.testSha256,
    sha(await unpack('evidence/sources/tests/pdf-bitmap-display.spec.ts.gz')),
  );
  assert.equal(binding.sourceManifestSha256, sha(await raw('candidate-source-manifest.json')));
  for (const [file, hash] of binding.sources)
    assert.equal(hash, new Map(sources.candidate).get('src/' + file));
  assert.equal(binding.runtimeSha256, sha(JSON.stringify(binding.runtime)));
  assert.deepEqual(
    binding.runtime.filter(([f]) => f !== 'package.json'),
    reports.find((r) => r.label === 'pdf-display-candidate-1').buildManifest,
  );
  assert.equal(
    new Map(binding.runtime).get('package.json'),
    new Map(sources.candidate).get('package.json'),
  );
  if (values['frozen-prefix'])
    for (const [file, hash] of binding.runtime) {
      assert.equal(
        sha(await readFile(inside(resolve(values['frozen-prefix'] + '-candidate'), file))),
        hash,
        file,
      );
      runtimeFiles++;
    }
  nativeBindings++;
}
const pick = async (suffix) => {
  const entry = resultFiles.find((e) => e.file.endsWith('/' + suffix + '.json.gz'));
  assert(entry, suffix);
  return JSON.parse(await unpack(entry.file));
};
const ownership = await pick('ownership'),
  recovery = await pick('recovery'),
  tiles = await pick('tile-thumbnail-recovery');
assert.equal(ownership.checks.length, 16);
assert.equal(ownership.recoveries, 2);
assert.equal(ownership.copies, 4);
assert.equal(recovery.length, 6);
assert.equal(tiles.length, 4);
assert([...recovery, ...tiles].every((r) => r.replaced && r.width > 1 && r.height > 1));
const foreground = manifest.evidence.filter((e) =>
  e.file.startsWith('evidence/results/pdf-display-foreground-native-results/'),
);
const pixels = JSON.parse(
  await unpack(foreground.find((e) => e.file.endsWith('/pixel-comparisons.json.gz')).file),
);
const transient = JSON.parse(
  await unpack(foreground.find((e) => e.file.endsWith('/transient-coverage.json.gz')).file),
);
assert.equal(pixels.length, 10);
assert(pixels.every((p) => p.maximum <= 1 && p.overOne === 0));
assert.equal(transient.length, 48);
assert(transient.every((f) => !f.missingInk && !f.missingObjects.length));
if (values['production-root'])
  for (const [file, hash] of sources[manifest.decision.productionSide]) {
    assert.equal(sha(await readFile(inside(resolve(values['production-root']), file))), hash, file);
    productionFiles++;
  }
console.log(
  JSON.stringify({
    passed: true,
    reports: reports.length,
    evidence: manifest.evidence.length,
    sourceFiles: sources.before.length + sources.candidate.length,
    runtimeFiles,
    pixelPairs: quality.checks.length,
    outputChecks: output.checks.length,
    nativeBindings,
    ownershipChecks: ownership.checks.length,
    recoveryChecks: recovery.length + tiles.length,
    foregroundPixels: pixels.length,
    firstFrameChecks: transient.length,
    productionFiles,
  }),
);
