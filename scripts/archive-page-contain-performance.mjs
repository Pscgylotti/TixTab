import { readFile, writeFile, mkdir, readdir, mkdtemp } from 'node:fs/promises';
import { resolve, join, dirname, basename, relative, isAbsolute } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { requireComparable, demandModel } from './performance-demand.mjs';
const { values } = parseArgs({ options: { mode: { type: 'string', default: 'create' } } });
assert(['create', 'verify'].includes(values.mode));
const root = resolve('docs/performance/2026-10-13-page-contain-performance');
const parent = resolve('docs/performance/2026-10-13-page-contain-quality');
const background = join(parent, 'diagnostics/background');
const baselineArchive = resolve('docs/performance/2026-10-13-pdf-display');
const qualityManifest = JSON.parse(await readFile(join(parent, 'MANIFEST.json')));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const safe = (base, file) => {
  const p = resolve(base, file),
    r = relative(base, p);
  assert(r && !r.startsWith('..') && !isAbsolute(r));
  return p;
};
const slots = ['before-1', 'candidate-1', 'candidate-2', 'before-2', 'before-3', 'candidate-3'];
async function files(dir, prefix = '') {
  const rows = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (e.isDirectory()) rows.push(...(await files(join(dir, e.name), prefix + e.name + '/')));
    else if (e.isFile()) rows.push(prefix + e.name);
  }
  return rows;
}
const helpers = [
  'scripts/archive-page-contain-performance.mjs',
  'scripts/benchmark-workflow.mjs',
  'scripts/performance-settle.mjs',
  'scripts/performance-demand.mjs',
  'scripts/performance-fixture.mjs',
  'scripts/object-workflow.mjs',
  'scripts/compare-workflows.mjs',
  'scripts/verify-reading-scale-output.mjs',
  'tests/foreground-culling.spec.ts',
  'tests/selection-start.spec.ts',
];
if (values.mode === 'create') {
  await mkdir(root);
  const decision = JSON.parse(await readFile('.cache/page-contain-decision.json'));
  assert(['before', 'candidate'].includes(decision.productionSide));
  const manifest = {
    schema: 1,
    decision,
    parentManifestSha256: sha(await readFile(join(parent, 'MANIFEST.json'))),
    backgroundManifestSha256: sha(await readFile(join(background, 'MANIFEST.json'))),
    baselineManifestSha256: sha(await readFile(join(baselineArchive, 'MANIFEST.json'))),
    evidence: [],
    reports: [],
    order: slots,
  };
  async function add(file, bytes) {
    const packed = gzipSync(bytes, { level: 9 });
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), packed, { flag: 'wx' });
    manifest.evidence.push({ file, sha256: sha(packed), rawSha256: sha(bytes) });
  }
  const reports = [];
  for (const slot of slots) {
    const raw = await readFile(`.cache/page-contain-${slot}.json`),
      report = JSON.parse(raw);
    requireComparable([report]);
    assert.equal(report.rows.length, 16);
    assert.equal(demandModel(report).unmatchedProcessIntervals, 0);
    assert.deepEqual(report.errors, []);
    const side = slot.startsWith('before') ? 'baseline' : 'candidate';
    assert.deepEqual(
      report.buildManifest,
      qualityManifest.runtime[side].filter(([p]) => p !== 'package.json'),
    );
    reports.push(report);
    manifest.reports.push({
      slot,
      reportSha256: sha(raw),
      buildSha256: report.buildSha256,
      harnessSha256: report.harnessSha256,
    });
    await add(`reports/${slot}.json.gz`, raw);
    await add(`logs/${slot}.log.gz`, await readFile(`.cache/page-contain-${slot}.log`));
    for (const item of report.objectDownloads) {
      const bytes = await readFile(item.path);
      assert.equal(sha(bytes), item.sha256);
      await add(`outputs/${slot}/${basename(item.path)}.gz`, bytes);
    }
  }
  requireComparable(reports);
  for (const side of ['baseline', 'candidate']) {
    const frozen = resolve(
      `.cache/performance-page-contain-${side === 'baseline' ? 'before' : 'candidate'}`,
    );
    for (const [p, h] of qualityManifest.runtime[side])
      assert.equal(sha(await readFile(join(frozen, p))), h);
    for (const [p, h] of qualityManifest.sources[side])
      assert.equal(sha(await readFile(join(frozen, 'source', p))), h);
  }
  const production =
    qualityManifest.sources[decision.productionSide === 'before' ? 'baseline' : 'candidate'];
  for (const [p, h] of production) assert.equal(sha(await readFile(p)), h);
  for (const file of helpers) await add('sources/' + file + '.gz', await readFile(file));
  for (const [file, input] of [
    ['inputs.json.gz', '.cache/page-contain-series-inputs.json'],
    ['launcher.ps1.gz', '.cache/run-page-contain-series.ps1'],
    ['preflight.mjs.gz', '.cache/preflight-page-contain-series.mjs'],
    ['preflight.log.gz', '.cache/page-contain-series-preflight.log'],
    ['acceptance.md.gz', '.cache/page-contain-acceptance.md'],
    ['resource-summary.json.gz', '.cache/page-contain-resource-summary.json'],
    ['resource-summary.log.gz', '.cache/page-contain-resource-summary.log'],
    ['summarize.mjs.gz', '.cache/summarize-page-contain.mjs'],
    ['decision.json.gz', '.cache/page-contain-decision.json'],
    ['comparison.json.gz', '.cache/page-contain-comparison.json'],
    ['comparison.md.gz', '.cache/page-contain-comparison.md'],
    ['comparison.log.gz', '.cache/page-contain-comparison.log'],
    ['output-quality.json.gz', '.cache/page-contain-output-quality.json'],
    ['output-quality.log.gz', '.cache/page-contain-output-quality.log'],
    ['functional.json.gz', '.cache/page-contain-functional.json'],
    ['functional.log.gz', '.cache/page-contain-functional.log'],
    ['functional.config.mjs.gz', '.cache/page-contain-functional.config.mjs'],
    ['typecheck.log.gz', '.cache/page-contain-typecheck.log'],
  ])
    await add(file, await readFile(input));
  for (const file of await files('.cache/page-contain-functional'))
    await add(
      `functional/${file}.gz`,
      await readFile(join('.cache/page-contain-functional', file)),
    );
  const readme = await readFile('.cache/page-contain-performance-README.md');
  await writeFile(join(root, 'README.md'), readme, { flag: 'wx' });
  manifest.readmeSha256 = sha(readme);
  await writeFile(join(root, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      created: true,
      evidence: manifest.evidence.length,
      runs: reports.length,
      productionSide: decision.productionSide,
    }),
  );
} else {
  const manifest = JSON.parse(await readFile(join(root, 'MANIFEST.json')));
  for (const [key, dir] of [
    ['parentManifestSha256', parent],
    ['backgroundManifestSha256', background],
    ['baselineManifestSha256', baselineArchive],
  ])
    assert.equal(manifest[key], sha(await readFile(join(dir, 'MANIFEST.json'))));
  assert.equal(manifest.readmeSha256, sha(await readFile(join(root, 'README.md'))));
  assert.deepEqual(manifest.order, slots);
  const temporary = await mkdtemp(join(tmpdir(), 'tixtab-page-contain-performance-'));
  for (const e of manifest.evidence) {
    const packed = await readFile(safe(root, e.file));
    assert.equal(sha(packed), e.sha256);
    const raw = gunzipSync(packed);
    assert.equal(sha(raw), e.rawSha256);
    const target = safe(temporary, e.file.replace(/\.gz$/, ''));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, raw);
  }
  for (const file of helpers)
    assert.equal(sha(await readFile(file)), sha(await readFile(join(temporary, 'sources', file))));
  const reports = [];
  for (const slot of slots) {
    const raw = await readFile(join(temporary, `reports/${slot}.json`)),
      r = JSON.parse(raw),
      entry = manifest.reports.find((e) => e.slot === slot);
    assert.equal(sha(raw), entry.reportSha256);
    assert.equal(r.buildSha256, entry.buildSha256);
    assert.equal(r.harnessSha256, entry.harnessSha256);
    reports.push(r);
    assert.equal(r.rows.length, 16);
    assert.equal(demandModel(r).unmatchedProcessIntervals, 0);
    assert.deepEqual(r.errors, []);
    for (const item of r.objectDownloads)
      assert.equal(
        sha(await readFile(join(temporary, 'outputs', slot, basename(item.path)))),
        item.sha256,
      );
  }
  requireComparable(reports);
  const inputs = JSON.parse(await readFile(join(temporary, 'inputs.json')));
  assert.equal(inputs.launcherSha256, sha(await readFile(join(temporary, 'launcher.ps1'))));
  assert.equal(inputs.preflightSha256, sha(await readFile(join(temporary, 'preflight.mjs'))));
  const harness = createHash('sha256');
  for (const [file, hash] of inputs.harnessFiles) {
    const raw = await readFile(join(temporary, 'sources', file));
    assert.equal(sha(raw), hash);
    harness.update(raw);
  }
  assert.equal(harness.digest('hex'), inputs.harnessSha256);
  assert(
    reports.every(
      (r) => r.harnessSha256 === inputs.harnessSha256 && r.fixture.sha256 === inputs.fixtureSha256,
    ),
  );
  const functional = JSON.parse(await readFile(join(temporary, 'functional.json')));
  assert.equal(functional.stats.expected, 2);
  assert.equal(functional.stats.unexpected, 0);
  assert.equal(functional.stats.skipped, 0);
  const comparison = JSON.parse(await readFile(join(temporary, 'comparison.json')));
  const comparisonArgs = [
    'scripts/compare-workflows.mjs',
    '--output',
    join(temporary, 'recomputed-comparison.json'),
  ];
  for (const slot of slots)
    comparisonArgs.push(
      slot.startsWith('before') ? '--baseline' : '--candidate',
      join(temporary, `reports/${slot}.json`),
    );
  const comparisonRun = spawnSync(process.execPath, comparisonArgs, { encoding: 'utf8' });
  assert.equal(comparisonRun.status, 0, comparisonRun.stdout + '\n' + comparisonRun.stderr);
  const stripComparison = ({ createdAt, source, ...rest }) => rest;
  assert.deepEqual(
    stripComparison(JSON.parse(await readFile(join(temporary, 'recomputed-comparison.json')))),
    stripComparison(comparison),
  );
  for (const [group, side] of [
    ['baseline', 'before'],
    ['candidate', 'candidate'],
  ])
    for (const run of comparison[group].runs) {
      const r = reports.find((r) => r.label === run.label);
      assert(r);
      assert.deepEqual(run.demand, demandModel(r));
      assert.equal(run.buildSha256, r.buildSha256);
      assert(r.label.startsWith('page-contain-' + side + '-'));
    }
  for (const side of ['baseline', 'candidate']) {
    const frozen = resolve(
      `.cache/performance-page-contain-${side === 'baseline' ? 'before' : 'candidate'}`,
    );
    for (const [p, h] of qualityManifest.runtime[side])
      assert.equal(sha(await readFile(join(frozen, p))), h);
  }
  for (const [p, h] of qualityManifest.sources[
    manifest.decision.productionSide === 'before' ? 'baseline' : 'candidate'
  ])
    assert.equal(sha(await readFile(p)), h);
  const bindings = (await files(join(temporary, 'functional'))).filter((p) =>
    p.endsWith('native-selection-binding.json'),
  );
  assert.equal(bindings.length, 1);
  const binding = JSON.parse(await readFile(join(temporary, 'functional', bindings[0])));
  assert.deepEqual(binding.runtime, qualityManifest.runtime.candidate);
  assert.deepEqual(binding.errors, []);
  assert(binding.contain.length && binding.contain.every((c) => c === 'layout style'));
  assert.equal(binding.harnessSha256, sha(await readFile('tests/selection-start.spec.ts')));
  const pixelFile = (await files(join(temporary, 'functional'))).find((p) =>
    p.endsWith('pixel-comparisons.json'),
  );
  const pixels = JSON.parse(await readFile(join(temporary, 'functional', pixelFile)));
  assert.equal(pixels.length, 10);
  assert(pixels.every((p) => p.maximum <= 1 && p.overOne === 0));
  const transientFile = (await files(join(temporary, 'functional'))).find((p) =>
    p.endsWith('transient-coverage.json'),
  );
  const transient = JSON.parse(await readFile(join(temporary, 'functional', transientFile)));
  assert.equal(transient.length, 48);
  assert(transient.every((p) => !p.missingObjects.length && !p.missingInk));
  const fixture = join(temporary, 'objects.tixtab');
  for (const ext of ['tixtab', 'tixtab.json'])
    await writeFile(
      join(temporary, 'objects.' + ext),
      gunzipSync(await readFile(join(baselineArchive, 'fixtures/objects.' + ext + '.gz'))),
    );
  const recorded = JSON.parse(await readFile(join(temporary, 'output-quality.json'))),
    checks = [];
  for (const slot of slots) {
    const output = join(temporary, `quality-${slot}.json`);
    const r = spawnSync(
      process.execPath,
      [
        'scripts/verify-reading-scale-output.mjs',
        '--report',
        join(temporary, `reports/${slot}.json`),
        '--fixture-file',
        fixture,
        '--model',
        '.cache/performance-page-contain-candidate/source/src/model.ts',
        '--artifact-dir',
        join(temporary, 'outputs', slot),
        '--output',
        output,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stdout + '\n' + r.stderr);
    const q = JSON.parse(await readFile(output));
    for (const key of ['fixtureSha256', 'modelSha256', 'harnessSha256'])
      assert.equal(q[key], recorded[key]);
    checks.push(...q.checks);
  }
  const noPath = ({ report, ...rest }) => rest;
  assert.deepEqual(
    checks.map(noPath).sort((a, b) => a.reportSha256.localeCompare(b.reportSha256)),
    recorded.checks.map(noPath).sort((a, b) => a.reportSha256.localeCompare(b.reportSha256)),
  );
  assert.equal(new Set(checks.map((c) => c.pdfGraphWithoutDatesSha256)).size, 1);
  console.log(
    JSON.stringify({
      verified: true,
      evidence: manifest.evidence.length,
      runs: reports.length,
      runtime: 616,
      outputs: checks.length,
      foregroundPixels: pixels.length,
      fastFrames: transient.length,
      productionSide: manifest.decision.productionSide,
    }),
  );
}
