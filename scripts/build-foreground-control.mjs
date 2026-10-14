import { build, normalizePath } from 'vite';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    'disable-culling': { type: 'boolean', default: false },
  },
});
if (!values.output) throw Error('Supply a new, dedicated --output .cache/performance-* directory.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, values.output);
const subpath = relative(resolve(root, '.cache'), destination);
if (isAbsolute(subpath) || subpath.startsWith('..') || !/^performance-[^/\\]+$/.test(subpath))
  throw Error('Control output must be a dedicated .cache/performance-* directory.');
// Never clean or overwrite a previously frozen experiment.
await mkdir(destination);
const target = normalizePath(resolve(root, 'src/useForegroundViewport.ts'));
const original = await readFile(target, 'utf8');
const marker = '  // Layout effects measure and synchronously commit before the first paint.';
if (!original.includes(marker))
  throw Error('Foreground hook changed: review the control transform.');
const compiled = values['disable-culling']
  ? original.replace(
      marker,
      '  enabled = false; // Measurement control: render the complete foreground.\n' + marker,
    )
  : original;
let matched = false;
await build({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  plugins: [
    {
      name: 'performance-foreground-control',
      enforce: 'pre',
      transform(code, id) {
        if (normalizePath(id.split('?')[0]) !== target) return;
        if (code !== original) throw Error('Foreground hook changed while building.');
        matched = true;
        return compiled;
      },
    },
  ],
  build: { outDir: resolve(destination, 'dist'), emptyOutDir: false },
});
if (!matched) throw Error('Foreground transform was not applied.');
await mkdir(resolve(destination, 'source'));
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
await writeFile(resolve(destination, 'source/src/useForegroundViewport.ts'), compiled);
await writeFile(
  resolve(destination, 'control-description.json'),
  JSON.stringify(
    {
      culling: !values['disable-culling'],
      mechanism:
        'Only force enabled=false in useForegroundViewport for A; B uses the unchanged hook. Both retain identical fixed quality, viewport scheduling code, application icons and other edits.',
      sourceHookSha256: createHash('sha256').update(original).digest('hex'),
      compiledHookSha256: createHash('sha256').update(compiled).digest('hex'),
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Frozen foreground ${values['disable-culling'] ? 'control' : 'candidate'}: ${destination}`,
);
