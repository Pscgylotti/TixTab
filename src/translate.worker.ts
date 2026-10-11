import { env, pipeline, type TranslationPipeline } from '@huggingface/transformers';
import { normalizeTranslationText } from './translationText';
env.allowRemoteModels = false;
env.allowLocalModels = true;
if (self.location.protocol === 'surfacetab:') env.useBrowserCache = false;
env.backends.onnx.wasm!.numThreads = 1;
let translator: TranslationPipeline | undefined,
  loaded = '';
self.onmessage = async ({
  data,
}: MessageEvent<{ text: string; direction: string; modelBase: string; runtimeBase: string }>) => {
  try {
    env.localModelPath = data.modelBase;
    env.backends.onnx.wasm!.wasmPaths = data.runtimeBase;
    const name = data.direction === 'en-zh' ? 'opus-en-zh' : 'opus-zh-en';
    if (!translator || loaded !== name) {
      await translator?.dispose();
      translator = undefined;
      self.postMessage({ type: 'progress', text: '首次加载本地翻译模型…' });
      translator = await (
        pipeline as unknown as (
          task: string,
          model: string,
          options: object,
        ) => Promise<TranslationPipeline>
      )('translation', name, { dtype: 'q8', device: 'wasm' });
      loaded = name;
    }
    if (translator.model.generation_config) translator.model.generation_config.max_new_tokens = 256;
    const start = performance.now(),
      output: string[] = [];
    // Preserve paragraphs; sentence chunks avoid silent truncation and limit memory.
    for (const paragraph of normalizeTranslationText(data.text).split(/\n{2,}/)) {
      const translated: string[] = [];
      const chunks = paragraph.match(/[^.!?。！？\n]+[.!?。！？]?/g) ?? [''];
      for (const sentence of chunks)
        for (let i = 0; i < sentence.length; i += 350) {
          const result = await translator(
            (data.direction === 'en-zh' ? '>>cmn_Hans<< ' : '') + sentence.slice(i, i + 350),
          );
          translated.push((result as { translation_text: string }[])[0].translation_text.trim());
        }
      output.push(translated.join(data.direction === 'en-zh' ? '' : ' '));
    }
    self.postMessage({
      type: 'result',
      text: output.join('\n\n').trim(),
      elapsed: performance.now() - start,
    });
  } catch (e) {
    self.postMessage({ type: 'error', error: e instanceof Error ? e.message : String(e) });
  }
};
