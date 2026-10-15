import { mkdir, copyFile, readdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const destination = new URL('../public/ort/', import.meta.url);
await mkdir(destination, { recursive: true });
const source = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url);
for (const name of await readdir(source))
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(name))
    await copyFile(new URL(name, source), new URL(name, destination));
const ocr = new URL('../public/ocr/', import.meta.url);
await mkdir(ocr, { recursive: true });
await copyFile(
  new URL('../node_modules/tesseract.js/dist/worker.min.js', import.meta.url),
  new URL('worker.min.js', ocr),
);
const core = new URL('../node_modules/tesseract.js-core/', import.meta.url);
for (const name of await readdir(core))
  if (/^tesseract-core.*-lstm\.(wasm|wasm.js)$/.test(name))
    await copyFile(new URL(name, core), new URL(name, ocr));
await build({
  entryPoints: ['node_modules/@mintplex-labs/piper-tts-web/dist/piper-tts-web.js'],
  outfile: 'public/piper/piper-tts.mjs',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['fs', 'path'],
  plugins: [
    {
      name: 'offline-piper',
      setup(build) {
        build.onLoad({ filter: /piper-tts-web\.js$/ }, async (args) => ({
          contents: (await readFile(args.path, 'utf8'))
            .replace(
              '"https://huggingface.co/diffusionstudio/piper-voices/resolve/main"',
              'globalThis.__surfacetabModelBase.replace(/\\/$/, "")',
            )
            .replace(
              'ort.env.wasm.numThreads = navigator.hardwareConcurrency',
              'ort.env.wasm.numThreads = 1',
            )
            .replace(
              'resolve(JSON.parse(data).phoneme_ids);',
              () =>
                `const decoded = JSON.parse(data), map = __privateGet(this, _modelConfig).phoneme_id_map; const ids = [...map['^'], ...map['_']]; for (const p of decoded.phonemes) { if (map[p]) ids.push(...map[p], ...map['_']); } ids.push(...map['$']); resolve(ids);`,
            )
            .replace(
              /function splitIntoChunks\(text, maxLength = MAX_CHUNK_LENGTH\) \{[\s\S]*?\nasync function predict\(/,
              () => `function splitIntoChunks(text, maxLength = 240) {
      const chunks = []; let remaining = text.trim();
      while (remaining.length > maxLength) {
        const head = remaining.slice(0, maxLength); const breaks = [...head.matchAll(/[.!?。！？\\s]/g)];
        const boundary = breaks.length ? breaks[breaks.length - 1].index + 1 : 0; const cut = boundary > maxLength / 2 ? boundary : maxLength;
        chunks.push(remaining.slice(0, cut).trim()); remaining = remaining.slice(cut).trim();
      }
      if (remaining) chunks.push(remaining); return chunks;
    }
    async function predict(`,
            ),
          loader: 'js',
        }));
      },
    },
  ],
});
console.log('Local ONNX browser runtime prepared.');
// Phonemization alone must not initialize ORT or a second copy of voice weights.
await build({
  entryPoints: ['node_modules/@mintplex-labs/piper-tts-web/dist/piper-o91UDS6e.js'],
  outfile: 'public/piper/phonemize.mjs',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['fs', 'path'],
});
