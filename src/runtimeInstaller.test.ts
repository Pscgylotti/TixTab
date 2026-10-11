import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const { createRuntimeInstaller } = createRequire(import.meta.url)(
  '../electron/runtime-installer.cjs',
);
const manifest = createRequire(import.meta.url)('../electron/runtime-manifest.json');

describe('managed runtime installer', () => {
  it('rejects arbitrary profiles and non-Windows targets without downloading or spawning', async () => {
    const installer = createRuntimeInstaller({
      root: tmpdir(),
      backend: resolve('backend'),
      fetch: () => {
        throw Error('Unexpected network');
      },
      spawnProcess: () => {
        throw Error('Unexpected command');
      },
      platform: 'linux',
      arch: 'x64',
    });
    expect(await installer.install({}, '../../escape')).toMatchObject({
      ok: false,
      error: 'invalid',
    });
    expect(await installer.install({}, 'speech')).toMatchObject({
      ok: false,
      error: 'unsupported',
    });
    installer.dispose();
  });
  it('rejects a corrupted interpreter before extraction and preserves existing data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfacetab-installer-'));
    try {
      await writeFile(join(root, 'keep.txt'), 'keep');
      let commands = 0;
      const installer = createRuntimeInstaller({
        root,
        backend: resolve('backend'),
        platform: 'win32',
        arch: 'x64',
        fetch: async () => new Response('corrupt'),
        spawnProcess: () => {
          commands++;
          throw Error('Must not extract');
        },
      });
      expect(await installer.install({}, 'speech')).toMatchObject({ ok: false, error: 'checksum' });
      expect(commands).toBe(0);
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('keep');
      expect((await readdir(root)).sort()).toEqual(['keep.txt', 'python']);
      expect(await readdir(join(root, 'python'))).toEqual([]);
      installer.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('isolates owners, prevents concurrent installs and allows retry after cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfacetab-installer-')),
      owner = {},
      other = {};
    let requested!: () => void;
    const entered = new Promise<void>((resolve) => (requested = resolve));
    const installer = createRuntimeInstaller({
      root,
      backend: resolve('backend'),
      platform: 'win32',
      arch: 'x64',
      fetch: async (url: string, options: any) => {
        expect(url).toBe(manifest.url);
        requested();
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(Error('cancelled')), {
            once: true,
          }),
        );
      },
    });
    try {
      const task = installer.install(owner, 'openvino');
      await entered;
      expect(installer.cancel(other)).toBe(false);
      expect(await installer.install(other, 'speech')).toMatchObject({ ok: false, error: 'busy' });
      expect(installer.cancel(owner)).toBe(true);
      expect(await task).toMatchObject({ ok: false, error: 'cancelled' });
      expect(await readdir(join(root, 'python'))).toEqual([]);
      expect((await readdir(root)).includes('.runtime-install.lock')).toBe(false);
    } finally {
      installer.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not modify an environment while another live process owns its lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfacetab-installer-'));
    try {
      await writeFile(join(root, '.runtime-install.lock'), JSON.stringify({ pid: process.pid }));
      const installer = createRuntimeInstaller({
        root,
        backend: resolve('backend'),
        platform: 'win32',
        arch: 'x64',
        fetch: () => {
          throw Error('Unexpected download');
        },
      });
      expect(await installer.install({}, 'speech')).toMatchObject({ ok: false, error: 'busy' });
      expect(JSON.parse(await readFile(join(root, '.runtime-install.lock'), 'utf8')).pid).toBe(
        process.pid,
      );
      installer.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
