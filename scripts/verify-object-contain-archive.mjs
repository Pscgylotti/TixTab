import { readFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const sharp = createRequire(import.meta.url)('sharp');
const { values } = parseArgs({
  options: {
    archive: { type: 'string' },
    'frozen-prefix': { type: 'string' },
    'production-root': { type: 'string' },
  },
});
if (!values.archive) throw Error('Supply quality archive directory');
const root = resolve(values.archive),
  sha = (b) => createHash('sha256').update(b).digest('hex');
const inside = (root, file) => {
  const path = resolve(root, file),
    r = relative(root, path);
  assert(r && !r.startsWith('..') && !isAbsolute(r), 'Unsafe path');
  return path;
};
const raw = (file) => readFile(inside(root, file)),
  unpack = async (file) => gunzipSync(await raw(file));
const manifest = JSON.parse(await raw('MANIFEST.json'));
const names = new Set();
for (const e of manifest.evidence) {
  assert(!names.has(e.file));
  names.add(e.file);
  const b = await raw(e.file);
  assert.equal(sha(b), e.sha256, e.file);
  assert.equal(b.length, e.bytes);
  if (e.rawSha256) assert.equal(sha(gunzipSync(b)), e.rawSha256);
}
const sourceBytes = await raw('SOURCE-MANIFEST.json'),
  sources = JSON.parse(sourceBytes);
assert.equal(sha(sourceBytes), manifest.sourceManifestSha256);
assert.deepEqual(
  sources.before.map(([p]) => p),
  sources.candidate.map(([p]) => p),
);
assert.deepEqual(
  sources.before.filter(([p, h]) => new Map(sources.candidate).get(p) !== h).map(([p]) => p),
  ['src/chrome.css'],
);
for (const group of ['before', 'candidate']) {
  assert.deepEqual(JSON.parse(await raw(group + '-source-manifest.json')), sources[group]);
  for (const [file, hash] of sources[group])
    assert.equal(sha(await unpack(`source-snapshots/${group}/${file}.gz`)), hash, file);
}
const runtimeBytes = await raw('RUNTIME-MANIFEST.json'),
  runtime = JSON.parse(runtimeBytes);
assert.equal(sha(runtimeBytes), manifest.runtimeManifestSha256);
let runtimeFilesChecked = 0;
for (const group of ['before', 'candidate'])
  for (const [file, hash] of runtime[group]) {
    if (values['frozen-prefix']) {
      assert.equal(
        sha(await readFile(inside(resolve(values['frozen-prefix'] + '-' + group), file))),
        hash,
        file,
      );
      runtimeFilesChecked++;
    }
    if (new Map(runtime[group === 'before' ? 'candidate' : 'before']).get(file) !== hash)
      assert.equal(sha(await unpack(`changed-runtime/${group}/${file}.gz`)), hash);
  }
const native = JSON.parse(await unpack('native/report.json.gz'));
assert.equal(native.pass, false);
assert.equal(native.contentPass, true);
assert(native.guidesVisible);
assert.deepEqual(native.errors, []);
assert.equal(native.checks.length, 24);
assert.equal(
  native.harnessSha256,
  sha(await unpack('tools/scripts/verify-object-preview-native.mjs.gz')),
);
assert.equal(
  native.scenariosSha256,
  sha(await unpack('tools/scripts/object-preview-scenarios.mjs.gz')),
);
assert.equal(native.fixtureSha256, sha(await unpack('native/fixture.tixtab.gz')));
for (const [label, group] of [
  ['baseline', 'before'],
  ['candidate', 'candidate'],
])
  assert.equal(
    native.sources[label].sourceManifestSha256,
    sha(await raw(group + '-source-manifest.json')),
  );
async function pixels(file, hash) {
  const b = await unpack(file);
  assert.equal(sha(b), hash);
  return sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
function difference(a, b) {
  assert.deepEqual(a.info, b.info);
  let different = 0,
    max = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d) {
      different++;
      max = Math.max(max, d);
    }
  }
  return { different, max, width: a.info.width, height: a.info.height };
}
let rasterPairs = 0;
for (const a of native.renders.baseline) {
  const b = native.renders.candidate.find((b) => b.id === a.id);
  assert.deepEqual(a.geometry, b.geometry);
  assert.deepEqual(a.root, b.root);
  assert.deepEqual(a.raster, b.raster);
  rasterPairs += a.raster.length;
  const x = await pixels('native/' + a.name + '.gz', a.sha256),
    y = await pixels('native/' + b.name + '.gz', b.sha256),
    d = difference(x, y),
    record = native.checks.find((c) => c.id === a.id);
  assert.deepEqual(
    d,
    (({ different, max, width, height }) => ({ different, max, width, height }))(record),
  );
  assert(d.different > 0 && d.max > 1, 'Candidate unexpectedly passes quality');
}
assert.equal(rasterPairs, 120);
const probe = JSON.parse(await unpack('probe/report.json.gz'));
assert.deepEqual(probe.errors, []);
assert(!probe.failure);
assert.equal(probe.checks.length, 28);
assert.equal(
  probe.harnessSha256,
  sha(await unpack('tools/scripts/probe-object-containment.mjs.gz')),
);
assert.equal(probe.scenariosSha256, native.scenariosSha256);
assert.equal(probe.sourceManifestSha256, sha(await raw('before-source-manifest.json')));
assert.equal(probe.fixtureSha256, sha(await unpack('probe/fixture.tixtab.gz')));
const geometry = (rows) => rows.map(({ contain, overflowClipMargin, ...r }) => r);
for (const night of [false, true])
  for (const resize of [false, true]) {
    const rows = probe.checks.filter((c) => c.night === night && c.resize === resize),
      base = rows.find((r) => r.label === 'none'),
      x = await pixels('probe/' + base.name + '.gz', base.sha256);
    assert.equal(rows.length, 7);
    for (const row of rows) {
      const y = await pixels('probe/' + row.name + '.gz', row.sha256);
      assert.deepEqual(
        difference(x, y),
        (({ different, max, width, height }) => ({ different, max, width, height }))(row),
      );
      assert.deepEqual(geometry(row.computed), geometry(base.computed));
      const expected = {
        none: ['none'],
        style: ['style'],
        layout: ['layout', 'style'],
        paint: ['paint'],
        content: ['layout', 'paint', 'style'],
        'wide-clip': ['layout', 'paint', 'style'],
        restore: ['none'],
      }[row.label];
      for (const node of row.computed) {
        // Chromium serializes layout + style + paint as the equivalent content keyword.
        const components =
          node.contain === 'content' ? ['layout', 'style', 'paint'] : node.contain.split(' ');
        assert.deepEqual(components.sort(), expected.slice().sort());
      }
      if (['layout', 'paint', 'content', 'wide-clip'].includes(row.label))
        assert(row.max > 1 && row.different > 0);
      if (row.label === 'wide-clip')
        assert(row.computed.every((n) => n.overflowClipMargin === '64px'));
    }
  }
const restored = JSON.parse(await unpack('restoration.json.gz'));
assert.equal(restored.sourceManifestSha256, sha(await raw('before-source-manifest.json')));
assert.equal(restored.sourceFilesMatched, sources.before.length);
assert.equal(restored.candidateRetained, false);
if (values['production-root'])
  for (const [file, hash] of sources.before)
    assert.equal(sha(await readFile(inside(resolve(values['production-root']), file))), hash, file);
console.log(
  JSON.stringify({
    passed: true,
    qualityCandidateRejected: true,
    sourceFiles: sources.before.length + sources.candidate.length,
    runtimeFilesChecked,
    failedSamePhasePixelPairs: 24,
    identicalRasterPairs: rasterPairs,
    propertyProbeScreens: 28,
    restoredSourceChecked: Boolean(values['production-root']),
    resourceBenchmarkRuns: 0,
    limitation:
      'Display changed; not evidence of energy benefit or a universal containment failure.',
  }),
);
