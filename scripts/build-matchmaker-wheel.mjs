// Rebuild the unmodified pinned source with an existing CPython 3.12 x64 environment.
// Usage: node scripts/build-matchmaker-wheel.mjs C:/path/to/python.exe
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const manifest = JSON.parse(await readFile('backend/wheels/matchmaker-build.json', 'utf8'));
const python = process.argv[2];
if (!python)
  throw Error('Supply an existing CPython 3.12 x64 executable; MSVC Build Tools are required.');
const run = (args) =>
  new Promise((done, fail) => {
    const p = spawn(python, args, { stdio: 'inherit', windowsHide: true });
    p.on('error', fail);
    p.on('exit', (code) => (code === 0 ? done() : fail(Error(`Build exited ${code}`))));
  });
await run([
  '-c',
  'import sys,struct,Cython,setuptools,importlib.metadata as m; assert sys.version_info[:2] == (3,12) and struct.calcsize("P")==8; assert Cython.__version__=="3.1.3" and setuptools.__version__=="80.9.0" and m.version("wheel")=="0.46.3"',
]);
await mkdir('.cache/matchmaker-build', { recursive: true });
const root = await mkdtemp(resolve('.cache/matchmaker-build/run-'));
const response = await fetch(manifest.source);
if (!response.ok) throw Error(`Source download failed: ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(archive).digest('hex') !== manifest.sourceSha256)
  throw Error('Source checksum mismatch');
const source = join(root, 'source.zip');
await writeFile(source, archive);
// pip expands the verified archive itself. Output is kept separate from the shipped wheel.
await run([
  '-m',
  'pip',
  '--isolated',
  'wheel',
  '--no-build-isolation',
  '--no-deps',
  source,
  '--wheel-dir',
  root,
]);
const built = await readFile(join(root, manifest.wheel));
console.log('Built:', join(root, manifest.wheel));
console.log('SHA256:', createHash('sha256').update(built).digest('hex'));
console.log(
  'Wheel archives may differ by build timestamps; review and update the manifest when replacing the shipped binary.',
);
