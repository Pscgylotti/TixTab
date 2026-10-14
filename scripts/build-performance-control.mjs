import { build, normalizePath } from 'vite';
import { readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: { output: { type: 'string', default: '.cache/performance-replay-control-app' } },
});
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  cache = resolve(root, '.cache'),
  destination = resolve(root, values.output),
  subpath = relative(cache, destination);
// Vite cleans its output directory. Confine it to a dedicated experiment folder.
if (isAbsolute(subpath) || subpath.startsWith('..') || !/^performance-[^/\\]+$/.test(subpath))
  throw Error('Control output must be a dedicated .cache/performance-* directory.');
const target = normalizePath(resolve(root, 'src/PageEditor.tsx')),
  source = await readFile(target, 'utf8'),
  marker = 'if (ink.current) committed.current!.paint(ink.current, page);';
if (!source.includes(marker))
  throw Error('Ink paint hook changed; update the control transform first.');
let transformed = false;
await build({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  plugins: [
    {
      name: 'performance-full-ink-replay-control',
      enforce: 'pre',
      transform(code, id) {
        if (normalizePath(id.split('?')[0]) !== target) return;
        if (!code.includes(marker)) throw Error('Control transform did not match.');
        transformed = true;
        return code.replace(
          marker,
          'if (ink.current) { committed.current!.reset(); committed.current!.paint(ink.current, page); }',
        );
      },
    },
  ],
  build: { outDir: resolve(destination, 'dist'), emptyOutDir: true },
});
if (!transformed) throw Error('Control transform was not applied.');
await mkdir(destination, { recursive: true });
for (const item of ['electron', 'package.json'])
  await cp(resolve(root, item), resolve(destination, item), { recursive: true });
await writeFile(
  resolve(destination, 'control-description.json'),
  JSON.stringify(
    {
      mechanism:
        'Only reset CommittedInk before each paint to force full replay. Source and candidate dist are never modified.',
      pageEditorSourceSha256: createHash('sha256').update(source).digest('hex'),
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);
console.log(`Control application: ${destination}`);
