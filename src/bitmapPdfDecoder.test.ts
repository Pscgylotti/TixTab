import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), draw: vi.fn(), close: vi.fn() }));
vi.mock('./pdfiumRaster', () => ({ createPdfiumImageDecoder: mocks.create }));
import { bitmapPdfDecoder } from './bitmapPdfDecoder';
afterEach(() => vi.resetAllMocks());
it('terminates a blocked decoder immediately on abort and does not wait for native acknowledgement', async () => {
  mocks.draw.mockImplementation(() => new Promise(() => {}));
  mocks.create.mockReturnValue({ draw: mocks.draw, close: mocks.close });
  const abort = new AbortController(),
    decoder = bitmapPdfDecoder({} as any, abort.signal);
  const pending = decoder.draw(0, 0, {} as any);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalled());
  abort.abort();
  await rejected;
  await decoder.close();
  expect(mocks.close).toHaveBeenCalled();
});
it('serializes decoding before parallel recognition and reuses only its own batch worker', async () => {
  let finish!: (value: boolean) => void;
  mocks.draw
    .mockImplementationOnce(() => new Promise<boolean>((r) => (finish = r)))
    .mockResolvedValue(true);
  mocks.create.mockReturnValue({ draw: mocks.draw, close: mocks.close });
  const decoder = bitmapPdfDecoder({} as any, new AbortController().signal);
  const a = decoder.draw(0, 0, {} as any),
    b = decoder.draw(1, 0, {} as any);
  await vi.waitFor(() => expect(mocks.draw).toHaveBeenCalledTimes(1));
  finish(true);
  await Promise.all([a, b]);
  await decoder.close();
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.draw).toHaveBeenCalledTimes(2);
  await expect(decoder.draw(2, 0, {} as any)).rejects.toThrow('closed');
});
