import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const { values } = parseArgs({
  options: { directory: { type: 'string' }, output: { type: 'string' } },
});
assert(values.directory && values.output);
const directory = resolve(values.directory),
  sha = (b) => createHash('sha256').update(b).digest('hex');
const reportBytes = await readFile(join(directory, 'report.json'));
const report = JSON.parse(reportBytes);
assert(report.contentPass, 'The entire content/lifecycle series must finish before analysis');
assert.deepEqual(report.errors, []);
const info = {
  reportSha256: sha(reportBytes),
  cycles: report.cycles,
  runs: {},
  crossBuild: [],
  notes: [
    'Finite repeated lifecycle observation, not resource/energy evidence or a guarantee for every driver/document.',
    'Every restored screenshot is compared to cycle zero, not merely the preceding frame.',
    'The original 1/255 display bound is preserved separately even if baseline compositor noise exceeds it.',
  ],
};
const decoded = {};
const delta = (a, b) => {
  assert.deepEqual(a.info, b.info);
  let differentChannels = 0,
    maxChannelDelta = 0;
  for (let n = 0; n < a.data.length; n++) {
    const d = Math.abs(a.data[n] - b.data[n]);
    if (d) differentChannels++;
    maxChannelDelta = Math.max(maxChannelDelta, d);
  }
  return { differentChannels, maxChannelDelta, width: a.info.width, height: a.info.height };
};
for (const label of ['baseline', 'candidate']) {
  const run = report.runs[label];
  assert.equal(run.checkpoints.length, report.cycles + 1);
  assert(run.projectExact);
  const saved = await Promise.all(
    [0, 1].map((n) => readFile(join(directory, label, `saved-${n}.tixtab`))),
  );
  assert.equal(sha(saved[0]), run.projectBeforeSha256);
  assert.equal(sha(saved[1]), run.projectAfterSha256);
  assert.deepEqual(JSON.parse(saved[0]), JSON.parse(saved[1]));
  decoded[label] = [];
  for (const c of run.checkpoints) {
    assert.deepEqual(c.sources, run.checkpoints[0].sources);
    assert.equal(c.pending, 0);
    const path = resolve(directory, c.name),
      rel = relative(directory, path);
    assert(rel && !rel.startsWith('..') && !isAbsolute(rel));
    const bytes = await readFile(path);
    assert.equal(sha(bytes), c.sha256);
    decoded[label].push(
      await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    );
    assert.deepEqual(delta(decoded[label][0], decoded[label].at(-1)), c.versusInitial);
    assert.equal(c.displayBoundPass, c.versusInitial.maxChannelDelta <= 1);
  }
  const rows = run.checkpoints.slice(1).map((c) => ({ cycle: c.cycle, ...c.versusInitial }));
  const maximum = (rows) => Math.max(...rows.map((c) => c.maxChannelDelta));
  info.runs[label] = {
    checkpoints: run.checkpoints.length,
    sourceExact: true,
    projectExact: true,
    firstTenMaximum: maximum(rows.slice(0, 10)),
    lastTenMaximum: maximum(rows.slice(-10)),
    maximum: maximum(rows),
    boundFailures: rows.filter((c) => c.maxChannelDelta > 1),
    differentFrames: rows.filter((c) => c.differentChannels).length,
    first: rows[0],
    last: rows.at(-1),
  };
}
assert.equal(report.crossBuild.length, report.cycles + 1);
for (let n = 0; n <= report.cycles; n++) {
  assert.deepEqual(
    report.runs.baseline.checkpoints[n].sources,
    report.runs.candidate.checkpoints[n].sources,
  );
  const d = { cycle: n, ...delta(decoded.baseline[n], decoded.candidate[n]) };
  const { displayBoundPass, ...stored } = report.crossBuild[n];
  assert.deepEqual(stored, d);
  assert.equal(displayBoundPass, d.maxChannelDelta <= 1);
  info.crossBuild.push(d);
}
info.crossBuildMaximum = Math.max(...info.crossBuild.map((c) => c.maxChannelDelta));
info.crossBuildBoundFailures = info.crossBuild.filter((c) => c.maxChannelDelta > 1);
info.sourceExact = true;
info.originalDisplayBoundPass = report.displayBoundPass;
await writeFile(resolve(values.output), JSON.stringify(info, null, 2) + '\n', { flag: 'wx' });
console.log(
  JSON.stringify({
    verified: true,
    cycles: info.cycles,
    runs: info.runs,
    crossBuildMaximum: info.crossBuildMaximum,
    originalDisplayBoundPass: info.originalDisplayBoundPass,
  }),
);
