import { build, normalizePath } from 'vite';
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: { output: { type: 'string' }, 'reference-source': { type: 'string' } },
});
if (!values.output) throw Error('Supply a new --output .cache/performance-* directory');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  destination = resolve(root, values.output);
const subpath = relative(resolve(root, '.cache'), destination);
if (isAbsolute(subpath) || subpath.startsWith('..') || !/^performance-[^/\\]+$/.test(subpath))
  throw Error('Unsafe control output');
await mkdir(destination);
const target = normalizePath(resolve(root, 'src/ReadingView.tsx'));
const original = await readFile(target, 'utf8');
const compiled = values['reference-source']
  ? await readFile(resolve(values['reference-source']), 'utf8')
  : original;
let matched = false;
const controlPlugin = () => ({
  name: 'reading-scale-control',
  enforce: 'pre',
  transform(code, id) {
    if (normalizePath(id.split('?')[0]) !== target) return;
    if (code !== original) throw Error('Reading scale source changed during build');
    matched = true;
    return compiled;
  },
});
await build({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  plugins: [controlPlugin()],
  worker: { plugins: () => [controlPlugin()] },
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
await writeFile(resolve(destination, 'source/src/ReadingView.tsx'), compiled);
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
      referenceSource: values['reference-source'] ?? null,
      originalSha256: hash(original),
      compiledSha256: hash(compiled),
      mechanism:
        'Only ReadingView.tsx differs: key background bitmap effects by actual quantized render scale instead of settled CSS width. Preserve visibility, page, appearance, density policy, final pixels and width/zoom settling.',
    },
    null,
    2,
  ) + '\n',
);
console.log('Frozen reading bitmap scale: ' + destination);
