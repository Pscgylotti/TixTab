import { expect, it } from 'vitest';
import { initialLocale } from './locale';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

it('uses English when system preferences are missing or unsupported', () => {
  expect(initialLocale(null, [])).toBe('en');
  expect(initialLocale('invalid', ['de-DE', 'fr', null])).toBe('en');
});
it('negotiates supported languages in system preference order', () => {
  expect(initialLocale(null, ['fr-FR', 'zh-Hans-CN', 'en-US'])).toBe('zh-CN');
  expect(initialLocale(null, ['en-GB', 'zh-CN'])).toBe('en');
  expect(initialLocale(null, ['ZH_cn'])).toBe('zh-CN');
});
it('preserves either explicit language over system changes', () => {
  expect(initialLocale('en', ['zh-CN'])).toBe('en');
  expect(initialLocale('zh-CN', ['en-US'])).toBe('zh-CN');
});
it('preload exposes only bounded system language tags without synchronous IPC', () => {
  const preload = readFileSync('electron/preload.cjs', 'utf8');
  const bridge = (argument: string) => {
    let result: any;
    runInNewContext(preload, {
      require: () => ({
        contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => (result = value) },
      }),
      process: { argv: ['electron', argument] },
    });
    return result.systemLanguages;
  };
  expect(bridge('--tixtab-system-languages=["zh-Hans-CN","en-US",null,"<script>"]')).toEqual([
    'zh-Hans-CN',
    'en-US',
  ]);
  expect(bridge('--tixtab-system-languages=invalid')).toEqual([]);
});
