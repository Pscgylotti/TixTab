import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const directory = resolve(`release/${pkg.version}/lite`),
  file = `TixTab-${pkg.version}-lite-setup-x64.exe`;
const sha = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
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
    unit: '387 tests / 69 files',
    browser:
      'Active UI regressions plus bitmap OCR, transparent overlays, ink selection, page jumps, reordering and canvas retirement',
    packaged:
      'Windows synthetic pen hover; all-view image/reference activation; foreground pixels/layer order and complete PDF export',
    nativeModels:
      'PP-OCRv4 CPU line geometry; Whisper NPU cold/warm/idle reload; backend lifecycle/resource policy',
    installer:
      'Compiled NSIS installer. Earlier isolated upgrade/repair/downgrade fixture evidence retained. Full installation was not rerun on this host.',
    limits:
      'Synthetic pen input is not real hardware validation. Resource measurements are not battery-life measurements. Recognition may be inaccurate.',
  },
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
