import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { PDFDocument } from 'pdf-lib';
import { readPerformanceFixture } from './performance-fixture.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: { fixtures: { type: 'string' }, model: { type: 'string', default: 'src/model.ts' } },
});
if (!values.fixtures) throw Error('Supply prepared --fixtures directory');
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
const results = [];
for (const profile of ['scanned', 'vector', 'objects']) {
  const { bytes, description } = await readPerformanceFixture(
    join(values.fixtures, profile + '.tixtab'),
  );
  const n = JSON.parse(bytes);
  assert(validNotebook(n), `${profile}: invalid actual app model`);
  const pdf = await PDFDocument.load(Buffer.from(n.source, 'base64'));
  assert.equal(pdf.getPageCount(), 16);
  assert.equal(n.pages[0].strokes.length, 3000);
  assert.equal(n.pages[0].images.length, description.objects);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 595, height: 842 });
  const kinds = [...new Set(n.pages[0].images.map((i) => i.kind))].sort();
  if (profile === 'objects') {
    assert.deepEqual(kinds, ['formula', 'image', 'sketch', 'text']);
    assert(n.pages[0].images.some((i) => i.group?.objects.some((child) => child.group)));
    assert.equal(n.pages[0].inkLayer, 120);
  }
  results.push({
    profile,
    sha256: description.sha256,
    model: true,
    pages: pdf.getPageCount(),
    kinds,
    nestedGroups: description.nestedGroups,
  });
}
// Integrity must reject truncation and a re-hashed but structurally inconsistent count.
const dir = await mkdtemp(join(tmpdir(), 'tixtab-fixture-integrity-'));
const file = join(dir, 'invalid.tixtab');
const body = Buffer.from(JSON.stringify({ pages: [{}, {}] }));
const description = {
  synthetic: true,
  bytes: body.length,
  pages: 2,
  sha256: createHash('sha256').update(body).digest('hex'),
};
await writeFile(file, body);
await writeFile(file + '.json', JSON.stringify(description));
await readPerformanceFixture(file);
await writeFile(file, body.subarray(1));
await assert.rejects(readPerformanceFixture(file), /Invalid or changed/);
await writeFile(file, body);
await writeFile(file + '.json', JSON.stringify({ ...description, pages: 3 }));
await assert.rejects(readPerformanceFixture(file), /page count mismatch/);
console.log(JSON.stringify({ passed: true, results, integrityRejections: 2 }));
