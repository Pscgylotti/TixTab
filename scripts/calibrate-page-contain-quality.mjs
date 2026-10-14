import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { novelRgba } from './observed-rgba.mjs';
const { values } = parseArgs({
  options: {
    'candidate-report': { type: 'string' },
    'reference-report': { type: 'string', multiple: true },
    output: { type: 'string' },
  },
});
assert(values['candidate-report'] && values['reference-report']?.length && values.output);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const paths = [
  ...new Set([...values['reference-report'], values['candidate-report']].map((p) => resolve(p))),
];
const reports = await Promise.all(
  paths.map(async (path) => {
    const bytes = await readFile(path);
    return { path, report: JSON.parse(bytes), sha256: sha(bytes) };
  }),
);
const target = reports.find((r) => r.path === resolve(values['candidate-report']));
assert(target.report.contentPass);
assert.deepEqual(target.report.errors, []);
const source = target.report.sources.baseline.sourceManifestSha256;
const references = reports.flatMap((r) =>
  ['baseline', 'candidate']
    .filter((label) => r.report.sources[label].sourceManifestSha256 === source)
    .map((label) => ({ ...r, label })),
);
assert(references.length >= 2);
for (const r of references) {
  assert.equal(r.report.harnessSha256, target.report.harnessSha256);
  assert.equal(r.report.scenariosSha256, target.report.scenariosSha256);
  assert.equal(r.report.fixtureSha256, target.report.fixtureSha256);
  assert.deepEqual(r.report.visuals[r.label], target.report.visuals.candidate);
  assert.equal(
    r.report.sources[r.label].runtimeSha256,
    sha(JSON.stringify(r.report.sources[r.label].runtime)),
  );
}
const checks = [];
for (const row of target.report.renders.candidate) {
  const refs = references.map((r) => ({
    capture: r,
    row: r.report.renders[r.label].find((x) => x.id === row.id),
  }));
  for (const r of refs) {
    assert(r.row, row.id);
    assert.deepEqual(r.row.geometry, row.geometry);
    assert.deepEqual(r.row.root, row.root);
    assert.deepEqual(r.row.raster, row.raster);
  }
  const decode = async (path, image) => {
    const bytes = await readFile(join(dirname(path), image.name));
    assert.equal(sha(bytes), image.sha256);
    return sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  };
  const c = await decode(target.path, row),
    buffers = await Promise.all(refs.map((r) => decode(r.capture.path, r.row)));
  for (const ref of buffers) assert.deepEqual(ref.info, c.info);
  const result = novelRgba(
    c.data,
    buffers.map((r) => r.data),
  );
  checks.push({ id: row.id, width: c.info.width, height: c.info.height, ...result });
}
const report = {
  schema: 1,
  pass: checks.every((c) => !c.novelPixels),
  checks,
  references: references.map((r) => ({ path: r.path, label: r.label, sha256: r.sha256 })),
  candidate: {
    path: target.path,
    sha256: target.sha256,
    source: target.report.sources.candidate.sourceManifestSha256,
  },
  baselineSource: source,
  harnessSha256: sha(await readFile(new URL(import.meta.url))),
  helperSha256: sha(await readFile(new URL('./observed-rgba.mjs', import.meta.url))),
  limits:
    'Finite observed baseline RGBA tuples at each exact pixel; no numeric tolerance and no interpolation. Geometry, object rasters, ink rasters and SVG markup must all match. This does not prove every future compositor state or GPU driver. Original strict pair failures remain unchanged.',
};
await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(
  JSON.stringify({
    pass: report.pass,
    referenceCaptures: references.length,
    checks: checks.length,
    novel: checks.filter((c) => c.novelPixels),
  }),
);
if (!report.pass) process.exitCode = 1;
