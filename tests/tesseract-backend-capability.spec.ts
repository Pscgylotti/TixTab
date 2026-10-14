import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
test('records actual Tesseract execution when GPU is requested without inventing a GPU backend', async ({
  page,
}) => {
  const loaded: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('tesseract-core')) loaded.push(url.pathname.split('/').at(-1)!);
  });
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const gpu = (navigator as any).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    const webgpu = adapter
      ? {
          available: true,
          vendor: adapter.info?.vendor,
          architecture: adapter.info?.architecture,
          description: adapter.info?.description,
          fallback: adapter.info?.isFallbackAdapter,
        }
      : { available: false };
    const { executeProvider } = await import('/src/providers.ts' as string);
    const { defaultProfile } = await import('/src/providerSettings.ts' as string);
    const { releaseOcr } = await import('/src/ocrWorkerSession.ts' as string);
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 140;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'black';
    ctx.font = '32px "Times New Roman"';
    const expected = 'The measured result preserves spaces and readable English text.';
    ctx.fillText(expected, 30, 75);
    const started = performance.now();
    try {
      const recognized = await executeProvider(
        {
          feature: 'ocr',
          config: { ...defaultProfile('ocr', 'local'), timeoutSeconds: 120, type: 'local' },
          input: canvas.toDataURL(),
          device: 'GPU',
          ocrLayout: true,
        },
        { signal: AbortSignal.timeout(120000) },
      );
      return {
        webgpu,
        requestedDevice: 'GPU',
        actualDevice: recognized.device,
        engine: recognized.engine,
        elapsedIncludingInitializationMs: performance.now() - started,
        text: recognized.text,
        expected,
        outcome:
          'GPU request runs the CPU/WASM implementation; no Tesseract GPU execution is available.',
      };
    } finally {
      releaseOcr();
      canvas.width = canvas.height = 1;
    }
  });
  const report = {
    kind: 'single-runtime-capability-check',
    date: '2026-10-14',
    ...result,
    coreFiles: [...new Set(loaded)],
    gpuSpeedupMeasured: false,
    notes: 'This is a backend capability check, not CPU/GPU performance evidence.',
  };
  await mkdir('.cache/tesseract-gpu-check', { recursive: true });
  await writeFile('.cache/tesseract-gpu-check/result.json', JSON.stringify(report, null, 2));
  expect(result.actualDevice).toBe('CPU (WASM)');
  expect(result.engine).toBe('Tesseract');
  expect(result.text).toBe(result.expected);
  expect(loaded.some((name) => name.includes('simd-lstm'))).toBe(true);
});
