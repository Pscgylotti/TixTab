import { expect, it, vi } from 'vitest';
import { openPdfiumForms } from './pdfiumForms';
it('owns the form callback structure until environment close and does not create it for ordinary documents', () => {
  const heap = new Uint8Array(1024).fill(255),
    free = vi.fn(),
    exit = vi.fn();
  const api: any = {
    pdfium: {
      HEAPU8: heap,
      wasmExports: { malloc: () => 64, free },
      setValue: (p: number, v: number) => new DataView(heap.buffer).setInt32(p, v, true),
    },
    FPDF_GetFormType: vi.fn(() => 0),
    FPDFDOC_InitFormFillEnvironment: vi.fn(() => 9),
    FPDFDOC_ExitFormFillEnvironment: exit,
  };
  expect(openPdfiumForms(api, 1)).toBeUndefined();
  expect(api.FPDFDOC_InitFormFillEnvironment).not.toHaveBeenCalled();
  api.FPDF_GetFormType.mockReturnValue(1);
  const environment = openPdfiumForms(api, 1)!;
  expect(new DataView(heap.buffer).getInt32(64, true)).toBe(1);
  expect(heap.subarray(68, 320).every((v) => v === 0)).toBe(true);
  expect(free).not.toHaveBeenCalled();
  environment.close();
  expect(exit).toHaveBeenCalledWith(9);
  expect(free).toHaveBeenCalledWith(64);
});
it('releases the structure if PDFium rejects form initialization', () => {
  const free = vi.fn(),
    api: any = {
      pdfium: {
        HEAPU8: new Uint8Array(512),
        wasmExports: { malloc: () => 64, free },
        setValue: () => {},
      },
      FPDF_GetFormType: () => 1,
      FPDFDOC_InitFormFillEnvironment: () => 0,
    };
  expect(() => openPdfiumForms(api, 1)).toThrow('unavailable');
  expect(free).toHaveBeenCalledWith(64);
});
