import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import './build-native-ocr.mjs';
const exec = promisify(execFile),
  root = resolve('.cache/native-ocr');
const sdk = resolve(
  process.env.TIXTAB_OPENVINO_ROOT || '.venv-openvino/Lib/site-packages/openvino',
);
const vswhere = join(
  process.env['ProgramFiles(x86)'],
  'Microsoft Visual Studio/Installer/vswhere.exe',
);
const { stdout } = await exec(
  vswhere,
  ['-latest', '-products', '*', '-property', 'installationPath'],
  { windowsHide: true },
);
const cmake = join(
  stdout.trim(),
  'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe',
);
const run = async (exe, args) =>
  new Promise((res, rej) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: 'inherit' });
    child.once('error', rej);
    child.once('exit', (code) => (code === 0 ? res() : rej(Error('Build failed: ' + code))));
  });
await run(resolve(process.env.TIXTAB_OPENVINO_PYTHON || '.venv-openvino/Scripts/python.exe'), [
  'scripts/export-native-npu.py',
]);
const build = join(root, 'build/npu');
await run(cmake, [
  '-S',
  resolve('native/ocr'),
  '-B',
  build,
  '-G',
  'Visual Studio 17 2022',
  '-A',
  'x64',
  `-DCMAKE_PREFIX_PATH=${join(root, 'prefix')}`,
  `-DTIXTAB_OPENVINO_ROOT=${sdk}`,
]);
await run(cmake, [
  '--build',
  build,
  '--config',
  'Release',
  '--target',
  'tixtab-ocr-npu',
  '--parallel',
  '2',
]);
const runtime = join(root, 'npu-runtime');
await mkdir(runtime, { recursive: true });
await copyFile(join(build, 'Release/tixtab-ocr-npu.exe'), join(runtime, 'tixtab-ocr-npu.exe'));
const names = [
  'openvino_c.dll',
  'openvino.dll',
  'openvino_ir_frontend.dll',
  'openvino_intel_npu_plugin.dll',
  'openvino_intel_npu_compiler.dll',
  'openvino_intel_npu_compiler_loader.dll',
  'tbb12.dll',
];
for (const file of names) await copyFile(join(sdk, 'libs', file), join(runtime, file));
await writeFile(
  join(runtime, 'BUILD-INFO.json'),
  JSON.stringify(
    {
      experimental: true,
      executableSha256: createHash('sha256')
        .update(await readFile(join(runtime, 'tixtab-ocr-npu.exe')))
        .digest('hex'),
      graphManifest: JSON.parse(
        await readFile(join(root, 'npu-models/fast/manifest.json'), 'utf8'),
      ),
      device: 'NPU',
      cpuRecognitionFallback: false,
      models: ['English Fast', 'English Best'],
      decoder: 'greedy CTC, not native Tesseract DAWG',
      dlls: await Promise.all(
        names.map(async (file) => ({
          file,
          sha256: createHash('sha256')
            .update(await readFile(join(runtime, file)))
            .digest('hex'),
        })),
      ),
    },
    null,
    2,
  ) + '\n',
);
console.log('Experimental C++ + NPU runtime:', runtime);
