const fs = require('node:fs/promises');
const path = require('node:path');
async function revealPdf(request, { chooseFile, showItemInFolder }) {
  try {
    let file = request?.path;
    if (file !== undefined && (typeof file !== 'string' || file.length > 32767))
      return { ok: false, error: 'invalid' };
    if (!file) {
      file = await chooseFile();
      if (!file) return { ok: false, cancelled: true };
    }
    if (
      !path.isAbsolute(file) ||
      path.extname(file).toLowerCase() !== '.pdf' ||
      file.includes('\0')
    )
      return { ok: false, error: 'invalid' };
    if (!(await fs.stat(file)).isFile()) return { ok: false, error: 'missing' };
    showItemInFolder(file);
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, error: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'reveal' };
  }
}
module.exports = { revealPdf };
