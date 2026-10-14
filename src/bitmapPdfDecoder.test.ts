import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getDocument: vi.fn(), draw: vi.fn(), stop: vi.fn() }));
vi.mock('pdfjs-dist', () => ({
  getDocument: mocks.getDocument,
  PDFWorker: class {
    destroy = mocks.stop;
  },
}));
vi.mock('./pdfOriginalImage', () => ({ drawPdfOriginalImage: mocks.draw }));
import { bitmapPdfDecoder } from './bitmapPdfDecoder';
afterEach(() => {
  vi.clearAllMocks();
});
it.each(['data', 'load', 'draw', 'cleanup'])(
  'cancels a stuck %s without waiting for PDF transport acknowledgement',
  async (stage) => {
    const never = () => new Promise<any>(() => {});
    const abort = new AbortController(),
      destroy = vi.fn(never),
      cleanup = vi.fn(stage === 'cleanup' ? never : async () => {});
    const source = { getData: vi.fn(stage === 'data' ? never : async () => new Uint8Array([1])) };
    mocks.getDocument.mockReturnValue({
      promise: stage === 'load' ? never() : Promise.resolve({ cleanup }),
      destroy,
    });
    mocks.draw.mockImplementation(stage === 'draw' ? never : async () => true);
    const decoder = bitmapPdfDecoder(source as any, abort.signal),
      pending = decoder.draw(0, 0, {} as any);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() =>
      expect(
        stage === 'data'
          ? source.getData
          : stage === 'load'
            ? mocks.getDocument
            : stage === 'draw'
              ? mocks.draw
              : cleanup,
      ).toHaveBeenCalled(),
    );
    abort.abort();
    await rejected;
    await decoder.close();
    if (stage !== 'data') expect(mocks.stop).toHaveBeenCalled();
  },
);
