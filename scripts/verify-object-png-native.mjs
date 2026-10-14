import { _electron as electron, expect } from '@playwright/test';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
const { values } = parseArgs({
  options: {
    baseline: { type: 'string' },
    candidate: { type: 'string' },
    'app-dir': { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.baseline || !values.candidate || !values['app-dir'] || !values.output)
  throw Error('Supply two exported projects, frozen app and fresh output');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const source = {},
  groups = {},
  pngs = {};
for (const [name, path] of [
  ['before', values.baseline],
  ['candidate', values.candidate],
]) {
  const bytes = await readFile(path),
    project = JSON.parse(bytes);
  source[name] = { path: resolve(path), sha256: sha(bytes) };
  groups[name] = project.pages[0].images[0];
  pngs[name] = Buffer.from(groups[name].data.split(',')[1], 'base64');
}
expect(groups.before.displayData).toBe(groups.candidate.displayData);
expect([groups.before.width, groups.before.height]).toEqual([
  groups.candidate.width,
  groups.candidate.height,
]);
const a = await sharp(pngs.before).ensureAlpha().raw().toBuffer(),
  b = await sharp(pngs.candidate).ensureAlpha().raw().toBuffer();
expect(a.length).toBe(b.length);
const encoded = {
  differentChannels: 0,
  alphaDifferences: 0,
  maxDifference: 0,
  premultipliedDifferences: 0,
};
for (let i = 0; i < a.length; i++) {
  const d = Math.abs(a[i] - b[i]);
  if (!d) continue;
  encoded.differentChannels++;
  encoded.maxDifference = Math.max(encoded.maxDifference, d);
  if (i % 4 === 3) encoded.alphaDifferences++;
  else {
    const alpha = a[i - (i % 4) + 3];
    if (Math.round((a[i] * alpha) / 255) !== Math.round((b[i] * alpha) / 255))
      encoded.premultipliedDifferences++;
  }
}
expect(encoded.alphaDifferences).toBe(0);
expect(encoded.premultipliedDifferences).toBe(0);
expect(encoded.maxDifference).toBeLessThanOrEqual(1);
const profile = await mkdtemp(join(tmpdir(), 'tixtab-object-png-'));
const app = await electron.launch({
  args: [resolve(values['app-dir'])],
  env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  const checks = await page.evaluate(
    async (data) => {
      const decode = async (src) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        return image;
      };
      const a = await decode(data.before),
        b = await decode(data.candidate),
        checks = [];
      const left = document.createElement('canvas'),
        right = document.createElement('canvas');
      for (const scale of [0.5, 1, 1.3])
        for (const background of [null, '#ffffff', '#171b23'])
          for (const filter of ['none', 'brightness(0.62)', 'invert(0.9) hue-rotate(180deg)']) {
            left.width = right.width = Math.ceil(a.naturalWidth * scale);
            left.height = right.height = Math.ceil(a.naturalHeight * scale);
            for (const [canvas, image] of [
              [left, a],
              [right, b],
            ]) {
              const ctx = canvas.getContext('2d');
              if (background) {
                ctx.fillStyle = background;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
              }
              ctx.filter = filter;
              ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            }
            const x = left.getContext('2d').getImageData(0, 0, left.width, left.height).data,
              y = right.getContext('2d').getImageData(0, 0, right.width, right.height).data;
            let different = 0,
              max = 0;
            for (let i = 0; i < x.length; i++)
              if (x[i] !== y[i]) {
                different++;
                max = Math.max(max, Math.abs(x[i] - y[i]));
              }
            checks.push({
              scale,
              background,
              filter,
              width: left.width,
              height: left.height,
              different,
              max,
            });
          }
      return checks;
    },
    { before: groups.before.data, candidate: groups.candidate.data },
  );
  expect(checks).toHaveLength(27);
  expect(checks.every((c) => c.different === 0)).toBe(true);
  await writeFile(
    resolve(values.output),
    JSON.stringify(
      {
        schema: 1,
        source,
        pngHashes: { before: sha(pngs.before), candidate: sha(pngs.candidate) },
        encoded,
        checks,
        appDir: resolve(values['app-dir']),
        sourceManifestSha256: sha(
          await readFile(resolve(values['app-dir'], 'SOURCE-MANIFEST.json')),
        ),
        harnessSha256: sha(await readFile(new URL(import.meta.url))),
        limits:
          'Encoded straight-alpha PNG channels may differ by one from alternative unpremultiplication rounding. Alpha and 8-bit premultiplied pixels must match; independently rendered Electron RGBA must match at all tested scales/backgrounds/filters. SVG display is byte-identical. Not a claim that encoded PNG bytes or all raw straight-alpha channels match, nor a timing/energy test.',
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify({ passed: true, encoded, nativeRgbaChecks: checks.length }));
} finally {
  await app.close();
}
