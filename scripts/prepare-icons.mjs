import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

// Keep the supplied vector design as the single source for Windows and browser assets.
const source = await readFile(new URL('../design/tixtab-icon/tixtab-paper.svg', import.meta.url));
const folder = new URL('../public/', import.meta.url);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = await Promise.all(
  sizes.map((size) => sharp(source).resize(size, size).png().toBuffer()),
);
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2); // ICO, with PNG frames for modern Windows.
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  directory[entry] = size % 256;
  directory[entry + 1] = size % 256;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frames[index].length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += frames[index].length;
}
const assets = {
  'tixtab.svg': source,
  'tixtab.png': await sharp(source).resize(512, 512).png().toBuffer(),
  'tixtab.ico': Buffer.concat([directory, ...frames]),
};
const check = process.argv.includes('--check');
if (!check) await mkdir(folder, { recursive: true });
for (const [name, data] of Object.entries(assets)) {
  const file = new URL(name, folder);
  if (check) assert.deepEqual(await readFile(file), data, `Regenerate ${name} from the source SVG`);
  else await writeFile(file, data);
}
console.log(
  `TixTab icons ${check ? 'verified' : 'generated'}: SVG, 512px PNG, ICO ${sizes.join('/')}`,
);
