import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { demandModel } from './performance-demand.mjs';

const inputs = [];
const evidence = [];
const extraSources = [];
let output;
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index],
    value = process.argv[index + 1];
  if (!value) throw Error(`Missing value for ${key}`);
  if (key === '--input') inputs.push(resolve(value));
  else if (key === '--evidence') evidence.push(resolve(value));
  else if (key === '--source') extraSources.push(value);
  else if (key === '--output') output = resolve(value);
  else throw Error(`Unknown option ${key}`);
}
if (!output || !inputs.length)
  throw Error('Use --output NEW_DIRECTORY --input REPORT [--input REPORT] [--evidence FILE]');
assert.equal(
  new Set(inputs.map((path) => basename(path))).size,
  inputs.length,
  'Report filenames must be unique',
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const stats = (values) => ({
  median: median(values),
  min: Math.min(...values),
  max: Math.max(...values),
  count: values.length,
});
const files = [];
const sources = new Map();
function source(name, hash) {
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.ok(!sources.has(name) || sources.get(name) === hash, `Inconsistent source ${name}`);
  sources.set(name, hash);
}
const reports = [];
for (const path of inputs) {
  const bytes = await readFile(path),
    report = JSON.parse(bytes);
  assert.equal(report.kind, 'asr-resource-benchmark');
  assert.equal(
    report.collector.type,
    'independent-process',
    'Thread-based collector is not comparable',
  );
  assert.equal(report.actualDevice, report.requestedDevice, 'Unexpected device fallback');
  assert.equal(report.fallback, '');
  assert.ok(report.samples.length > 10 && report.phases.length > 6);
  for (const [name, hash] of Object.entries(report.sources)) source(name, hash);
  if (reports.length) {
    assert.deepEqual(report.host, reports[0].report.host);
    assert.deepEqual(report.runtimeVersions, reports[0].report.runtimeVersions);
    assert.deepEqual(report.fixture, reports[0].report.fixture);
  }
  for (const previous of reports.filter((row) => row.report.engine === report.engine))
    assert.deepEqual(report.model, previous.report.model);
  const sampleFile = `raw/${basename(path)}.gz`;
  const compressed = gzipSync(bytes, { level: 9 });
  files.push({
    file: sampleFile,
    bytes: compressed,
    originalSha256: digest(bytes),
    originalBytes: bytes.length,
  });
  const phase = (name) => {
    const found = report.phases.find((row) => row.name === name);
    assert.ok(found, `Missing phase ${name}`);
    return found;
  };
  const languages = [...new Set(report.transcriptions.map((row) => row.language))].sort();
  const transcription = Object.fromEntries(
    languages.map((language) => {
      const rows = report.transcriptions.filter((row) => row.language === language);
      assert.equal(rows.length, 3, 'Each language requires first inference plus two repeats');
      const values = rows.map((row) => ({
        ...row,
        phase: phase(`transcribe/${language}/${row.repeat}`),
      }));
      return [
        language,
        {
          text: rows.map((row) => row.text),
          firstMs: values[0].phase.wallMs,
          firstCpuSeconds: values[0].phase.cpuSeconds,
          warmMs: median(values.slice(1).map((row) => row.phase.wallMs)),
          warmCpuSeconds: median(values.slice(1).map((row) => row.phase.cpuSeconds)),
        },
      ];
    }),
  );
  const before = new Map(report.cache.afterLoad.map((row) => [row.file, row]));
  const after = new Map(report.cache.afterInference.map((row) => [row.file, row]));
  const changedCache = [...new Set([...before.keys(), ...after.keys()])]
    .filter((name) => JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)))
    .map((name) => ({
      file: name,
      before: before.get(name) ?? null,
      after: after.get(name) ?? null,
    }));
  const demand = demandModel(report);
  const row = {
    file: sampleFile,
    engine: report.engine,
    device: report.actualDevice,
    mode: report.mode,
    languages,
    loadMs: phase('load-model').wallMs,
    loadCpuSeconds: phase('load-model').cpuSeconds,
    verifyMs: phase('verify-model').wallMs,
    transcriptions: transcription,
    residentWorkingSetBytes: phase('idle-resident').workingSetBytesAfter,
    releasedWorkingSetBytes: phase('idle-released').workingSetBytesAfter,
    sampledPeakWorkingSetBytes: Math.max(
      ...report.samples.flatMap((s) => s.processes.map((p) => p.workingSetBytes)),
    ),
    residentIdleCpuSeconds: phase('idle-resident').cpuSeconds,
    releasedIdleCpuSeconds: phase('idle-released').cpuSeconds,
    releaseMs: phase('release-model').wallMs,
    cpuSeconds: demand.totalCpuSeconds,
    cpuDemand200MsP99: demand.windows[200].coreEquivalent.p99,
    cpuDemand200MsPeak: demand.windows[200].coreEquivalent.max,
    collectorCpuSeconds: report.collector.cpuSeconds,
    maximumSamplingGapMs: report.collector.maximumGapMs,
    compileCacheBytes: report.cache.afterInference.reduce((sum, entry) => sum + entry.bytes, 0),
    changedCacheDuringInference: changedCache,
    phaseIoLogicalTransfers: Object.fromEntries(
      report.phases.map((entry) => [entry.name, entry.ioDelta]),
    ),
  };
  reports.push({ report, row });
}
const groups = new Map();
for (const { row } of reports) {
  const key = `${row.engine}/${row.device}/${row.mode}/${row.languages.join('+')}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
const fields = [
  'loadMs',
  'loadCpuSeconds',
  'cpuSeconds',
  'residentWorkingSetBytes',
  'releasedWorkingSetBytes',
  'sampledPeakWorkingSetBytes',
  'residentIdleCpuSeconds',
  'releasedIdleCpuSeconds',
  'releaseMs',
  'collectorCpuSeconds',
  'maximumSamplingGapMs',
  'cpuDemand200MsP99',
  'cpuDemand200MsPeak',
  'compileCacheBytes',
];
const summary = {
  schema: 1,
  kind: 'asr-baseline-summary',
  reportCount: reports.length,
  host: reports[0].report.host,
  runtimeVersions: reports[0].report.runtimeVersions,
  groups: [...groups].map(([key, rows]) => ({
    key,
    runs: rows.length,
    ...Object.fromEntries(fields.map((name) => [name, stats(rows.map((row) => row[name]))])),
    transcriptions: Object.fromEntries(
      rows[0].languages.map((language) => [
        language,
        Object.fromEntries(
          ['firstMs', 'firstCpuSeconds', 'warmMs', 'warmCpuSeconds'].map((name) => [
            name,
            stats(rows.map((row) => row.transcriptions[language][name])),
          ]),
        ),
      ]),
    ),
  })),
  runs: reports.map(({ row }) => row),
  limitations: [
    'Resource baseline, not a before/after optimization experiment or whole UI workflow',
    'Group medians use process runs; warm per-run medians use repeats 1 and 2, excluding first inference',
    'Cold means empty compiler cache, not cold OS file cache; cached means a fresh process with existing files',
    'Only inference-process CPU/memory/logical I/O; collector cost separate; driver/service energy and GPU/NPU activity unknown',
    '200 ms demand uses interpolation across actual sample intervals; it cannot recover shorter spikes',
    'Literal Chinese character distance includes simplified/traditional variants; two TTS sentences do not measure recognition accuracy',
    'Five-second idle phases and explicit close do not represent the 1800-second production idle policy',
    'GPU kernel-cache changes do not by themselves establish full graph recompilation',
    'No energy, battery-life, or lowest-power-device claim',
  ],
};

// Evidence may name the exact source snapshot used by an independent protocol validation.
for (const path of evidence) {
  const bytes = await readFile(path);
  if (path.endsWith('.json')) {
    const parsed = JSON.parse(bytes);
    if (parsed.sources && !Array.isArray(parsed.sources))
      for (const [name, hash] of Object.entries(parsed.sources)) source(name, hash);
  }
  files.push({ file: `evidence/${basename(path)}`, bytes });
}
sources.set('scripts/summarize-asr.mjs', digest(await readFile(new URL(import.meta.url))));
sources.set(
  'scripts/performance-demand.mjs',
  digest(await readFile('scripts/performance-demand.mjs')),
);
for (const name of extraSources) source(name, digest(await readFile(name)));
for (const [name, expected] of sources) {
  const path = resolve(name),
    local = relative(process.cwd(), path);
  assert.ok(
    local && !local.startsWith('..') && !isAbsolute(local),
    'Sources must stay in the repository',
  );
  const bytes = await readFile(path);
  assert.equal(digest(bytes), expected, `Current source differs from the measured source: ${name}`);
  files.push({ file: `sources/${local.replaceAll('\\', '/')}`, bytes });
}
files.push({ file: 'summary.json', bytes: Buffer.from(JSON.stringify(summary, null, 2) + '\n') });
assert.equal(new Set(files.map((row) => row.file)).size, files.length);
// mkdir is exclusive: existing archives cannot silently lose provenance.
await mkdir(output, { recursive: false });
const manifest = { schema: 1, created: new Date().toISOString(), files: [] };
for (const { file, bytes, ...original } of files) {
  const target = join(output, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });
  manifest.files.push({ file, sha256: digest(bytes), bytes: bytes.length, ...original });
}
await writeFile(join(output, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    output,
    reports: reports.length,
    groups: summary.groups.length,
    artifacts: files.length,
    loadMs: summary.groups.map((group) => [group.key, group.loadMs.median]),
  }),
);
