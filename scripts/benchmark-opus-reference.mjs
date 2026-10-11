// Offline ONNX Runtime CPU reference: isolate padding effects from OpenVINO conversion.
import * as ort from 'onnxruntime-node';
import { AutoTokenizer, env } from '@huggingface/transformers';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
env.allowRemoteModels = false;
env.localModelPath = resolve('public/models').replaceAll('\\', '/') + '/';
const samples = JSON.parse(await readFile('.cache/opus-tokenizer-baseline.json', 'utf8'));
const root = '.cache/opus-reference';
await mkdir(root, { recursive: true });
const records = [];
const int64 = (ids, dims) => new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), dims);
for (const direction of ['en-zh', 'zh-en']) {
  const folder = `public/models/opus-${direction}`,
    tokenizer = await AutoTokenizer.from_pretrained(`opus-${direction}`);
  const options = { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 };
  const encoder = await ort.InferenceSession.create(
    `${folder}/onnx/encoder_model_quantized.onnx`,
    options,
  );
  const decoder = await ort.InferenceSession.create(
    `${folder}/onnx/decoder_model_merged_quantized.onnx`,
    options,
  );
  const cases = samples.filter((s) => s.direction === direction);
  for (let index = 0; index < cases.length; index++)
    for (const padding of [0, 128]) {
      const sample = cases[index],
        n = sample.ids.length,
        length = padding || n;
      const ids = [...sample.ids, ...Array(length - n).fill(65000)],
        mask = [...Array(n).fill(1), ...Array(length - n).fill(0)];
      const encoded = await encoder.run({
        input_ids: int64(ids, [1, length]),
        attention_mask: int64(mask, [1, length]),
      });
      const source = encoded.last_hidden_state,
        states = new ort.Tensor('float32', source.data.slice(0, n * 512), [1, n, 512]);
      const stateFile = `${direction}-${index}-${padding}.f32`;
      await writeFile(
        `${root}/${stateFile}`,
        Buffer.from(states.data.buffer, states.data.byteOffset, states.data.byteLength),
      );
      let cache = Object.fromEntries(
        decoder.inputNames
          .filter((k) => k.startsWith('past_key_values.'))
          .map((k) => [k, new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64])]),
      );
      const tokens = [65000],
        start = performance.now();
      for (let step = 0; step < 256; step++) {
        const feeds = {
          input_ids: int64([tokens.at(-1)], [1, 1]),
          encoder_attention_mask: int64(Array(n).fill(1), [1, n]),
          encoder_hidden_states: states,
          use_cache_branch: new ort.Tensor('bool', new Uint8Array([step > 0 ? 1 : 0]), [1]),
          ...cache,
        };
        const output = await decoder.run(
          Object.fromEntries(decoder.inputNames.map((k) => [k, feeds[k]])),
        );
        const logits = output.logits.data;
        let best = 0;
        for (let i = 1; i < logits.length; i++)
          if (i !== 65000 && logits[i] > logits[best]) best = i;
        tokens.push(best);
        if (best === 0) break;
        cache = Object.fromEntries(
          Object.keys(cache).map((k) => [
            k,
            step > 0 && k.includes('.encoder.')
              ? cache[k]
              : output[k.replace('past_key_values.', 'present.')],
          ]),
        );
      }
      const record = {
        direction,
        index,
        padding,
        text: sample.text,
        ids: sample.ids,
        stateFile,
        tokens,
        translation: tokenizer.decode(tokens, { skip_special_tokens: true }),
        decodeMs: performance.now() - start,
      };
      records.push(record);
      console.log(JSON.stringify(record));
    }
  await encoder.release();
  await decoder.release();
}
await writeFile(`${root}/reference.json`, JSON.stringify(records, null, 2));
