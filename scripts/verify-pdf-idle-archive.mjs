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
    'src/pdfRenderCache.ts',
  ]),
);
const temp = await mkdtemp(join(tmpdir(), 'tixtab-pdf-idle-archive-'));
let runtimeFiles = 0,
  pixelPairs = 0,
  nativeChecks = 0,
  productionFiles = 0;
const reports = [];
for (const entry of manifest.entries) {
  const report = JSON.parse(await unpack(entry.file));
  reports.push(report);
  if (values['frozen-prefix']) {
    const group = entry.file.startsWith('before-') ? 'before' : 'candidate';
    for (const [file, hash] of report.buildManifest) {
      assert.equal(
        sha(await readFile(inside(resolve(values['frozen-prefix'] + '-' + group + '-v2'), file))),
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
  const native = JSON.parse(await unpack(`native/${group}.json.gz`));
  assert.equal(native.sourceManifestSha256, quality.sourceManifestSha256);
  assert.equal(
    native.harnessSha256,
    sha(await unpack('evidence/sources/scripts/verify-pdf-idle-native.mjs.gz')),
  );
  assert.equal(native.fixture.sha256, sha(await unpack('fixtures/matrix/vector.tixtab.gz')));
  assert.deepEqual(native.errors, []);
  assert.deepEqual(
    native.checks.map((c) => c.scenario),
    ['release', 'cancel', 'lost-capture', 'stale-contact', 'hidden-restore'],
  );
  for (const c of native.checks) {
    assert.equal(c.during.stages['pdf-raster'].completed, c.before.stages['pdf-raster'].completed);
    assert.equal(c.during.stages['pdf-raster'].pending, 0);
    assert(c.after.ledger.stages['pdf-raster'].completed > c.before.stages['pdf-raster'].completed);
    assert.equal(c.after.ledger.pending, 0);
    assert(c.after.visibleBackgrounds > 0);
    assert(Object.values(c.after.ledger.stages).every((s) => s.failed === 0));
    nativeChecks++;
  }
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
  recorded = JSON.parse(await unpack('evidence/scheduler-idle-quality-comparison.json.gz'));
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
  run('scripts/verify-object-workflow.mjs', [
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
  recordedOutput = JSON.parse(await unpack('evidence/scheduler-idle-output-quality-v2.json.gz'));
for (const key of ['fixtureSha256', 'modelSha256', 'harnessSha256'])
  assert.equal(output[key], recordedOutput[key]);
assert.equal(
  output.harnessSha256,
  sha(await unpack('evidence/sources/scripts/verify-object-workflow.mjs.gz')),
);
const withoutPath = ({ report, ...rest }) => rest;
assert.deepEqual(output.checks.map(withoutPath), recordedOutput.checks.map(withoutPath));
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
    nativeChecks,
    outputChecks: output.checks.length,
    productionSide: manifest.decision.productionSide,
    productionFiles,
  }),
);
