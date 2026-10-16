import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const directory = resolve(`release/${pkg.version}/lite`),
  file = `TixTab-${pkg.version}-lite-setup-x64.exe`;
const sha = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const info = {
  version: pkg.version,
  source: 'https://github.com/Pscgylotti/TixTab',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim(),
  platform: 'Windows x64',
  electron: pkg.devDependencies.electron,
  license: pkg.license,
  unsigned: true,
  neuralWeightsBundled: false,
  createdAt: new Date().toISOString(),
  installer: { file, sha256: await sha(join(directory, file)) },
  appAsarSha256: await sha(join(directory, 'win-unpacked/resources/app.asar')),
  penNativeBindingSha256: await sha(
    join(
      directory,
      'win-unpacked/resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
    ),
  ),
  validation: {
    unit: '554 tests / 116 files',
    browser:
      '23 release browser cases passed: PDFium native object selection/transforms/styles/live previews, native text editing and undo, page rotate/crop, review editing and keyboard policy, cross-sheet erasing in three views with pen-tail/cancel/unmount buffer release, scratch OCR, original image copy/touch/keyboard navigation and standalone translation/quick actions.',
    packaged:
      'Static ASAR/build asset SHA256 and file-set verification, required backend/preload modules, native binding/icon and model exclusion; this release did not launch the installer or packaged application',
    nativeModels:
      '13 native PDF editor tests and 15 Hy-MT2/shared worker/request lifecycle tests passed. Earlier real Hy-MT2 llama.cpp CPU/Vulkan and OpenVINO CPU/GPU smoke evidence retained; local OpenVINO NPU initialization failed and is not claimed to work. Previous UVDoc/Audiveris/homr evidence retained. No new energy or cross-device speed benchmark is claimed.',
    installer:
      'Compiled NSIS installer. Earlier isolated upgrade/repair/downgrade fixture evidence retained. Full installation was not rerun on this host.',
    limits:
      'Synthetic pen input is not real hardware validation. Resource measurements are not battery-life measurements. Recognition may be inaccurate.',
  },
  contributors: [
    { name: 'Pscgylotti', role: 'Project creator and maintainer' },
    { name: 'Codex (OpenAI)', role: 'AI coding assistant' },
    {
      name: 'Claude (Anthropic)',
      role: 'AI coding assistant; PDF object editing implementation and auditing',
    },
  ],
};
await writeFile(join(directory, 'BUILD-INFO.json'), JSON.stringify(info, null, 2) + '\n');
const lines = await Promise.all(
  [file, 'BUILD-INFO.json'].map(async (name) => `${await sha(join(directory, name))}  ${name}`),
);
await writeFile(join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(
  JSON.stringify({
    version: pkg.version,
    sourceCommit: info.sourceCommit,
    installerSha256: info.installer.sha256,
  }),
);
