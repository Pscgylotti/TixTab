import {
  env,
  Tensor,
  VisionEncoderDecoderModel,
  PreTrainedTokenizer,
} from '@huggingface/transformers';
env.allowRemoteModels = false;
env.allowLocalModels = true;
if (self.location.protocol === 'surfacetab:') env.useBrowserCache = false;
env.backends.onnx.wasm!.numThreads = 1;
let model: Awaited<ReturnType<typeof VisionEncoderDecoderModel.from_pretrained>> | undefined;
let tokenizer: Awaited<ReturnType<typeof PreTrainedTokenizer.from_pretrained>> | undefined;
let loadedDevice = '';
async function pixels(data: string) {
  const blob = await (await fetch(data)).blob(),
    bitmap = await createImageBitmap(blob);
  const input = new OffscreenCanvas(bitmap.width, bitmap.height),
    ctx = input.getContext('2d')!;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, input.width, input.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, input.width, input.height).data;
  let left = input.width,
    top = input.height,
    right = 0,
    bottom = 0;
  for (let y = 0; y < input.height; y++)
    for (let x = 0; x < input.width; x++) {
      const i = (y * input.width + x) * 4;
      if (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114 < 200) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  if (left > right || top > bottom) throw new Error('画板为空');
  const w = right - left + 1,
    h = bottom - top + 1,
    factor = 384 / Math.max(w, h),
    width = Math.max(1, Math.round(w * factor)),
    height = Math.max(1, Math.round(h * factor));
  const output = new OffscreenCanvas(384, 384),
    out = output.getContext('2d')!;
  out.fillStyle = '#000';
  out.fillRect(0, 0, 384, 384);
  out.drawImage(
    input,
    left,
    top,
    w,
    h,
    Math.floor((384 - width) / 2),
    Math.floor((384 - height) / 2),
    width,
    height,
  );
  const bytes = out.getImageData(0, 0, 384, 384).data,
    values = new Float32Array(3 * 384 * 384);
  for (let i = 0; i < 384 * 384; i++) {
    const value =
      ((bytes[i * 4] * 0.299 + bytes[i * 4 + 1] * 0.587 + bytes[i * 4 + 2] * 0.114) / 255 -
        0.7931) /
      0.1738;
    values[i] = value;
    values[i + 384 * 384] = value;
    values[i + 2 * 384 * 384] = value;
  }
  return new Tensor('float32', values, [1, 3, 384, 384]);
}
self.onmessage = async (
  event: MessageEvent<{
    image: string;
    device: 'wasm' | 'webgpu';
    modelBase: string;
    runtimeBase: string;
  }>,
) => {
  try {
    env.localModelPath = event.data.modelBase;
    env.backends.onnx.wasm!.wasmPaths = event.data.runtimeBase;
    const device = event.data.device;
    if (!model || loadedDevice !== device) {
      await model?.dispose();
      model = undefined;
      model = await VisionEncoderDecoderModel.from_pretrained('texo', {
        dtype: 'fp32',
        device,
        progress_callback: (progress) => {
          self.postMessage({
            type: 'progress',
            text: 'file' in progress ? `加载 Texo：${progress.file}` : '初始化本地 Texo…',
          });
        },
      });
      tokenizer = await PreTrainedTokenizer.from_pretrained('texo');
      loadedDevice = device;
    }
    const start = performance.now();
    if (model.generation_config) model.generation_config.max_new_tokens = 256;
    const generated = await model.generate({ inputs: await pixels(event.data.image) });
    if ((generated as Tensor).dims.at(-1)! >= 257)
      throw new Error('公式过长或无法辨认，请重写或选择更小区域');
    const latex = tokenizer!.batch_decode(generated as Tensor, { skip_special_tokens: true })[0];
    self.postMessage({
      type: 'result',
      latex,
      elapsed: performance.now() - start,
      device: loadedDevice,
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
