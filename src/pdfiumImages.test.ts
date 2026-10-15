import { expect, it, vi } from 'vitest';
import { nativeImages, nativeOriginalImage } from './pdfiumImages';

function fake() {
  const heap = new ArrayBuffer(512),
    f = new Float32Array(heap),
    ints = new Int32Array(heap);
  const free = vi.fn(),
    alloc = vi.fn(() => 64);
  const api: any = {
    pdfium: {
      wasmExports: { malloc: alloc, free },
      getValue: (p: number, type: string) => (type === 'float' ? f[p / 4] : ints[p / 4]),
      HEAPU8: new Uint8Array(heap),
    },
    FPDFPage_CountObjects: () => 2,
    FPDFPage_GetObject: (_: number, i: number) => [10, 20][i],
    FPDFPageObj_GetType: (o: number) => (o === 20 ? 5 : 3),
    FPDFFormObj_CountObjects: () => 1,
    FPDFFormObj_GetObject: () => 30,
    FPDFPageObj_GetMatrix: (o: number, p: number) => {
      f.set(o === 20 ? [2, 0, 0, 3, 10, 20] : [4, 0, 0, 5, 1, 2], p / 4);
      return true;
    },
    FPDFImageObj_GetImagePixelSize: (_: number, p: number, q: number) => {
      ints[p / 4] = 20;
      ints[q / 4] = 30;
      return true;
    },
    FPDFImageObj_GetImageMetadata: () => {
      throw new Error('DIB metadata forbidden');
    },
    FPDFImageObj_GetBitmap: () => {
      throw new Error('pixels forbidden in index');
    },
    FPDFPageObj_GetClipPath: () => 0,
    FPDFImageObj_GetRenderedBitmap: vi.fn(() => {
      throw new Error('decode failed');
    }),
    FPDFImageObj_SetMatrix: vi.fn(() => true),
  };
  return { api, free, alloc };
}
it('composes repeated/nested occurrence transforms without any pixel or DIB access', async () => {
  const { api, free } = fake();
  const images = await nativeImages(api, 1, () => {});
  expect(images.map((i) => i.polygon)).toEqual([
    [1, 2, 5, 2, 5, 7, 1, 7],
    [12, 26, 20, 26, 20, 41, 12, 41],
  ]);
  expect(free).toHaveBeenCalledWith(64);
  expect(api.FPDFImageObj_GetRenderedBitmap).not.toHaveBeenCalled();
});
it('releases index scratch memory on cancellation and restores the source matrix after a decoder failure', async () => {
  const { api, free } = fake();
  await expect(
    nativeImages(api, 1, () => {
      throw new Error('cancelled');
    }),
  ).rejects.toThrow('cancelled');
  expect(free).toHaveBeenCalledOnce();
  expect(() => nativeOriginalImage(api, 1, 2, { object: 10, width: 20, height: 30 }, 600)).toThrow(
    'decode failed',
  );
  expect(api.FPDFImageObj_SetMatrix).toHaveBeenLastCalledWith(10, 4, 0, 0, 5, 1, 2);
  expect(free).toHaveBeenCalledTimes(2);
});
