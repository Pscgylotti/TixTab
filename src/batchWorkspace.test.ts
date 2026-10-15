import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchOutputName } from './batchWorkspace';
const { createBatchPdf } = createRequire(import.meta.url)('../electron/batch-pdf.cjs');
it('indexes only PDFs recursively, persists folder grants and exports without overwriting originals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tixtab-batch-')),
    input = join(root, 'input'),
    output = join(root, 'output');
  await mkdir(join(input, 'nested'), { recursive: true });
  await mkdir(output);
  const bytes = Buffer.from('%PDF-1.7\nfixture');
  await writeFile(join(input, 'paper10.pdf'), bytes);
  await writeFile(join(input, 'paper2.PDF'), bytes);
  await writeFile(join(input, 'nested', 'third.pdf'), bytes);
  await writeFile(join(input, 'ignore.txt'), 'ignored');
  const options = {
    showItemInFolder: vi.fn(),
    grantFile: join(root, 'grants.json'),
    chooseDirectory: async (_owner: unknown, exporting: boolean) => (exporting ? output : input),
  };
  let service = createBatchPdf(options);
  const owner = {};
  try {
    const chosen = await service.run(owner, { action: 'choose' });
    expect(chosen.folder.files.map((file: any) => file.name)).toEqual([
      'nested/third.pdf',
      'paper2.PDF',
      'paper10.pdf',
    ]);
    const { id: folderId, files } = chosen.folder;
    expect(await service.run(owner, { action: 'reveal', folderId, fileId: files[1].id })).toEqual({
      ok: true,
    });
    expect(options.showItemInFolder).toHaveBeenCalledWith(join(input, 'paper2.PDF'));
    expect(
      (await service.run(owner, { action: 'reveal', folderId, fileId: '../ignore.txt' })).ok,
    ).toBe(false);
    expect(
      (await service.run(owner, { action: 'read', folderId, fileId: files[1].id })).bytes,
    ).toEqual(bytes);
    expect(
      (await service.run(owner, { action: 'read', folderId, fileId: '../ignore.txt' })).ok,
    ).toBe(false);
    service.dispose();
    service = createBatchPdf(options);
    expect(
      (await service.run(owner, { action: 'read', folderId, fileId: files[0].id })).bytes,
    ).toEqual(bytes);
    const target = await service.run(owner, { action: 'choose-output' });
    const request = { action: 'write', token: target.token, name: 'paper-annotated.pdf', bytes };
    expect((await service.run({}, request)).ok).toBe(false);
    expect((await service.run(owner, { ...request, name: '../bad.pdf' })).ok).toBe(false);
    expect((await service.run(owner, request)).name).toBe('paper-annotated.pdf');
    expect((await service.run(owner, request)).name).toBe('paper-annotated (2).pdf');
    expect(await readFile(join(input, 'paper10.pdf'))).toEqual(bytes);
    expect(await readFile(join(output, 'paper-annotated.pdf'))).toEqual(bytes);
    service.cancel(owner);
    expect((await service.run(owner, request)).ok).toBe(false);
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
it('cancellation during the output picker cannot recreate a writing capability', async () => {
  let release!: (directory: string) => void;
  const root = await mkdtemp(join(tmpdir(), 'tixtab-batch-cancel-'));
  const service = createBatchPdf({
      grantFile: join(root, 'grants.json'),
      chooseDirectory: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
    owner = {};
  try {
    const choosing = service.run(owner, { action: 'choose-output' });
    // The grant file read is asynchronous, so wait until the native picker has been requested.
    for (let attempt = 0; !release && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    service.cancel(owner);
    release(root);
    expect((await choosing).cancelled).toBe(true);
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
it('output names flatten relative paths and retain a distinct annotation suffix', () => {
  expect(batchOutputName('nested/paper.PDF')).toBe('nested_paper-annotated.pdf');
});
