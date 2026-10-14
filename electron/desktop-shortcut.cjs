const path = require('node:path');
const fs = require('node:fs');
const APP_ID = 'local.surfacetab.app';
function createDesktopShortcut({
  app,
  shell,
  portable = process.env.PORTABLE_EXECUTABLE_FILE,
  platform = process.platform,
}) {
  if (platform !== 'win32' || !app.isPackaged) return { ok: false, error: 'packaged-windows-only' };
  try {
    // The portable launcher survives extraction cleanup; process.execPath does not.
    const target = portable || app.getPath('exe');
    if (
      !path.isAbsolute(target) ||
      path.extname(target).toLowerCase() !== '.exe' ||
      !fs.statSync(target).isFile()
    )
      return { ok: false, error: 'missing-executable' };
    const desktop = app.getPath('desktop');
    for (let number = 1; number <= 100; number++) {
      const file = path.join(desktop, number === 1 ? 'TixTab.lnk' : `TixTab (${number}).lnk`);
      let operation = 'create';
      if (fs.existsSync(file)) {
        let previous;
        try {
          previous = shell.readShortcutLink(file);
        } catch {
          continue;
        }
        if (
          previous.appUserModelId !== APP_ID &&
          path.normalize(previous.target).toLowerCase() !== path.normalize(target).toLowerCase()
        )
          continue;
        operation = 'update';
      }
      const ok = shell.writeShortcutLink(file, operation, {
        target,
        cwd: path.dirname(target),
        icon: target,
        iconIndex: 0,
        appUserModelId: APP_ID,
        description: 'TixTab PDF workspace',
      });
      return ok ? { ok: true, path: file } : { ok: false, error: 'write-failed' };
    }
    return { ok: false, error: 'name-conflict' };
  } catch {
    return { ok: false, error: 'write-failed' };
  }
}
module.exports = { createDesktopShortcut };
