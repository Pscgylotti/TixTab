import { extractFile, listPackage } from '@electron/asar';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { dirname, join, normalize } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { verifyExecutableIcon } from './verify-icons.mjs';
const archive =
  process.argv[2] ||
  `release/${JSON.parse(readFileSync('package.json', 'utf8')).version}/win-unpacked/resources/app.asar`;
const entries = listPackage(archive).map((name) => name.replaceAll('\\', '/'));
for (const folder of ['performance', 'maintenance'])
  assert.equal(
    existsSync(join(dirname(dirname(archive)), 'docs', folder)),
    false,
    'Raw experiment archives must not ship: ' + folder,
  );
for (const name of ['tixtab.svg', 'tixtab.png', 'tixtab.ico'])
  assert.deepEqual(
    extractFile(archive, normalize('dist/' + name)),
    readFileSync('public/' + name),
    'Bundled application icon differs: ' + name,
  );
await verifyExecutableIcon(join(dirname(dirname(archive)), 'TixTab.exe'));
assert.ok(entries.includes('/electron/preload.cjs'));
assert.ok(entries.includes('/electron/desktop-shortcut.cjs'), 'Desktop shortcut module missing');
assert.ok(
  entries.includes('/electron/provider-vault.cjs'),
  'Encrypted provider settings module missing',
);
assert.ok(entries.includes('/electron/provider-relay.cjs'), 'Native HTTP relay module missing');
assert.ok(entries.includes('/electron/model-library.cjs'), 'Model library module missing');
assert.ok(entries.includes('/electron/zotero.cjs'), 'Zotero local API bridge missing');
assert.ok(entries.includes('/electron/model-catalog.json'), 'Pinned model catalog missing');
for (const file of ['runtime-installer.cjs', 'runtime-manifest.json'])
  assert.ok(entries.includes('/electron/' + file), 'Managed runtime companion missing: ' + file);
assert.ok(
  entries.includes('/electron/neural-dictation.cjs'),
  'Local neural speech controller missing',
);
for (const file of ['cache-manager.cjs', 'cache-helper.ps1', 'cache-catalog.json'])
  assert.ok(entries.includes('/electron/' + file), 'Cache management companion missing: ' + file);
for (const file of ['cache-helper.ps1', 'cache-catalog.json']) {
  const unpacked = archive + '.unpacked/electron/' + file;
  assert.equal(
    createHash('sha256').update(readFileSync(unpacked)).digest('hex'),
    createHash('sha256')
      .update(readFileSync('electron/' + file))
      .digest('hex'),
    'Unpacked helper differs: ' + file,
  );
}
assert.ok(entries.includes('/dist/piper/phonemize.mjs'), 'Offline phonemizer module missing');
const lite = process.argv.includes('--lite');
let buildFilesVerified = 0;
function verifyBuildFolder(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const name = folder + '/' + entry.name;
    if (lite && (name === 'dist/models' || /^dist\/piper\/.*\.(wasm|data)$/.test(name))) continue;
    if (entry.isDirectory()) verifyBuildFolder(name);
    else if (entry.isFile()) {
      assert.ok(entries.includes('/' + name), 'Build file missing: ' + name);
      assert.deepEqual(
        extractFile(archive, normalize(name)),
        readFileSync(name),
        'Build file differs: ' + name,
      );
      buildFilesVerified++;
    }
  }
}
verifyBuildFolder('dist');
verifyBuildFolder('electron');
assert.ok(
  !entries.some((name) => /\/(?:\.claude|\.cache|tests|test-results)\//.test(name)),
  'Private or test data must not ship',
);
if (!lite)
  for (const name of ['LICENSE.txt', 'NOTICE.txt', 'RAPIDOCR-MODEL-LICENSES.md'])
    assert.ok(
      entries.includes('/dist/models/ppocrv4/' + name),
      'OCR license/notice missing: ' + name,
    );
const nativeDependency = (name) =>
  name.startsWith('/node_modules/koffi/') ||
  name.startsWith('/node_modules/@koromix/koffi-win32-x64/') ||
  [
    '/node_modules',
    '/node_modules/koffi',
    '/node_modules/@koromix',
    '/node_modules/@koromix/koffi-win32-x64',
  ].includes(name);
assert.deepEqual(
  entries.filter((name) => name.startsWith('/node_modules/') && !nativeDependency(name)),
  [],
  'Only the Windows pen native dependency may ship in node_modules',
);
assert.ok(entries.includes('/electron/pen-native.cjs'), 'Native pen bridge missing');
for (const name of [
  'pdf-editor.cjs',
  'clipboard-history.cjs',
  'pen-haptics.cjs',
  'pen-haptics-native.cjs',
  'runtime-sources.cjs',
  'runtime-log.cjs',
])
  assert.ok(entries.includes('/electron/' + name), 'Desktop companion missing: ' + name);
for (const name of [
  'pdf_editor.py',
  'requirements-pdf.txt',
  'install_dependencies.py',
  'python-sources.json',
  'document_correct.py',
  'homr_runner.py',
  'homr_layout.py',
  'requirements-homr.txt',
])
  assert.deepEqual(
    readFileSync(join(dirname(dirname(archive)), 'backend', name)),
    readFileSync(join('backend', name)),
    'Native editor/setup source differs: ' + name,
  );
assert.equal(
  entries.filter((name) => /^\/dist\/assets\/pdfium\.worker-[^/]+\.js$/.test(name)).length,
  1,
  'PDFium worker must ship',
);
assert.ok(
  existsSync(archive + '.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node'),
  'Unpacked pen native binding missing',
);
const json = (name) => JSON.parse(extractFile(archive, normalize(name)).toString());
const pkg = json('package.json');
assert.equal(pkg.main, 'electron/main.cjs');
assert.equal(pkg.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
for (const file of [
  'tixtab-ocr.exe',
  'TESSERACT-LICENSE.txt',
  'LEPTONICA-LICENSE.txt',
  'BUILD-INFO.json',
])
  assert.deepEqual(
    readFileSync(join(dirname(dirname(archive)), 'native/ocr', file)),
    readFileSync(join('.cache/native-ocr/runtime', file)),
    'Native OCR runtime differs: ' + file,
  );
for (const name of ['batch-pdf.cjs', 'clipboard-shelf.cjs', 'main.cjs', 'preload.cjs'])
  assert.deepEqual(
    extractFile(archive, normalize('electron/' + name)),
    readFileSync('electron/' + name),
    'Desktop release source differs: ' + name,
  );
const pdfExportWorkers = entries.filter((name) =>
  /^\/dist\/assets\/pdfExport\.worker-[^/]+\.js$/.test(name),
);
assert.equal(pdfExportWorkers.length, 1, 'Exactly one bundled PDF export worker must exist');
const pinyinWorkers = entries.filter((name) =>
  /^\/dist\/assets\/pinyin\.worker-[^/]+\.js$/.test(name),
);
assert.equal(
  pinyinWorkers.length,
  1,
  'Exactly one offline Pinyin worker/dictionary must exist in both variants',
);
assert.ok(
  extractFile(archive, normalize(pinyinWorkers[0].slice(1))).length > 2_000_000,
  'Bundled Pinyin dictionary missing',
);
const catalog = json('electron/model-catalog.json');
assert.equal(catalog.models.length, 17);
assert.equal(
  catalog.models.reduce((n, m) => n + m.files.length, 0),
  68,
);
for (const name of [
  'native_tesseract.py',
  'experimental/tesseract_graph.py',
  'experimental/tesseract_batch_graph.py',
  'experimental/tesseract_pipeline.py',
])
  assert.ok(
    existsSync(join(dirname(dirname(archive)), 'backend', name)),
    'Queued NPU OCR companion missing: ' + name,
  );
let checked = 0,
  bytes = 0;
if (lite)
  assert.ok(
    !entries.some((name) => /\/piper\/.*\.(wasm|data)$/.test(name)),
    'Lite build must not redistribute the optional phonemizer binary',
  );
if (lite)
  assert.equal(
    entries.filter((name) => name.startsWith('/dist/models/')).length,
    0,
    'Lite build must not bundle model weights',
  );
else
  for (const manifest of [
    'dist/models/reading-manifest.json',
    'dist/models/texo/manifest.json',
    'dist/models/opus-en-zh/manifest.json',
    'dist/models/opus-zh-en/manifest.json',
    'dist/models/ppocrv4/manifest.json',
  ]) {
    const base = manifest.slice(0, manifest.lastIndexOf('/') + 1);
    for (const file of json(manifest).files) {
      const name = file.name ?? file.file,
        data = extractFile(archive, normalize(base + name));
      assert.equal(data.length, file.size ?? file.bytes, name + ' size');
      assert.equal(createHash('sha256').update(data).digest('hex'), file.sha256, name + ' SHA256');
      checked++;
      bytes += data.length;
    }
  }
console.log(
  JSON.stringify(
    {
      version: pkg.version,
      lite,
      catalogModels: catalog.models.length,
      entries: entries.length,
      buildFilesVerified,
      modelFilesVerified: checked,
      modelBytesVerified: bytes,
      duplicateNodeModules: false,
      nativePreload: true,
      pdfExportWorker: pdfExportWorkers[0],
    },
    null,
    2,
  ),
);
