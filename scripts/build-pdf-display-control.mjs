import { build } from 'vite';
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output) throw Error('Supply a fresh --output .cache/performance-* directory');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, values.output);
const subpath = relative(resolve(root, '.cache'), destination);
if (isAbsolute(subpath) || subpath.startsWith('..') || !/^performance-[^/\\]+$/.test(subpath))
  throw Error('Unsafe output');
await mkdir(destination);
await build({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  build: { outDir: resolve(destination, 'dist'), emptyOutDir: false },
});
for (const item of ['electron', 'package.json'])
  await cp(resolve(root, item), resolve(destination, item), { recursive: true });
for (const item of [
  'src',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'tsconfig.json',
  'index.html',
])
  await cp(resolve(root, item), resolve(destination, 'source', item), { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function inventory(directory, prefix = '') {
  const files = [];
  for (const e of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = resolve(directory, e.name),
      name = prefix + e.name;
    if (e.isDirectory()) files.push(...(await inventory(path, name + '/')));
    else if (e.isFile()) files.push([name, hash(await readFile(path))]);
  }
  return files;
}
await writeFile(
  resolve(destination, 'SOURCE-MANIFEST.json'),
  JSON.stringify(await inventory(resolve(destination, 'source')), null, 2) + '\n',
);
await writeFile(
  resolve(destination, 'control-description.json'),
  JSON.stringify(
    {
      mechanism:
        'Borrow one immutable cached canvas per raster; concurrent views copy without stealing. React owns an empty display:contents host. Preserve dimensions, source quality and scheduler. Release without resizing; invalidate lost cache surfaces and request recovery. Applies to base, reading, detail tiles and thumbnails.',
      builderSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    },
    null,
    2,
  ) + '\n',
);
console.log('Frozen PDF display candidate: ' + destination);
