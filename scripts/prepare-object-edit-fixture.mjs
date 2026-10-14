import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readPerformanceFixture } from './performance-fixture.mjs';
// Derived once from a fixed authored fixture, before starting any measured app.
const input = await readPerformanceFixture('.cache/performance-inputs-night-matrix/objects.tixtab');
const project = JSON.parse(input.bytes);
project.name = 'Synthetic object editing workload';
project.pages[0].images = project.pages[0].images.map((image, i) => ({
  ...image,
  x: 18 + (i % 12) * 45,
  y: 22 + Math.floor(i / 12) * 39,
  width: 42,
  height: 36,
}));
const bytes = Buffer.from(JSON.stringify(project));
const directory = resolve('.cache/performance-inputs-object-edit');
await mkdir(directory);
const description = {
  ...input.description,
  profile: 'object-edit',
  parentSha256: input.description.sha256,
  generatorSha256: createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex'),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
  limits:
    'Derived synthetic four-kind/nested object fixture. All 240 first-page objects fit inside the page. Includes 3000 pen strokes and 16 vector-background pages. Not real Excalidraw editing, physical pen latency or recognition quality.',
};
await writeFile(resolve(directory, 'objects.tixtab'), bytes, { flag: 'wx' });
await writeFile(
  resolve(directory, 'objects.tixtab.json'),
  JSON.stringify(description, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify(description));
