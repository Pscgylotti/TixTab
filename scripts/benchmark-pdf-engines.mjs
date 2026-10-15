import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const argv = process.argv.slice(2);
const option = (key, fallback) => {
  const i = argv.indexOf(key);
  return i < 0 ? fallback : argv[i + 1];
};
const book = resolve(
  option(
    '--pdf',
    'C:/UserData/Readings/Books/maths/Optimal transport old and new Part 1 = 最优输运 第1分册 (Cédric Villani) (Z-Library).pdf',
  ),
);
const out = resolve(option('--out', '.cache/pdfium-render-benchmark'));
const base = option('--base', 'http://127.0.0.1:5173');
const first = Number(option('--first', '40')),
  last = Number(option('--last', '100'));
if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first)
  throw Error('Invalid page range');
await mkdir(out, { recursive: true });
const vector = await PDFDocument.create(),
  font = await vector.embedFont(StandardFonts.Helvetica);
for (let n = 0; n < 12; n++) {
  const page = vector.addPage([600, 800]);
  for (let row = 0; row < 55; row++)
    page.drawText(`Vector/text sample ${n + 1}: rendering PDF content without OCR.`, {
      x: 30,
      y: 770 - row * 13,
      font,
      size: 9,
    });
  for (let k = 0; k < 800; k++)
    page.drawLine({
      start: { x: 30 + (k % 500), y: 50 + (k % 600) },
      end: { x: 35 + (k % 500), y: 60 + (k % 600) },
      thickness: 0.4,
      color: rgb((k % 7) / 7, (k % 9) / 9, (k % 11) / 11),
    });
}
const vectorFile = join(out, 'vector-fixture.pdf');
await writeFile(vectorFile, await vector.save());
const server = createServer(async (req, res) => {
  const file = req.url === '/book.pdf' ? book : req.url === '/vector.pdf' ? vectorFile : null;
  if (!file) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', base);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', (await stat(file)).size);
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixtureBase = `http://127.0.0.1:${server.address().port}`;
const execute = promisify(execFile);
async function processMemory(cdp) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const ids = processInfo.map((p) => Number(p.id)).filter(Number.isSafeInteger);
  const { stdout } = await execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$taskProcesses = Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue; [pscustomobject]@{ privateBytes = ($taskProcesses | Measure-Object PrivateMemorySize64 -Sum).Sum; workingSetBytes = ($taskProcesses | Measure-Object WorkingSet64 -Sum).Sum } | ConvertTo-Json -Compress`,
    ],
    { windowsHide: true },
  );
  return JSON.parse(stdout);
}
const results = [];
try {
  for (const dataset of [
    { label: 'scanned-book', route: 'book', first, last },
    { label: 'vector-text', route: 'vector', first: 1, last: 12 },
  ]) {
    for (const backend of ['pdfjs', 'pdfium']) {
      const browser = await chromium.launch({
        executablePath:
          process.env.SURFACETAB_CHROME ||
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: true,
      });
      try {
        const page = await browser.newPage({
          viewport: { width: 1440, height: 960 },
          deviceScaleFactor: 1,
        });
        await page.goto(base);
        await page.waitForFunction(() => {
          const button = [...document.querySelectorAll('button')].find(
            (button) => button.textContent?.trim() === '打开',
          );
          return button && !button.disabled;
        });
        const cdp = await browser.newBrowserCDPSession();
        const baselineMemory = await processMemory(cdp);
        const beforeCpu = (await cdp.send('SystemInfo.getProcessInfo')).processInfo;
        const open = await page.evaluate(
          async ({ url, backend }) => {
            const { loadPdf } = await import('/src/pdf.ts');
            const { renderPdfium } = await import('/src/pdfiumRaster.ts');
            const { setPdfRenderBackend } = await import('/src/appearance.ts');
            setPdfRenderBackend(backend);
            const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
            const start = performance.now();
            const pdf = await loadPdf(bytes);
            window.__pdfEngineBench = { pdf, bytes, renderPdfium };
            return { parseMs: performance.now() - start, pages: pdf.numPages, bytes: bytes.length };
          },
          { url: `${fixtureBase}/${dataset.route}.pdf`, backend },
        );
        if (open.pages < dataset.last) throw Error('Input has too few pages');
        const rows = [],
          memory = [];
        for (let number = dataset.first; number <= dataset.last; number++) {
          const row = await page.evaluate(
            async ({ number, backend }) => {
              const { pdf, renderPdfium } = window.__pdfEngineBench;
              const metaStart = performance.now();
              const page = await pdf.getPage(number);
              const natural = page.getViewport({ scale: 1 });
              const scale = Math.min(1.5, Math.sqrt(4_000_000 / (natural.width * natural.height)));
              const viewport = page.getViewport({ scale });
              const canvas = document.createElement('canvas');
              canvas.width = Math.ceil(viewport.width);
              canvas.height = Math.ceil(viewport.height);
              const ctx = canvas.getContext('2d', { alpha: true });
              const metadataMs = performance.now() - metaStart;
              const start = performance.now();
              if (backend === 'pdfium')
                await renderPdfium(pdf, number - 1, canvas, canvas.width, canvas.height, {
                  x: 0,
                  y: 0,
                  width: canvas.width,
                  height: canvas.height,
                }).promise;
              else
                await page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' })
                  .promise;
              const renderMs = performance.now() - start;
              const pixels = canvas.width * canvas.height;
              const sample = Array.from(
                ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)
                  .data,
              );
              const { getPdfiumStats } = await import('/src/pdfiumRaster.ts');
              const wasmHeap = getPdfiumStats().heapBytes;
              canvas.width = canvas.height = 1;
              page.cleanup();
              return {
                page: number,
                width: Math.ceil(viewport.width),
                height: Math.ceil(viewport.height),
                scale,
                pixels,
                metadataMs,
                renderMs,
                wasmHeap,
                sample,
              };
            },
            { number, backend },
          );
          rows.push(row);
          if (
            number === dataset.first ||
            number === Math.floor((dataset.first + dataset.last) / 2) ||
            number === dataset.last
          )
            memory.push({ page: number, ...(await processMemory(cdp)) });
          if ((number - dataset.first) % 10 === 0 || number === dataset.last)
            console.log(
              `${dataset.label}/${backend}: ${number}/${dataset.last}, ${row.renderMs.toFixed(1)} ms`,
            );
        }
        const afterCpu = (await cdp.send('SystemInfo.getProcessInfo')).processInfo;
        const startingCpu = new Map(beforeCpu.map((p) => [p.id, p.cpuTime]));
        const cpuSeconds = afterCpu.reduce(
          (sum, p) => sum + Math.max(0, p.cpuTime - (startingCpu.get(p.id) || 0)),
          0,
        );
        const renderMs = rows.reduce((sum, row) => sum + row.renderMs, 0);
        const pixels = rows.reduce((sum, row) => sum + row.pixels, 0);
        const afterCloseEngine = await page.evaluate(async () => {
          await window.__pdfEngineBench.pdf.destroy();
          delete window.__pdfEngineBench;
          const { getPdfiumStats } = await import('/src/pdfiumRaster.ts');
          for (let n = 0; n < 200 && getPdfiumStats().pending; n++)
            await new Promise((resolve) => setTimeout(resolve, 10));
          return getPdfiumStats();
        });
        const result = {
          dataset: dataset.label,
          backend,
          first: dataset.first,
          last: dataset.last,
          ...open,
          frames: rows.length,
          firstFrameMs: rows[0].renderMs,
          steadyFrameMedianMs: rows
            .slice(1)
            .map((r) => r.renderMs)
            .sort((a, b) => a - b)[Math.floor((rows.length - 1) / 2)],
          renderMs,
          pagesPerSecond: (rows.length * 1000) / renderMs,
          megapixelsPerSecond: pixels / 1000 / renderMs,
          cpuSeconds,
          baselineMemory,
          sampledMemory: memory,
          afterCloseMemory: await processMemory(cdp),
          afterCloseEngine,
          rows,
        };
        results.push(result);
        await writeFile(join(out, 'results.partial.json'), JSON.stringify(results, null, 2));
      } finally {
        await browser.close();
      }
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
const sourceFiles = [
  'src/pdfium.worker.ts',
  'src/pdfiumRaster.ts',
  'src/pdfRenderCache.ts',
  'src/pdf.ts',
  'src/appearance.ts',
];
const sources = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    ]),
  ),
);
const report = {
  timestamp: new Date().toISOString(),
  methodology:
    'One pass per engine/input in a fresh browser. Identical output pixel budget, sequential pages, no page raster cache, page resources released between pages. PDFium uses the current hybrid adapter (PDF.js metadata remains); raster time includes worker transport and canvas presentation. First frame includes lazy WASM initialization/document import. Initialized engine remains resident after document close; closure waits for pending release messages. No repeated-run means or energy claims. Process memory is summed over this browser process tree at three checkpoints; sampled maximum is not a true peak. CPU time includes document setup and browser work.',
  sources,
  results,
};
await writeFile(join(out, 'results.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    results.map(({ rows, sampledMemory, ...result }) => ({
      ...result,
      sampledMaxPrivateMiB: Math.max(...sampledMemory.map((row) => row.privateBytes)) / 1048576,
    })),
    null,
    2,
  ),
);
