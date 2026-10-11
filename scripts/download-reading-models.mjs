import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../public/models/', import.meta.url);
const piperRevision = 'c10ece1aade47bb51c153c893d14e5bf8e5b7117',
  ocrRevision = '87416418657359cb625c412a48b6e1d6d41c29bd';
const assets = [];
for (const lang of ['eng', 'chi_sim'])
  assets.push({
    name: `ocr/${lang}.traineddata`,
    url: `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${ocrRevision}/${lang}.traineddata`,
  });
for (const voice of [
  'en/en_US/lessac/low/en_US-lessac-low',
  'zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low',
]) {
  for (const suffix of ['.onnx', '.onnx.json'])
    assets.push({
      name: `piper/${voice}${suffix}`,
      url: `https://huggingface.co/rhasspy/piper-voices/resolve/${piperRevision}/${voice}${suffix}`,
    });
  assets.push({
    name: `piper/${voice.slice(0, voice.lastIndexOf('/') + 1)}MODEL_CARD`,
    url: `https://huggingface.co/rhasspy/piper-voices/resolve/${piperRevision}/${voice.slice(0, voice.lastIndexOf('/') + 1)}MODEL_CARD`,
  });
}
for (const ext of ['wasm', 'data'])
  assets.push({
    name: `piper/runtime/piper_phonemize.${ext}`,
    url: `https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.${ext}`,
  });
const manifest = { piperRevision, ocrRevision, files: [] },
  sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let previous;
try {
  previous = JSON.parse(await readFile(new URL('reading-manifest.json', root), 'utf8'));
} catch {}
for (const asset of assets) {
  const target = new URL(asset.name, root);
  await mkdir(new URL('./', target), { recursive: true });
  let bytes;
  try {
    const existing = await readFile(target),
      old = previous?.files.find((f) => f.name === asset.name && f.url === asset.url);
    if (old && sha(existing) === old.sha256) bytes = existing;
  } catch {}
  if (!bytes) {
    console.log(`Preparing ${asset.name}`);
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(240000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${asset.name}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(target, bytes);
  }
  manifest.files.push({ ...asset, size: bytes.length, sha256: sha(bytes) });
}
await writeFile(new URL('reading-manifest.json', root), JSON.stringify(manifest, null, 2));
console.log('Offline OCR and Piper voices prepared.');
