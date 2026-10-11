import { _electron as electron } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { verifyPdfUi } from './verify-pdf-ui.mjs';
import { verifyPdfWorkerUi } from './verify-pdf-worker-ui.mjs';
import { verifyDocumentUi } from './verify-document-ui.mjs';
import { verifyFormulaUi } from './verify-formula-ui.mjs';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const profile = await mkdtemp(join(tmpdir(), 'surfacetab-pdf-export-'));
const executable = resolve(process.argv[2] || `release/${version}/win-unpacked/SurfaceTab.exe`);
const app = await electron.launch({
  executablePath: executable,
  args: [],
  env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
  timeout: 60000,
});
try {
  const page = await app.firstWindow(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.app-shell').waitFor();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await verifyPdfUi(page);
  await verifyPdfWorkerUi(page);
  await verifyDocumentUi(page);
  await verifyFormulaUi(page);
  assert.deepEqual(errors, []);
  console.log('Actual packaged PDF export UI: passed; renderer errors: none; ' + executable);
} finally {
  await app.close();
}
