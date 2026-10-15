import { it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { revealPdf } = createRequire(import.meta.url)('../electron/document-location.cjs');
it('reveals only an existing absolute PDF, supports associating old tabs and handles picker cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tixtab-location-')),
    file = join(root, '[Website] paper.PDF'),
    showItemInFolder = vi.fn(),
    chooseFile = vi.fn(async () => file),
    options = { chooseFile, showItemInFolder };
  try {
    await writeFile(file, '%PDF-1.7');
    expect(await revealPdf({ path: file }, options)).toEqual({ ok: true, path: file });
    expect(chooseFile).not.toHaveBeenCalled();
    expect(await revealPdf({}, options)).toEqual({ ok: true, path: file });
    expect(showItemInFolder).toHaveBeenCalledTimes(2);
    for (const path of ['paper.pdf', join(root, 'missing.pdf'), join(root, 'program.exe'), root])
      expect((await revealPdf({ path }, options)).ok).toBe(false);
    expect(showItemInFolder).toHaveBeenCalledTimes(2);
    chooseFile.mockResolvedValueOnce(null as any);
    expect(await revealPdf({}, options)).toEqual({ ok: false, cancelled: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
