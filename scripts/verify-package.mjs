import { extractFile, listPackage } from '@electron/asar';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { normalize } from 'node:path';
import { readFileSync } from 'node:fs';
const archive =
  process.argv[2] ||
  `release/${JSON.parse(readFileSync('package.json', 'utf8')).version}/win-unpacked/resources/app.asar`;
const entries = listPackage(archive).map((name) => name.replaceAll('\\', '/'));
assert.ok(entries.includes('/electron/preload.cjs'));
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
if (!lite)
  for (const name of ['LICENSE.txt', 'NOTICE.txt', 'RAPIDOCR-MODEL-LICENSES.md'])
    assert.ok(
      entries.includes('/dist/models/ppocrv4/' + name),
      'OCR license/notice missing: ' + name,
    );
assert.equal(
  entries.filter((name) => name.startsWith('/node_modules/')).length,
  0,
  'Desktop main only uses built-ins; bundled browser code should not duplicate node_modules',
);
const json = (name) => JSON.parse(extractFile(archive, normalize(name)).toString());
const pkg = json('package.json');
assert.equal(pkg.main, 'electron/main.cjs');
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
assert.equal(catalog.models.length, 12);
assert.equal(
  catalog.models.reduce((n, m) => n + m.files.length, 0),
  60,
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
