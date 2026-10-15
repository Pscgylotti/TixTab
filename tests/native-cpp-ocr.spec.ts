import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { createNativeOcr } = createRequire(import.meta.url)('../electron/native-ocr.cjs');
test('native C++ bitmap OCR persists searchable line/word geometry and screenshot provider uses the same runtime', async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'tixtab-native-ui-')),
    owner = new EventEmitter(),
    requests: any[] = [];
  const service = createNativeOcr({
    executable: resolve('.cache/native-ocr/runtime/tixtab-ocr.exe'),
    workingRoot: root,
    resolveModel: async (name: string) => resolve('public/models', name),
    npu: {
      executable: resolve('.cache/native-ocr/npu-runtime/tixtab-ocr-npu.exe'),
      modelsRoot: resolve('.cache/native-ocr/npu-models'),
      cacheRoot: resolve('.cache/native-ocr/npu-cache'),
    },
  });
  await page.exposeFunction('nativeOcrRequest', async (request: any) => {
    requests.push({ action: request.action, variant: request.variant, count: request.count });
    return service.run(owner, request);
  });
  await page.addInitScript(() => {
    (window as any).surfaceDesktop = {
      onFullscreen: () => () => {},
      toggleFullscreen: async () => false,
      nativeOcr: { run: (request: any) => (window as any).nativeOcrRequest(request) },
    };
  });
  try {
    await page.goto('/');
    const data = await page.evaluate(async () => {
      const { newNotebook } = await import('/src/model.ts');
      const n = newNotebook();
      n.name = 'Native OCR UI';
      const c = document.createElement('canvas');
      c.width = 1000;
      c.height = 200;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, 1000, 200);
      ctx.fillStyle = 'black';
      ctx.font = '36px Arial';
      ctx.fillText('Native Tesseract preserves word spacing.', 30, 75);
      const data = c.toDataURL();
      n.pages[0].images = Array.from({ length: 3 }, (_, i) => ({
        id: 'native-' + i,
        kind: 'image' as const,
        data,
        x: 20,
        y: 40 + i * 120,
        width: 500,
        height: 100,
      }));
      return JSON.stringify(n);
    });
    await page.locator('input[type=file]').setInputFiles({
      name: 'native.tixtab',
      mimeType: 'application/json',
      buffer: Buffer.from(data),
    });
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
    await page.getByRole('button', { name: '解析位图', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '解析位图' });
    await dialog.getByLabel('OCR 后端', { exact: true }).selectOption('tesseract-native');
    await dialog.getByLabel('原生 Tesseract 模型').selectOption('fast');
    await dialog.getByText('设置', { exact: true }).click();
    await dialog.getByLabel('并行任务数').selectOption('4');
    await dialog.getByRole('button', { name: '开始解析', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('解析完成：3 张位图');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const s = await import('/src/workspaceStore.ts');
          const meta = (await s.listWorkspace()).documents.find((d) => d.name === 'Native OCR UI');
          if (!meta) return 0;
          const n = (await s.loadWorkspaceDocument(meta.id, false)).notebook;
          return n.pages[0].images.filter(
            (i) =>
              i.ocr?.text.includes('preserves word spacing') &&
              i.ocr.lines[0].words?.length === 5 &&
              i.ocr.lines[0].words.every((w) => w.polygon.every((v) => v >= 0 && v <= 1)),
          ).length;
        }),
      )
      .toBe(3);
    const result = await page.evaluate(async (data) => {
      const { executeProvider } = await import('/src/providers.ts');
      const { defaultProfile } = await import('/src/providerSettings.ts');
      return executeProvider({
        feature: 'ocr',
        input: JSON.parse(data).pages[0].images[0].data,
        config: {
          ...defaultProfile('ocr', 'tesseract-native'),
          type: 'tesseract-native',
          model: 'fast',
        },
      });
    }, data);
    expect(result.text).toContain('preserves word spacing');
    expect(result.device).toBe('CPU (native)');
    expect(result.engine).toBe('Tesseract C++');
    await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
    await page.getByRole('button', { name: '解析位图', exact: true }).click();
    await dialog.getByLabel('原生 Tesseract 模型').selectOption('npu-fast');
    await dialog.getByText('设置', { exact: true }).click();
    await expect(dialog.getByLabel('并行任务数')).toBeDisabled();
    await expect(dialog.getByLabel('并行任务数')).toHaveValue('1');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const accelerated = await page.evaluate(async () => {
      const { executeProvider } = await import('/src/providers.ts');
      const { defaultProfile } = await import('/src/providerSettings.ts');
      const c = document.createElement('canvas');
      c.width = 600;
      c.height = 240;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, 600, 240);
      ctx.font = '44px Arial';
      ctx.fillStyle = 'black';
      ctx.fillText('Native OCR', 35, 80);
      ctx.fillText('Hello world', 35, 170);
      return executeProvider({
        feature: 'ocr',
        input: c.toDataURL(),
        config: {
          ...defaultProfile('ocr', 'tesseract-native'),
          type: 'tesseract-native',
          model: 'npu-fast',
        },
      });
    });
    expect(accelerated.device).toBe('NPU');
    expect(accelerated.experimental).toBe(true);
    expect(accelerated.lines).toHaveLength(2);
    expect(requests.filter((r) => r.action === 'open')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variant: 'fast', count: 4 }),
        expect.objectContaining({ variant: 'fast', count: 1 }),
      ]),
    );
    expect(await readdir(root)).toEqual([]);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
