import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  mkdir,
  mkdtemp,
  rm,
  rename,
  copyFile,
  readFile,
  writeFile,
  access,
} from 'node:fs/promises';
import sharp from 'sharp';
import os from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const speech = process.argv.includes('--speech');
const directory = speech ? 'windows-ai-speech' : 'windows-ai-ocr';
const component = speech ? 'Speech' : 'Ocr';
if (process.platform !== 'win32') throw Error('Windows AI OCR requires a Windows build host.');
// Build only. Never installs an SDK runtime, registers identity or launches TixTab.
const cache = path.resolve(root, '.cache', directory);
if (!cache.startsWith(path.resolve(root) + path.sep)) throw Error('Invalid build output');
await mkdir(cache, { recursive: true });
const staging = await mkdtemp(path.join(cache, 'publish-'));
const child = spawn(
  'dotnet',
  [
    'publish',
    path.join(root, 'native', directory, `TixTab.WindowsAI.${component}.csproj`),
    '-c',
    'Release',
    '-o',
    staging,
    '--disable-build-servers',
    '-m:1',
  ],
  {
    cwd: root,
    windowsHide: true,
    stdio: 'inherit',
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_GCHeapHardLimit: '40000000' },
  },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
const code = await new Promise((resolve) => {
  child.once('exit', resolve);
  child.once('error', () => resolve(1));
});
if (code !== 0) {
  await rm(staging, { recursive: true, force: true });
  process.exitCode = code ?? 1;
} else {
  await copyFile(
    path.join(root, 'native', directory, 'AppxManifest.xml'),
    path.join(staging, 'AppxManifest.xml'),
  );
  const packageVersion = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  ).version;
  if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) throw Error('Invalid identity package version');
  const manifest = path.join(staging, 'AppxManifest.xml');
  await writeFile(
    manifest,
    (await readFile(manifest, 'utf8')).replace(
      /Version="\d+\.\d+\.\d+\.\d+"/,
      `Version="${packageVersion}.0"`,
    ),
  );
  const nuget = process.env.NUGET_PACKAGES || path.join(os.homedir(), '.nuget/packages');
  await mkdir(path.join(staging, 'Licenses'));
  for (const [name, version] of [
    ['microsoft.windowsappsdk.ai', speech ? '2.2.6-experimental' : '1.8.79'],
    ['microsoft.windowsappsdk.foundation', speech ? '2.1.1-experimental' : '1.8.260505001'],
    ...(speech ? [['microsoft.windowsappsdk.ml', '2.1.75-experimental']] : []),
  ])
    await copyFile(
      path.join(nuget, name, version, 'license.txt'),
      path.join(staging, 'Licenses', name + '.txt'),
    );
  if (speech)
    await copyFile(
      path.join(
        nuget,
        'microsoft.windowsappsdk.ml',
        '2.1.75-experimental',
        'ThirdPartyNotices.txt',
      ),
      path.join(staging, 'Licenses', 'windows-ml-third-party.txt'),
    );
  const dotnetRoot = path.dirname(
    execFileSync('where.exe', ['dotnet'], { encoding: 'utf8', windowsHide: true })
      .trim()
      .split(/\r?\n/)[0],
  );
  await copyFile(
    path.join(dotnetRoot, 'LICENSE.txt'),
    path.join(staging, 'Licenses', 'dotnet.txt'),
  );
  await copyFile(
    path.join(dotnetRoot, 'ThirdPartyNotices.txt'),
    path.join(staging, 'Licenses', 'dotnet-third-party.txt'),
  );
  await mkdir(path.join(staging, 'Assets'));
  for (const [name, size] of [
    ['Logo', 50],
    ['Square150', 150],
    ['Square44', 44],
  ])
    await sharp(path.join(root, 'public/tixtab.png'))
      .resize(size, size)
      .png()
      .toFile(path.join(staging, 'Assets', name + '.png'));
  const runtime = path.join(cache, 'runtime');
  // Both resolved paths are fixed children of this repository's build cache.
  if (path.dirname(runtime) !== cache || path.dirname(staging) !== cache)
    throw Error('Invalid build output');
  // Swap whole directories so a running companion cannot leave a half-deleted runtime.
  const retired = path.join(cache, 'runtime-retired-' + Date.now());
  let moved = false;
  try {
    await access(runtime);
    await rename(runtime, retired);
    moved = true;
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw Error('The native companion is still in use. Build output is preserved at ' + staging, {
        cause: error,
      });
  }
  try {
    await rename(staging, runtime);
  } catch (error) {
    if (moved) await rename(retired, runtime);
    throw error;
  }
  if (moved) {
    if (path.dirname(retired) !== cache) throw Error('Invalid retired runtime output');
    await rm(retired, { recursive: true, force: true }).catch(() => {
      console.warn('A running native companion retains the previous build at ' + retired);
    });
  }
  const certificate = process.env.TIXTAB_WINDOWS_AI_CERT_SHA1;
  if (certificate) {
    if (!/^[a-fA-F0-9]{40}$/.test(certificate))
      throw Error('Invalid signing certificate thumbprint');
    const sdk =
      process.env.TIXTAB_WINDOWS_SDK_BIN ||
      'C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64';
    const identity = await mkdtemp(path.join(cache, 'identity-'));
    try {
      await copyFile(
        path.join(runtime, 'AppxManifest.xml'),
        path.join(identity, 'AppxManifest.xml'),
      );
      await mkdir(path.join(identity, 'Assets'));
      for (const name of ['Logo', 'Square150', 'Square44'])
        await copyFile(
          path.join(runtime, 'Assets', name + '.png'),
          path.join(identity, 'Assets', name + '.png'),
        );
      const pack = path.join(runtime, `TixTab.WindowsAI.${component}.identity.msix`);
      for (const [exe, args] of [
        ['makeappx.exe', ['pack', '/o', '/nv', '/d', identity, '/p', pack]],
        ['signtool.exe', ['sign', '/fd', 'SHA256', '/sha1', certificate, pack]],
      ])
        await new Promise((resolve, reject) => {
          const job = spawn(path.join(sdk, exe), args, { windowsHide: true, stdio: 'inherit' });
          job.once('error', reject);
          job.once('exit', (code) => (code === 0 ? resolve() : reject(Error(exe + ' failed'))));
        });
    } finally {
      if (path.dirname(identity) !== cache) throw Error('Invalid identity output');
      await rm(identity, { recursive: true, force: true });
    }
  }
}
