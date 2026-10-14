import { readFile, writeFile, mkdir, readdir, mkdtemp } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const { values } = parseArgs({ options: { mode: { type: 'string', default: 'create' } } });
assert(['create', 'verify'].includes(values.mode));
const root = resolve('docs/performance/2026-10-13-page-contain-quality');
const parent = resolve('docs/performance/2026-10-13-pdf-display');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const safe = (base, file) => {
  const path = resolve(base, file),
    rel = relative(base, path);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel));
  return path;
};
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
const experiments = [
  'page-contain-native',
  'page-contain-native-aa',
  'page-contain-native-high',
  'page-contain-native-aa-copy',
  'page-contain-native-high-copy',
  'page-contain-cycles',
  'page-contain-cycles-native-path',
  'page-contain-cycles-settled',
  'page-contain-cycles-full',
];
const helpers = [
  'scripts/archive-page-contain-quality.mjs',
  'scripts/verify-page-contain-native.mjs',
  'scripts/verify-page-contain-cycles.mjs',
  'scripts/analyze-page-contain-cycles.mjs',
  'scripts/calibrate-page-contain-cycles.mjs',
  'scripts/object-preview-scenarios.mjs',
  'scripts/performance-settle.mjs',
  'scripts/build-page-contain-control.mjs',
  'scripts/calibrate-page-contain-quality.mjs',
  'scripts/observed-rgba.mjs',
  'scripts/observed-rgba.test.mjs',
];
if (values.mode === 'create') {
  await mkdir(root);
  const manifest = {
    schema: 1,
    decision:
      'Quality/lifecycle observation only; containment remains an unaccepted performance experiment',
    parentManifestSha256: sha(await readFile(join(parent, 'MANIFEST.json'))),
    parentSourcesSha256: sha(await readFile(join(parent, 'SOURCE-MANIFEST.json'))),
    evidence: [],
    sources: {},
    runtime: {},
  };
  async function add(name, bytes) {
    const packed = gzipSync(bytes, { level: 9 });
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), packed, { flag: 'wx' });
    manifest.evidence.push({ file: name, sha256: sha(packed), rawSha256: sha(bytes) });
  }
  for (const name of experiments) {
    for (const file of await files(join('.cache', name)))
      await add(`experiments/${name}/${file}.gz`, await readFile(join('.cache', name, file)));
    await add(`logs/${name}.log.gz`, await readFile(`.cache/${name}.log`));
  }
  for (const file of helpers) await add(`sources/${file}.gz`, await readFile(file));
  for (const version of [1, 2, 3]) {
    for (const prefix of ['verify-page-contain-native', 'verify-page-contain-cycles']) {
      const file = `.cache/${prefix}-v${version}.mjs`;
      await add(`sources/history/${prefix}-v${version}.mjs.gz`, await readFile(file));
    }
  }
  for (const name of [
    'page-contain-calibration',
    'page-contain-calibration-copy',
    'page-contain-calibration-unit',
    'page-contain-build-before',
    'page-contain-build-candidate',
    'page-contain-cycles-analysis',
    'page-contain-cycles-observed',
  ]) {
    for (const ext of name.includes('calibration-unit') || name.includes('build-')
      ? ['log']
      : ['json', 'log'])
      await add(`analyses/${name}.${ext}.gz`, await readFile(`.cache/${name}.${ext}`));
  }
  const cycle = JSON.parse(await readFile('.cache/page-contain-cycles-full/report.json'));
  assert(cycle.contentPass);
  for (const label of ['baseline', 'candidate']) {
    const dir = resolve(
      `.cache/performance-page-contain-${label === 'baseline' ? 'before' : 'candidate'}`,
    );
    const sourceBytes = await readFile(join(dir, 'SOURCE-MANIFEST.json'));
    assert.equal(sha(sourceBytes), cycle.runs[label].sourceManifestSha256);
    manifest.sources[label] = JSON.parse(sourceBytes);
    manifest.runtime[label] = cycle.runs[label].runtime;
    await add(`builds/${label}-source-manifest.json.gz`, sourceBytes);
    await add(`builds/${label}-chrome.css.gz`, await readFile(join(dir, 'source/src/chrome.css')));
    for (const [file, hash] of manifest.sources[label])
      assert.equal(sha(await readFile(join(dir, 'source', file))), hash);
    for (const [file, hash] of manifest.runtime[label]) {
      const bytes = await readFile(join(dir, file));
      assert.equal(sha(bytes), hash);
      const other = cycle.runs[label === 'baseline' ? 'candidate' : 'baseline'].runtime;
      if (new Map(other).get(file) !== hash)
        await add(`builds/changed-runtime/${label}/${file}.gz`, bytes);
    }
  }
  const changed = manifest.sources.baseline
    .filter(([p, h]) => new Map(manifest.sources.candidate).get(p) !== h)
    .map(([p]) => p);
  assert.deepEqual(changed, ['src/chrome.css']);
  assert.deepEqual(
    manifest.sources.baseline,
    JSON.parse(await readFile(join(parent, 'candidate-source-manifest.json'))),
  );
  const parentReport = JSON.parse(gunzipSync(await readFile(join(parent, 'candidate-1.json.gz'))));
  assert.deepEqual(
    manifest.runtime.baseline.filter(([p]) => p !== 'package.json'),
    parentReport.buildManifest,
  );
  const readme = await readFile('.cache/page-contain-quality-README.md');
  await writeFile(join(root, 'README.md'), readme, { flag: 'wx' });
  manifest.readmeSha256 = sha(readme);
  await writeFile(join(root, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(JSON.stringify({ created: true, evidence: manifest.evidence.length }));
} else {
  const manifest = JSON.parse(await readFile(join(root, 'MANIFEST.json')));
  assert.equal(manifest.parentManifestSha256, sha(await readFile(join(parent, 'MANIFEST.json'))));
  assert.equal(
    manifest.parentSourcesSha256,
    sha(await readFile(join(parent, 'SOURCE-MANIFEST.json'))),
  );
  assert.equal(manifest.readmeSha256, sha(await readFile(join(root, 'README.md'))));
  const temporary = await mkdtemp(join(tmpdir(), 'tixtab-contain-quality-'));
  for (const e of manifest.evidence) {
    const packed = await readFile(safe(root, e.file));
    assert.equal(sha(packed), e.sha256);
    const raw = gunzipSync(packed);
    assert.equal(sha(raw), e.rawSha256);
    const target = safe(temporary, e.file.replace(/\.gz$/, ''));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, raw);
  }
  const cycleDir = join(temporary, 'experiments/page-contain-cycles-full');
  const cycle = JSON.parse(await readFile(join(cycleDir, 'report.json')));
  for (const label of ['baseline', 'candidate']) {
    assert.deepEqual(cycle.runs[label].runtime, manifest.runtime[label]);
    assert.equal(
      cycle.runs[label].sourceManifestSha256,
      sha(await readFile(join(temporary, `builds/${label}-source-manifest.json`))),
    );
    const actual = resolve(
      `.cache/performance-page-contain-${label === 'baseline' ? 'before' : 'candidate'}`,
    );
    for (const [p, h] of manifest.runtime[label])
      assert.equal(sha(await readFile(join(actual, p))), h);
  }
  assert.equal(
    cycle.harnessSha256,
    sha(await readFile(join(temporary, 'sources/scripts/verify-page-contain-cycles.mjs'))),
  );
  assert.equal(
    cycle.scenarioSha256,
    sha(await readFile(join(temporary, 'sources/scripts/object-preview-scenarios.mjs'))),
  );
  assert.equal(
    cycle.settleSha256,
    sha(await readFile(join(temporary, 'sources/scripts/performance-settle.mjs'))),
  );
  const output = join(temporary, 'cycle-analysis.json');
  const execution = spawnSync(
    process.execPath,
    ['scripts/analyze-page-contain-cycles.mjs', '--directory', cycleDir, '--output', output],
    { encoding: 'utf8' },
  );
  assert.equal(execution.status, 0, execution.stdout + '\n' + execution.stderr);
  assert.deepEqual(
    JSON.parse(await readFile(output)),
    JSON.parse(await readFile(join(temporary, 'analyses/page-contain-cycles-analysis.json'))),
  );
  const calibrated = join(temporary, 'calibrated.json');
  const calibration = spawnSync(
    process.execPath,
    [
      'scripts/calibrate-page-contain-cycles.mjs',
      '--directory',
      cycleDir,
      '--reference-directory',
      join(temporary, 'experiments/page-contain-cycles-settled'),
      '--output',
      calibrated,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(calibration.status, 0, calibration.stdout + '\n' + calibration.stderr);
  assert.deepEqual(
    JSON.parse(await readFile(calibrated)),
    JSON.parse(await readFile(join(temporary, 'analyses/page-contain-cycles-observed.json'))),
  );
  console.log(
    JSON.stringify({
      verified: true,
      evidence: manifest.evidence.length,
      runtime: manifest.runtime.baseline.length + manifest.runtime.candidate.length,
      sourceExact: true,
      cycles: cycle.cycles,
      originalDisplayBoundPass: cycle.displayBoundPass,
    }),
  );
}
