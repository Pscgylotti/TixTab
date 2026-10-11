import { AutoTokenizer, env } from '@huggingface/transformers';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = resolve('public/models').replaceAll('\\', '/') + '/';
const cases = {
  'en-zh': [
    'The book is on the table.',
    'Competitive diffusion improves performance.',
    'Hello, world!',
    '  A\tnew\nline and café.  ',
    'ＡＢＣ ～ ~ ① ﬁ',
    'The formula is x^2 + y^2 = z^2.',
    'Pressure-sensitive ink supports the Surface Pen.',
  ],
  'zh-en': [
    '这本书在桌子上。',
    '你好，世界！',
    '实验性夜间模式可以降低图片亮度。',
    '竞争与扩散能够改善性能。',
    '这是第一段。\n\n这是第二段。',
    '全角ＡＢＣ与～符号。',
  ],
};
const result = [];
for (const [direction, samples] of Object.entries(cases)) {
  const tokenizer = await AutoTokenizer.from_pretrained('opus-' + direction);
  for (const text of samples) {
    const input = (direction === 'en-zh' ? '>>cmn_Hans<< ' : '') + text;
    result.push({
      direction,
      text,
      ids: tokenizer.encode(input),
      decoded: tokenizer.decode(tokenizer.encode(input), { skip_special_tokens: true }),
    });
  }
}
await mkdir('.cache', { recursive: true });
await writeFile('.cache/opus-tokenizer-baseline.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ cases: result.length, remoteModels: false }));
