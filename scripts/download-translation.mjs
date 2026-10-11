import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const models = [
  {
    name: 'opus-en-zh',
    repo: 'Xenova/opus-mt-en-zh',
    revision: '046f55aec303cdee3e0318604406d4df20f1e8ea',
    encoder: 'd3b7912bf6a9bd27e4c074c2df91d4ff3d5b4bc5f7f6c8d7cc9c805c98fbafee',
    decoder: '023be4f841f4c47cd65fffcbaa81c0d99d7f7e0138f7ba0e03fa220a4e688aff',
  },
  {
    name: 'opus-zh-en',
    repo: 'Xenova/opus-mt-zh-en',
    revision: '39d480d52a9ea3065a1f117adfe4dbc55de10e6f',
    encoder: '84d5e171b626bc8b6b220d022ac58696e9528c25deeacca62b5cbf4364547a99',
    decoder: 'c6b7f04ff1ba0fbd1bf6852599b4c0cad6fe512d57cd887f44ef36cf705424cb',
  },
];
const files = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const model of models) {
  const root = new URL(`../public/models/${model.name}/`, import.meta.url),
    manifest = { ...model, files: [] };
  for (const file of files) {
    const target = new URL(file, root),
      expected = file.includes('encoder_model')
        ? model.encoder
        : file.includes('decoder_model')
          ? model.decoder
          : undefined;
    await mkdir(new URL('./', target), { recursive: true });
    let bytes;
    try {
      const existing = await readFile(target);
      if (expected && hash(existing) === expected) bytes = existing;
    } catch {}
    if (!bytes) {
      console.log(`${model.name}: ${file}`);
      const response = await fetch(
        `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file}`,
        { signal: AbortSignal.timeout(240000) },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${file}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      if (expected && hash(bytes) !== expected) throw new Error(`SHA256 mismatch: ${file}`);
      if (file.endsWith('.json')) JSON.parse(new TextDecoder().decode(bytes));
      await writeFile(target, bytes);
    }
    manifest.files.push({ file, size: bytes.length, sha256: hash(bytes) });
  }
  await writeFile(new URL('manifest.json', root), JSON.stringify(manifest, null, 2));
}
console.log(
  'Offline English ↔ Chinese translation models prepared. Rebuild to include them in the desktop app.',
);
