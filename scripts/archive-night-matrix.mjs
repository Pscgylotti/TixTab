import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { demandModel, requireComparable, cpuIntervals, quantiles } from './performance-demand.mjs';

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    verify: { type: 'string' },
    decision: { type: 'string' },
    'frozen-prefix': { type: 'string' },
    'quality-source': { type: 'string' },
  },
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sides = ['before', 'candidate'],
  profiles = ['scanned', 'vector', 'objects'];
if (!!values.output === !!values.verify) throw Error('Supply either fresh --output or --verify');
const root = resolve(values.output ?? values.verify);
let manifest,
  blobs = new Map();
if (values.output) {
  assert(['retained', 'rejected'].includes(values.decision));
  await mkdir(root);
  await mkdir(join(root, 'objects'));
  manifest = {
    schema: 1,
    decision: values.decision,
    files: {},
    builds: {},
    sources: {},
    externalRuntime: {},
  };
  const add = async (name, bytes) => {
    assert(!manifest.files[name], 'Duplicate evidence name');
    const rawSha256 = sha(bytes),
      blob = `objects/${rawSha256}.gz`;
    if (!blobs.has(blob)) {
      const compressed = gzipSync(bytes, { level: 9 });
      await writeFile(join(root, blob), compressed, { flag: 'wx' });
      blobs.set(blob, sha(compressed));
    }
    manifest.files[name] = { rawSha256, bytes: bytes.length, blob, sha256: blobs.get(blob) };
  };
  for (const side of sides) {
    const frozen = resolve(`.cache/performance-night-matrix-${side}`);
    const sourceBytes = await readFile(join(frozen, 'SOURCE-MANIFEST.json'));
    manifest.sources[side] = JSON.parse(sourceBytes);
    await add(`source/${side}/SOURCE-MANIFEST.json`, sourceBytes);
    for (const [file, hash] of manifest.sources[side]) {
      const bytes = await readFile(join(frozen, 'source', file));
      assert.equal(sha(bytes), hash);
      await add(`source/${side}/${file}`, bytes);
    }
    const quality = JSON.parse(await readFile(`.cache/night-matrix-quality-${side}.json`));
    assert.equal(quality.sourceManifestSha256, sha(sourceBytes));
    await add(`quality/${side}.json`, Buffer.from(JSON.stringify(quality)));
    for (const check of quality.checks)
      for (const image of check.images)
        await add(
          `quality/${side}/${image.file}`,
          await readFile(`.cache/night-matrix-quality-${side}-pixels/${image.file}`),
        );
    for (const profile of profiles)
      for (let round = 1; round <= 3; round++) {
        const name = `night-matrix-${profile}-${side}-${round}`;
        const reportBytes = await readFile(`.cache/${name}.json`),
          report = JSON.parse(reportBytes);
        await add(`runs/${name}.json`, reportBytes);
        await add(`runs/${name}.log`, await readFile(`.cache/${name}.log`));
        if (manifest.builds[side]) assert.deepEqual(manifest.builds[side], report.buildManifest);
        else manifest.builds[side] = report.buildManifest;
      }
    for (const [file, hash] of manifest.builds[side]) {
      const bytes = await readFile(join(frozen, file));
      assert.equal(sha(bytes), hash);
      if (file.startsWith('dist/models/') || file.startsWith('dist/ort/') || file.endsWith('.wasm'))
        manifest.externalRuntime[`runtime/${side}/${file}`] = {
          sha256: hash,
          bytes: bytes.length,
          reason:
            'Unchanged downloaded model/runtime; hash reference only, not redistributed in measurement archive.',
        };
      else await add(`runtime/${side}/${file}`, bytes);
    }
    assert.equal(
      sha(await readFile(join(frozen, 'package.json'))),
      new Map(manifest.sources[side]).get('package.json'),
    );
    await add(`runtime/${side}/package.json`, await readFile(join(frozen, 'package.json')));
    await add(
      `source/${side}/control-description.json`,
      await readFile(join(frozen, 'control-description.json')),
    );
  }
  for (const profile of profiles) {
    for (const suffix of ['.tixtab', '.tixtab.json'])
      await add(
        `fixtures/${profile}${suffix}`,
        await readFile(`.cache/performance-inputs-night-matrix/${profile}${suffix}`),
      );
    for (const suffix of ['json', 'log'])
      await add(
        `discovery/${profile}.${suffix}`,
        await readFile(`.cache/night-matrix-${profile}-discovery.${suffix}`),
      );
    for (const suffix of ['json', 'md'])
      await add(
        `comparison/${profile}.${suffix}`,
        await readFile(`.cache/night-matrix-${profile}-comparison.${suffix}`),
      );
  }
  for (const file of [
    'scripts/benchmark-workflow.mjs',
    'scripts/performance-settle.mjs',
    'scripts/performance-demand.mjs',
    'scripts/performance-fixture.mjs',
    'scripts/performance-matrix-fixture.mjs',
    'scripts/prepare-performance-matrix.mjs',
    'scripts/build-night-control.mjs',
    'scripts/verify-night-matrix.mjs',
    'scripts/compare-workflows.mjs',
    'scripts/archive-night-matrix.mjs',
    'scripts/verify-performance-fixtures.mjs',
  ])
    await add(
      `tools/${file}`,
      await readFile(
        file === 'scripts/verify-night-matrix.mjs' && values['quality-source']
          ? values['quality-source']
          : file,
      ),
    );
  for (const [name, file] of [
    ['unit.log', '.cache/night-colors-fast-path-unit.log'],
    ['types.log', '.cache/night-colors-fast-path-types.log'],
    ['fixtures.log', '.cache/night-matrix-inputs.log'],
    ['fixture-validation.log', '.cache/night-matrix-fixture-validation.log'],
    ...sides.flatMap((side) => [
      [`quality-${side}.log`, `.cache/night-matrix-quality-${side}.log`],
      [`build-${side}.log`, `.cache/night-matrix-build-${side}.log`],
    ]),
  ])
    await add(`logs/${name}`, await readFile(file));
  const readme = await readFile('.cache/night-matrix-README.md');
  await add('README.md', readme);
  await writeFile(join(root, 'README.md'), readme, { flag: 'wx' });
  await writeFile(join(root, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
} else manifest = JSON.parse(await readFile(join(root, 'MANIFEST.json')));

const loaded = new Map();
async function read(name) {
  const entry = manifest.files[name];
  assert(entry, `Missing ${name}`);
  assert(/^objects\/[0-9a-f]{64}\.gz$/.test(entry.blob));
  if (!loaded.has(entry.blob)) {
    const bytes = await readFile(join(root, entry.blob));
    assert.equal(sha(bytes), entry.sha256);
    const raw = gunzipSync(bytes);
    assert.equal(sha(raw), entry.rawSha256);
    assert.equal(raw.length, entry.bytes);
    loaded.set(entry.blob, raw);
  }
  const raw = loaded.get(entry.blob);
  assert.equal(sha(raw), entry.rawSha256);
  assert.equal(raw.length, entry.bytes);
  return raw;
}
for (const name of Object.keys(manifest.files)) await read(name);
assert.equal(sha(await readFile(join(root, 'README.md'))), sha(await read('README.md')));
const json = async (name) => JSON.parse(await read(name));
const changed = manifest.sources.before
  .filter(([file, hash]) => new Map(manifest.sources.candidate).get(file) !== hash)
  .map(([file]) => file);
assert.deepEqual(changed, ['src/pdfNightColors.ts']);
assert.deepEqual(
  manifest.sources.before.map(([p]) => p),
  manifest.sources.candidate.map(([p]) => p),
);
let actualRuntimeFilesVerified = 0;
for (const side of sides) {
  assert.deepEqual(await json(`source/${side}/SOURCE-MANIFEST.json`), manifest.sources[side]);
  for (const [file, hash] of manifest.sources[side])
    assert.equal(sha(await read(`source/${side}/${file}`)), hash);
  for (const [file, hash] of manifest.builds[side]) {
    const name = `runtime/${side}/${file}`;
    if (manifest.files[name]) assert.equal(sha(await read(name)), hash);
    else {
      assert.equal(manifest.externalRuntime[name].sha256, hash);
      assert.equal(
        new Map(manifest.builds[side === 'before' ? 'candidate' : 'before']).get(file),
        hash,
      );
    }
    if (values['frozen-prefix']) {
      const bytes = await readFile(resolve(values['frozen-prefix'] + '-' + side, file));
      assert.equal(sha(bytes), hash);
      if (manifest.externalRuntime[name])
        assert.equal(bytes.length, manifest.externalRuntime[name].bytes);
      actualRuntimeFilesVerified++;
    }
  }
}
let reportsChecked = 0;
for (const profile of profiles) {
  const description = await json(`fixtures/${profile}.tixtab.json`),
    fixture = await read(`fixtures/${profile}.tixtab`);
  assert.equal(sha(fixture), description.sha256);
  assert.equal(fixture.length, description.bytes);
  assert.equal(
    description.generatorSha256,
    sha(await read('tools/scripts/performance-matrix-fixture.mjs')),
  );
  assert.equal(JSON.parse(fixture).pages.length, 16);
  const reports = [];
  for (const side of sides)
    for (let round = 1; round <= 3; round++) {
      const r = await json(`runs/night-matrix-${profile}-${side}-${round}.json`);
      assert.deepEqual(r.fixture, description);
      assert.deepEqual(r.errors, []);
      assert.equal(r.rows.length, 11);
      assert(r.completionGate.enabled);
      for (const row of r.rows) {
        assert.equal(row.completionAfter.pending, 0);
        for (const checkpoint of row.checkpoints) assert.equal(checkpoint.ledger.pending, 0);
      }
      assert.equal(r.counterWarmup.stablePairs, 2);
      assert(r.counterWarmup.samples.at(-1).at < r.samples[0].at);
      assert(
        cpuIntervals(r.counterWarmup.samples.slice(-3)).every((interval) => !interval.unmatched),
      );
      assert.equal(demandModel(r).unmatchedProcessIntervals, 0);
      assert.deepEqual(r.buildManifest, manifest.builds[side]);
      assert.equal(r.buildSha256, sha(JSON.stringify(r.buildManifest)));
      const harness = createHash('sha256');
      for (const file of r.harnessFiles) harness.update(await read(`tools/${file}`));
      assert.equal(harness.digest('hex'), r.harnessSha256);
      reports.push(r);
      reportsChecked++;
    }
  requireComparable(reports);
  const comparison = await json(`comparison/${profile}.json`);
  for (const side of sides) {
    const group = reports.filter((r) => r.label.includes(`-${side}-`));
    assert.equal(group.length, 3);
    const rows = comparison[side === 'before' ? 'baseline' : side].runs;
    assert.equal(rows.length, 3);
    for (let i = 0; i < 3; i++) assert.deepEqual(rows[i].demand, demandModel(group[i]));
    const summary = comparison[side === 'before' ? 'baseline' : side];
    assert.deepEqual(
      summary.cpuSeconds,
      quantiles(group.map((r) => demandModel(r).totalCpuSeconds)),
    );
    assert.deepEqual(summary.elapsedMs, quantiles(group.map((r) => demandModel(r).elapsedMs)));
    const fields = {
      cpuSeconds: (r) => r.cpuSeconds,
      wallMs: (r) => r.wallMs,
      mainThreadSeconds: (r) => r.mainThreadSeconds,
      frameP95Ms: (r) => r.framesMs.p95,
      frameP99Ms: (r) => r.framesMs.p99,
      frameMaxMs: (r) => r.framesMs.max,
      longTasksMaxMs: (r) => r.longTasksMs.max,
    };
    for (const phase of summary.phases)
      for (const [field, select] of Object.entries(fields))
        assert.deepEqual(
          phase[field],
          quantiles(group.map((r) => select(r.rows.find((row) => row.name === phase.name)))),
        );
  }
}
const a = await json('quality/before.json'),
  b = await json('quality/candidate.json');
assert.deepEqual(a.fixtures, b.fixtures);
assert.equal(a.harnessSha256, b.harnessSha256);
assert.equal(a.harnessSha256, sha(await read('tools/scripts/verify-night-matrix.mjs')));
assert.deepEqual(a.errors, []);
assert.deepEqual(b.errors, []);
assert.equal(a.checks.length, 27);
assert.deepEqual(a.checks, b.checks);
let canvases = 0;
const decoded = new Map();
for (const [side, report] of [
  ['before', a],
  ['candidate', b],
]) {
  assert.equal(report.sourceManifestSha256, sha(await read(`source/${side}/SOURCE-MANIFEST.json`)));
  for (const check of report.checks)
    for (const image of check.images) {
      const png = await read(`quality/${side}/${image.file}`);
      assert.equal(sha(png), image.pngSha256);
      if (!decoded.has(image.pngSha256)) {
        const { data, info } = await sharp(png)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        decoded.set(image.pngSha256, { hash: sha(data), width: info.width, height: info.height });
      }
      assert.deepEqual(decoded.get(image.pngSha256), {
        hash: image.rgbaSha256,
        width: image.width,
        height: image.height,
      });
      canvases++;
    }
}
console.log(
  JSON.stringify({
    passed: true,
    decision: manifest.decision,
    reports: reportsChecked,
    configurations: a.checks.length,
    strictCanvasPairs: canvases / 2,
    sourceFiles: sides.reduce((n, s) => n + manifest.sources[s].length, 0),
    runtimeFiles: sides.reduce((n, s) => n + manifest.builds[s].length, 0),
    externalRuntimeReferences: Object.keys(manifest.externalRuntime).length,
    actualRuntimeFilesVerified,
    files: Object.keys(manifest.files).length,
    uniqueBlobs: loaded.size,
  }),
);
