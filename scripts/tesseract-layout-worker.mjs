// Development CPU layout bridge. Never calls Recognize: layoutBlocks only.
import path from 'node:path';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { createWorker, PSM } from 'tesseract.js';

const folder = path.resolve(process.argv[2]);
const send = (value) => process.stdout.write(`TIXTAB_LAYOUT ${JSON.stringify(value)}\n`);
const start = performance.now();
const worker = await createWorker('eng', 1, {
  langPath: path.resolve('public/models/ocr'),
  gzip: false,
  cacheMethod: 'none',
});
try {
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  send({ ready: true, ms: performance.now() - start });
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.length > 512) throw new Error('Invalid layout command');
    const { id, image } = JSON.parse(line);
    if (!Number.isInteger(id) || !/^page-\d{3}\.(jpeg|jpg|png)$/.test(image))
      throw new Error('Invalid layout input');
    const before = performance.now();
    const { data } = await worker.recognize(
      path.join(folder, image),
      {},
      {
        text: false,
        layoutBlocks: true,
      },
    );
    send({
      id,
      ms: performance.now() - before,
      rss: process.memoryUsage().rss,
      lines: (data.layoutBlocks ?? []).flatMap((block) =>
        (block.paragraphs ?? []).flatMap((para) =>
          (para.lines ?? []).map((line) => ({ bbox: line.bbox })),
        ),
      ),
    });
  }
} finally {
  await worker.terminate();
}
