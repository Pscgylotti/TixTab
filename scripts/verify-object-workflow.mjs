import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { PDFDocument, PDFDict, PDFArray, PDFRawStream } from 'pdf-lib';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { readPerformanceFixture } from './performance-fixture.mjs';
import { requireComparable, demandModel } from './performance-demand.mjs';
const { values } = parseArgs({
  options: {
    report: { type: 'string', multiple: true },
    'fixture-file': { type: 'string' },
    model: { type: 'string', default: 'src/model.ts' },
    'artifact-dir': { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.report?.length || !values['fixture-file'] || !values.output)
  throw Error('Supply reports, authored fixture and fresh output');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const bundle = await build({
  entryPoints: [values.model],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { validNotebook } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
const fixture = await readPerformanceFixture(values['fixture-file']),
  original = JSON.parse(fixture.bytes);
assert(validNotebook(original));
assert.equal(original.pages[0].images.length, 240);
assert(
  original.pages[0].images.every(
    (i) => i.x >= 0 && i.y >= 0 && i.x + i.width <= 595 && i.y + i.height <= 842,
  ),
);
const normalizeIds = (value) =>
  Array.isArray(value)
    ? value.map(normalizeIds)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([k]) => k !== 'id')
            .map(([k, v]) => [k, normalizeIds(v)]),
        )
      : value;
// Include annotation appearance streams and their image/mask/resources, not only
// page Contents. Ignore document dates, which do not affect displayed content.
const pdfValue = (value) =>
  value instanceof PDFRawStream
    ? { dictionary: pdfValue(value.dict), contents: sha(value.getContents()) }
    : value instanceof PDFDict
      ? Object.fromEntries(
          value
            .entries()
            .map(([k, v]) => [k.decodeText(), v])
            .filter(([k]) => k !== 'CreationDate' && k !== 'ModDate')
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, pdfValue(v)]),
        )
      : value instanceof PDFArray
        ? value.asArray().map(pdfValue)
        : value.toString();
const reports = [],
  checks = [];
let projectOracle, pdfOracle;
for (const path of values.report) {
  const stored = await readFile(path),
    raw = path.endsWith('.gz') ? gunzipSync(stored) : stored,
    report = JSON.parse(raw);
  reports.push(report);
  requireComparable([report]);
  assert.equal(demandModel(report).unmatchedProcessIntervals, 0);
  assert.equal(report.rows.length, 15);
  assert.equal(report.objectDownloads.length, 2);
  const artifacts = {};
  for (const a of report.objectDownloads) {
    const path = values['artifact-dir']
      ? join(values['artifact-dir'], basename(a.path.replaceAll('\\', '/')))
      : a.path;
    const bytes = await readFile(path);
    assert.equal(sha(bytes), a.sha256);
    assert.equal(bytes.length, a.bytes);
    assert.equal(a.state, 'completed');
    artifacts[a.kind] = bytes;
  }
  const project = JSON.parse(artifacts.project);
  assert(validNotebook(project));
  assert.equal(project.pages.length, 16);
  assert.equal(project.source, original.source);
  assert.deepEqual(project.pages[0].strokes, original.pages[0].strokes);
  assert.deepEqual(project.pages.slice(1), original.pages.slice(1));
  assert.equal(project.pages[0].images.length, 1);
  assert.equal(project.pages[0].inkLayer, 0);
  const group = project.pages[0].images[0];
  assert.equal(group.group.objects.length, 240);
  assert.equal(new Set(group.group.objects.map((i) => i.id)).size, 240);
  assert(group.group.objects.every((i) => typeof i.id === 'string' && i.id.length));
  const scale = ((537 - 40) * 537 + (777 - 60) * 777) / (537 ** 2 + 777 ** 2);
  for (const [actual, expected] of [
    [group.x, 35],
    [group.y, 32],
    [group.width, 537 * scale],
    [group.height, 777 * scale],
  ])
    assert(Math.abs(actual - expected) < 1e-9);
  for (let i = 0; i < 240; i++) {
    const before = original.pages[0].images[i],
      after = group.group.objects[i];
    assert(Math.abs(after.x - (before.x - 18) * scale) < 1e-9);
    assert(Math.abs(after.y - (before.y - 22) * scale) < 1e-9);
    assert(Math.abs(after.width - before.width * scale) < 1e-9);
    assert(Math.abs(after.height - before.height * scale) < 1e-9);
    for (const key of ['kind', 'data', 'displayData', 'scene', 'latex', 'textBox', 'group'])
      assert.deepEqual(after[key], before[key]);
  }
  const canonical = normalizeIds(project);
  delete canonical.pages[0].images[0].data;
  if (projectOracle) assert.deepEqual(canonical, projectOracle);
  else projectOracle = canonical;
  const png = Buffer.from(group.data.split(',')[1], 'base64');
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, Math.ceil(group.width * 4));
  assert.equal(info.height, Math.ceil(group.height * 4));
  const pdf = await PDFDocument.load(artifacts.pdf);
  assert.equal(pdf.getPageCount(), 16);
  const graph = pdf.context
    .enumerateIndirectObjects()
    .map(([ref, value]) => [ref.toString(), pdfValue(value)]);
  const pdfSignature = sha(JSON.stringify(graph));
  if (pdfOracle) assert.equal(pdfSignature, pdfOracle);
  else pdfOracle = pdfSignature;
  checks.push({
    report: path,
    reportSha256: sha(raw),
    projectSha256: sha(artifacts.project),
    svgSha256: sha(group.displayData),
    pngSha256: sha(png),
    straightRgbaSha256: sha(data),
    pngDimensions: [info.width, info.height],
    originalObjects: 240,
    hierarchyPreserved: true,
    inkLayer: 0,
    strokes: 3000,
    pages: pdf.getPageCount(),
    pdfSha256: sha(artifacts.pdf),
    pdfGraphWithoutDatesSha256: pdfSignature,
  });
}
requireComparable(reports);
await writeFile(
  values.output,
  JSON.stringify(
    {
      schema: 1,
      checks,
      fixtureSha256: fixture.description.sha256,
      modelSha256: sha(await readFile(values.model)),
      harnessSha256: sha(await readFile(new URL(import.meta.url))),
      limits:
        'Authored mixed/nested stress fixture. Actual model accepts all saved projects; original metadata/affine transforms/ink order and full PDF object graph including annotation appearances are checked. PNG encoder straight-alpha rounding is evaluated separately by native rendering; do not call differing raw PNG bytes or straight RGBA identical. PDF dates ignored; IDs preserved in PDF graph. Not real Excalidraw editing or physical pen validation.',
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    passed: true,
    workflows: checks.length,
    pagesPerPdf: 16,
    childrenPerGroup: 240,
    pdfGraphEqualIgnoringDates: true,
  }),
);
