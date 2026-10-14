import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createDesktopShortcut } = createRequire(import.meta.url)(
  '../electron/desktop-shortcut.cjs',
);
it('targets the persistent executable, updates own shortcut, and preserves unrelated desktop files', () => {
  const folder = mkdtempSync(join(tmpdir(), 'tixtab-shortcut-')),
    exe = join(folder, 'TixTab.exe'),
    portable = join(folder, 'TixTab-portable.exe'),
    writes: { file: string; operation: string; options: any }[] = [],
    details = new Map<string, any>();
  const app = { isPackaged: true, getPath: (name: string) => (name === 'desktop' ? folder : exe) },
    shell = {
      readShortcutLink: (file: string) =>
        details.get(file) ?? { target: 'unrelated.exe', appUserModelId: 'unrelated' },
      writeShortcutLink: (file: string, operation: string, options: any) => {
        writes.push({ file, operation, options });
        details.set(file, options);
        writeFileSync(file, 'shortcut');
        return true;
      },
    };
  try {
    writeFileSync(exe, 'test');
    writeFileSync(portable, 'test');
    writeFileSync(join(folder, 'TixTab.lnk'), 'unrelated');
    expect(createDesktopShortcut({ app, shell, platform: 'win32', portable: '' }).ok).toBe(true);
    expect(writes[0].file).toBe(join(folder, 'TixTab (2).lnk'));
    expect(writes[0].options.target).toBe(exe);
    expect(createDesktopShortcut({ app, shell, platform: 'win32', portable }).ok).toBe(true);
    expect(writes[1].operation).toBe('update');
    expect(writes[1].options.target).toBe(portable);
    expect(writes[1].options.icon).toBe(portable);
    expect(
      createDesktopShortcut({ app: { ...app, isPackaged: false }, shell, platform: 'win32' }).ok,
    ).toBe(false);
  } finally {
    for (const file of readdirSync(folder)) unlinkSync(join(folder, file));
    rmdirSync(folder);
  }
});
