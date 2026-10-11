type Voice = 'en_US-lessac-low' | 'zh_CN-huayan-x_low';
type PhonemeModule = { callMain: (args: string[]) => void };
let modulePromise: Promise<PhonemeModule> | undefined;
let onOutput: ((output: string) => void) | undefined;
const configs = new Map<
  string,
  { espeak: { voice: string }; phoneme_id_map: Record<string, number[]> }
>();
self.onmessage = async ({ data }: MessageEvent<{ text: string; voice: Voice; base: string }>) => {
  try {
    const paths: Record<Voice, string> = {
      'en_US-lessac-low': 'en/en_US/lessac/low/en_US-lessac-low',
      'zh_CN-huayan-x_low': 'zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low',
    };
    if (!paths[data.voice] || !data.text.trim() || data.text.length > 4000)
      throw new Error('Invalid speech input');
    if (!configs.has(data.voice)) {
      const response = await fetch(
        new URL(`models/piper/${paths[data.voice]}.onnx.json`, data.base),
      );
      if (!response.ok) throw new Error('Voice configuration unavailable');
      configs.set(data.voice, await response.json());
    }
    const config = configs.get(data.voice)!;
    if (!modulePromise) {
      const { createPiperPhonemize } = await import(
        /* @vite-ignore */ new URL('piper/phonemize.mjs', data.base).href
      );
      modulePromise = createPiperPhonemize({
        print: (line: string) => onOutput?.(line),
        locateFile: (file: string) =>
          new URL(
            `models/piper/runtime/${file.endsWith('.wasm') ? 'piper_phonemize.wasm' : 'piper_phonemize.data'}`,
            data.base,
          ).href,
      });
    }
    const runtime = await modulePromise!;
    const chunks: string[] = [];
    let remaining = data.text.trim();
    while (remaining.length > 80) {
      const head = remaining.slice(0, 80),
        breaks = [...head.matchAll(/[.!?。！？\s]/g)];
      const boundary = breaks.length ? breaks.at(-1)!.index! + 1 : 0,
        cut = boundary > 40 ? boundary : 80;
      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) chunks.push(remaining);
    const encoded: number[][] = [];
    let totalIds = 0;
    for (let index = 0; index < chunks.length; index++) {
      const text = chunks[index];
      let result: number[] | undefined;
      onOutput = (line) => {
        const output = JSON.parse(line),
          map = config.phoneme_id_map;
        if (!Array.isArray(output.phonemes)) throw new Error('Invalid phonemizer result');
        result = [...map['^'], ...map['_']];
        for (const phoneme of output.phonemes)
          if (map[phoneme]) result.push(...map[phoneme], ...map['_']);
        result.push(...map['$']);
      };
      runtime.callMain([
        '-l',
        config.espeak.voice,
        '--input',
        JSON.stringify([{ text }]),
        '--espeak_data',
        '/espeak-ng-data',
      ]);
      if (result && result.length > 1024 && text.length > 1) {
        // Numbers/abbreviations may expand far beyond their written length.
        // Split the source and phonemize again; never truncate phoneme IDs.
        const middle = Math.floor(text.length / 2);
        chunks.splice(index, 1, text.slice(0, middle).trim(), text.slice(middle).trim());
        if (chunks.length > 256) throw new Error('Too many speech chunks');
        index--;
        continue;
      }
      if (!result || result.length < 3 || result.length > 1024)
        throw new Error('Speech phoneme chunk exceeds the model limit');
      totalIds += result.length;
      if (totalIds > 65536) throw new Error('Speech exceeds the phoneme limit');
      encoded.push(result);
    }
    onOutput = undefined;
    if (encoded.length > 256) throw new Error('Too many speech chunks');
    self.postMessage({ type: 'result', chunks: encoded });
  } catch (error) {
    onOutput = undefined;
    self.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
