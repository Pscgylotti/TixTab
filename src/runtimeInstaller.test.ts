import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
const { createRuntimeInstaller } = createRequire(import.meta.url)(
  '../electron/runtime-installer.cjs',
);
const manifest = createRequire(import.meta.url)('../electron/runtime-manifest.json');

describe('managed runtime installer', () => {
  it('retries the pinned Python mirror, logs redacted progress, and installs from the selected package source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tixtab-runtime-fallback-')),
      calls: string[] = [],
      commands: string[][] = [];
    const archive = Buffer.from('verified archive test');
    const record = {
      ...manifest,
      bytes: archive.length,
      sha256: createHash('sha256').update(archive).digest('hex'),
    };
    const installer = createRuntimeInstaller({
      root,
      backend: resolve('backend'),
      platform: 'win32',
      arch: 'x64',
      runtimeManifest: record,
      fetch: async (url: string) => {
        calls.push(url);
        if (url === record.url) throw Error('offline');
        return new Response(archive);
      },
      spawnProcess: (_exe: string, args: string[], options: any) => {
        expect(options.windowsHide).toBe(true);
        commands.push(args);
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(async () => {
          if (args[0] === '-xzf') {
            await mkdir(join(args[3], 'python'));
            await writeFile(join(args[3], 'python', 'python.exe'), 'test');
          }
          if (args.includes('venv')) {
            await mkdir(join(args[2], 'Scripts'), { recursive: true });
            await writeFile(join(args[2], 'Scripts', 'python.exe'), 'test');
          }
          if (args[0] === '-c')
            child.stdout.emit('data', Buffer.from('{"installed":true,"devices":[]}'));
          if (args[0].endsWith('install_dependencies.py')) {
            expect(args.slice(2)).toEqual(['--source', 'tuna']);
            child.stdout.emit('data', Buffer.from('{"event":"source","source":"tuna"}\n'));
            child.stderr.emit(
              'data',
              Buffer.from(
                'Authorization: Bearer private123\nhttps://user:pass@example.org/a?token=hidden\n',
              ),
            );
          }
          child.emit('close', 0);
        });
        return child;
      },
    });
    try {
      expect(
        await installer.configureSources({ packages: 'tuna', python: 'auto', customIndex: '' }),
      ).toMatchObject({ ok: true });
      expect(await installer.install({}, 'pdf')).toMatchObject({ ok: true });
      expect(calls).toEqual([record.url, record.mirrors[0]]);
      expect(commands.some((args) => args[0] === '-xzf')).toBe(true);
      const result = await installer.diagnostics({}, 'pdf');
      expect(result.logs).toContain('SHA256 verified');
      expect(result.logs).toContain('Package source: tuna');
      expect(result.logs).toContain('[redacted]');
      for (const secret of ['private123', 'user:pass', 'token=hidden'])
        expect(result.logs).not.toContain(secret);
      expect(result.updatedAt).toBeGreaterThan(0);
      expect(await installer.downloadSources()).toEqual({
        packages: 'tuna',
        python: 'auto',
        customIndex: '',
      });
      expect(
        await installer.configureSources({
          packages: 'custom',
          python: 'auto',
          customIndex: 'https://user:pass@example.org/simple',
        }),
      ).toMatchObject({ ok: false, error: 'invalid-source' });
    } finally {
      installer.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('checks the PDF-only runtime without importing OpenVINO or probing accelerators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tixtab-pdf-runtime-'));
    try {
      const scripts = join(root, 'pdf-runtime', 'Scripts');
      await mkdir(scripts, { recursive: true });
      await writeFile(join(scripts, 'python.exe'), 'test');
      const installer = createRuntimeInstaller({
        root,
        backend: resolve('backend'),
        platform: 'win32',
        arch: 'x64',
        fetch: () => {
          throw Error('Unexpected download');
        },
        spawnProcess: (_exe: string, args: string[], options: any) => {
          expect(options.windowsHide).toBe(true);
          expect(args[1]).toContain('import pymupdf');
          expect(args[1]).toContain('1.28.2');
          expect(args[1]).not.toContain('openvino');
          const child = new EventEmitter() as any;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => {};
          queueMicrotask(() => {
            child.stdout.emit('data', Buffer.from('{"installed":true,"devices":[]}'));
            child.emit('close', 0);
          });
          return child;
        },
      });
      expect(await installer.status('pdf')).toEqual({ installed: true, devices: [] });
      expect(await installer.install({}, 'pdf')).toMatchObject({
        ok: true,
        data: { installed: true, devices: [] },
      });
      installer.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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
      expect((await readdir(root)).sort()).toEqual([
        'keep.txt',
        'python',
        'runtime-install-speech.log',
      ]);
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
