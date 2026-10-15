import { afterEach, expect, it, vi } from 'vitest';
import { withWindowsAiOcr, windowsAiError } from './windowsAiOcr';
vi.mock('./modelIdle', () => ({ getModelIdleSeconds: () => 120 }));
afterEach(() => vi.unstubAllGlobals());
it('retains layout, accepts an empty result and closes the recognizer on success', async () => {
  const run = vi.fn(async ({ action }: { action: string }) =>
    action === 'recognize'
      ? { ok: true, data: { text: '', lines: [], engine: 'Windows AI OCR' } }
      : { ok: true },
  );
  vi.stubGlobal('window', { surfaceDesktop: { windowsAiOcr: { run } } });
  await withWindowsAiOcr(new AbortController().signal, async (recognize) => {
    expect(await recognize('input', 0)).toMatchObject({ text: '', lines: [] });
  });
  expect(run.mock.calls.map(([v]) => v.action)).toEqual(['open', 'recognize', 'close']);
});
it('abort closes in-flight system inference and never publishes late text', async () => {
  const abort = new AbortController();
  let finish: (v: unknown) => void;
  const run = vi.fn(({ action }: { action: string }) =>
    action === 'recognize'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ ok: true }),
  );
  vi.stubGlobal('window', { surfaceDesktop: { windowsAiOcr: { run } } });
  const job = withWindowsAiOcr(abort.signal, (recognize) => recognize('input', 0));
  await vi.waitFor(() =>
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ action: 'recognize' })),
  );
  abort.abort();
  finish!({ ok: true, data: { text: 'late', lines: [], engine: 'Windows AI OCR' } });
  await expect(job).rejects.toThrow();
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ action: 'close' }));
});
it('distinguishes native result failures from missing application identity', () => {
  expect(windowsAiError('windows-ai-unavailable', '0x80004003', 'read-result')).toContain(
    '读取识别结果',
  );
  expect(windowsAiError('windows-ai-identity', '0x80070005')).toContain('身份权限');
});
