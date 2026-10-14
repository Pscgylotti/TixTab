// Preserve already-completed experiments without launching builds or benchmarks.
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { setPriority, constants } from 'node:os';
import assert from 'node:assert/strict';
try {
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
} catch {}
const root = resolve('docs/performance/2026-10-14-text-share');
assert.equal(
  await access(join(root, 'MANIFEST.json')).then(
    () => true,
    () => false,
  ),
  false,
  'Archive already finalized',
);
await mkdir(root, { recursive: true });
await mkdir(join(root, 'blobs'), { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = [],
  hashes = new Set();
async function add(name, path) {
  const bytes = await readFile(path),
    hash = sha(bytes);
  if (!hashes.has(hash)) {
    try {
      await writeFile(join(root, 'blobs', hash), bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assert.equal(sha(await readFile(join(root, 'blobs', hash))), hash);
    }
    hashes.add(hash);
  }
  files.push({ name, sha256: hash, bytes: bytes.length });
}
const inputs = [
  '.cache/text-share-reviewed.json',
  '.cache/text-share-reviewed-fixed.log',
  '.cache/text-share-reviewed.log', // Initial review inventory mismatch retained.
  '.cache/text-share-before-once.json',
  '.cache/text-share-candidate-once.json',
  '.cache/text-share-before-once.log',
  '.cache/text-share-candidate-once.log',
  '.cache/text-share-broad-before-once.json',
  '.cache/text-share-broad-candidate-once.json',
  '.cache/text-share-broad-before-once.log',
  '.cache/text-share-broad-candidate-once.log',
  '.cache/text-share-broad-before-setup-failed.log',
  '.cache/text-share-broad-export-quality.json',
  '.cache/text-share-broad-export-quality.log',
  '.cache/text-share-archive.log',
  '.cache/text-share-fixture.pdf',
  '.cache/performance-inputs-object-edit/objects.tixtab',
  '.cache/performance-inputs-object-edit/objects.tixtab.json',
  '.cache/text-share-unit.log',
  '.cache/text-share-types-fixed.log',
  '.cache/text-share-browser-quality.log',
  '.cache/text-selection-before.log',
  '.cache/text-selection-candidate.log',
  '.cache/text-share-build-before.log',
  '.cache/text-share-build-candidate.log',
];
for (const file of inputs) await add('evidence/' + file.replace(/^\.cache\//, ''), file);
for (const side of ['before', 'candidate']) {
  const app = resolve(`.cache/performance-text-share-${side}`);
  await add(`${side}/SOURCE-MANIFEST.json`, join(app, 'SOURCE-MANIFEST.json'));
  await add(`${side}/control-description.json`, join(app, 'control-description.json'));
  const sources = JSON.parse(await readFile(join(app, 'SOURCE-MANIFEST.json')));
  for (const [name, hash] of sources) {
    const path = resolve(app, 'source', name),
      local = relative(join(app, 'source'), path);
    assert.ok(local && !local.startsWith('..') && !isAbsolute(local));
    await add(`${side}/source/${name}`, path);
    assert.equal(files.at(-1).sha256, hash);
  }
  const report = JSON.parse(await readFile(`.cache/text-share-broad-${side}-once.json`));
  for (const artifact of report.objectDownloads) {
    await add(`${side}/exports/${artifact.kind}`, artifact.path);
    assert.equal(files.at(-1).sha256, artifact.sha256);
  }
  const dir = resolve(`.cache/text-selection-${side}`);
  for (const entry of await readdir(dir, { withFileTypes: true }))
    if (entry.isDirectory())
      await add(
        `${side}/native-selection-binding.json`,
        join(dir, entry.name, 'native-selection-binding.json'),
      );
}
for (const name of [
  'scripts/build-text-control.mjs',
  'scripts/benchmark-text-workflow.mjs',
  'scripts/benchmark-workflow.mjs',
  'scripts/performance-settle.mjs',
  'scripts/performance-demand.mjs',
  'scripts/performance-fixture.mjs',
  'scripts/object-workflow.mjs',
  'scripts/verify-object-workflow.mjs',
  'scripts/review-text-share.mjs',
  'scripts/archive-text-share.mjs',
  'tests/selection-start.spec.ts',
])
  await add('tools/' + name, name);
const summary = JSON.parse(await readFile('.cache/text-share-reviewed.json'));
await writeFile(join(root, 'RESULT.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
await writeFile(
  join(root, 'MANIFEST.json'),
  JSON.stringify(
    {
      schema: 1,
      kind: 'single-pair-text-reuse-review',
      storage:
        'Uncompressed content-addressed blobs; filenames are SHA256. Read MANIFEST names to restore files.',
      runtimeScope:
        'Runtime bytes verified against both frozen local apps during review. Runtime inventories retained in reports/native bindings; full runtime binaries are not duplicated here. Sources, locked dependencies, fixtures, samples and actual exports are retained.',
      files,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
// Read back every stored blob once, without compression or concurrent workers.
for (const hash of hashes) assert.equal(sha(await readFile(join(root, 'blobs', hash))), hash);
const readme = `# 有界 PDF 文本内容复用：单次对照

保留 raw PDF.js 文本内容复用。选文层与搜索/链接共享默认提取结果，各自保持 DOM、字体布局及阅读顺序。按 PDFDocumentProxy 身份隔离；每文档最多 32 页、估计 8 MB，失败可重试，关闭文档后可随引用释放。这是源数据估算上限，不是精确堆或全局内存上限。

两版各 262 份来源，唯一差异为复用开关。实际运行文件、来源与原生选文测试绑定复核通过。目标/广泛流程各只执行一次 A/B，按用户要求不重复取均值；本次整理只读取现有文件，没有重跑应用、推理或安装器。

| 指标 | 基线 → 候选 |
| --- | --- |
| 12 页阅读/搜索/切换工具实际提取 | 30 → 12 |
| 缓存命中 | 0 → 18 |
| 目标流程累计 CPU 秒 | 13.326 → 12.450（单次 -6.6%） |
| 200 ms 最高核等效需求 | 1.718 → 1.791（升高） |
| 最后可见文字布局 | 46 个 span 文本/坐标及页面边界相同 |
| 最后页面 raster | 同尺寸、同 SHA256；未保存原始像素文件供独立解码 |

两版原生选文分别通过行首边缘、栏间、缩放、RTL、旋转及反向拖动检查；核心缓存/导航/账本 13 单元和四项浏览器检查日志保留。只覆盖所列范围，不代表整个应用回归完成。

16 页/3000 笔迹/240 混合嵌套对象的广泛流程：实际工程结构、对象变换、层级、笔迹和全 PDF 对象图校验通过，两份 PDF 文件逐字节一致。该流程两版文本提取均为 **0**；累计 CPU 34.121→25.581 秒，以及 raster、保存、空闲等差异，不能归因于文本缓存。原始数据完整保留，不将较大的数值改善当成应用优化成果。

本项按确定的重复提取减少保留，不宣称降低尖峰、能耗或整机功率。构建/设置/安装器后续改动不在这些冻结测试范围内。0.3.0 的其它活跃待办、真实输入、模型及最终发布门槛继续开放。

MANIFEST.json 将逻辑路径映射到 blobs/<SHA256>。包括两版完整来源/锁文件、四份原始报告与采样、合成输入、实际工程/PDF 导出、质量记录、原生绑定和工具。当前归档不重复完整运行时二进制；报告中的实际运行文件哈希已在本机冻结应用上复核。初次 review 因两个 harness 对 package.json 的清单范围不同而失败，保留原日志，修正为各自完整清单验证；没有改写原始测量。早期缺失 fixture sidecar 的准备失败也保留，不算额外正式轮次。
`;
await writeFile(join(root, 'README.md'), readme, { flag: 'wx' });
console.log(
  JSON.stringify({
    archive: root,
    entries: files.length,
    uniqueBlobs: hashes.size,
    verified: true,
  }),
);
