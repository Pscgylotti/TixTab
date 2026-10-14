import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { requireComparable, cpuIntervals } from './performance-demand.mjs';

const { values } = parseArgs({
  options: {
    archive: { type: 'string' },
    before: { type: 'string' },
    candidate: { type: 'string' },
    production: { type: 'boolean', default: false },
  },
});
if (!values.archive)
  throw Error('Use --archive DIRECTORY [--before APP --candidate APP --production]');
const root = resolve(values.archive);
const sha = (b) => createHash('sha256').update(b).digest('hex');
function inside(base, file) {
  const path = resolve(base, file),
    name = relative(base, path);
  assert.ok(name && !name.startsWith('..') && !isAbsolute(name), file);
  return path;
}
const manifest = JSON.parse(await readFile(inside(root, 'MANIFEST.json')));
const data = new Map();
for (const e of manifest.files) {
  assert.ok(!data.has(e.file));
  const bytes = await readFile(inside(root, e.file));
  assert.equal(sha(bytes), e.sha256, e.file);
  const raw = e.rawSha256 ? gunzipSync(bytes) : bytes;
  if (e.rawSha256) assert.equal(sha(raw), e.rawSha256, e.file);
  data.set(e.file, raw);
}
const json = (file) => JSON.parse(data.get(file));
let runtimeFiles = 0,
  sourceFiles = 0;
const sources = {};
for (const group of ['before', 'candidate']) {
  sources[group] = json(`${group}-source-manifest.json`);
  for (const [file, hash] of sources[group]) {
    assert.equal(sha(data.get(`sources/${group}/${file}.gz`)), hash, `${group}/${file}`);
    if (values.production && group === 'candidate' && file.startsWith('src/'))
      assert.equal(sha(await readFile(resolve(file))), hash, file);
    sourceFiles++;
  }
  if (values[group])
    for (const [file, hash] of json(`${group}-runtime-manifest.json`)) {
      assert.equal(sha(await readFile(inside(resolve(values[group]), file))), hash, file);
      runtimeFiles++;
    }
}
const candidate = new Map(sources.candidate);
assert.deepEqual(
  sources.before.filter(([file, hash]) => candidate.get(file) !== hash).map(([file]) => file),
  ['src/FormulaDialog.tsx'],
);
const native = json('native.json.gz');
assert.equal(native.sourceManifestSha256, sha(data.get('candidate-source-manifest.json')));
assert.equal(native.checks.length, 13);
assert.deepEqual(native.errors, []);
assert.ok(native.checks.every((c) => c.different === 0));
for (const count of [20, 21])
  for (const target of ['visible', 'committed'])
    assert.ok(
      native.checks.some(
        (c) =>
          c.name === `restored-${target}-context-${count}` &&
          c.height === (count === 20 ? 320 : 640),
      ),
    );
assert.match(data.get('height-diagnostic.log.gz').toString(), /restored-visible-context-21/);
assert.match(data.get('browser.log.gz').toString(), /9 passed/);
const integration = json('integration.json.gz');
requireComparable([integration]);
assert.equal(cpuIntervals(integration.samples).filter((s) => s.unmatched).length, 0);
assert.deepEqual(integration.buildManifest, json('candidate-runtime-manifest.json'));
assert.equal(sha(JSON.stringify(integration.buildManifest)), integration.buildSha256);
assert.equal(
  sha(Buffer.concat(integration.harnessFiles.map((p) => data.get(`tools/${p}.gz`)))),
  integration.harnessSha256,
);
console.log(
  JSON.stringify({
    passed: true,
    files: data.size,
    sourceFiles,
    runtimeFiles,
    nativeChecks: native.checks.length,
    integrationPhases: integration.rows.length,
    production: values.production,
  }),
);
