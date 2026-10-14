import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve('@huggingface/transformers'))('sharp');
const folder = new URL('./', import.meta.url);
await mkdir(new URL('previews/', folder), { recursive: true });
for (const name of process.argv.slice(2)) {
  const source = await readFile(new URL(name, folder));
  await sharp(source)
    .resize(512, 512)
    .png()
    .toFile(fileURLToPath(new URL(name.replace(/\.svg$/, '.png'), folder)));
  const sizes = [256, 64, 48, 32, 24, 16];
  const layers = [];
  let x = 28;
  for (const size of sizes) {
    const icon = await sharp(source).resize(size, size).png().toBuffer();
    layers.push({ input: icon, left: x, top: Math.round((304 - size) / 2) });
    x += size + 28;
  }
  const width = x;
  const light = await sharp({ create: { width, height: 304, channels: 4, background: '#F4F7FB' } })
    .composite(layers)
    .png()
    .toBuffer();
  const dark = await sharp({ create: { width, height: 304, channels: 4, background: '#1E242F' } })
    .composite(layers)
    .png()
    .toBuffer();
  await sharp({ create: { width, height: 608, channels: 4, background: '#F4F7FB' } })
    .composite([
      { input: light, top: 0, left: 0 },
      { input: dark, top: 304, left: 0 },
    ])
    .png()
    .toFile(
      fileURLToPath(
        new URL(
          `previews/${name
            .split('/')
            .pop()
            .replace(/\.svg$/, '-sizes.png')}`,
          folder,
        ),
      ),
    );
  console.log(`Rendered ${name}: 512px and light/dark sizes (${sizes.join(', ')}).`);
}
