import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const { values } = parseArgs({
  options: {
    baseline: { type: 'string' },
    candidate: { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.baseline || !values.candidate || !values.output)
  throw Error('Supply two actual canvas quality reports and fresh output');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const reports = await Promise.all(
  [values.baseline, values.candidate].map(async (p) => JSON.parse(await readFile(p))),
);
assert.deepEqual(reports[0].fixtures, reports[1].fixtures);
assert.equal(reports[0].harnessSha256, reports[1].harnessSha256);
assert.equal(reports[0].checks.length, 27);
const checks = [];
for (let n = 0; n < reports[0].checks.length; n++) {
  const [a, b] = reports.map((r) => r.checks[n]);
  assert.deepEqual([a.workload, a.view, a.appearance], [b.workload, b.view, b.appearance]);
  assert.equal(a.images.length, b.images.length);
  for (let i = 0; i < a.images.length; i++) {
    const images = [a.images[i], b.images[i]];
    const pixels = [];
    for (let side = 0; side < 2; side++) {
      const bytes = await readFile(
        join(
          resolve([values.baseline, values.candidate][side]).replace(/\.json$/, '') + '-pixels',
          images[side].file,
        ),
      );
      assert.equal(sha(bytes), images[side].pngSha256);
      const { data, info } = await sharp(bytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.equal(sha(data), images[side].rgbaSha256);
      assert.equal(info.width, images[side].width);
      assert.equal(info.height, images[side].height);
      pixels.push(data);
    }
    const metadata = images.map(({ file, pngSha256, rgbaSha256, ...rest }) => rest);
    assert.deepEqual(metadata[0], metadata[1]);
    assert.equal(pixels[0].length, pixels[1].length);
    let different = 0,
      maxDelta = 0;
    for (let p = 0; p < pixels[0].length; p++) {
      const d = Math.abs(pixels[0][p] - pixels[1][p]);
      if (d) different++;
      maxDelta = Math.max(maxDelta, d);
    }
    checks.push({
      workload: a.workload,
      view: a.view,
      appearance: a.appearance,
      index: i,
      width: images[0].width,
      height: images[0].height,
      different,
      maxDelta,
      rgbaSha256: images.map((x) => x.rgbaSha256),
    });
  }
}
assert.deepEqual(
  reports.map((r) => r.errors),
  [[], []],
);
const pass = checks.every((c) => c.different === 0);
await writeFile(
  values.output,
  JSON.stringify(
    {
      schema: 1,
      pass,
      combinations: 27,
      sourceManifests: reports.map((r) => r.sourceManifestSha256),
      qualityHarnessSha256: reports[0].harnessSha256,
      comparisonHarnessSha256: sha(await readFile(new URL(import.meta.url))),
      checks,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    pass,
    combinations: 27,
    pixelPairs: checks.length,
    differentPairs: checks.filter((c) => c.different).length,
  }),
);
assert(pass, 'Actual PDF canvas pixels changed');
