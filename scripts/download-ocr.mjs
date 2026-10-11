import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = 'public/models/ppocrv4';
const models = [
  [
    'det',
    'ch_PP-OCRv4_det_mobile.onnx',
    4745517,
    'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
  ],
  [
    'rec',
    'ch_PP-OCRv4_rec_mobile.onnx',
    10857958,
    '48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b',
  ],
  [
    'cls',
    'ch_ppocr_mobile_v2.0_cls_mobile.onnx',
    585532,
    'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c',
  ],
];
await mkdir(root, { recursive: true });
const files = [];
for (const [stage, file, size, sha256] of models) {
  const source = `https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv4/${stage}/${file}`;
  let data;
  try {
    data = await readFile(`${root}/${file}`);
  } catch {}
  const valid = () =>
    data?.length === size && createHash('sha256').update(data).digest('hex') === sha256;
  if (!valid()) {
    const response = await fetch(source, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`OCR download HTTP ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
    if (!valid()) throw new Error(`OCR checksum mismatch: ${file}`);
    await writeFile(`${root}/${file}.tmp`, data);
    await rename(`${root}/${file}.tmp`, `${root}/${file}`);
  }
  files.push({ file, size, sha256, source });
  console.log(`Verified ${file}: ${size} bytes`);
}
await writeFile(
  `${root}/manifest.json`,
  JSON.stringify(
    {
      name: 'ppocrv4',
      revision: 'rapidocr310',
      license: 'Apache-2.0',
      upstream: 'PaddlePaddle/PaddleOCR',
      conversion: 'RapidAI/RapidOCR 3.10.0',
      files,
    },
    null,
    2,
  ) + '\n',
);
