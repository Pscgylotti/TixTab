import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Include build tools too: Electron itself is a dev dependency in package.json.
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = [
    '| Leptonica (bundled native OCR helper) | 1.85.0 | BSD-2-Clause | https://github.com/DanBloomberg/leptonica |',
    '| PyMuPDF (optional local PDF runtime) | 1.28.2 | AGPL-3.0 / separate upstream commercial license | https://github.com/pymupdf/PyMuPDF |',
    '| Tesseract (bundled native OCR / optional OpenVINO adapter) | 5.5.0 | Apache-2.0 upstream; TixTab adapter: AGPL-3.0-only | https://github.com/tesseract-ocr/tesseract/tree/5.5.0 |',
    '| Windows App SDK AI (optional isolated OCR helper) | AI 1.8.79 / Foundation 1.8.260505001 | Microsoft Windows App SDK redistributable terms; bundled in component Licenses | https://github.com/microsoft/WindowsAppSDK |',
    '| .NET runtime (optional isolated OCR helper) | 10.0.2 | MIT / upstream third-party notices; bundled in component Licenses | https://github.com/dotnet/runtime |',
  ],
  texts = [];
for (const directory of Object.keys(lock.packages).filter((key) =>
  key.startsWith('node_modules/'),
)) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  const license =
    typeof pkg.license === 'string'
      ? pkg.license
      : JSON.stringify(pkg.license || pkg.licenses || 'See upstream');
  const repository =
    typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
  notices.push(
    `| ${pkg.name} | ${pkg.version} | ${license.replaceAll('|', '/')} | ${repository.replace(/^git\+/, '').replace(/\.git$/, '')} |`,
  );
  for (const file of (await readdir(directory)).filter((name) =>
    /^(licen[sc]e|copying|notice)([.-].*)?$/i.test(name),
  )) {
    try {
      texts.push(
        `\n===== ${pkg.name}@${pkg.version} / ${file} =====\n\n${await readFile(join(directory, file), 'utf8')}`,
      );
    } catch {
      /* Some packages have a directory named LICENSE. */
    }
  }
}
await writeFile(
  'THIRD_PARTY_NOTICES.md',
  `# Third-party notices / 第三方说明\n\nTixTab application code is AGPL-3.0-only. Third-party code and models retain their own licenses; this file does not relicense them. / 应用许可不覆盖第三方代码与模型。\n\nFull license texts: [docs/THIRD-PARTY-LICENSES.txt](docs/THIRD-PARTY-LICENSES.txt). Additional attribution: [Pinyin](docs/PINYIN-NOTICES.md), [model terms](docs/MODELS.md), [distribution notes](docs/DISTRIBUTION.md). Electron and Chromium notices are also included beside the extracted executable.\n\nPDF.js 5.4.624 is modified at build time for geometry-only image indexing. The reproducible patch is scripts/prepare-pdf-index-worker.mjs; generated workers retain the upstream Apache-2.0 notice. / PDF.js 构建扩展仅增加不解码位图的图片索引，保留上游 Apache-2.0 声明。\n\nGenerated from the locked dependency tree, including development tools. Exact package archives and hashes are recorded in package-lock.json.\n\n| Package | Version | License | Upstream |\n|---|---|---|---|\n${notices.sort().join('\n')}\n`,
);
await writeFile('docs/THIRD-PARTY-LICENSES.txt', texts.join('\n'));
console.log('Dependency notices:', notices.length, '; license/notice texts:', texts.length);
