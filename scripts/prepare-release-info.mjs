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
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim();
// When only unbundled tests/metadata change after packaging, retain the exact
// packaging revision as well as the final corresponding-source revision.
const buildSourceCommit = process.argv[2] ?? sourceCommit;
if (!/^[0-9a-f]{40}$/.test(buildSourceCommit)) throw Error('Invalid build source commit');
const info = {
  version: pkg.version,
  source: 'https://github.com/Pscgylotti/TixTab',
  sourceCommit,
  buildSourceCommit,
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
    unit: '565 tests / 120 files',
    browser:
      '40 browser regressions passed, including targeted reruns after updating stale test interactions. Coverage includes fullscreen presentation in three layouts, trackpad gesture accumulation/momentum and zoom, native speech progress/cancellation/waveforms, single/double pen-tail gestures and final phrase drain, background downloads/processing, workspace cards, Markdown, keyboard policy, chat and real PDF export worker cancellation/recovery.',
    packaged:
      'Static ASAR/build asset SHA256 and file-set verification, required backend/preload modules, native binding/icon and model exclusion; this release did not launch the installer or packaged application',
    nativeModels:
      'Local Windows AI Speech load/start/stop, 20 real microphone meter samples, resident model reuse and two idle WorkloadsSessionHost CPU samples checked. Cold compilation took about 400 seconds and cached loading about 7 seconds on this host only. Previous PDF editor, Hy-MT2 CPU/GPU, UVDoc/Audiveris/homr evidence retained; local Hy-MT2 OpenVINO NPU initialization failed and is not claimed to work. No new energy or cross-device speed benchmark is claimed.',
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
