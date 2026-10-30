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
    unit: '615 tests / 129 files; 3 Node integration tests; 8 Python score-following checks passed, 1 optional local-performance fixture skipped',
    browser:
      '37 browser regressions passed across targeted runs. Coverage includes camera capture/device switching/orientation/lifecycle, mouse/pen/touch crop movement and resizing, touch editing and two-finger navigation in three views, Copista/homr/Audiveris score data, correction, Matchmaker/MIDI lifecycle, two-page turning, fullscreen score seeking and smooth system scrolling, project persistence, optional-tool error isolation and workspace night/popover behavior. Camera/audio interfaces are mocked; pointer inputs use browser automation.',
    packaged:
      'Static ASAR/build asset SHA256 and file-set verification, required backend/preload modules, native binding/icon and model exclusion; this release did not launch the installer or packaged application',
    nativeModels:
      'Python synthetic Matchmaker pause/jump/cache, high-amplitude PCM and failure protocol regressions passed. Earlier geometry, Copista layout and local model evidence is retained; real camera/microphone, Windows AI/NPU and LILI performance checks were not repeated during packaging. No energy or cross-device speed benchmark is claimed.',
    installer:
      'Compiled NSIS installer. Earlier opt-in PDF association, upgrade/repair/downgrade evidence retained. Installer and packaged application were not executed on this host.',
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
