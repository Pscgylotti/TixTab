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
const root = resolve('docs/performance/2026-10-13-pdf-admission');
const parent = resolve('docs/performance/2026-10-13-pdf-display');
const priorTrace = join(parent, 'diagnostics/frame-budget');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const safe = (base, file) => {
  const p = resolve(base, file),
    r = relative(base, p);
  assert(r && !r.startsWith('..') && !isAbsolute(r));
  return p;
};
const phases = ['facing-zoom', 'continuous-scroll-roundtrip', 'reading-zoom-settle-cycle'];
const tools = [
  'scripts/archive-pdf-admission.mjs',
  'scripts/build-pdf-admission-control.mjs',
  'scripts/benchmark-workflow.mjs',
  'scripts/performance-settle.mjs',
  'scripts/performance-demand.mjs',
  'scripts/performance-fixture.mjs',
  'scripts/object-workflow.mjs',
  'scripts/compare-workflows.mjs',
  'scripts/verify-reading-scale-output.mjs',
  'scripts/verify-pdf-idle-native.mjs',
  'scripts/verify-night-matrix.mjs',
  'scripts/compare-pdf-quality.mjs',
  'scripts/analyze-frame-budget.mjs',
  'scripts/trace-frame-budget.mjs',
  'scripts/trace-intervals.mjs',
  'tests/foreground-culling.spec.ts',
  'tests/selection-start.spec.ts',
];
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
const priorReport = JSON.parse(gunzipSync(await readFile(join(parent, 'candidate-1.json.gz'))));
if (values.mode === 'create') {
  const decision = JSON.parse(await readFile('.cache/pdf-admission-decision.json'));
  assert(['before', 'candidate'].includes(decision.productionSide));
  assert([3, 6].includes(decision.runsPerSide));
  await mkdir(root);
  const manifest = {
    schema: 1,
    decision,
    parentManifestSha256: sha(await readFile(join(parent, 'MANIFEST.json'))),
    parentSourcesSha256: sha(await readFile(join(parent, 'SOURCE-MANIFEST.json'))),
    priorTraceManifestSha256: sha(await readFile(join(priorTrace, 'MANIFEST.json'))),
    sources: {},
    runtime: {},
    evidence: [],
    reports: [],
  };
  async function add(file, bytes) {
    const packed = gzipSync(bytes, { level: 9 });
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), packed, { flag: 'wx' });
    manifest.evidence.push({ file, sha256: sha(packed), rawSha256: sha(bytes) });
  }
  const reports = [];
  for (const side of ['before', 'candidate']) {
    const frozen = resolve(`.cache/performance-pdf-admission-${side}`);
    const sourceBytes = await readFile(join(frozen, 'SOURCE-MANIFEST.json'));
    manifest.sources[side] = JSON.parse(sourceBytes);
    await add(`builds/${side}-source-manifest.json.gz`, sourceBytes);
    await add(
      `builds/${side}-control.json.gz`,
      await readFile(join(frozen, 'control-description.json')),
    );
    for (let n = 1; n <= decision.runsPerSide; n++) {
      const slot = `${side}-${n}`,
        raw = await readFile(`.cache/pdf-admission-${slot}.json`),
        r = JSON.parse(raw);
      requireComparable([r]);
      assert.equal(r.rows.length, 16);
      assert.equal(demandModel(r).unmatchedProcessIntervals, 0);
      assert.deepEqual(r.errors, []);
      if (manifest.runtime[side]) assert.deepEqual(r.buildManifest, manifest.runtime[side]);
      else manifest.runtime[side] = r.buildManifest;
      reports.push(r);
      manifest.reports.push({
        slot,
        reportSha256: sha(raw),
        buildSha256: r.buildSha256,
        harnessSha256: r.harnessSha256,
      });
      await add(`reports/${slot}.json.gz`, raw);
      await add(`logs/${slot}.log.gz`, await readFile(`.cache/pdf-admission-${slot}.log`));
      for (const a of r.objectDownloads) {
        const bytes = await readFile(a.path);
        assert.equal(sha(bytes), a.sha256);
        await add(`outputs/${slot}/${basename(a.path)}.gz`, bytes);
      }
    }
    for (const [p, h] of manifest.sources[side])
      assert.equal(sha(await readFile(join(frozen, 'source', p))), h);
    for (const [p, h] of manifest.runtime[side])
      assert.equal(sha(await readFile(join(frozen, p))), h);
    assert.equal(
      sha(await readFile(join(frozen, 'package.json'))),
      new Map(manifest.sources[side]).get('package.json'),
    );
  }
  requireComparable(reports);
  assert.deepEqual(
    manifest.sources.before,
    JSON.parse(await readFile(join(parent, 'candidate-source-manifest.json'))),
  );
  assert.deepEqual(manifest.runtime.before, priorReport.buildManifest);
  const changed = [
    ...new Set([...manifest.sources.before, ...manifest.sources.candidate].map(([p]) => p)),
  ]
    .filter(
      (p) => new Map(manifest.sources.before).get(p) !== new Map(manifest.sources.candidate).get(p),
    )
    .sort();
  assert.deepEqual(changed, [
    'src/pdfAdmission.test.ts',
    'src/pdfContinuationGate.test.ts',
    'src/pdfContinuationGate.ts',
    'src/pdfRenderCache.ts',
  ]);
  for (const p of changed)
    await add(
      'candidate-sources/' + p + '.gz',
      await readFile(join('.cache/performance-pdf-admission-candidate/source', p)),
    );
  for (const side of ['before', 'candidate'])
    for (const [p, h] of manifest.runtime[side])
      if (new Map(manifest.runtime[side === 'before' ? 'candidate' : 'before']).get(p) !== h)
        await add(
          `changed-runtime/${side}/${p}.gz`,
          await readFile(join(`.cache/performance-pdf-admission-${side}`, p)),
        );
  for (const [p, h] of manifest.sources[decision.productionSide])
    assert.equal(sha(await readFile(p)), h);
  const traceRaw = await readFile('.cache/pdf-admission-trace.json'),
    trace = JSON.parse(traceRaw);
  requireComparable([trace]);
  assert.deepEqual(trace.buildManifest, manifest.runtime.candidate);
  await add('diagnostic/report.json.gz', traceRaw);
  await add('diagnostic/trace.json.gz', await readFile('.cache/pdf-admission-trace.trace.json'));
  await add('diagnostic/trace.log.gz', await readFile('.cache/pdf-admission-trace.log'));
  for (const a of trace.objectDownloads) {
    const bytes = await readFile(a.path);
    assert.equal(sha(bytes), a.sha256);
    await add(`outputs/diagnostic/${basename(a.path)}.gz`, bytes);
  }
  for (const phase of phases)
    for (const ext of ['json', 'log'])
      await add(
        `diagnostic/${phase}.${ext}.gz`,
        await readFile(`.cache/pdf-admission-${phase}-frames.${ext}`),
      );
  for (const fixture of ['scanned', 'vector'])
    for (const ext of ['json', 'log'])
      await add(
        `native/${fixture}.${ext}.gz`,
        await readFile(`.cache/pdf-admission-native-${fixture}.${ext}`),
      );
  const qualityRaw = await readFile('.cache/pdf-admission-quality-candidate.json'),
    quality = JSON.parse(qualityRaw);
  assert.equal(
    quality.sourceManifestSha256,
    sha(await readFile('.cache/performance-pdf-admission-candidate/SOURCE-MANIFEST.json')),
  );
  await add('quality/candidate.json.gz', qualityRaw);
  await add(
    'quality/candidate.log.gz',
    await readFile('.cache/pdf-admission-quality-candidate.log'),
  );
  for (const c of quality.checks)
    for (const image of c.images) {
      const bytes = await readFile(
        join('.cache/pdf-admission-quality-candidate-pixels', image.file),
      );
      assert.equal(sha(bytes), image.pngSha256);
      await add(`quality/candidate-pixels/${image.file}.gz`, bytes);
    }
  for (const ext of ['json', 'log'])
    await add(
      `quality/comparison.${ext}.gz`,
      await readFile(`.cache/pdf-admission-quality-comparison.${ext}`),
    );
  for (const file of tools) await add('tools/' + file + '.gz', await readFile(file));
  for (const [file, input] of [
    ['inputs.json.gz', '.cache/pdf-admission-series-inputs.json'],
    ['launcher.ps1.gz', '.cache/run-pdf-admission-series.ps1'],
    ['preflight.mjs.gz', '.cache/preflight-pdf-admission-series.mjs'],
    ['preflight.log.gz', '.cache/pdf-admission-series-preflight.log'],
    ['acceptance.md.gz', '.cache/pdf-admission-acceptance.md'],
    ['quality-launcher.ps1.gz', '.cache/run-pdf-admission-quality.ps1'],
    ['functional.config.mjs.gz', '.cache/pdf-admission-functional.config.mjs'],
    ['functional.json.gz', '.cache/pdf-admission-functional.json'],
    ['functional.log.gz', '.cache/pdf-admission-functional.log'],
    ['unit.log.gz', '.cache/pdf-admission-unit-final.log'],
    ['frozen-unit.log.gz', '.cache/pdf-admission-frozen-unit.log'],
    ['types.log.gz', '.cache/pdf-admission-typecheck-final.log'],
    ['restored-unit.log.gz', '.cache/pdf-admission-restored-unit.log'],
    ['restored-types.log.gz', '.cache/pdf-admission-restored-types.log'],
    ['build-before.log.gz', '.cache/pdf-admission-build-before.log'],
    ['build-candidate.log.gz', '.cache/pdf-admission-build-candidate.log'],
    [
      'output-quality.json.gz',
      `.cache/pdf-admission-output-quality${decision.runsPerSide === 6 ? '-final' : ''}.json`,
    ],
    [
      'output-quality.log.gz',
      `.cache/pdf-admission-output-quality${decision.runsPerSide === 6 ? '-final' : ''}.log`,
    ],
    ['diagnostic/output-quality.json.gz', '.cache/pdf-admission-trace-output-quality.json'],
    ['diagnostic/output-quality.log.gz', '.cache/pdf-admission-trace-output-quality.log'],
    ['summary.json.gz', '.cache/pdf-admission-resource-summary.json'],
    ['summary.log.gz', '.cache/pdf-admission-resource-summary.log'],
    ['summarize.mjs.gz', '.cache/summarize-pdf-admission.mjs'],
  ])
    await add(file, await readFile(input));
  if (decision.runsPerSide === 6)
    for (const [file, input] of [
      ['confirmation/inputs.json.gz', '.cache/pdf-admission-series-inputs-confirm.json'],
      ['confirmation/launcher.ps1.gz', '.cache/run-pdf-admission-series-confirm.ps1'],
      ['confirmation/preflight.mjs.gz', '.cache/preflight-pdf-admission-series-confirm.mjs'],
      ['confirmation/preflight.log.gz', '.cache/pdf-admission-series-preflight-confirm.log'],
      ['confirmation/summary.json.gz', '.cache/pdf-admission-resource-summary-confirm.json'],
      ['confirmation/summary.log.gz', '.cache/pdf-admission-resource-summary-confirm.log'],
      ['confirmation/summarize.mjs.gz', '.cache/summarize-pdf-admission-confirm.mjs'],
      ['confirmation/first-output-quality.json.gz', '.cache/pdf-admission-output-quality.json'],
      ['confirmation/first-output-quality.log.gz', '.cache/pdf-admission-output-quality.log'],
    ])
      await add(file, await readFile(input));
  for (const suffix of decision.runsPerSide === 6 ? ['', '-confirm'] : [''])
    for (const ext of ['json', 'md', 'log'])
      await add(
        `comparison${suffix}.${ext}.gz`,
        await readFile(`.cache/pdf-admission-comparison${suffix}.${ext}`),
      );
  for (const f of await files('.cache/pdf-admission-functional'))
    await add(
      'functional/' + f + '.gz',
      await readFile(join('.cache/pdf-admission-functional', f)),
    );
  const readme = await readFile('.cache/pdf-admission-README.md');
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
  assert.equal(manifest.parentManifestSha256, sha(await readFile(join(parent, 'MANIFEST.json'))));
  assert.equal(
    manifest.parentSourcesSha256,
    sha(await readFile(join(parent, 'SOURCE-MANIFEST.json'))),
  );
  assert.equal(
    manifest.priorTraceManifestSha256,
    sha(await readFile(join(priorTrace, 'MANIFEST.json'))),
  );
  assert.equal(manifest.readmeSha256, sha(await readFile(join(root, 'README.md'))));
  const temporary = await mkdtemp(join(tmpdir(), 'tixtab-pdf-admission-'));
  for (const e of manifest.evidence) {
    const bytes = await readFile(safe(root, e.file));
    assert.equal(sha(bytes), e.sha256);
    const raw = gunzipSync(bytes);
    assert.equal(sha(raw), e.rawSha256);
    const target = safe(temporary, e.file.replace(/\.gz$/, ''));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, raw);
  }
  for (const file of tools)
    assert.equal(sha(await readFile(file)), sha(await readFile(join(temporary, 'tools', file))));
  const reports = [];
  for (const entry of manifest.reports) {
    const raw = await readFile(join(temporary, 'reports', entry.slot + '.json')),
      r = JSON.parse(raw);
    assert.equal(sha(raw), entry.reportSha256);
    assert.equal(r.buildSha256, entry.buildSha256);
    assert.equal(demandModel(r).unmatchedProcessIntervals, 0);
    assert.equal(r.rows.length, 16);
    assert.deepEqual(r.errors, []);
    reports.push(r);
    for (const a of r.objectDownloads)
      assert.equal(
        sha(await readFile(join(temporary, 'outputs', entry.slot, basename(a.path)))),
        a.sha256,
      );
  }
  requireComparable(reports);
  assert.deepEqual(manifest.runtime.before, priorReport.buildManifest);
  for (const side of ['before', 'candidate']) {
    const frozen = resolve(`.cache/performance-pdf-admission-${side}`);
    for (const [p, h] of manifest.runtime[side])
      assert.equal(sha(await readFile(join(frozen, p))), h);
    for (const [p, h] of manifest.sources[side])
      assert.equal(sha(await readFile(join(frozen, 'source', p))), h);
    assert.equal(
      sha(await readFile(join(frozen, 'package.json'))),
      new Map(manifest.sources[side]).get('package.json'),
    );
  }
  for (const [p, h] of manifest.sources[manifest.decision.productionSide])
    assert.equal(sha(await readFile(p)), h);
  const inputs = JSON.parse(await readFile(join(temporary, 'inputs.json'))),
    harness = createHash('sha256');
  assert.equal(inputs.launcherSha256, sha(await readFile(join(temporary, 'launcher.ps1'))));
  for (const [p, h] of inputs.harnessFiles) {
    const bytes = await readFile(join(temporary, 'tools', p));
    assert.equal(sha(bytes), h);
    harness.update(bytes);
  }
  assert.equal(harness.digest('hex'), inputs.harnessSha256);
  assert(reports.every((r) => r.harnessSha256 === inputs.harnessSha256));
  assert.deepEqual(inputs.order, ['A1', 'B1', 'B2', 'A2', 'A3', 'B3']);
  if (manifest.decision.runsPerSide === 6) {
    const confirmed = JSON.parse(await readFile(join(temporary, 'confirmation/inputs.json')));
    assert.equal(confirmed.harnessSha256, inputs.harnessSha256);
    assert.equal(confirmed.fixtureSha256, inputs.fixtureSha256);
    assert.equal(
      confirmed.launcherSha256,
      sha(await readFile(join(temporary, 'confirmation/launcher.ps1'))),
    );
    assert.equal(
      confirmed.preflightSha256,
      sha(await readFile(join(temporary, 'confirmation/preflight.mjs'))),
    );
    assert.deepEqual(confirmed.order, ['B4', 'A4', 'A5', 'B5', 'B6', 'A6']);
  }
  function run(script, args) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + '\n' + r.stderr);
  }
  for (const suffix of manifest.decision.runsPerSide === 6 ? ['', '-confirm'] : ['']) {
    const comparison = JSON.parse(await readFile(join(temporary, `comparison${suffix}.json`))),
      out = join(temporary, `comparison-replay${suffix}.json`),
      args = ['--output', out];
    for (const side of ['before', 'candidate'])
      for (let n = suffix ? 4 : 1; n <= (suffix ? 6 : 3); n++)
        args.push(
          side === 'before' ? '--baseline' : '--candidate',
          join(temporary, `reports/${side}-${n}.json`),
        );
    run('scripts/compare-workflows.mjs', args);
    const strip = ({ createdAt, source, ...rest }) => rest;
    assert.deepEqual(strip(JSON.parse(await readFile(out))), strip(comparison));
  }
  const trace = JSON.parse(await readFile(join(temporary, 'diagnostic/report.json')));
  assert.deepEqual(trace.buildManifest, manifest.runtime.candidate);
  trace.tracePath = join(temporary, 'diagnostic/trace.json');
  const replayReport = join(temporary, 'trace-replay-report.json');
  await writeFile(replayReport, JSON.stringify(trace));
  for (const phase of phases) {
    const out = join(temporary, `trace-${phase}.json`);
    run('scripts/analyze-frame-budget.mjs', [
      '--trace',
      trace.tracePath,
      '--report',
      replayReport,
      '--runtime',
      '.cache/performance-pdf-admission-candidate',
      '--phase',
      phase,
      '--output',
      out,
    ]);
    const strip = ({ reportSha256, ...rest }) => rest;
    const recorded = JSON.parse(await readFile(join(temporary, `diagnostic/${phase}.json`)));
    assert.deepEqual(strip(JSON.parse(await readFile(out))), strip(recorded));
    assert(recorded.summary.pdfRoots > 0 && recorded.summary.maxPdfCallbacks === 1);
  }
  for (const fixture of ['scanned', 'vector']) {
    const r = JSON.parse(await readFile(join(temporary, `native/${fixture}.json`)));
    assert.equal(r.checks.length, 5);
    assert.deepEqual(r.errors, []);
    assert.equal(
      r.sourceManifestSha256,
      sha(await readFile('.cache/performance-pdf-admission-candidate/SOURCE-MANIFEST.json')),
    );
    assert.equal(r.harnessSha256, sha(await readFile('scripts/verify-pdf-idle-native.mjs')));
    assert(r.checks.every((c) => c.after.ledger.pending === 0 && c.after.visibleBackgrounds > 0));
  }
  const functional = JSON.parse(await readFile(join(temporary, 'functional.json')));
  assert.equal(functional.stats.expected, 2);
  assert.equal(functional.stats.unexpected, 0);
  const ff = await files(join(temporary, 'functional'));
  const readSuffix = async (name) =>
    JSON.parse(
      await readFile(
        join(
          temporary,
          'functional',
          ff.find((f) => f.endsWith(name)),
        ),
      ),
    );
  const binding = await readSuffix('native-selection-binding.json');
  assert.deepEqual(
    binding.runtime.filter(([p]) => p !== 'package.json'),
    manifest.runtime.candidate,
  );
  assert.deepEqual(binding.errors, []);
  assert.equal(
    new Map(binding.runtime).get('package.json'),
    new Map(manifest.sources.candidate).get('package.json'),
  );
  assert(binding.contain.length && binding.contain.every((c) => c === 'none'));
  assert.equal(binding.harnessSha256, sha(await readFile('tests/selection-start.spec.ts')));
  const pixels = await readSuffix('pixel-comparisons.json'),
    fast = await readSuffix('transient-coverage.json');
  assert.equal(pixels.length, 10);
  assert(pixels.every((p) => p.maximum <= 1 && !p.overOne));
  assert.equal(fast.length, 48);
  assert(fast.every((p) => !p.missingObjects.length && !p.missingInk));
  const baseline = JSON.parse(
    gunzipSync(await readFile(join(parent, 'quality/candidate.json.gz'))),
  );
  await writeFile(join(temporary, 'quality/baseline.json'), JSON.stringify(baseline));
  await mkdir(join(temporary, 'quality/baseline-pixels'));
  for (const c of baseline.checks)
    for (const image of c.images) {
      const bytes = gunzipSync(
        await readFile(safe(parent, `quality/candidate-pixels/${image.file}.gz`)),
      );
      assert.equal(sha(bytes), image.pngSha256);
      await writeFile(join(temporary, 'quality/baseline-pixels', image.file), bytes);
    }
  const pixelReplay = join(temporary, 'quality/pixel-replay.json');
  run('scripts/compare-pdf-quality.mjs', [
    '--baseline',
    join(temporary, 'quality/baseline.json'),
    '--candidate',
    join(temporary, 'quality/candidate.json'),
    '--output',
    pixelReplay,
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(pixelReplay)),
    JSON.parse(await readFile(join(temporary, 'quality/comparison.json'))),
  );
  for (const ext of ['tixtab', 'tixtab.json'])
    await writeFile(
      join(temporary, 'objects.' + ext),
      gunzipSync(await readFile(join(parent, 'fixtures/objects.' + ext + '.gz'))),
    );
  const checks = [];
  for (const slot of [...manifest.reports.map((r) => r.slot), 'diagnostic']) {
    const path = join(
        temporary,
        slot === 'diagnostic' ? 'diagnostic/report.json' : `reports/${slot}.json`,
      ),
      out = join(temporary, `outputs-${slot}.json`);
    run('scripts/verify-reading-scale-output.mjs', [
      '--report',
      path,
      '--fixture-file',
      join(temporary, 'objects.tixtab'),
      '--model',
      '.cache/performance-pdf-admission-candidate/source/src/model.ts',
      '--artifact-dir',
      join(temporary, 'outputs', slot),
      '--output',
      out,
    ]);
    checks.push(...JSON.parse(await readFile(out)).checks);
  }
  const recorded = [
    ...JSON.parse(await readFile(join(temporary, 'output-quality.json'))).checks,
    ...JSON.parse(await readFile(join(temporary, 'diagnostic/output-quality.json'))).checks,
  ];
  const stripCheck = ({ report, ...rest }) => rest;
  const bySha = (a, b) => a.reportSha256.localeCompare(b.reportSha256);
  assert.deepEqual(checks.map(stripCheck).sort(bySha), recorded.map(stripCheck).sort(bySha));
  assert.equal(new Set(checks.map((c) => c.pdfGraphWithoutDatesSha256)).size, 1);
  console.log(
    JSON.stringify({
      verified: true,
      evidence: manifest.evidence.length,
      runs: reports.length,
      runtime: manifest.runtime.before.length + manifest.runtime.candidate.length + 2,
      sourceFiles: manifest.sources[manifest.decision.productionSide].length,
      backgroundPairs: 369,
      nativeRecovery: 10,
      foregroundPositions: 10,
      fastFrames: 48,
      outputPairs: checks.length,
      productionSide: manifest.decision.productionSide,
    }),
  );
}
