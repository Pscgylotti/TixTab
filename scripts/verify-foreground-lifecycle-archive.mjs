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
const temp = await mkdtemp(join(tmpdir(), 'tixtab-foreground-lifecycle-archive-'));
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
  recorded = JSON.parse(await unpack('evidence/foreground-lifecycle-quality-comparison.json.gz'));
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
  recordedOutput = JSON.parse(await unpack('evidence/foreground-lifecycle-output-quality.json.gz'));
for (const key of ['fixtureSha256', 'modelSha256', 'harnessSha256'])
  assert.equal(output[key], recordedOutput[key]);
assert.equal(
  output.harnessSha256,
  sha(await unpack('evidence/sources/scripts/verify-reading-scale-output.mjs.gz')),
);
const withoutPath = ({ report, ...rest }) => rest;
assert.deepEqual(output.checks.map(withoutPath), recordedOutput.checks.map(withoutPath));
const idle = JSON.parse(await unpack('evidence/foreground-lifecycle-idle.json.gz'));
assert.equal(idle.length, 6);
for (const entry of idle) {
  const report = reports.find(
    (r) => r.label === `foreground-lifecycle-${entry.group}-${entry.round}`,
  );
  const row = report.rows.find((r) => r.name === 'idle-tail');
  assert.deepEqual(entry, {
    group: entry.group,
    round: entry.round,
    cpuSeconds: row.cpuSeconds,
    byType: row.cpuByType,
    mainThreadSeconds: row.mainThreadSeconds,
    ledgerBefore: row.completionBefore.revision,
    ledgerAfter: row.completionAfter.revision,
    foregroundBefore: row.completionBefore.stages['foreground-view'].completed,
    foregroundAfter: row.completionAfter.stages['foreground-view'].completed,
  });
}
const lifecycleFiles = manifest.evidence.filter(
  (e) =>
    e.file.startsWith('evidence/results/foreground-lifecycle-candidate-test-results/') &&
    e.file.endsWith('/lifecycle.json.gz'),
);
assert.equal(lifecycleFiles.length, 1);
const lifecycle = JSON.parse(await unpack(lifecycleFiles[0].file));
assert.equal(
  lifecycle.sourceSha256,
  new Map(sources.candidate).get('src/useForegroundViewport.ts'),
);
assert.equal(lifecycle.checks.length, 5);
for (const check of lifecycle.checks) {
  assert(check.reads > 0);
  assert.equal(check.frames.length, 3);
  assert(check.frames.every((f) => !f.missing.length));
}
for (const key of ['inactive', 'idle', 'teardown']) assert.equal(lifecycle[key], 0);
const nativeFiles = manifest.evidence.filter((e) =>
  e.file.startsWith('evidence/results/foreground-lifecycle-native-results/'),
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
let nativeLifecycleChecks = 0;
for (const group of ['before', 'candidate']) {
  for (const version of ['v1', 'v2']) {
    const r = JSON.parse(
      await unpack('evidence/foreground-lifecycle-' + group + '-native-' + version + '.json.gz'),
    );
    assert(r.passed);
    assert.deepEqual(r.errors, []);
    assert.equal(r.checks.length, version === 'v1' ? 10 : 11);
    assert.equal(r.sourceManifestSha256, sha(await raw(group + '-source-manifest.json')));
    assert.equal(
      r.harnessSha256,
      sha(
        await unpack(
          version === 'v1'
            ? 'evidence/foreground-lifecycle-native-v1.mjs.gz'
            : 'evidence/sources/scripts/verify-foreground-lifecycle-native.mjs.gz',
        ),
      ),
    );
    assert.equal(
      r.settleSha256,
      sha(await unpack('evidence/sources/scripts/performance-settle.mjs.gz')),
    );
    assert.equal(r.fixtureSha256, sha(await unpack('fixtures/objects.tixtab.gz')));
    assert.equal(r.buildSha256, sha(JSON.stringify(r.buildManifest)));
    assert.deepEqual(
      r.buildManifest.filter(([file]) => file !== 'package.json'),
      reports.find((x) => x.label.includes(group + '-')).buildManifest,
    );
    assert.equal(
      new Map(r.buildManifest).get('package.json'),
      new Map(sources[group]).get('package.json'),
    );
    for (const check of r.checks) {
      const expected = check.label.endsWith('-old-disposed')
        ? 0
        : group === 'before' && ['return-single', 'return-single-again'].includes(check.label)
          ? 0
          : 1;
      assert.equal(check.expected, expected);
      assert.equal(check.delta, expected);
      nativeLifecycleChecks++;
    }
    if (values['frozen-prefix'])
      for (const [file, hash] of r.buildManifest) {
        assert.equal(
          sha(await readFile(inside(resolve(values['frozen-prefix'] + '-' + group), file))),
          hash,
        );
        runtimeFiles++;
      }
  }
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
    lifecycleFrameChecks: lifecycle.checks.reduce((sum, c) => sum + c.frames.length, 0),
    nativePixelChecks: native.length,
    firstFrameChecks: transient.length,
    nativeLifecycleChecks,
    productionSide: manifest.decision.productionSide,
    productionFiles,
  }),
);
