import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { performanceFixture } from './performance-fixture.mjs';
const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const sharp = require('sharp');
const svgUrl = (xml) => 'data:image/svg+xml;base64,' + Buffer.from(xml).toString('base64');
const pngUrl = (bytes) => 'data:image/png;base64,' + bytes.toString('base64');

/** Synthetic readable scan, without a network font or user document. */
function scanSvg(n, width = 1600, height = 2264) {
  const lines = Array.from(
    { length: 38 },
    (_, i) =>
      `<text x="100" y="${220 + i * 43}" font-size="27" fill="#252b34">${i + 1}. Synthetic scanned page ${n + 1}: local PDF reading and annotations.</text>`,
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g"><stop stop-color="#174e86"/><stop offset="1" stop-color="#cf634c"/></linearGradient></defs><rect width="100%" height="100%" fill="#faf8f3"/><g font-family="Arial"><text x="100" y="120" font-size="54">Synthetic scan ${n + 1}</text>${lines}</g><rect x="100" y="1920" width="1400" height="200" rx="30" fill="url(#g)"/><circle cx="${250 + n * 190}" cy="2020" r="70" fill="#eccb47" fill-opacity=".6"/></svg>`;
}

export async function performanceMatrixFixture(profile) {
  if (!['scanned', 'vector', 'objects'].includes(profile)) throw Error('Unknown matrix profile');
  const pages = 16,
    strokes = 3000,
    objects = profile === 'objects' ? 240 : 80;
  const base = await performanceFixture({ pages, strokes, objects });
  const notebook = JSON.parse(base.bytes);
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date('2020-01-01T00:00:00Z'));
  pdf.setModificationDate(new Date('2020-01-01T00:00:00Z'));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const scans = [];
  if (profile === 'scanned')
    for (let n = 0; n < 4; n++)
      scans.push(
        await pdf.embedPng(
          await sharp(Buffer.from(scanSvg(n)))
            .png()
            .toBuffer(),
        ),
      );
  for (let n = 0; n < pages; n++) {
    const p = pdf.addPage([595, 842]);
    if (profile === 'scanned') {
      p.drawImage(scans[n % 4], { x: 0, y: 0, width: 595, height: 842 });
      continue;
    }
    for (let line = 0; line < 55; line++)
      p.drawText(`Page ${n + 1}: ${profile} workload, local annotations and PDF reading.`, {
        x: 30,
        y: 810 - line * 14,
        size: 9,
        font,
      });
    const count = profile === 'vector' ? 2500 : 250;
    for (let i = 0; i < count; i++)
      p.drawRectangle({
        x: 15 + ((i * 37) % 550),
        y: 20 + ((i * 53) % 780),
        width: 4 + (i % 31),
        height: 2 + (i % 12),
        opacity: 0.1 + (i % 3) * 0.05,
        color: rgb((i % 7) / 7, (i % 11) / 11, (i % 13) / 13),
        rotate: { type: 'degrees', angle: (i % 5) * 7 },
      });
  }
  notebook.source = Buffer.from(await pdf.save()).toString('base64');
  if (profile === 'objects') {
    const art = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" rx="8" fill="#478bbb" fill-opacity=".4"/>${Array.from({ length: 40 }, (_, i) => `<path d="M ${i * 3} 0 Q ${120 - i * 2} 40 ${i * 3} 80" fill="none" stroke="${i % 2 ? '#ce4666' : '#285a87'}" stroke-opacity=".4"/>`).join('')}</svg>`;
    const formula = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><text x="6" y="48" font-family="Times New Roman" font-size="32">∫ x² dx</text></svg>`;
    const label = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><text x="6" y="40" font-family="Arial" font-size="18" fill="#285a87">Local note</text></svg>`;
    const photo = scanSvg(1, 160, 226);
    const assets = await Promise.all(
      [photo, art, formula, label].map(async (xml) => ({
        data: pngUrl(await sharp(Buffer.from(xml)).png().toBuffer()),
        displayData: svgUrl(xml),
      })),
    );
    const leaf = (id, type, x = 0, y = 0, width = 120, height = 80) => ({
      id,
      ...assets[type],
      x,
      y,
      width,
      height,
      kind: ['image', 'sketch', 'formula', 'text'][type],
      ...(type === 1 ? { scene: { elements: [] } } : {}),
      ...(type === 2 ? { latex: '\\int x^2 dx' } : {}),
      ...(type === 3
        ? { textBox: { content: 'Local note', fontSize: 18, color: '#285a87', bold: false } }
        : {}),
    });
    for (let n = 0; n < pages; n++) {
      const count = n === 0 ? objects : 12;
      notebook.pages[n].images = Array.from({ length: count }, (_, i) => {
        const x = 20 + (i % 8) * 70,
          y = 30 + Math.floor(i / 8) * 28;
        if (i % 5 !== 4) return leaf(`complex-${n}-${i}`, i % 5, x, y, 100, 60);
        const inner = {
          ...leaf(`inner-${n}-${i}`, 0, 0, 0, 60, 80),
          group: {
            width: 120,
            height: 80,
            objects: [leaf(`a-${n}-${i}`, 1, 0, 0, 60, 80), leaf(`b-${n}-${i}`, 2, 60, 0, 60, 80)],
          },
        };
        return {
          ...leaf(`group-${n}-${i}`, 0, x, y, 100, 60),
          group: {
            width: 120,
            height: 80,
            objects: [inner, leaf(`c-${n}-${i}`, 3, 60, 0, 60, 80)],
          },
        };
      });
      notebook.pages[n].inkLayer = Math.floor(notebook.pages[n].images.length / 2);
    }
  }
  notebook.name = `Synthetic ${profile} performance workload`;
  const bytes = Buffer.from(JSON.stringify(notebook));
  if (bytes.length > 32 * 1024 * 1024) throw Error('Matrix fixture exceeded 32 MiB budget');
  return {
    bytes,
    description: {
      synthetic: true,
      profile,
      pages,
      strokes,
      objects,
      seed: 813,
      scanPixels: profile === 'scanned' ? [1600, 2264] : null,
      vectorRectanglesPerPage: profile === 'vector' ? 2500 : profile === 'objects' ? 250 : 0,
      nestedGroups: profile === 'objects',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      limits:
        'Synthetic page/asset render stress, not real handwriting/recognition accuracy or full Excalidraw editing. Four distinct scans reused across 16 pages; image generation is outside app measurement.',
    },
  };
}
