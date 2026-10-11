import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const revision = 'b2668efe5112082846fde4d446b9bfaab3989533';
const root = new URL('../public/models/texo/', import.meta.url);
const names = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model.onnx',
  'onnx/decoder_model_merged.onnx',
];
const manifest = {
  repo: 'alephpi/FormulaNet (Texo)',
  revision,
  source: 'https://github.com/alephpi/Texo',
  files: [],
};
for (const name of names) {
  const target = new URL(name, root);
  await mkdir(new URL('./', target), { recursive: true });
  console.log(`Downloading ${name}…`);
  const response = await fetch(
    `https://huggingface.co/alephpi/FormulaNet/resolve/${revision}/${name}`,
    { signal: AbortSignal.timeout(180000) },
  );
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (name.endsWith('.json')) JSON.parse(new TextDecoder().decode(bytes));
  await writeFile(target, bytes);
  manifest.files.push({
    name,
    bytes: (await stat(target)).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
await writeFile(new URL('manifest.json', root), JSON.stringify(manifest, null, 2));
console.log('Texo ready. Rebuild the desktop app to include local model files.');
