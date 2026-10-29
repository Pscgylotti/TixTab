import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Include build tools too: Electron itself is a dev dependency in package.json.
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = [
    '| Matchmaker (bundled Windows wheel, optional runtime) | 0.4.0 / eacec8128e80fc6de980ac1371f6368176633b38 | Apache-2.0; original license retained inside wheel | https://github.com/pymatchmaker/matchmaker |',
    '| DocAligner (optional document corner model) | 1.1.1 FastViT T8 | Apache-2.0; model LICENSE downloaded alongside weights | https://github.com/DocsaidLab/DocAligner |',
    '| FluidSynth (optional score-reference synthesizer) | 2.6.1 | LGPL-2.1; downloaded archive retains upstream license and notices | https://github.com/FluidSynth/fluidsynth |',
    '| GeneralUser GS (optional score-reference SoundFont) | 2.0.3 | GeneralUser GS License v2.0; license downloaded alongside bank | https://github.com/mrbumpy409/GeneralUser-GS |',
    '| Hy-MT2 1.8B (optional local translation weights) | a0c709d9fac510f2c807aa3af52872340dc37a4a | Apache-2.0 | https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF |',
    '| llama.cpp (optional Vulkan / OpenVINO runtime) | b11429 | MIT / bundled OpenVINO Apache-2.0 notices | https://github.com/ggml-org/llama.cpp |',
    '| Audiveris (optional local music recognition) | 5.11.0 | AGPL-3.0 | https://github.com/Audiveris/audiveris |',
    '| homr (optional local music recognition) | 0.7.0 | AGPL-3.0 | https://github.com/liebharc/homr |',
    '| Copista 28M / copisteria (optional local music recognition) | 1.3.4 | Apache-2.0; KobiMusic, LICENSE and NOTICE retained with downloaded source | https://github.com/kobimusic/copisteria |',
    '| UVDoc ONNX (optional document correction) | 3bcf535371727d11e783101f79a504c68848aae3 | Apache-2.0 | https://huggingface.co/PaddlePaddle/UVDoc_onnx |',
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
  `# Third-party notices / 第三方说明\n\nTixTab application code is AGPL-3.0-only. Third-party code and models retain their own licenses; this file does not relicense them. / 应用许可不覆盖第三方代码与模型。\n\nFull license texts: [docs/THIRD-PARTY-LICENSES.txt](docs/THIRD-PARTY-LICENSES.txt). Additional attribution: [Pinyin](docs/PINYIN-NOTICES.md), [model terms](docs/MODELS.md), [distribution notes](docs/DISTRIBUTION.md). Electron and Chromium notices are also included beside the extracted executable.\n\nGenerated from the locked dependency tree, including development tools. Exact package archives and hashes are recorded in package-lock.json.\n\n| Package | Version | License | Upstream |\n|---|---|---|---|\n${notices.sort().join('\n')}\n`,
);
await writeFile('docs/THIRD-PARTY-LICENSES.txt', texts.join('\n'));
console.log('Dependency notices:', notices.length, '; license/notice texts:', texts.length);
