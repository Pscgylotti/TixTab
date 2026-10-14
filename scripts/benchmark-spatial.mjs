import { build } from 'esbuild';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus, platform, release } from 'node:os';
import { performanceFixture } from './performance-fixture.mjs';

// Synchronous kernel benchmark, not an energy or end-to-end latency measurement.
const directory = resolve('.cache/performance-spatial-kernel');
await mkdir(directory, { recursive: true });
const entry = ['spatialIndex', 'ink', 'model', 'objectSelection']
  .map((name) => `export * from ${JSON.stringify(resolve(`src/${name}.ts`))};`)
  .join('\n');
const artifact = resolve(directory, 'kernel.mjs');
await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: artifact,
});
const { SpatialIndex, inkBounds, hitStroke, hitImage, imageBounds, sweptBounds, objectsInBox } =
  await import(`file:///${artifact.replaceAll('\\', '/')}`);
const fixture = await performanceFixture(),
  scene = JSON.parse(fixture.bytes).pages[0];
const queries = Array.from({ length: 240 }, (_, i) => {
  const x = 25 + (i % 24) * 21,
    y = 35 + Math.floor(i / 24) * 75;
  return {
    from: [x, y, 0.5],
    to: [x + 3, y + 4, 0.5],
    radius: 10,
    marquee: { x, y, width: 45, height: 35 },
  };
});
const ink = new SpatialIndex(inkBounds),
  objects = new SpatialIndex(imageBounds);
const time = (run) => {
  const start = performance.now();
  const result = run();
  return { ms: performance.now() - start, result };
};
const cold = time(() => {
  ink.update(scene.strokes);
  objects.update(scene.images);
});
let candidateStrokes = 0,
  candidateImages = 0;
const brute = () =>
  queries.map((q) => ({
    strokes: scene.strokes.filter((s) => hitStroke(s, q.from, q.to, q.radius)).map((s) => s.id),
    images: scene.images.filter((s) => hitImage(s, q.from, q.to, q.radius)).map((s) => s.id),
    marquee: objectsInBox(scene.images, q.marquee),
  }));
const indexed = () =>
  queries.map((q) => {
    // Include the per-input update checks, not just bare tree.search().
    ink.update(scene.strokes);
    objects.update(scene.images);
    const box = sweptBounds(q.from, q.to, q.radius),
      strokes = ink.search(box),
      images = objects.search(box);
    candidateStrokes += strokes.length;
    candidateImages += images.length;
    return {
      strokes: strokes.filter((s) => hitStroke(s, q.from, q.to, q.radius)).map((s) => s.id),
      images: images.filter((s) => hitImage(s, q.from, q.to, q.radius)).map((s) => s.id),
      marquee: objectsInBox(scene.images, q.marquee, objects),
    };
  });
const oracle = JSON.stringify(brute());
if (JSON.stringify(indexed()) !== oracle) throw Error('Indexed results differ');
const rows = [];
for (let i = 0; i < 6; i++) {
  const run = (name, action) => {
    const result = time(action);
    if (JSON.stringify(result.result) !== oracle) throw Error('Result changed');
    return { mode: name, ms: result.ms };
  };
  rows.push(
    i % 2
      ? [run('index', indexed), run('scan', brute)]
      : [run('scan', brute), run('index', indexed)],
  );
}
const before = { ...ink.stats };
const updates = time(() => {
  let strokes = scene.strokes;
  for (let i = 0; i < 30; i++) {
    strokes = [...strokes, { ...scene.strokes[i], id: `append-${i}` }];
    ink.update(strokes);
  }
  for (let i = 0; i < 30; i++) {
    strokes = strokes.slice(0, -1);
    ink.update(strokes);
  }
});
const report = {
  schema: 1,
  host: {
    cpu: cpus()[0].model,
    logicalProcessors: cpus().length,
    platform: platform(),
    release: release(),
    node: process.version,
  },
  createdAt: new Date().toISOString(),
  fixture: fixture.description,
  harnessSha256: createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex'),
  kernelSha256: createHash('sha256')
    .update(await readFile(artifact))
    .digest('hex'),
  coldBuildMs: cold.ms,
  queriesPerRound: queries.length,
  rows,
  narrowPhaseCandidatesPerRound: { strokes: candidateStrokes / 7, images: candidateImages / 7 },
  bruteCandidatesPerRound: {
    strokes: queries.length * scene.strokes.length,
    images: queries.length * scene.images.length,
  },
  append30Remove30: { ms: updates.ms, before, after: ink.stats },
  exactResultsMatch: true,
  limitations:
    'Node synchronous kernel only. Cold bounds include outline preparation that real paint also uses. Cold cost is separate, not amortized out. No Canvas, PDF rendering, IPC, UI scheduling, GPU/NPU activity or actual energy measured. Includes all six alternating rounds after one warmup; no outlier exclusion.',
};
await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
