import { build, normalizePath } from 'vite';
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: { output: { type: 'string' }, 'full-replay': { type: 'boolean', default: false } },
});
if (!values.output) throw Error('Supply a new --output .cache/performance-* directory');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  destination = resolve(root, values.output);
const subpath = relative(resolve(root, '.cache'), destination);
if (isAbsolute(subpath) || subpath.startsWith('..') || !/^performance-[^/\\]+$/.test(subpath))
  throw Error('Unsafe control output');
await mkdir(destination);
const target = normalizePath(resolve(root, 'src/FormulaDialog.tsx'));
const original = await readFile(target, 'utf8'),
  marker = '        if (!ink.current!.paint(base, strokes.current, drawingHeight)) {';
if (!original.includes(marker)) throw Error('Formula hook changed; review transform');
const compiled = values['full-replay']
  ? original.replace(
      marker,
      '        ink.current!.reset(); // Measurement control: replay the white raster.\n' + marker,
    )
  : original;
let matched = false;
await build({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  plugins: [
    {
      name: 'formula-ink-control',
      enforce: 'pre',
      transform(code, id) {
        if (normalizePath(id.split('?')[0]) !== target) return;
        if (code !== original) throw Error('Formula source changed during build');
        matched = true;
        return compiled;
      },
    },
  ],
  build: { outDir: resolve(destination, 'dist'), emptyOutDir: false },
});
if (!matched) throw Error('Control was not applied');
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
await writeFile(resolve(destination, 'source/src/FormulaDialog.tsx'), compiled);
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
      fullReplay: values['full-replay'],
      originalSha256: hash(original),
      compiledSha256: hash(compiled),
      mechanism:
        'Only reset FormulaInk before each dirty paint for A. Both sides keep the same immutable stroke arrays, immediate pointerup redraw, white 960px raster, save strategy and UI.',
    },
    null,
    2,
  ) + '\n',
);
console.log('Frozen formula raster: ' + destination);
