import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const { PDFDocument, StandardFonts, rgb } = createRequire(import.meta.url)('pdf-lib');

/** Cached authored inputs keep image generation outside the measured app workflow. */
export async function readPerformanceFixture(path) {
  const bytes = await readFile(path);
  const description = JSON.parse(await readFile(path + '.json', 'utf8'));
  if (
    description.synthetic !== true ||
    createHash('sha256').update(bytes).digest('hex') !== description.sha256 ||
    bytes.length !== description.bytes ||
    !Number.isInteger(description.pages) ||
    description.pages < 1 ||
    description.pages > 1000
  )
    throw Error('Invalid or changed synthetic performance fixture');
  const parsed = JSON.parse(bytes);
  if (parsed.pages?.length !== description.pages) throw Error('Fixture page count mismatch');
  return { bytes, description };
}

/** Fixed seed, PDF metadata and vector points make before/after input identical. */
export async function performanceFixture({
  pages = 40,
  strokes = 3000,
  objects = 80,
  seed = 813,
} = {}) {
  let state = seed;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date('2020-01-01T00:00:00Z'));
  pdf.setModificationDate(new Date('2020-01-01T00:00:00Z'));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 0; n < pages; n++) {
    const p = pdf.addPage([595, 842]);
    for (let line = 0; line < 55; line++)
      p.drawText(`Page ${n + 1}: computational demand, annotations and PDF reading.`, {
        x: 30,
        y: 810 - line * 14,
        size: 9,
        font,
      });
    for (let i = 0; i < 250; i++)
      p.drawRectangle({
        x: random() * 550,
        y: random() * 780,
        width: 5 + random() * 30,
        height: 2 + random() * 12,
        opacity: 0.15,
        color: rgb(random(), random(), random()),
      });
  }
  const source = Buffer.from(await pdf.save()).toString('base64');
  const data =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=';
  const notebook = {
    version: 1,
    name: 'Performance workload',
    source,
    pages: Array.from({ length: pages }, (_, n) => ({
      id: `perf-page-${n}`,
      sourceIndex: n,
      width: 595,
      height: 842,
      paper: 'plain',
      strokes: Array.from({ length: n === 0 ? strokes : 15 }, (_, i) => {
        const x = 25 + random() * 510,
          y = 30 + random() * 760;
        return {
          id: `stroke-${n}-${i}`,
          tool: ['pen', 'highlighter', 'pencil', 'ballpoint'][i % 4],
          color: ['#263b67', '#e9c526', '#b35c66'][i % 3],
          size: i % 4 === 1 ? 9 : 2,
          points: Array.from({ length: 12 }, (_, j) => [
            x + j * 2,
            y + Math.sin(j * 0.6) * 4,
            0.3 + random() * 0.6,
          ]),
        };
      }),
      images: Array.from({ length: n === 0 ? objects : 2 }, (_, i) => ({
        id: `object-${n}-${i}`,
        kind: i % 2 ? 'image' : 'sketch',
        data,
        displayData: `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="60" height="35"><rect width="60" height="35" fill="#478bbb" fill-opacity=".4"/><path d="M0 20 Q30 0 60 20" stroke="#cc4b3e" fill="none"/></svg>`).toString('base64')}`,
        x: 30 + (i % 8) * 65,
        y: 40 + Math.floor(i / 8) * 60,
        width: 50,
        height: 30,
      })),
    })),
  };
  const bytes = Buffer.from(JSON.stringify(notebook));
  return {
    bytes,
    description: {
      pages,
      strokes,
      objects,
      seed,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    },
  };
}
