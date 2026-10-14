import { readFile, writeFile, readdir, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, basename, relative, isAbsolute } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { demandModel, requireComparable } from './performance-demand.mjs';

const { values } = parseArgs({ options: { mode: { type: 'string', default: 'verify' } } });
assert(['create', 'verify'].includes(values.mode));
const root = resolve('docs/performance/2026-10-13-pdf-concurrency-ui');
const parent = resolve('docs/performance/2026-10-13-pdf-display');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const safe = (base, file) => {
  const path = resolve(base, file),
    sub = relative(base, path);
  assert(sub && !sub.startsWith('..') && !isAbsolute(sub));
  return path;
};
async function files(dir, prefix = '') {
  const rows = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    assert(!e.isSymbolicLink());
    if (e.isDirectory()) rows.push(...(await files(join(dir, e.name), prefix + e.name + '/')));
    else if (e.isFile()) rows.push(prefix + e.name);
  }
  return rows;
}
const helpers = [
  'scripts/archive-pdf-concurrency.mjs',
  'scripts/build-pdf-concurrency-control.mjs',
  'scripts/benchmark-workflow.mjs',
  'scripts/performance-settle.mjs',
  'scripts/performance-demand.mjs',
  'scripts/performance-fixture.mjs',
  'scripts/object-workflow.mjs',
  'scripts/compare-workflows.mjs',
  'scripts/verify-reading-scale-output.mjs',
  'scripts/verify-night-matrix.mjs',
  'scripts/compare-pdf-quality.mjs',
  'scripts/verify-pdf-idle-native.mjs',
  'tests/foreground-culling.spec.ts',
  'tests/selection-start.spec.ts',
];
const extra = [
  ['inputs.json', '.cache/pdf-concurrency-series-inputs.json'],
  ['launcher.ps1', '.cache/run-pdf-concurrency-series.ps1'],
  ['preflight.mjs', '.cache/preflight-pdf-concurrency-series.mjs'],
  ['preflight.log', '.cache/pdf-concurrency-preflight.log'],
  ['ui-changes.json', '.cache/pdf-concurrency-ui-changes.json'],
  ['ui-audit.mjs', '.cache/audit-ui-performance-base.mjs'],
  ['post-measurement/discovery.json', '.cache/pdf-concurrency-current-source.json'],
  ['post-measurement/snapshot.json', '.cache/pdf-concurrency-current-source-snapshot.json'],
  ['post-measurement/audit.mjs', '.cache/audit-pdf-concurrency-live.mjs'],
  ['post-measurement/audit.log', '.cache/pdf-concurrency-current-source.log'],
  ['failed-create.log', '.cache/pdf-concurrency-archive-create-failed.log'],
  ['failed-create-helper.mjs', '.cache/pdf-concurrency-archive-initial-helper.mjs'],
  ['decision.json', '.cache/pdf-concurrency-decision.json'],
  ['acceptance.json', '.cache/pdf-concurrency-acceptance.json'],
  ['describe.mjs', '.cache/describe-pdf-concurrency.mjs'],
  ['series.log', '.cache/pdf-concurrency-series.log'],
  ['confirmation/series.log', '.cache/pdf-concurrency-series-confirm.log'],
  ['quality-launcher.ps1', '.cache/run-pdf-concurrency-quality.ps1'],
  ['quality-series.log', '.cache/pdf-concurrency-quality-series.log'],
  ['comparison.json', '.cache/pdf-concurrency-comparison-all.json'],
  ['comparison.md', '.cache/pdf-concurrency-comparison-all.md'],
  ['comparison.log', '.cache/pdf-concurrency-comparison-all.log'],
  ['initial/comparison.json', '.cache/pdf-concurrency-comparison.json'],
  ['initial/comparison.md', '.cache/pdf-concurrency-comparison.md'],
  ['initial/comparison.log', '.cache/pdf-concurrency-comparison.log'],
  ['resource-summary.json', '.cache/pdf-concurrency-resource-summary.json'],
  ['resource-summary.log', '.cache/pdf-concurrency-resource-summary.log'],
  ['summarize.mjs', '.cache/summarize-pdf-concurrency.mjs'],
  ['output-quality.json', '.cache/pdf-concurrency-output-quality-all.json'],
  ['output-quality.log', '.cache/pdf-concurrency-output-quality-all.log'],
  ['initial/output-quality.json', '.cache/pdf-concurrency-output-quality.json'],
  ['initial/output-quality.log', '.cache/pdf-concurrency-output-quality.log'],
  ['functional.json', '.cache/pdf-concurrency-functional.json'],
  ['functional.log', '.cache/pdf-concurrency-functional.log'],
  ['functional.config.mjs', '.cache/pdf-concurrency-functional.config.mjs'],
  ['baseline-unit.log', '.cache/pdf-concurrency-baseline-unit.log'],
  ['candidate-unit.log', '.cache/pdf-concurrency-candidate-unit.log'],
  ['types.log', '.cache/pdf-concurrency-types.log'],
  ['frozen-unit.config.mjs', '.cache/pdf-concurrency-frozen-unit.config.mjs'],
  ['frozen-unit.log', '.cache/pdf-concurrency-frozen-unit.log'],
  ['build-before.log', '.cache/pdf-concurrency-build-before.log'],
  ['build-candidate.log', '.cache/pdf-concurrency-build-candidate.log'],
  ['restored-unit.log', '.cache/pdf-concurrency-restored-unit.log'],
  ['restored-types.log', '.cache/pdf-concurrency-restored-types.log'],
  ['acceptance.md', '.cache/pdf-concurrency-acceptance.md'],
  ['confirmation/inputs.json', '.cache/pdf-concurrency-confirm-inputs.json'],
  ['confirmation/launcher.ps1', '.cache/run-pdf-concurrency-series-confirm.ps1'],
  ['confirmation/preflight.mjs', '.cache/preflight-pdf-concurrency-confirm.mjs'],
  ['confirmation/preflight.log', '.cache/pdf-concurrency-confirm-preflight.log'],
  ['confirmation/comparison.json', '.cache/pdf-concurrency-comparison-confirm.json'],
  ['confirmation/comparison.md', '.cache/pdf-concurrency-comparison-confirm.md'],
  ['confirmation/comparison.log', '.cache/pdf-concurrency-comparison-confirm.log'],
  ['confirmation/resource-summary.json', '.cache/pdf-concurrency-resource-summary-confirm.json'],
  ['confirmation/resource-summary.log', '.cache/pdf-concurrency-resource-summary-confirm.log'],
  ['confirmation/summarize.mjs', '.cache/summarize-pdf-concurrency-confirm.mjs'],
];

if (values.mode === 'create') {
  const decision = JSON.parse(await readFile('.cache/pdf-concurrency-decision.json'));
  assert([3, 6].includes(decision.runsPerSide));
  assert(['before', 'candidate'].includes(decision.productionSide));
  await mkdir(root);
  const manifest = {
    schema: 1,
    decision,
    parentManifestSha256: sha(await readFile(join(parent, 'MANIFEST.json'))),
    sources: {},
    runtime: {},
    evidence: [],
    reports: [],
  };
  async function add(file, bytes) {
    const packed = gzipSync(bytes, { level: 9 }),
      path = safe(root, file + '.gz');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, packed, { flag: 'wx' });
    manifest.evidence.push({ file: file + '.gz', sha256: sha(packed), rawSha256: sha(bytes) });
  }
  const reports = [];
  for (const side of ['before', 'candidate']) {
    const frozen = resolve(`.cache/performance-pdf-concurrency-ui-${side}`);
    manifest.sources[side] = JSON.parse(await readFile(join(frozen, 'SOURCE-MANIFEST.json')));
    await add(
      `builds/${side}/SOURCE-MANIFEST.json`,
      await readFile(join(frozen, 'SOURCE-MANIFEST.json')),
    );
    await add(
      `builds/${side}/control-description.json`,
      await readFile(join(frozen, 'control-description.json')),
    );
    for (const [p, h] of manifest.sources[side]) {
      const bytes = await readFile(join(frozen, 'source', p));
      assert.equal(sha(bytes), h);
      await add(`sources/${side}/${p}`, bytes);
    }
    for (let n = 1; n <= decision.runsPerSide; n++) {
      const slot = `${side}-${n}`,
        raw = await readFile(`.cache/pdf-concurrency-${slot}.json`),
        r = JSON.parse(raw);
      requireComparable([r]);
      assert.equal(r.rows.length, 16);
      assert.deepEqual(r.errors, []);
      assert.equal(demandModel(r).unmatchedProcessIntervals, 0);
      if (manifest.runtime[side]) assert.deepEqual(r.buildManifest, manifest.runtime[side]);
      else manifest.runtime[side] = r.buildManifest;
      reports.push(r);
      manifest.reports.push({ slot, sha256: sha(raw) });
      await add(`reports/${slot}.json`, raw);
      await add(`logs/${slot}.log`, await readFile(`.cache/pdf-concurrency-${slot}.log`));
      for (const item of r.objectDownloads) {
        const bytes = await readFile(item.path);
        assert.equal(sha(bytes), item.sha256);
        await add(`outputs/${slot}/${basename(item.path)}`, bytes);
      }
    }
    const quality = JSON.parse(await readFile(`.cache/pdf-concurrency-quality-${side}.json`));
    assert.equal(
      quality.sourceManifestSha256,
      sha(await readFile(join(frozen, 'SOURCE-MANIFEST.json'))),
    );
    await add(
      `quality/${side}.json`,
      await readFile(`.cache/pdf-concurrency-quality-${side}.json`),
    );
    await add(`quality/${side}.log`, await readFile(`.cache/pdf-concurrency-quality-${side}.log`));
    for (const file of await files(`.cache/pdf-concurrency-quality-${side}-pixels`))
      await add(
        `quality/${side}-pixels/${file}`,
        await readFile(`.cache/pdf-concurrency-quality-${side}-pixels/${file}`),
      );
  }
  requireComparable(reports);
  const prior = JSON.parse(gunzipSync(await readFile(join(parent, 'candidate-1.json.gz'))));
  const priorRuntime = new Map(prior.buildManifest);
  for (const side of ['before', 'candidate'])
    for (const [p, h] of manifest.runtime[side]) {
      const bytes = await readFile(`.cache/performance-pdf-concurrency-ui-${side}/${p}`);
      assert.equal(sha(bytes), h);
      if (priorRuntime.get(p) !== h) await add(`changed-runtime/${side}/${p}`, bytes);
    }
  // Other authorized work changed UI/render sources while these frozen samples ran.
  // Check our restored policy, preserve that later snapshot, and never claim it was measured.
  assert.equal(decision.productionScope, 'concurrency-policy-only');
  assert.equal(
    sha(await readFile('src/appearance.ts')),
    new Map(manifest.sources.before).get('src/appearance.ts'),
  );
  const later = JSON.parse(await readFile('.cache/pdf-concurrency-current-source-snapshot.json'));
  assert(later.policyRestored && later.changes.length > 0);
  manifest.laterSourceFiles = later.sources.length;
  manifest.laterSourceChanges = later.changes;
  for (const [p, h] of later.sources) {
    const bytes = await readFile(join('.cache/pdf-concurrency-live-source', p));
    assert.equal(sha(bytes), h);
    await add('post-measurement/source/' + p, bytes);
  }
  for (const file of helpers) await add('tools/' + file, await readFile(file));
  for (const [file, input] of extra) await add(file, await readFile(input));
  for (const fixture of ['scanned', 'vector'])
    for (const ext of ['json', 'log'])
      await add(
        `native/${fixture}.${ext}`,
        await readFile(`.cache/pdf-concurrency-native-${fixture}.${ext}`),
      );
  for (const ext of ['json', 'log'])
    await add(
      `quality/comparison.${ext}`,
      await readFile(`.cache/pdf-concurrency-quality-comparison.${ext}`),
    );
  for (const file of await files('.cache/pdf-concurrency-functional'))
    await add('functional/' + file, await readFile('.cache/pdf-concurrency-functional/' + file));
  for (const ext of ['tixtab', 'tixtab.json'])
    await add(
      'fixtures/objects.' + ext,
      await readFile('.cache/performance-inputs-object-edit/objects.' + ext),
    );
  const readme = await readFile('.cache/pdf-concurrency-README.md');
  manifest.readmeSha256 = sha(readme);
  await writeFile(join(root, 'README.md'), readme, { flag: 'wx' });
  await writeFile(join(root, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({ created: true, evidence: manifest.evidence.length, runs: reports.length }),
  );
} else {
  const manifest = JSON.parse(await readFile(join(root, 'MANIFEST.json')));
  assert.equal(manifest.parentManifestSha256, sha(await readFile(join(parent, 'MANIFEST.json'))));
  assert.equal(manifest.readmeSha256, sha(await readFile(join(root, 'README.md'))));
  const temp = await mkdtemp(join(tmpdir(), 'tixtab-pdf-concurrency-archive-'));
  for (const entry of manifest.evidence) {
    const packed = await readFile(safe(root, entry.file));
    assert.equal(sha(packed), entry.sha256);
    const raw = gunzipSync(packed);
    assert.equal(sha(raw), entry.rawSha256);
    const target = safe(temp, entry.file.replace(/\.gz$/, ''));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, raw);
  }
  for (const file of helpers)
    assert.deepEqual(await readFile(file), await readFile(join(temp, 'tools', file)));
  const inputs = JSON.parse(await readFile(join(temp, 'inputs.json'))),
    harness = createHash('sha256');
  for (const [p, h] of inputs.harnessFiles) {
    const bytes = await readFile(join(temp, 'tools', p));
    assert.equal(sha(bytes), h);
    harness.update(bytes);
  }
  assert.equal(harness.digest('hex'), inputs.harnessSha256);
  assert.equal(sha(await readFile(join(temp, 'launcher.ps1'))), inputs.launcherSha256);
  assert.equal(sha(await readFile(join(temp, 'preflight.mjs'))), inputs.preflightSha256);
  assert.deepEqual(inputs.order, ['A1', 'B1', 'B2', 'A2', 'A3', 'B3']);
  const confirmed = JSON.parse(await readFile(join(temp, 'confirmation/inputs.json')));
  assert.equal(confirmed.initialInputsSha256, sha(await readFile(join(temp, 'inputs.json'))));
  assert.equal(confirmed.harnessSha256, inputs.harnessSha256);
  assert.equal(confirmed.fixtureSha256, inputs.fixtureSha256);
  assert.equal(
    confirmed.launcherSha256,
    sha(await readFile(join(temp, 'confirmation/launcher.ps1'))),
  );
  assert.equal(
    confirmed.preflightSha256,
    sha(await readFile(join(temp, 'confirmation/preflight.mjs'))),
  );
  assert.deepEqual(confirmed.order, ['B4', 'A4', 'A5', 'B5', 'B6', 'A6']);
  const a = new Map(manifest.sources.before),
    b = new Map(manifest.sources.candidate);
  assert.deepEqual(
    [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)),
    ['src/appearance.ts'],
  );
  const before = await readFile(join(temp, 'sources/before/src/appearance.ts'), 'utf8');
  assert.equal(
    await readFile(join(temp, 'sources/candidate/src/appearance.ts'), 'utf8'),
    before.replace('concurrency: eco ? 1 : 2,', 'concurrency: 1,'),
  );
  let runtime = 0;
  for (const side of ['before', 'candidate']) {
    const frozen = resolve(`.cache/performance-pdf-concurrency-ui-${side}`);
    for (const [p, h] of manifest.runtime[side]) {
      assert.equal(sha(await readFile(join(frozen, p))), h);
      runtime++;
    }
    for (const [p, h] of manifest.sources[side]) {
      assert.equal(sha(await readFile(join(temp, 'sources', side, p))), h);
      assert.equal(sha(await readFile(join(frozen, 'source', p))), h);
    }
    assert.equal(
      sha(await readFile(join(frozen, 'package.json'))),
      new Map(manifest.sources[side]).get('package.json'),
    );
    runtime++;
  }
  assert.equal(manifest.decision.productionScope, 'concurrency-policy-only');
  assert.equal(
    sha(await readFile('src/appearance.ts')),
    new Map(manifest.sources.before).get('src/appearance.ts'),
  );
  const later = JSON.parse(await readFile(join(temp, 'post-measurement/snapshot.json')));
  assert.equal(later.sources.length, manifest.laterSourceFiles);
  assert.deepEqual(later.changes, manifest.laterSourceChanges);
  assert(later.policyRestored);
  for (const [p, h] of later.sources)
    assert.equal(sha(await readFile(join(temp, 'post-measurement/source', p))), h);
  const reports = [];
  for (const entry of manifest.reports) {
    const raw = await readFile(join(temp, 'reports', entry.slot + '.json')),
      r = JSON.parse(raw);
    assert.equal(sha(raw), entry.sha256);
    assert.deepEqual(r.errors, []);
    assert.equal(r.rows.length, 16);
    assert.equal(r.harnessSha256, inputs.harnessSha256);
    assert.equal(r.fixture.sha256, inputs.fixtureSha256);
    assert.equal(demandModel(r).unmatchedProcessIntervals, 0);
    assert.deepEqual(
      r.buildManifest,
      manifest.runtime[entry.slot.startsWith('before') ? 'before' : 'candidate'],
    );
    for (const item of r.objectDownloads)
      assert.equal(
        sha(await readFile(join(temp, 'outputs', entry.slot, basename(item.path)))),
        item.sha256,
      );
    reports.push(r);
  }
  requireComparable(reports);
  function run(script, args) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + '\n' + r.stderr);
  }
  const comparisonArgs = ['--output', join(temp, 'comparison-recomputed.json')];
  for (const entry of manifest.reports)
    comparisonArgs.push(
      entry.slot.startsWith('before') ? '--baseline' : '--candidate',
      join(temp, 'reports', entry.slot + '.json'),
    );
  run('scripts/compare-workflows.mjs', comparisonArgs);
  const strip = ({ createdAt, source, ...rest }) => rest;
  assert.deepEqual(
    strip(JSON.parse(await readFile(join(temp, 'comparison-recomputed.json')))),
    strip(JSON.parse(await readFile(join(temp, 'comparison.json')))),
  );
  for (const [folder, start, end] of [
    ['initial', 1, 3],
    ['confirmation', 4, 6],
  ]) {
    const args = ['--output', join(temp, folder, 'comparison-recomputed.json')];
    for (const side of ['before', 'candidate'])
      for (let n = start; n <= end; n++)
        args.push(
          side === 'before' ? '--baseline' : '--candidate',
          join(temp, 'reports', `${side}-${n}.json`),
        );
    run('scripts/compare-workflows.mjs', args);
    assert.deepEqual(
      strip(JSON.parse(await readFile(join(temp, folder, 'comparison-recomputed.json')))),
      strip(JSON.parse(await readFile(join(temp, folder, 'comparison.json')))),
    );
  }
  run('scripts/compare-pdf-quality.mjs', [
    '--baseline',
    join(temp, 'quality/before.json'),
    '--candidate',
    join(temp, 'quality/candidate.json'),
    '--output',
    join(temp, 'quality/recomputed.json'),
  ]);
  const qualityStrip = ({ createdAt, baseline, candidate, ...rest }) => rest;
  assert.deepEqual(
    qualityStrip(JSON.parse(await readFile(join(temp, 'quality/recomputed.json')))),
    qualityStrip(JSON.parse(await readFile(join(temp, 'quality/comparison.json')))),
  );
  for (const fixture of ['scanned', 'vector']) {
    const r = JSON.parse(await readFile(join(temp, 'native', fixture + '.json')));
    assert.equal(r.checks.length, 5);
    assert.deepEqual(r.errors, []);
    assert.equal(r.sourceManifestSha256, inputs.builds.candidate.sourceManifestSha256);
  }
  const functional = JSON.parse(await readFile(join(temp, 'functional.json')));
  assert.equal(functional.stats.expected, 2);
  assert.equal(functional.stats.unexpected, 0);
  assert.equal(functional.stats.skipped, 0);
  const attachments = await files(join(temp, 'functional'));
  const pixels = JSON.parse(
    await readFile(
      join(
        temp,
        'functional',
        attachments.find((p) => p.endsWith('pixel-comparisons.json')),
      ),
    ),
  );
  assert.equal(pixels.length, 10);
  assert(pixels.every((p) => p.maximum <= 1 && p.overOne === 0));
  const fast = JSON.parse(
    await readFile(
      join(
        temp,
        'functional',
        attachments.find((p) => p.endsWith('transient-coverage.json')),
      ),
    ),
  );
  assert.equal(fast.length, 48);
  assert(fast.every((p) => !p.missingObjects.length && !p.missingInk));
  const binding = JSON.parse(
    await readFile(
      join(
        temp,
        'functional',
        attachments.find((p) => p.endsWith('native-selection-binding.json')),
      ),
    ),
  );
  assert.deepEqual(
    binding.runtime,
    [
      ...manifest.runtime.candidate,
      ['package.json', new Map(manifest.sources.candidate).get('package.json')],
    ].sort((a, b) => a[0].localeCompare(b[0])),
  );
  assert.deepEqual(binding.errors, []);
  const recorded = JSON.parse(await readFile(join(temp, 'output-quality.json'))),
    checks = [];
  for (const entry of manifest.reports) {
    const output = join(temp, 'output-' + entry.slot + '.json');
    run('scripts/verify-reading-scale-output.mjs', [
      '--report',
      join(temp, 'reports', entry.slot + '.json'),
      '--fixture-file',
      join(temp, 'fixtures/objects.tixtab'),
      '--model',
      join(temp, 'sources/candidate/src/model.ts'),
      '--artifact-dir',
      join(temp, 'outputs', entry.slot),
      '--output',
      output,
    ]);
    const check = JSON.parse(await readFile(output));
    for (const key of ['fixtureSha256', 'modelSha256', 'harnessSha256'])
      assert.equal(check[key], recorded[key]);
    checks.push(...check.checks);
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
      runtime,
      sourceFiles: manifest.sources[manifest.decision.productionSide].length,
      backgroundPairs: JSON.parse(await readFile(join(temp, 'quality/comparison.json'))).checks
        .length,
      nativeRecovery: 10,
      foregroundPositions: pixels.length,
      fastFrames: fast.length,
      outputPairs: checks.length,
      productionSide: manifest.decision.productionSide,
    }),
  );
}
