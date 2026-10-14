// CPU-only layout pass. Recognition is explicitly disabled; no page text is
// collected. The same boxes are reused for every hardware/model comparison.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createWorker, PSM } from 'tesseract.js';

const folder = path.resolve(process.argv[2]);
const index = JSON.parse(await readFile(path.join(folder, 'index.json'), 'utf8'));
const started = performance.now();
const worker = await createWorker('eng', 1, {
  langPath: path.resolve('public/models/ocr'),
  gzip: false,
  cacheMethod: 'none',
});
index.layoutInitializationMs = performance.now() - started;
try {
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  for (const item of index.pages) {
    const started = performance.now();
    const { data } = await worker.recognize(
      path.join(folder, item.image),
      {},
      {
        text: false,
        layoutBlocks: true,
      },
    );
    item.layoutMs = performance.now() - started;
    item.lines = (data.layoutBlocks ?? []).flatMap((block) =>
      (block.paragraphs ?? []).flatMap((para) =>
        (para.lines ?? []).map((line) => ({
          bbox: line.bbox,
          baseline: line.baseline,
          rowAttributes: line.rowAttributes,
        })),
      ),
    );
    console.log(
      JSON.stringify({
        page: item.page,
        lines: item.lines.length,
        layoutMs: Math.round(item.layoutMs),
      }),
    );
  }
  await writeFile(path.join(folder, 'index.json'), JSON.stringify(index, null, 2));
} finally {
  await worker.terminate();
}
