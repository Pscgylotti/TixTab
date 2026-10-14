import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { demandModel, quantiles, requireComparable, cpuIntervals } from './performance-demand.mjs';
import { jointDemand, inferenceOverlap } from './joint-demand.mjs';

const { values } = parseArgs({
  options: {
    archive: { type: 'string', default: 'docs/performance/2026-10-13-ai-workflow' },
    'frozen-ui': { type: 'string' },
    production: { type: 'boolean', default: false },
  },
});
const root = resolve(values.archive);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (base, name) => {
  const path = resolve(base, name),
    local = relative(base, path);
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local), `Unsafe archive path ${name}`);
  return path;
};
const manifest = JSON.parse(await readFile(join(root, 'MANIFEST.json')));
assert.equal(manifest.kind, 'ai-workflow-archive');
const entries = new Map();
for (const entry of manifest.files) {
  assert.ok(!entries.has(entry.file), 'Duplicate manifest entry');
  const bytes = await readFile(inside(root, entry.file));
  assert.equal(bytes.length, entry.bytes);
  assert.equal(sha(bytes), entry.sha256, entry.file);
  if (entry.rawSha256) {
    const raw = gunzipSync(bytes);
    assert.equal(raw.length, entry.rawBytes);
    assert.equal(sha(raw), entry.rawSha256, entry.file);
  }
  entries.set(entry.file, entry);
}
const raw = async (name) => {
  assert.ok(entries.has(name), `Unmanifested file ${name}`);
  const bytes = await readFile(inside(root, name));
  return name.endsWith('.gz') ? gunzipSync(bytes) : bytes;
};
const json = async (name) => JSON.parse(await raw(name));
const sources = {};
for (const group of ['before', 'candidate']) {
  sources[group] = await json(`${group}/SOURCE-MANIFEST.json`);
  for (const [file, hash] of Object.entries(sources[group].files))
    assert.equal(entries.get(`${group}/${file}.gz`).rawSha256, hash);
  const config = (await raw(`${group}/backend/asr-ort.config.gz`)).toString();
  for (const kind of ['intra', 'inter'])
    assert.ok(
      config.includes(
        `SessionConfig.session.${kind}_op.allow_spinning=${group === 'before' ? 1 : 0}`,
      ),
    );
}
assert.deepEqual(Object.keys(sources.before.files), Object.keys(sources.candidate.files));
assert.deepEqual(
  Object.keys(sources.before.files).filter(
    (name) => sources.before.files[name] !== sources.candidate.files[name],
  ),
  ['backend/asr-ort.config'],
);
const groups = { before: [], candidate: [] },
  diagnostic = [];
for (const group of ['before', 'candidate'])
  for (let n = 1; n <= 3; n++)
    for (const phase of ['strict', 'diagnostic']) {
      const name = `${phase}/${group}-${n}`;
      const report = await json(name + '.json.gz');
      assert.equal(report.kind, 'ai-workflow-resource-benchmark');
      for (const component of ['pdf', 'asr'])
        assert.deepEqual(report[component], await json(name + '.' + component + '.json.gz'));
      for (const [file, hash] of Object.entries(report.sources))
        assert.equal(
          hash,
          entries.get(
            phase === 'diagnostic' &&
              ['scripts/benchmark-ai-workflow.mjs', 'scripts/benchmark-workflow.mjs'].includes(file)
              ? 'diagnostic/sources/' + file.slice('scripts/'.length) + '.gz'
              : 'sources/' + file + '.gz',
          ).rawSha256,
        );
      assert.equal(
        report.pdf.harnessSha256,
        sha(
          Buffer.concat(
            await Promise.all(
              ['scripts/benchmark-workflow.mjs', 'scripts/performance-settle.mjs'].map((file) =>
                raw(
                  phase === 'diagnostic' && file === 'scripts/benchmark-workflow.mjs'
                    ? 'diagnostic/sources/benchmark-workflow.mjs.gz'
                    : 'sources/' + file + '.gz',
                ),
              ),
            ),
          ),
        ),
      );
      assert.equal(report.pdf.buildSha256, sha(JSON.stringify(report.pdf.buildManifest)));
      for (const [file, hash] of Object.entries(report.asr.sources))
        assert.equal(
          hash,
          file.startsWith('backend/')
            ? sources[group].files[file]
            : entries.get('sources/' + file + '.gz').rawSha256,
        );
      assert.equal(report.asr.collector.type, 'independent-process');
      assert.equal(report.asr.actualDevice, 'CPU');
      assert.equal(report.asr.fallback, '');
      assert.deepEqual(report.asr.workload, { repeats: 10, idleSeconds: 10, betweenSeconds: 1 });
      assert.equal(report.asr.transcriptions.length, 10);
      assert.deepEqual(
        report.demand,
        jointDemand([
          { name: 'pdf', report: report.pdf },
          { name: 'asr', report: report.asr },
        ]),
      );
      assert.deepEqual(Object.keys(report.inferenceOverlapMs), [
        'continuous-scroll-roundtrip',
        'facing-zoom',
      ]);
      for (const [name, ms] of Object.entries(report.inferenceOverlapMs)) {
        assert.equal(ms, inferenceOverlap(report.pdf, report.asr, name));
        assert.ok(ms > 0, 'Inference did not actually overlap PDF operation');
      }
      if (phase === 'strict') {
        assert.equal(report.demand.unmatchedProcessIntervals, 0);
        groups[group].push(report);
      } else diagnostic.push(report);
    }
const all = [...groups.before, ...groups.candidate];
requireComparable(all.map((r) => r.pdf));
assert.equal(new Set(all.map((r) => r.pdf.buildSha256)).size, 1);
for (const report of all) {
  assert.deepEqual(report.sources, all[0].sources);
  for (const field of ['fixture', 'model', 'host', 'runtimeVersions', 'workload', 'transcriptions'])
    assert.deepEqual(report.asr[field], all[0].asr[field]);
}
const incomplete = diagnostic.filter((r) => r.demand.unmatchedProcessIntervals);
assert.equal(incomplete.length, 1);
assert.equal(incomplete[0].label, 'candidate-1');
assert.equal(incomplete[0].demand.unmatchedProcessIntervals, 1);
const recheck = [];
for (const group of ['before', 'candidate'])
  for (let n = 1; n <= 2; n++) {
    const report = await json(`diagnostic-recheck/${group}-${n}.json.gz`);
    for (const component of ['pdf', 'asr'])
      assert.deepEqual(
        report[component],
        await json(`diagnostic-recheck/${group}-${n}.${component}.json.gz`),
      );
    for (const [file, hash] of Object.entries(report.sources))
      assert.equal(
        hash,
        entries.get(
          file === 'scripts/benchmark-ai-workflow.mjs'
            ? 'diagnostic-recheck/sources/benchmark-ai-workflow.mjs.gz'
            : file === 'scripts/benchmark-workflow.mjs'
              ? 'diagnostic/sources/benchmark-workflow.mjs.gz'
              : 'sources/' + file + '.gz',
        ).rawSha256,
      );
    assert.equal(report.demand.unmatchedProcessIntervals, 0);
    recheck.push(report);
  }
requireComparable(recheck.map((r) => r.pdf));
const failedPdf = await json('diagnostic-recheck/failed-before-3.pdf.json.gz');
const badIntervals = cpuIntervals(failedPdf.samples).filter((r) => r.unmatched);
assert.equal(badIntervals.length, 1);
assert.equal(badIntervals[0].phase, 'setup');
// Confirm the diagnosed failure was a same-process counter decrease, not PID churn.
const first = failedPdf.samples.find((r) => r.at === badIntervals[0].start);
const second = failedPdf.samples.find((r) => r.at === badIntervals[0].end);
assert.deepEqual(
  first.processes.map((p) => p.pid),
  second.processes.map((p) => p.pid),
);
assert.ok(
  second.processes.some(
    (p) =>
      p.cpu.cumulativeCPUUsage <
      first.processes.find((a) => a.pid === p.pid).cpu.cumulativeCPUUsage,
  ),
);
const comparison = await json('evidence/ai-workflow-primed-comparison.json.gz');
assert.equal(comparison.kind, 'ai-workflow-comparison');
for (const [group, reports] of Object.entries(groups)) {
  const summary = comparison[group];
  assert.equal(summary.count, reports.length);
  const stats = {
    cpuSeconds: (r) => r.demand.cpuSeconds,
    elapsedMs: (r) => r.demand.elapsedMs,
    pdfCpuSeconds: (r) => demandModel(r.pdf).totalCpuSeconds,
    asrCpuSeconds: (r) => demandModel(r.asr).totalCpuSeconds,
    demand200MsP99: (r) => r.demand.windows[200].coreEquivalent.p99,
    demand200MsPeak: (r) => r.demand.windows[200].coreEquivalent.max,
    inferenceP50Ms: (r) =>
      quantiles(r.asr.phases.filter((p) => p.name.startsWith('transcribe/')).map((p) => p.wallMs))
        .p50,
    inferenceP95Ms: (r) =>
      quantiles(r.asr.phases.filter((p) => p.name.startsWith('transcribe/')).map((p) => p.wallMs))
        .p95,
    asrPeakWorkingSetMiB: (r) =>
      Math.max(...r.asr.samples.flatMap((s) => s.processes.map((p) => p.workingSetBytes))) /
      1048576,
    pdfPeakWorkingSetMiB: (r) =>
      Math.max(...r.pdf.rows.map((p) => p.memoryWorkingSetKbPeak)) / 1024,
  };
  for (const [name, measure] of Object.entries(stats))
    assert.deepEqual(summary[name], quantiles(reports.map(measure)), `${group}/${name}`);
  assert.deepEqual(
    summary.pdfPhases.map((p) => p.name),
    reports[0].pdf.rows.map((p) => p.name),
  );
  for (const phase of summary.pdfPhases) {
    const rows = reports.map((r) => r.pdf.rows.find((p) => p.name === phase.name));
    assert.deepEqual(phase.cpuSeconds, quantiles(rows.map((r) => r.cpuSeconds)));
    assert.deepEqual(phase.frameP95Ms, quantiles(rows.map((r) => r.framesMs.p95)));
    assert.deepEqual(phase.frameP99Ms, quantiles(rows.map((r) => r.framesMs.p99)));
  }
}
const ui = await json('UI-REFERENCE.json');
assert.equal(ui.archive, '../2026-10-13-round2/path-elements');
const uiRoot = resolve(root, ui.archive);
assert.equal(sha(await readFile(join(uiRoot, 'MANIFEST.json'))), ui.manifestSha256);
const uiSources = await readFile(join(uiRoot, 'SOURCE-MANIFEST.json'));
assert.equal(sha(uiSources), ui.sourceManifestSha256);
assert.equal(ui.buildSha256, all[0].pdf.buildSha256);
const uiManifest = JSON.parse(await readFile(join(uiRoot, 'MANIFEST.json')));
assert.ok(
  uiManifest.entries.some(
    (r) => r.file.startsWith('candidate-') && r.buildSha256 === ui.buildSha256,
  ),
);
for (const [file, hash] of JSON.parse(uiSources).candidate)
  assert.equal(
    sha(gunzipSync(await readFile(inside(uiRoot, `source-snapshots/candidate/${file}.gz`)))),
    hash,
  );
let runtimeFiles = 0;
if (values['frozen-ui']) {
  for (const [file, hash] of all[0].pdf.buildManifest) {
    assert.equal(sha(await readFile(inside(resolve(values['frozen-ui']), file))), hash);
    runtimeFiles++;
  }
  if (all[0].pdf.executableHash)
    assert.equal(sha(await readFile(all[0].pdf.executable)), all[0].pdf.executableHash);
}
const fallback = await json('evidence/asr-fallback-real-cpu.json.gz');
assert.equal(fallback.actual, 'CPU');
assert.equal(fallback.requested, 'NPU');
assert.equal(fallback.fallback, 'NPU');
assert.deepEqual(
  fallback.rows.map((r) => r.language),
  ['en-US', 'zh-CN'],
);
assert.ok(fallback.rows.every((r) => r.text.length > 3));
for (const [name, hash] of Object.entries(fallback.sources))
  assert.equal(
    hash,
    name.startsWith('backend/')
      ? sources.candidate.files[name]
      : entries.get('sources/' + name + '.gz').rawSha256,
  );
if (values.production) {
  for (const name of ['backend/native_asr.py', 'backend/asr-ort.config'])
    assert.equal(sha(await readFile(name)), sources.candidate.files[name]);
  assert.equal(
    sha(await readFile('src/PageEditor.tsx')),
    new Map(JSON.parse(uiSources).candidate).get('src/PageEditor.tsx'),
  );
  assert.ok(
    JSON.parse(await readFile('package.json')).build.extraFiles.some((row) =>
      row.filter?.includes('asr-ort.config'),
    ),
  );
}
console.log(
  JSON.stringify({
    passed: true,
    formalRuns: all.length,
    retainedDiagnosticRuns: diagnostic.length,
    retainedRecheckRuns: recheck.length,
    incompleteDiagnosticRuns: incomplete.length,
    files: entries.size,
    runtimeFiles,
    cpuSeconds: [comparison.before.cpuSeconds.p50, comparison.candidate.cpuSeconds.p50],
    realCpuFallbackUtterances: fallback.rows.length,
  }),
);
