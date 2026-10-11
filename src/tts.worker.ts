let session: { predict: (text: string) => Promise<Blob> } | undefined;
self.onmessage = async ({ data }: MessageEvent<{ text: string; voice: string; base: string }>) => {
  try {
    Object.assign(globalThis, { __surfacetabModelBase: new URL('models/piper/', data.base).href });
    const runtime = new URL('piper/piper-tts.mjs', data.base).href;
    const piper = await import(/* @vite-ignore */ runtime);
    self.postMessage({ type: 'progress', text: '加载本地 Piper 语音…' });
    session ??= await piper.TtsSession.create({
      voiceId: data.voice,
      wasmPaths: {
        onnxWasm: new URL('ort/', data.base).href,
        piperData: new URL('models/piper/runtime/piper_phonemize.data', data.base).href,
        piperWasm: new URL('models/piper/runtime/piper_phonemize.wasm', data.base).href,
      },
    });
    const start = performance.now(),
      audio = await session!.predict(data.text);
    self.postMessage({ type: 'result', audio, elapsed: performance.now() - start });
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
