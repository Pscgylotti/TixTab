import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { performanceMatrixFixture } from './performance-matrix-fixture.mjs';
const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output) throw Error('Supply new --output .cache/performance-inputs-* directory');
const root = resolve(values.output),
  local = relative(resolve('.cache'), root);
if (isAbsolute(local) || local.startsWith('..') || !/^performance-inputs-[^/\\]+$/.test(local))
  throw Error('Unsafe fixture output');
await mkdir(root);
const generatorSha256 = createHash('sha256')
  .update(await readFile(new URL('./performance-matrix-fixture.mjs', import.meta.url)))
  .digest('hex');
for (const profile of ['scanned', 'vector', 'objects']) {
  const fixture = await performanceMatrixFixture(profile);
  fixture.description.generatorSha256 = generatorSha256;
  await writeFile(resolve(root, profile + '.tixtab'), fixture.bytes, { flag: 'wx' });
  await writeFile(
    resolve(root, profile + '.tixtab.json'),
    JSON.stringify(fixture.description, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify(fixture.description));
}
