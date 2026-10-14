import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const { values } = parseArgs({
  options: {
    directory: { type: 'string' },
    'reference-directory': { type: 'string', multiple: true },
    output: { type: 'string' },
  },
});
assert(values.directory && values['reference-directory']?.length && values.output);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const targetDir = resolve(values.directory),
  targetBytes = await readFile(join(targetDir, 'report.json'));
const target = JSON.parse(targetBytes);
assert(target.contentPass);
const oracle = target.runs.baseline,
  frames = new Map(),
  references = [];
async function pixels(dir, c) {
  const path = resolve(dir, c.name),
    rel = relative(dir, path);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel));
  const bytes = await readFile(path);
  assert.equal(sha(bytes), c.sha256);
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1138);
  assert.equal(info.height, 1613);
  assert.equal(info.channels, 4);
  return sha(data);
}
for (const directory of [
  ...new Set([targetDir, ...values['reference-directory'].map((p) => resolve(p))]),
]) {
  const bytes = await readFile(join(directory, 'report.json')),
    report = JSON.parse(bytes),
    baseline = report.runs.baseline;
  assert.deepEqual(report.errors, []);
  assert.equal(report.fixtureSha256, target.fixtureSha256);
  assert.equal(report.scenarioSha256, target.scenarioSha256);
  assert.equal(report.settleSha256, target.settleSha256);
  assert.equal(baseline.sourceManifestSha256, oracle.sourceManifestSha256);
  assert.equal(baseline.runtimeSha256, oracle.runtimeSha256);
  assert.deepEqual(baseline.visuals, oracle.visuals);
  assert.equal(baseline.contain, 'none');
  assert.equal(baseline.projectBeforeSha256, oracle.projectBeforeSha256);
  const reference = { reportSha256: sha(bytes), harnessSha256: report.harnessSha256, frames: [] };
  references.push(reference);
  // An earlier strict-bound test may abort after capturing a differing frame.
  // It remains an observed unmodified-baseline frame, never a successful run.
  for (const c of baseline.checkpoints) {
    assert.deepEqual(c.sources, oracle.checkpoints[0].sources);
    assert.equal(c.pending, 0);
    const rgbaSha256 = await pixels(directory, c);
    reference.frames.push({ cycle: c.cycle, rgbaSha256 });
    if (!frames.has(rgbaSha256))
      frames.set(rgbaSha256, { reportSha256: reference.reportSha256, cycle: c.cycle });
  }
}
const checks = [];
for (const c of target.runs.candidate.checkpoints) {
  assert.deepEqual(c.sources, oracle.checkpoints[0].sources);
  assert.equal(c.pending, 0);
  const rgbaSha256 = await pixels(targetDir, c),
    match = frames.get(rgbaSha256);
  checks.push({ cycle: c.cycle, rgbaSha256, baselineWholeFrameMatch: match ?? null });
}
const output = {
  schema: 1,
  policy:
    'Candidate complete RGBA frame must literally match a captured unmodified baseline complete frame; no numeric tolerance or per-pixel/channel mixing',
  targetReportSha256: sha(targetBytes),
  originalDisplayBoundPass: target.displayBoundPass,
  references,
  checks,
  pass: checks.every((c) => c.baselineWholeFrameMatch),
};
await writeFile(resolve(values.output), JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
assert(output.pass);
console.log(
  JSON.stringify({
    pass: true,
    candidateFrames: checks.length,
    observedBaselineFrames: references.reduce((n, r) => n + r.frames.length, 0),
    uniqueBaselineFrames: frames.size,
    originalDisplayBoundPass: output.originalDisplayBoundPass,
  }),
);
