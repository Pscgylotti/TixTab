// Fixed asset records reused by the desktop library and slim builds.
import { readFile, writeFile } from 'node:fs/promises';
const read = (name) =>
  readFile(new URL(`../public/models/${name}`, import.meta.url), 'utf8').then(JSON.parse);
const texo = await read('texo/manifest.json'),
  reading = await read('reading-manifest.json'),
  ocr = await read('ppocrv4/manifest.json');
const models = [];
// Optional runtimes/models are pinned by their dedicated preparation scripts.
// Regenerating the base catalog must not remove those independent records.
const previous = JSON.parse(
  await readFile(new URL('../electron/model-catalog.json', import.meta.url), 'utf8'),
);
const add = (id, name, feature, revision, license, source, device, files, metadata = []) =>
  models.push({
    id,
    name,
    feature,
    revision,
    license,
    source,
    device,
    files,
    metadata,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
  });
add(
  'texo',
  'Texo',
  'formula',
  texo.revision,
  'AGPL-3.0',
  'https://github.com/alephpi/Texo',
  'NPU → GPU → CPU · CPU decoder',
  texo.files.map((f) => ({
    path: `texo/${f.name}`,
    bytes: f.bytes,
    sha256: f.sha256,
    url: `https://huggingface.co/alephpi/FormulaNet/resolve/${texo.revision}/${f.name}`,
  })),
  [{ path: 'texo/manifest.json', data: texo }],
);
for (const id of ['opus-en-zh', 'opus-zh-en']) {
  const m = await read(`${id}/manifest.json`);
  add(
    id,
    id === 'opus-en-zh' ? 'OPUS English → 中文' : 'OPUS 中文 → English',
    'translation',
    m.revision,
    'Apache-2.0 (upstream OPUS-MT)',
    `https://huggingface.co/${m.repo}`,
    'CPU (WASM) · optional NPU/GPU encoder',
    m.files.map((f) => ({
      path: `${id}/${f.file}`,
      bytes: f.size,
      sha256: f.sha256,
      url: `https://huggingface.co/${m.repo}/resolve/${m.revision}/${f.file}`,
    })),
    [{ path: `${id}/manifest.json`, data: m }],
  );
}
add(
  'tesseract',
  'Tesseract English + 中文',
  'ocr',
  reading.ocrRevision,
  'Apache-2.0',
  'https://github.com/tesseract-ocr/tessdata_fast',
  'CPU (WASM)',
  reading.files
    .filter((f) => f.name.startsWith('ocr/'))
    .map((f) => ({ path: f.name, bytes: f.size, sha256: f.sha256, url: f.url })),
);
add(
  'ppocrv4',
  'PP-OCRv4 中文 + English',
  'ocr',
  ocr.revision,
  'Apache-2.0 · PaddleOCR / RapidOCR',
  'https://github.com/RapidAI/RapidOCR',
  'NPU → GPU → CPU · CPU projection',
  ocr.files.map((f) => ({
    path: `ppocrv4/${f.file}`,
    bytes: f.size,
    sha256: f.sha256,
    url: f.source,
  })),
  [{ path: 'ppocrv4/manifest.json', data: ocr }],
);
add(
  'tesseract-openvino',
  'Tesseract English Fast + Best',
  'ocr',
  'englishqueuev1',
  'Apache-2.0',
  'https://github.com/tesseract-ocr/tessdata_best',
  'NPU · experimental queued recognition · CPU layout',
  [
    {
      path: 'tesseract-openvino/fast.traineddata',
      bytes: 4113088,
      sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
      url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata',
    },
    {
      path: 'tesseract-openvino/best.traineddata',
      bytes: 15400601,
      sha256: '8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba',
      url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec/eng.traineddata',
    },
  ],
);
for (const [id, prefix, name, license] of [
  [
    'piper-en',
    'piper/en/',
    'Piper Lessac English',
    'Voice model: upstream MODEL_CARD; dataset: Lessac terms',
  ],
  [
    'piper-zh',
    'piper/zh/',
    'Piper Huayan 中文',
    'Voice model: upstream MODEL_CARD; dataset license: Unknown',
  ],
])
  add(
    id,
    name,
    'speech',
    reading.piperRevision,
    license,
    'https://huggingface.co/rhasspy/piper-voices',
    'NPU → GPU → CPU vocoder · CPU (WASM) fallback',
    reading.files
      .filter((f) => f.name.startsWith(prefix))
      .map((f) => ({ path: f.name, bytes: f.size, sha256: f.sha256, url: f.url })),
  );
add(
  'piper-runtime',
  'Piper phonemizer',
  'speech',
  '1.0.0',
  'eSpeak NG: GPL-3.0 · WASM build: see upstream',
  'https://github.com/diffusionstudio/piper-wasm',
  'CPU · shared by both voices',
  reading.files
    .filter((f) => f.name.startsWith('piper/runtime/'))
    .map((f) => ({ path: f.name, bytes: f.size, sha256: f.sha256, url: f.url })),
);
add(
  'tesseract-openvino-zh',
  'Tesseract 中英混合 Best',
  'ocr',
  'mixedqueuev1',
  'Apache-2.0',
  'https://github.com/tesseract-ocr/tessdata_best',
  'NPU · Simplified Chinese + English · experimental',
  [
    {
      path: 'tesseract-openvino-zh/mixed-best.traineddata',
      bytes: 13077423,
      sha256: '4fef2d1306c8e87616d4d3e4c6c67faf5d44be3342290cf8f2f0f6e3aa7e735b',
      url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec/chi_sim.traineddata',
    },
  ],
);
const generatedIds = new Set(models.map((m) => m.id));
models.push(...previous.models.filter((m) => !generatedIds.has(m.id)));
await writeFile(
  new URL('../electron/model-catalog.json', import.meta.url),
  JSON.stringify({ version: 1, models }, null, 2) + '\n',
);
console.log(
  'Pinned model catalog:',
  models.length,
  'bundles,',
  models.reduce((n, m) => n + m.files.length, 0),
  'files',
);
