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
    unit: '605 tests / 129 files; 8 Node integration tests; 12 Python checks passed, 1 optional local-performance fixture skipped',
    browser:
      '25 browser regressions passed. Coverage includes Copista/homr/Audiveris score data, correction previews and manual geometry, background processing, Matchmaker capture cleanup, MIDI output lifecycle, two-page turning, fullscreen/collapsed controls, repeated project imports, OS PDF launch/legacy project lookup, Review note objects in four views and optional-tool error isolation. Native interfaces are mocked in browser tests.',
    packaged:
      'Static ASAR/build asset SHA256 and file-set verification, required backend/preload modules, native binding/icon and model exclusion; this release did not launch the installer or packaged application',
    nativeModels:
      'Python geometry, Copista layout and synthetic Matchmaker pause/jump/cache regressions passed. Retained earlier local Copista, DocAligner CPU/NPU and LILI performance evidence documented in docs; those real-input runs were not repeated during packaging. Windows AI Speech, PDF editor, Hy-MT2 CPU/GPU, UVDoc/Audiveris/homr evidence retained; local Hy-MT2 OpenVINO NPU initialization failed and is not claimed to work. No energy or cross-device speed benchmark is claimed.',
    installer:
      'Compiled NSIS installer and separate install/uninstall include harness for opt-in PDF association. Earlier upgrade/repair/downgrade evidence retained. Installer and packaged application were not executed on this host.',
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
