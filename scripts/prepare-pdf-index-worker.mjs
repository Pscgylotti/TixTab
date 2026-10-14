import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const version = JSON.parse(
  await readFile(new URL('node_modules/pdfjs-dist/package.json', root), 'utf8'),
).version;
if (version !== '5.4.624')
  throw Error('Review the PDF image-index extension before upgrading PDF.js.');
let code = await readFile(new URL('node_modules/pdfjs-dist/build/pdf.worker.mjs', root), 'utf8');
const license = code.slice(0, code.indexOf('*/') + 2);
function replaceOnce(before, after) {
  if (code.split(before).length !== 2) throw Error('PDF image-index patch anchor changed.');
  code = code.replace(before, after);
}
// Keep PDF.js responsible for parsing streams, inline images, Form XObjects,
// annotations and transforms. Index mode never decodes pixels or loads fonts.
replaceOnce(
  'this._streamSink = streamSink;',
  'this._streamSink = streamSink; this.tixtabImageIndex = !!(intent & 0x10000);',
);
replaceOnce(
  '    let optionalContent;\n    if (dict.has("OC"))',
  `    if (operatorList.tixtabImageIndex) {
      if (!(dict.get("IM", "ImageMask") || false)) operatorList.addOp(OPS.paintImageXObject, ["tixtab-index", w, h]);
      return;
    }
    let optionalContent;
    if (dict.has("OC"))`,
);
replaceOnce(
  '        let fn = operation.fn;\n        switch (fn | 0) {',
  `        let fn = operation.fn;
        if (operatorList.tixtabImageIndex && fn !== OPS.save && fn !== OPS.restore && fn !== OPS.transform && fn !== OPS.paintXObject && fn !== OPS.endInlineImage) continue;
        switch (fn | 0) {`,
);
replaceOnce(
  'const localImage = localImageCache.getByName(name);',
  'const localImage = !operatorList.tixtabImageIndex && localImageCache.getByName(name);',
);
replaceOnce(
  'const cachedImage = localImageCache.getByRef(xobj) || self._regionalImageCache.getByRef(xobj) || self.globalImageCache.getData(xobj, self.pageIndex);',
  'const cachedImage = !operatorList.tixtabImageIndex && (localImageCache.getByRef(xobj) || self._regionalImageCache.getByRef(xobj) || self.globalImageCache.getData(xobj, self.pageIndex));',
);
replaceOnce(
  '    const opList = new OperatorList();\n    let optionalContent;',
  '    const opList = new OperatorList(intent);\n    let optionalContent;',
);
replaceOnce(
  '    handler.on("GetOperatorList", function (data, sink) {',
  `    handler.on("TixTabImageIndex", async function (data) {
      const pageIndex = data.pageIndex;
      if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new Error("Invalid image-index page");
      const page = await pdfManager.getPage(pageIndex), task = new WorkerTask("TixTab image index");
      const output = { fnArray: [], argsArray: [] };
      startWorkerTask(task);
      try {
        await page.getOperatorList({ handler: { send() {} }, task, pageIndex,
          intent: RenderingIntentFlag.DISPLAY | RenderingIntentFlag.OPLIST | 0x10000,
          sink: { ready: Promise.resolve(), enqueue(chunk) {
            for (let i=0;i<chunk.fnArray.length;i++) {
              if (output.fnArray.length >= 100000) throw new Error("Image-index operation limit");
              output.fnArray.push(chunk.fnArray[i]); output.argsArray.push(chunk.argsArray[i]);
            }
          } }
        });
        return output;
      } finally { finishWorkerTask(task); }
    });
    handler.on("GetOperatorList", function (data, sink) {`,
);
await mkdir(new URL('.cache/', root), { recursive: true });
const result = await build({
  write: false,
  stdin: { contents: code, sourcefile: 'tixtab-pdf-index-worker.mjs' },
  outfile: fileURLToPath(new URL('.cache/pdf-index-worker.mjs', root)),
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  legalComments: 'inline',
});

await writeFile(
  new URL('.cache/pdf-index-worker.mjs', root),
  license +
    '\n// Modified by TixTab: geometry-only image indexing; source: scripts/prepare-pdf-index-worker.mjs.\n' +
    result.outputFiles[0].text.replace(/import\(/g, 'import(/* @vite-ignore */'),
);
