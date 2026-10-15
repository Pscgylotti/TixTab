import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./appearance', () => ({
  getPdfRenderBackend: () => 'pdfium',
  subscribeAppearance: () => () => {},
}));
import { createPdfiumImageDecoder, getPdfiumStats } from './pdfiumRaster';

afterEach(() => vi.unstubAllGlobals());
it.each(['data', 'load', 'decode'])(
  'terminates an isolated decoder stuck at %s and rejects pending work',
  async (stage) => {
    const sent = vi.fn(),
      stop = vi.fn();
    vi.stubGlobal(
      'Worker',
      class {
        onmessage?: (event: any) => void;
        terminate = stop;
        postMessage(message: any) {
          sent(message);
          if (message.type === 'open' && stage !== 'load')
            queueMicrotask(() =>
              this.onmessage?.({
                data: { type: 'opened', id: message.id, documents: 1, pages: [] },
              }),
            );
        }
      },
    );
    const source = {
        getData: vi.fn(() =>
          stage === 'data'
            ? new Promise<Uint8Array>(() => {})
            : Promise.resolve(new Uint8Array([1])),
        ),
      },
      abort = new AbortController(),
      decoder = createPdfiumImageDecoder(source as any, abort.signal);
    const pending = decoder.draw(0, 0, {} as any);
    const rejection = expect(pending).rejects.toThrow(/cancel|abort/i);
    await vi.waitFor(() =>
      expect(
        stage === 'data'
          ? source.getData.mock.calls.length
          : sent.mock.calls.filter(
              ([m]) => m.type === (stage === 'load' ? 'open' : 'original-image'),
            ).length,
      ).toBeGreaterThan(0),
    );
    abort.abort();
    await rejection;
    decoder.close();
    decoder.close();
    expect(stop).toHaveBeenCalledOnce();
    expect(getPdfiumStats().decoderWorkers).toBe(0);
  },
);

it('closes a transferred bitmap when presentation throws and releases its worker on close', async () => {
  const bitmap = { width: 64, height: 48, close: vi.fn() },
    stop = vi.fn();
  vi.stubGlobal(
    'Worker',
    class {
      onmessage?: (event: any) => void;
      terminate = stop;
      postMessage(m: any) {
        if (m.type === 'open')
          queueMicrotask(() =>
            this.onmessage?.({ data: { type: 'opened', id: m.id, documents: 1, pages: [] } }),
          );
        if (m.type === 'original-image')
          queueMicrotask(() =>
            this.onmessage?.({ data: { type: m.type, id: m.id, bitmap, heapBytes: 100 } }),
          );
      }
    },
  );
  const decoder = createPdfiumImageDecoder(
    { getData: async () => new Uint8Array([1]) } as any,
    new AbortController().signal,
  );
  await expect(
    decoder.draw(0, 0, {
      getContext: () => ({
        drawImage: () => {
          throw new Error('context lost');
        },
      }),
    } as any),
  ).rejects.toThrow('context lost');
  expect(bitmap.close).toHaveBeenCalledOnce();
  decoder.close();
  expect(stop).toHaveBeenCalledOnce();
  expect(getPdfiumStats().decoderWorkers).toBe(0);
});
