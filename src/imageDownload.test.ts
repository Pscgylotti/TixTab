import { afterEach, expect, it, vi } from 'vitest';
import { releaseImageDownloads, saveImageBlob } from './imageDownload';
afterEach(() => {
  releaseImageDownloads();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('bounds active image URLs and revokes them on expiry and explicit cleanup', () => {
  vi.useFakeTimers();
  let id = 0;
  const revoke = vi.fn(),
    remove = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: () => `blob:${++id}`, revokeObjectURL: revoke });
  vi.stubGlobal('document', {
    createElement: () => ({ click: vi.fn(), remove }),
    body: { append: vi.fn() },
  });
  for (let n = 0; n < 3; n++) saveImageBlob(new Blob(['png']), 'picture.png');
  expect(revoke).toHaveBeenCalledWith('blob:1');
  expect(remove).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(10000);
  expect(revoke).toHaveBeenCalledTimes(3);
  saveImageBlob(new Blob(['png']), 'picture.png');
  releaseImageDownloads();
  expect(revoke).toHaveBeenCalledWith('blob:4');
  expect(vi.getTimerCount()).toBe(0);
});
