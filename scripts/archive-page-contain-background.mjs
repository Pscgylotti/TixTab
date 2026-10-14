import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const { values } = parseArgs({ options: { mode: { type: 'string', default: 'create' } } });
assert(['create', 'verify'].includes(values.mode));
const parent = resolve('docs/performance/2026-10-13-page-contain-quality');
const baselineArchive = resolve('docs/performance/2026-10-13-pdf-display');
const root = join(parent, 'diagnostics/background');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const safe = (base, file) => {
  const p = resolve(base, file),
    r = relative(base, p);
  assert(r && !r.startsWith('..') && !isAbsolute(r));
  return p;
};
const baselineRaw = gunzipSync(await readFile(join(baselineArchive, 'quality/candidate.json.gz')));
const baseline = JSON.parse(baselineRaw);
if (values.mode === 'create') {
  await mkdir(root, { recursive: true });
  const manifest = {
    schema: 1,
    parentManifestSha256: sha(await readFile(join(parent, 'MANIFEST.json'))),
    baselineManifestSha256: sha(await readFile(join(baselineArchive, 'MANIFEST.json'))),
    baselineReportSha256: sha(baselineRaw),
    evidence: [],
  };
  async function add(file, bytes) {
    const packed = gzipSync(bytes, { level: 9 });
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), packed, { flag: 'wx' });
    manifest.evidence.push({ file, sha256: sha(packed), rawSha256: sha(bytes) });
  }
  const raw = await readFile('.cache/page-contain-quality-candidate.json'),
    quality = JSON.parse(raw);
  const lifecycle = JSON.parse(
    gunzipSync(await readFile(join(parent, 'experiments/page-contain-cycles-full/report.json.gz'))),
  );
  assert.equal(quality.sourceManifestSha256, lifecycle.runs.candidate.sourceManifestSha256);
  assert.equal(baseline.sourceManifestSha256, lifecycle.runs.baseline.sourceManifestSha256);
  assert.equal(quality.harnessSha256, baseline.harnessSha256);
  await add('candidate.json.gz', raw);
  for (const check of quality.checks)
    for (const image of check.images) {
      const bytes = await readFile(
        join('.cache/page-contain-quality-candidate-pixels', image.file),
      );
      assert.equal(sha(bytes), image.pngSha256);
      await add(`candidate-pixels/${image.file}.gz`, bytes);
    }
  for (const [file, input] of [
    ['candidate.log.gz', '.cache/page-contain-quality-candidate.log'],
    ['comparison.json.gz', '.cache/page-contain-background-comparison.json'],
    ['comparison.log.gz', '.cache/page-contain-background-comparison.log'],
    ...[
      'scripts/verify-night-matrix.mjs',
      'scripts/compare-pdf-quality.mjs',
      'scripts/archive-page-contain-background.mjs',
    ].map((p) => ['sources/' + p + '.gz', p]),
  ])
    await add(file, await readFile(input));
  const readme = Buffer.from(
    '# 页面布局隔离：背景画布质量矩阵\n\n候选原生 Electron 完成扫描、矢量、复杂对象三样本 × 单页/连续/双页 × 日间/夜间/原色，共 27 组合、369 个实际 Canvas。基线复用画布复用 B 的已归档结果，其运行文件与页面隔离 A 完全一致；两侧源和运行绑定见父质量归档。逐 RGBA 对照 369 对全部零差异，不降低采样或分辨率。\n\n本子归档仅补充严格背景质量，不表示功能、完整流程资源、能量或第二轮验收通过。父 672 份前景/循环证据保持不变，原严格失败仍保留。下一步为裁剪/选择/快速跳转、工程/PDF 和整段资源 A/B。\n\n复核：`node scripts/archive-page-contain-background.mjs --mode verify`，校验所有哈希、解压双方实际 Canvas 并独立重算对照。\n',
  );
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
    manifest.baselineManifestSha256,
    sha(await readFile(join(baselineArchive, 'MANIFEST.json'))),
  );
  assert.equal(manifest.baselineReportSha256, sha(baselineRaw));
  assert.equal(manifest.readmeSha256, sha(await readFile(join(root, 'README.md'))));
  const temporary = await mkdtemp(join(tmpdir(), 'tixtab-contain-background-'));
  for (const e of manifest.evidence) {
    const packed = await readFile(safe(root, e.file));
    assert.equal(sha(packed), e.sha256);
    const raw = gunzipSync(packed);
    assert.equal(sha(raw), e.rawSha256);
    const target = safe(temporary, e.file.replace(/\.gz$/, ''));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, raw);
  }
  await writeFile(join(temporary, 'baseline.json'), baselineRaw);
  await mkdir(join(temporary, 'baseline-pixels'));
  for (const check of baseline.checks)
    for (const image of check.images) {
      const raw = gunzipSync(
        await readFile(safe(baselineArchive, `quality/candidate-pixels/${image.file}.gz`)),
      );
      assert.equal(sha(raw), image.pngSha256);
      await writeFile(join(temporary, 'baseline-pixels', image.file), raw);
    }
  const candidate = JSON.parse(await readFile(join(temporary, 'candidate.json')));
  assert.equal(
    candidate.harnessSha256,
    sha(await readFile(join(temporary, 'sources/scripts/verify-night-matrix.mjs'))),
  );
  const output = join(temporary, 'recomputed.json');
  const execution = spawnSync(
    process.execPath,
    [
      'scripts/compare-pdf-quality.mjs',
      '--baseline',
      join(temporary, 'baseline.json'),
      '--candidate',
      join(temporary, 'candidate.json'),
      '--output',
      output,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(execution.status, 0, execution.stdout + '\n' + execution.stderr);
  const comparison = JSON.parse(await readFile(output));
  assert.deepEqual(comparison, JSON.parse(await readFile(join(temporary, 'comparison.json'))));
  assert(comparison.pass);
  assert.equal(comparison.checks.length, 369);
  console.log(
    JSON.stringify({
      verified: true,
      evidence: manifest.evidence.length,
      combinations: 27,
      strictPixelPairs: comparison.checks.length,
      differentPairs: comparison.checks.filter((c) => c.different).length,
    }),
  );
}
