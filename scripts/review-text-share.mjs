// Review existing measurements only: no Git, app launches, builds or inference.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { setPriority, constants } from 'node:os';
import { demandModel, requireComparable } from './performance-demand.mjs';

try {
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
} catch {}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const json = async (name) => JSON.parse(await readFile(name, 'utf8'));
const fileHash = async (name) => {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(name)) h.update(chunk);
  return h.digest('hex');
};
const inside = (base, name) => {
  const path = resolve(base, name),
    local = relative(base, path);
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local));
  return path;
};
const pairs = { text: [], broad: [] },
  sources = [],
  bindings = [];
for (const side of ['before', 'candidate']) {
  const app = resolve(`.cache/performance-text-share-${side}`);
  const manifestBytes = await readFile(join(app, 'SOURCE-MANIFEST.json'));
  const manifest = JSON.parse(manifestBytes);
  for (const [name, hash] of manifest)
    assert.equal(await fileHash(inside(join(app, 'source'), name)), hash, `Source drift: ${name}`);
  sources.push(manifest);
  const text = await json(`.cache/text-share-${side}-once.json`);
  const broad = await json(`.cache/text-share-broad-${side}-once.json`);
  assert.equal(text.sourceManifestSha256, sha(manifestBytes));
  // The historical broad harness omits package.json from its runtime inventory.
  // Compare its complete inventory and bind that extra file via the text run.
  assert.deepEqual(
    text.buildManifest.filter(([name]) => name !== 'package.json'),
    broad.buildManifest,
  );
  assert.equal(sha(JSON.stringify(text.buildManifest)), text.buildSha256);
  assert.equal(sha(JSON.stringify(broad.buildManifest)), broad.buildSha256);
  for (const [name, hash] of text.buildManifest)
    assert.equal(await fileHash(inside(app, name)), hash, `Runtime drift: ${name}`);
  for (const r of [text, broad]) {
    assert.deepEqual(r.errors, []);
    assert.equal(
      sha(Buffer.concat(await Promise.all(r.harnessFiles.map((p) => readFile(p))))),
      r.harnessSha256,
    );
    assert.equal(demandModel(r).unmatchedProcessIntervals, 0);
  }
  for (const row of text.rows) {
    assert.equal(row.checkpoint.ledger.pending, 0);
    assert.equal(row.after.pending, 0);
  }
  assert.equal(text.finalLedger.pending, 0);
  assert.equal(broad.rows.at(-1).completionAfter.pending, 0);
  assert.equal(broad.rows.at(-1).completionAfter.counters.pdfTextExtractions, 0);
  const dir = resolve(`.cache/text-selection-${side}`);
  const bindingDirs = await readdir(dir, { withFileTypes: true });
  const bindingDir = bindingDirs.find((e) => e.isDirectory());
  assert.ok(bindingDir);
  const bindingPath = join(dir, bindingDir.name, 'native-selection-binding.json');
  const binding = await json(bindingPath);
  assert.deepEqual(binding.errors, []);
  assert.equal(binding.sourceManifestSha256, sha(manifestBytes));
  assert.deepEqual(new Map(binding.runtime), new Map(text.buildManifest));
  assert.equal(binding.harnessSha256, await fileHash('tests/selection-start.spec.ts'));
  bindings.push({ path: bindingPath, sha256: await fileHash(bindingPath) });
  pairs.text.push(text);
  pairs.broad.push(broad);
}
const beforeSources = new Map(sources[0]),
  candidateSources = new Map(sources[1]);
assert.deepEqual([...beforeSources.keys()], [...candidateSources.keys()]);
const differences = sources[0]
  .filter(([name, hash]) => candidateSources.get(name) !== hash)
  .map(([name]) => name);
assert.deepEqual(differences, ['src/pdfTextContent.ts']);
const beforeText = await readFile(
  '.cache/performance-text-share-before/source/src/pdfTextContent.ts',
  'utf8',
);
const candidateText = await readFile(
  '.cache/performance-text-share-candidate/source/src/pdfTextContent.ts',
  'utf8',
);
assert.equal(
  beforeText.replace('const REUSE_TEXT_CONTENT = false;', 'const REUSE_TEXT_CONTENT = true;'),
  candidateText,
);
for (const name of [
  'src/pdfTextContent.ts',
  'src/PdfTextLayer.tsx',
  'src/documentNavigation.ts',
  'src/performanceLedger.ts',
])
  assert.equal(
    await fileHash(name),
    candidateSources.get(name),
    `Production text consumer drift: ${name}`,
  );
requireComparable(pairs.broad);
assert.deepEqual(pairs.text[0].fixture, pairs.text[1].fixture);
assert.deepEqual(pairs.text[0].visuals, pairs.text[1].visuals);
assert.deepEqual(pairs.text[0].quality, pairs.text[1].quality);
assert.equal(pairs.text[0].fixture.sha256, await fileHash('.cache/text-share-fixture.pdf'));
assert.equal(
  pairs.broad[0].fixture.sha256,
  await fileHash('.cache/performance-inputs-object-edit/objects.tixtab'),
);
const quality = await json('.cache/text-share-broad-export-quality.json');
assert.equal(quality.checks.length, 2);
for (let i = 0; i < 2; i++) {
  assert.equal(
    quality.checks[i].reportSha256,
    await fileHash(`.cache/text-share-broad-${['before', 'candidate'][i]}-once.json`),
  );
  for (const artifact of pairs.broad[i].objectDownloads)
    assert.equal(await fileHash(artifact.path), artifact.sha256);
}
assert.equal(quality.checks[0].pdfSha256, quality.checks[1].pdfSha256);
assert.equal(
  quality.checks[0].pdfGraphWithoutDatesSha256,
  quality.checks[1].pdfGraphWithoutDatesSha256,
);
const summarize = (rs) => {
  const ds = rs.map(demandModel);
  return {
    cpuSeconds: ds.map((d) => d.totalCpuSeconds),
    cpuChangePercent: (ds[1].totalCpuSeconds / ds[0].totalCpuSeconds - 1) * 100,
    peak200ms: ds.map((d) => d.windows['200'].coreEquivalent.max),
    peak1000ms: ds.map((d) => d.windows['1000'].coreEquivalent.max),
    finalCounters: rs.map((r) => (r.finalLedger ?? r.rows.at(-1).completionAfter).counters),
    phases: rs[0].rows.map((r, i) => ({
      name: r.name,
      cpuSeconds: [r.cpuSeconds, rs[1].rows[i].cpuSeconds],
      frameP99Ms: [r.framesMs.p99, rs[1].rows[i].framesMs.p99],
      frameMaxMs: [r.framesMs.max, rs[1].rows[i].framesMs.max],
    })),
  };
};
const result = {
  schema: 1,
  review: 'Existing single-pair text reuse and broad correctness measurements; no rerun',
  sourceFiles: sources.map((s) => s.length),
  sourceDifferences: differences,
  runtimeFiles: pairs.text.map((r) => r.buildManifest.length),
  nativeBindings: bindings,
  text: summarize(pairs.text),
  broad: summarize(pairs.broad),
  geometrySpans: pairs.text[0].quality.spans.length,
  raster: pairs.text[0].quality.raster,
  exportQualitySha256: await fileHash('.cache/text-share-broad-export-quality.json'),
  decision:
    'Retain bounded raw PDF text reuse for fewer duplicate extractions. No peak, energy or whole-app CPU reduction claim.',
  limitations: [
    'One A/B run per workload per user instruction; no repetition, averaging or statistical significance claim.',
    'Broad workload performed zero text extractions in both builds; its CPU differences are not caused or explained by the cache. Raster/save counts and idle CPU also differ.',
    'Targeted final raster hash is equal, but raw pixel files were not retained for independent decode; native selection covers layout semantics.',
    'Cache estimates source bytes; 32 pages / 8 MB per document is not an exact heap or global multi-document memory limit.',
    'Full application regression, hardware input and final release remain separate gates.',
  ],
};
await writeFile('.cache/text-share-reviewed.json', JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    verified: true,
    sources: result.sourceFiles,
    runtime: result.runtimeFiles,
    extractions: result.text.finalCounters.map((c) => c.pdfTextExtractions),
    cpu: result.text.cpuSeconds,
    broadCpu: result.broad.cpuSeconds,
    decision: result.decision,
  }),
);
