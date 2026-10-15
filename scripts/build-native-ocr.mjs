import { readFile, writeFile, mkdir, access, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw Error('Native OCR build requires Windows x64');
const root = resolve('.cache/native-ocr'),
  prefix = join(root, 'prefix'),
  runtime = join(root, 'runtime');
const sources = [
  [
    'tesseract-5.5.0',
    'https://codeload.github.com/tesseract-ocr/tesseract/tar.gz/refs/tags/5.5.0',
    'f2fb34ca035b6d087a42875a35a7a5c4155fa9979c6132365b1e5a28ebc3fc11',
  ],
  [
    'leptonica-1.85.0',
    'https://codeload.github.com/DanBloomberg/leptonica/tar.gz/refs/tags/1.85.0',
    'c01376bce0379d4ea4bc2ec5d5cbddaa49e2f06f88242619ab8c059e21adf233',
  ],
];
await mkdir(join(root, 'sources'), { recursive: true });
const vswhere = join(
  process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)',
  'Microsoft Visual Studio/Installer/vswhere.exe',
);
const installation = execFileSync(
  vswhere,
  [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  ],
  { encoding: 'utf8', windowsHide: true },
).trim();
if (!installation) throw Error('Install Visual Studio 2022 C++ build tools');
const cmake = join(
  installation,
  'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe',
);
async function run(exe, args) {
  await new Promise((res, rej) => {
    const child = spawn(exe, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', rej);
    child.once('exit', (code) => (code === 0 ? res() : rej(Error(`${exe} exited ${code}`))));
  });
}
for (const [name, url, hash] of sources) {
  const archive = join(root, name + '.tar.gz');
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw Error(`Source download: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== hash)
    throw Error('Upstream source hash mismatch: ' + name);
  await writeFile(archive, bytes);
  const folder = join(root, 'sources', name);
  try {
    await access(join(folder, 'CMakeLists.txt'));
  } catch {
    await run('tar', ['-xf', archive, '-C', join(root, 'sources')]);
  }
  const file = join(folder, 'CMakeLists.txt');
  // Bound compiler fan-out as well as MSBuild project parallelism.
  await writeFile(file, (await readFile(file, 'utf8')).replace(/ \/MP"/g, ' /MP1"'));
}
const common = [
  '-G',
  'Visual Studio 17 2022',
  '-A',
  'x64',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DSW_BUILD=OFF',
  '-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF',
  '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
  '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
  `-DCMAKE_INSTALL_PREFIX=${prefix}`,
  `-DCMAKE_PREFIX_PATH=${prefix}`,
];
for (const [name, flags] of [
  [
    'leptonica-1.85.0',
    [
      '-DBUILD_PROG=OFF',
      ...['ZLIB', 'PNG', 'GIF', 'JPEG', 'TIFF', 'WEBP', 'OPENJPEG'].map((x) => `-DENABLE_${x}=OFF`),
    ],
  ],
  [
    'tesseract-5.5.0',
    [
      '-DWIN32_MT_BUILD=ON',
      '-DOPENMP_BUILD=OFF',
      '-DGRAPHICS_DISABLED=ON',
      '-DDISABLED_LEGACY_ENGINE=ON',
      '-DBUILD_TRAINING_TOOLS=OFF',
      '-DDISABLE_ARCHIVE=ON',
      '-DDISABLE_CURL=ON',
      '-DDISABLE_TIFF=ON',
      '-DINSTALL_CONFIGS=OFF',
    ],
  ],
]) {
  const build = join(root, 'build', name);
  await run(cmake, ['-S', join(root, 'sources', name), '-B', build, ...common, ...flags]);
  await run(cmake, [
    '--build',
    build,
    '--config',
    'Release',
    '--target',
    'install',
    '--parallel',
    '2',
  ]);
}
await run(cmake, [
  '-S',
  resolve('native/ocr'),
  '-B',
  join(root, 'build/helper'),
  ...common,
  `-DCMAKE_INSTALL_PREFIX=${runtime}`,
]);
await run(cmake, [
  '--build',
  join(root, 'build/helper'),
  '--config',
  'Release',
  '--target',
  'install',
  '--parallel',
  '2',
]);
await copyFile(
  join(root, 'sources/tesseract-5.5.0/LICENSE'),
  join(runtime, 'TESSERACT-LICENSE.txt'),
);
await copyFile(
  join(root, 'sources/leptonica-1.85.0/leptonica-license.txt'),
  join(runtime, 'LEPTONICA-LICENSE.txt'),
);
const binary = await readFile(join(runtime, 'tixtab-ocr.exe'));
await writeFile(
  join(runtime, 'BUILD-INFO.json'),
  JSON.stringify(
    {
      tesseract: '5.5.0',
      leptonica: '1.85.0',
      sources: sources.map(([name, url, sha256]) => ({ name, url, sha256 })),
      imageDecoder: 'Windows WIC',
      staticCrt: true,
      openmp: false,
      helperSources: await Promise.all(
        ['native/ocr/main.cpp', 'native/ocr/npu.h', 'native/ocr/CMakeLists.txt'].map(
          async (file) => ({
            file,
            sha256: createHash('sha256')
              .update(await readFile(file))
              .digest('hex'),
          }),
        ),
      ),
      sha256: createHash('sha256').update(binary).digest('hex'),
    },
    null,
    2,
  ) + '\n',
);
console.log('Native C++ OCR ready:', runtime);
