import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { providerTypes, defaultProfile } from './providerSettings';
const { createProviderVault } = createRequire(import.meta.url)('../electron/provider-vault.cjs');
const record = (key = 'secret') => ({
  selected: 'web',
  profiles: {
    web: {
      url: 'https://api.test',
      model: 'model',
      voice: 'alloy',
      key,
      headers: '{"x-api-key":"header-secret"}',
      timeoutSeconds: 15,
      fallback: true,
      stream: false,
    },
  },
});
function crypto() {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text: string) => {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv),
        bytes = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptStringAsync: async (bytes: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return {
        result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
      };
    },
  };
}
async function fixture(fn: (file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'surfacetab-vault-unit-'));
  try {
    await fn(join(dir, 'settings.enc'));
  } finally {
    await rm(dir, { recursive: true });
  }
}
it('encrypts all fields and preserves concurrent per-feature writes across reopening', async () =>
  fixture(async (file) => {
    const safeStorage = crypto(),
      vault = createProviderVault({ file, safeStorage });
    await Promise.all(
      ['translation', 'speech', 'ocr', 'formula'].map((feature) =>
        vault.write(feature, record(feature + '-key')),
      ),
    );
    const bytes = await readFile(file);
    expect(bytes.toString()).not.toContain('header-secret');
    expect(bytes.toString()).not.toContain('translation-key');
    const reopened = createProviderVault({ file, safeStorage });
    for (const feature of ['translation', 'speech', 'ocr', 'formula'])
      expect((await reopened.read(feature)).data.profiles.web.key).toBe(feature + '-key');
  }));
it('keeps session-only data when OS encryption is unavailable, without writing plaintext', async () =>
  fixture(async (file) => {
    const vault = createProviderVault({
      file,
      safeStorage: { isAsyncEncryptionAvailable: async () => false },
    });
    expect((await vault.write('ocr', record())).status).toBe('session');
    expect((await vault.read('ocr')).data.profiles.web.key).toBe('secret');
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  }));
it('preserves unreadable/corrupt existing vault and refuses an implicit overwrite', async () =>
  fixture(async (file) => {
    await writeFile(file, 'original corrupt data');
    const vault = createProviderVault({ file, safeStorage: crypto() });
    expect((await vault.read('ocr')).status).toBe('error');
    expect((await vault.write('ocr', record())).status).toBe('error');
    expect(await readFile(file, 'utf8')).toBe('original corrupt data');
  }));
it('clears only chosen backend credentials and never returns mutable internal state', async () =>
  fixture(async (file) => {
    const vault = createProviderVault({ file, safeStorage: crypto() });
    const r = record();
    r.profiles = {
      ...r.profiles,
      llm: { ...r.profiles.web, key: 'separate-key' },
    } as typeof r.profiles;
    await vault.write('translation', r);
    const loaded = await vault.read('translation');
    loaded.data.profiles.web.key = '';
    loaded.data.profiles.web.headers = '';
    await vault.write('translation', loaded.data);
    expect((await vault.read('translation')).data.profiles.llm.key).toBe('separate-key');
    const copy = await vault.read('translation');
    copy.data.profiles.llm.key = 'changed';
    expect((await vault.read('translation')).data.profiles.llm.key).toBe('separate-key');
  }));
it('rejects unknown profiles, features, oversized keys and invalid timeouts', async () =>
  fixture(async (file) => {
    const vault = createProviderVault({ file, safeStorage: crypto() });
    await expect(vault.read('__proto__')).rejects.toThrow();
    for (const r of [
      { ...record(), selected: 'unknown' },
      record('x'.repeat(8193)),
      {
        selected: 'web',
        profiles: { web: { ...record().profiles.web, timeoutSeconds: Infinity } },
      },
    ])
      await expect(vault.write('ocr', r)).rejects.toThrow();
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  }));
it('failed encryption cannot replace the previous valid file or publish an unsaved state', async () =>
  fixture(async (file) => {
    const safeStorage = crypto(),
      vault = createProviderVault({ file, safeStorage });
    await vault.write('ocr', record('old'));
    const previous = await readFile(file);
    safeStorage.encryptStringAsync = async () => {
      throw new Error('unavailable');
    };
    expect((await vault.write('ocr', record('new'))).status).toBe('error');
    expect(await readFile(file)).toEqual(previous);
    expect((await vault.read('ocr')).data.profiles.web.key).toBe('old');
  }));

it('all supported profiles can reach their allowed field sizes and still reopen', async () =>
  fixture(async (file) => {
    const safeStorage = crypto(),
      vault = createProviderVault({ file, safeStorage });
    for (const feature of ['translation', 'speech', 'ocr', 'formula', 'chat'] as const) {
      const profiles = Object.fromEntries(
        providerTypes[feature].map((type) => [
          type,
          { ...defaultProfile(feature, type), key: 'k'.repeat(8192), headers: 'h'.repeat(16384) },
        ]),
      );
      await vault.write(feature, { selected: providerTypes[feature][0], profiles });
    }
    const bytes = await readFile(file);
    expect(bytes.length).toBeGreaterThan(262144);
    expect(bytes.length).toBeLessThan(1048576);
    const reopened = createProviderVault({ file, safeStorage });
    expect((await reopened.read('formula')).data.profiles.llm.key).toHaveLength(8192);
    expect((await reopened.read('chat')).data.profiles.llm.pdfInput).toBe('text');
    expect((await reopened.read('chat')).data.profiles.llm.key).toHaveLength(8192);
  }));

it('persists both Hy-MT2 translation selections without losing other provider profiles', async () =>
  fixture(async (file) => {
    const safeStorage = crypto();
    let vault = createProviderVault({ file, safeStorage });
    for (const type of ['hymt2', 'hymt2-openvino'] as const) {
      await vault.write('translation', {
        selected: type,
        profiles: { ...record('kept-key').profiles, [type]: defaultProfile('translation', type) },
      });
      vault = createProviderVault({ file, safeStorage });
      const saved = await vault.read('translation');
      expect(saved.status).toBe('encrypted');
      expect(saved.data.selected).toBe(type);
      expect(saved.data.profiles.web.key).toBe('kept-key');
      expect(saved.data.profiles[type]).toEqual(defaultProfile('translation', type));
    }
  }));
