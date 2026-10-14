import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join, dirname, basename, relative, isAbsolute } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { requireComparable } from './performance-demand.mjs';
const { values } = parseArgs({
  options: { mode: { type: 'string', default: 'create' }, runtime: { type: 'string' } },
});
const parent = resolve('docs/performance/2026-10-13-pdf-display');
const root = join(parent, 'diagnostics/frame-budget');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tools = [
  'scripts/archive-frame-budget.mjs',
  'scripts/trace-frame-budget.mjs',
  'scripts/trace-frame-budget.test.mjs',
  'scripts/analyze-frame-budget.mjs',
  'scripts/analyze-workflow-trace.mjs',
  'scripts/analyze-workflow-gc.mjs',
  'scripts/trace-intervals.mjs',
  'scripts/performance-demand.mjs',
];
const phases = ['facing-zoom', 'continuous-scroll-roundtrip', 'reading-zoom-settle-cycle'];
const safe = (base, file) => {
  const p = resolve(base, file),
    r = relative(base, p);
  assert(r && !r.startsWith('..') && !isAbsolute(r));
  return p;
};
const reportBytes = await readFile(
  values.mode === 'create' ? '.cache/pdf-frame-budget-trace.json' : join(root, 'report.json.gz'),
);
const report = JSON.parse(values.mode === 'create' ? reportBytes : gunzipSync(reportBytes));
const baseline = JSON.parse(gunzipSync(await readFile(join(parent, 'candidate-1.json.gz'))));
requireComparable([report, baseline]);
assert.equal(report.buildSha256, baseline.buildSha256);
const sourceManifest = await readFile(join(parent, 'candidate-source-manifest.json'));
if (values.mode === 'create') {
  await mkdir(root, { recursive: true });
  const evidence = [];
  async function add(file, bytes) {
    const packed = gzipSync(bytes, { level: 9 });
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), packed, { flag: 'wx' });
    evidence.push({ file, sha256: sha(packed), rawSha256: sha(bytes) });
  }
  for (const [file, input] of [
    ['report.json.gz', '.cache/pdf-frame-budget-trace.json'],
    ['trace.json.gz', '.cache/pdf-frame-budget-trace.trace.json'],
    ['trace.log.gz', '.cache/pdf-frame-budget-trace.log'],
    ['unit.log.gz', '.cache/pdf-frame-budget-unit.log'],
    ['output-quality.json.gz', '.cache/pdf-frame-budget-output-quality.json'],
    ['output-quality.log.gz', '.cache/pdf-frame-budget-output-quality.log'],
  ])
    await add(file, await readFile(input));
  for (const phase of phases)
    for (const suffix of ['', '-frames', '-gc'])
      for (const ext of ['json', 'log'])
        await add(
          `analyses/${phase}${suffix}.${ext}.gz`,
          await readFile(`.cache/pdf-frame-budget-${phase}${suffix}.${ext}`),
        );
  for (const file of tools) await add('sources/' + file + '.gz', await readFile(file));
  await add('dependency/pdf.mjs.gz', await readFile('node_modules/pdfjs-dist/build/pdf.mjs'));
  for (const a of report.objectDownloads) {
    const bytes = await readFile(a.path);
    assert.equal(sha(bytes), a.sha256);
    await add('outputs/' + basename(a.path) + '.gz', bytes);
  }
  const readme = await readFile('.cache/pdf-frame-budget-README.md');
  await writeFile(join(root, 'README.md'), readme, { flag: 'wx' });
  await writeFile(
    join(root, 'MANIFEST.json'),
    JSON.stringify(
      {
        schema: 1,
        evidence,
        readmeSha256: sha(readme),
        parentManifestSha256: sha(await readFile(join(parent, 'MANIFEST.json'))),
        parentSourcesSha256: sha(await readFile(join(parent, 'SOURCE-MANIFEST.json'))),
        sourceManifestSha256: sha(sourceManifest),
        reportSha256: sha(reportBytes),
        buildSha256: report.buildSha256,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify({ created: true, evidence: evidence.length, report: 1, analyses: 9 }));
} else {
  assert.equal(values.mode, 'verify');
  assert(values.runtime, 'Supply actual frozen --runtime');
  const manifest = JSON.parse(await readFile(join(root, 'MANIFEST.json')));
  assert.equal(manifest.parentManifestSha256, sha(await readFile(join(parent, 'MANIFEST.json'))));
  assert.equal(
    manifest.parentSourcesSha256,
    sha(await readFile(join(parent, 'SOURCE-MANIFEST.json'))),
  );
  assert.equal(manifest.sourceManifestSha256, sha(sourceManifest));
  assert.equal(manifest.reportSha256, sha(gunzipSync(reportBytes)));
  assert.equal(manifest.buildSha256, report.buildSha256);
  assert.equal(manifest.readmeSha256, sha(await readFile(join(root, 'README.md'))));
  const unpack = async (f) => gunzipSync(await readFile(safe(root, f)));
  for (const entry of manifest.evidence) {
    const bytes = await readFile(safe(root, entry.file));
    assert.equal(sha(bytes), entry.sha256, entry.file);
    assert.equal(sha(gunzipSync(bytes)), entry.rawSha256, entry.file);
  }
  for (const file of tools)
    assert.equal(sha(await readFile(file)), sha(await unpack('sources/' + file + '.gz')), file);
  const run = (script, args) => {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + '\n' + r.stderr);
    return r.stdout.trim();
  };
  console.log(run('scripts/verify-pdf-display-archive.mjs', ['--archive', parent]));
  const runtime = resolve(values.runtime);
  for (const [file, h] of report.buildManifest)
    assert.equal(sha(await readFile(safe(runtime, file))), h, file);
  assert.equal(
    sha(await readFile(join(runtime, 'SOURCE-MANIFEST.json'))),
    manifest.sourceManifestSha256,
  );
  const dependency = (await unpack('dependency/pdf.mjs.gz')).toString('utf8');
  assert(
    dependency.includes('const EXECUTION_TIME = 15;') &&
      dependency.includes('const EXECUTION_STEPS = 10;'),
  );
  assert(dependency.includes('this.task.onContinue(this._scheduleNextBound)'));
  const temp = await mkdtemp(join(tmpdir(), 'tixtab-frame-budget-'));
  const trace = join(temp, 'trace.json'),
    reportPath = join(temp, 'report.json');
  await writeFile(trace, await unpack('trace.json.gz'));
  // Keep the original report intact; the analyzer checks its recorded trace path.
  // Recreate that basename in a derived temporary report, then compare all data
  // except the report hash/path that necessarily changes for the replay.
  const replayReport = { ...report, tracePath: trace };
  await writeFile(reportPath, JSON.stringify(replayReport));
  for (const phase of phases)
    for (const suffix of ['', '-frames', '-gc']) {
      const output = join(temp, phase + suffix + '.json');
      const script =
        suffix === '-frames'
          ? 'scripts/analyze-frame-budget.mjs'
          : suffix === '-gc'
            ? 'scripts/analyze-workflow-gc.mjs'
            : 'scripts/analyze-workflow-trace.mjs';
      run(script, [
        '--trace',
        trace,
        '--phase',
        phase,
        '--output',
        output,
        ...(suffix === '-frames' ? ['--report', reportPath, '--runtime', runtime] : []),
      ]);
      const actual = JSON.parse(await readFile(output)),
        expected = JSON.parse(await unpack(`analyses/${phase}${suffix}.json.gz`));
      delete actual.trace;
      delete expected.trace;
      if (suffix === '-frames') {
        delete actual.reportSha256;
        delete expected.reportSha256;
      }
      assert.deepEqual(actual, expected, phase + suffix);
    }
  console.log(run('--test', ['scripts/trace-frame-budget.test.mjs']));
  await mkdir(join(temp, 'src'));
  await mkdir(join(temp, 'artifacts'));
  for (const file of ['model.ts', 'zoteroSource.ts'])
    await writeFile(
      join(temp, 'src', file),
      gunzipSync(await readFile(join(parent, `source-snapshots/candidate/src/${file}.gz`))),
    );
  for (const ext of ['tixtab', 'tixtab.json'])
    await writeFile(
      join(temp, 'objects.' + ext),
      gunzipSync(await readFile(join(parent, `fixtures/objects.${ext}.gz`))),
    );
  for (const [r, child] of [
    [report, true],
    [baseline, false],
  ])
    for (const a of r.objectDownloads) {
      const name = basename(a.path.replaceAll('\\', '/'));
      const bytes = child
        ? await unpack('outputs/' + name + '.gz')
        : gunzipSync(await readFile(join(parent, 'outputs/' + name + '.gz')));
      assert.equal(sha(bytes), a.sha256);
      await writeFile(join(temp, 'artifacts', name), bytes, { flag: 'wx' });
    }
  console.log(
    run('scripts/verify-reading-scale-output.mjs', [
      '--report',
      join(root, 'report.json.gz'),
      '--report',
      join(parent, 'candidate-1.json.gz'),
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
  const actual = JSON.parse(await readFile(join(temp, 'outputs.json'))),
    expected = JSON.parse(await unpack('output-quality.json.gz'));
  for (const key of ['fixtureSha256', 'modelSha256', 'harnessSha256'])
    assert.equal(actual[key], expected[key]);
  const noPath = ({ report, ...r }) => r;
  assert.deepEqual(actual.checks.map(noPath), expected.checks.map(noPath));
  console.log(
    JSON.stringify({
      passed: true,
      evidence: manifest.evidence.length,
      runtimeFiles: report.buildManifest.length,
      analyses: 9,
      tests: 3,
      outputs: 2,
      parentImmutable: true,
    }),
  );
}
