import { it, expect } from 'vitest';
import { pdfFingerprint, samePdfPath } from './pdfAssociation';
import { newNotebook } from './model';
import { encodeProject, decodeProject } from './storage';

it('matches Windows path spelling and preserves original PDF identity after embedded edits and export', async () => {
  expect(samePdfPath('C:\\Papers\\One.pdf', 'c:/papers/ONE.PDF')).toBe(true);
  expect(samePdfPath('C:/Papers/One.pdf', 'D:/Other/One.pdf')).toBe(false);
  expect(samePdfPath(undefined, undefined)).toBe(false);
  const sourceFingerprint = await pdfFingerprint(new Uint8Array([1, 2, 3]));
  const n = {
    ...newNotebook(),
    source: new Uint8Array([4, 5, 6]),
    sourceFingerprint,
    sourcePath: 'C:/Papers/One.pdf',
  };
  const copy = decodeProject(encodeProject(n));
  expect(copy.sourcePath).toBeUndefined();
  expect(copy.sourceFingerprint).toBe(sourceFingerprint);
  expect(await pdfFingerprint(copy.source!)).not.toBe(sourceFingerprint);
});
