import { build, normalizePath } from 'vite';
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: { output: { type: 'string' }, reuse: { type: 'boolean', default: false } },
});
if (!values.output) throw Error('Supply a fresh --output .cache/performance-* directory');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  destination = resolve(root, values.output),
  subpath = relative(resolve(root, '.cache'), destination);
if (isAbsolute(subpath) || subpath.startsWith('..') || !/^performance-[^/\\]+$/.test(subpath))
  throw Error('Unsafe output');
await mkdir(destination);
const target = normalizePath(resolve(root, 'src/pdfTextContent.ts')),
  original = await readFile(target, 'utf8'),
  marker = 'const REUSE_TEXT_CONTENT = true;';
if (!original.includes(marker)) throw Error('Review changed text cache source');
const compiled = values.reuse
  ? original
  : original.replace(marker, 'const REUSE_TEXT_CONTENT = false;');
let matched = false;
const plugin = () => ({
  name: 'text-content-control',
  enforce: 'pre',
  transform(code, id) {
    if (normalizePath(id.split('?')[0]) !== target) return;
    if (code !== original) throw Error('Text source changed during build');
    matched = true;
    return compiled;
  },
});
await build({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  plugins: [plugin()],
  worker: { plugins: () => [plugin()] },
  build: { outDir: resolve(destination, 'dist'), emptyOutDir: false },
});
if (!matched) throw Error('Control was not applied');
for (const item of ['electron', 'package.json'])
  await cp(resolve(root, item), resolve(destination, item), { recursive: true });
for (const item of [
  'src',
  'electron',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'tsconfig.json',
  'index.html',
])
  await cp(resolve(root, item), resolve(destination, 'source', item), { recursive: true });
await writeFile(resolve(destination, 'source/src/pdfTextContent.ts'), compiled);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = resolve(directory, entry.name),
      name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...(await inventory(file, name + '/')));
    else if (entry.isFile()) files.push([name, hash(await readFile(file))]);
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
      reuse: values.reuse,
      originalSha256: hash(original),
      compiledSha256: hash(compiled),
      mechanism:
        'Only the raw default PDF text reuse flag differs. No text-layer layout, reading order, search geometry, raster, appearance or export changes.',
    },
    null,
    2,
  ) + '\n',
);
console.log('Frozen text content control: ' + destination);
