import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { requireComparable, demandModel, quantiles } from './performance-demand.mjs';
import { jointDemand, inferenceOverlap } from './joint-demand.mjs';

const { values } = parseArgs({
  options: {
    before: { type: 'string', multiple: true },
    candidate: { type: 'string', multiple: true },
    output: { type: 'string' },
  },
});
if (!values.before?.length || !values.candidate?.length || !values.output)
  throw Error('Use repeated --before and --candidate reports, plus --output NEW_JSON');
const read = async (path) => {
  const bytes = await readFile(path);
  return JSON.parse(path.endsWith('.gz') ? gunzipSync(bytes) : bytes);
};
const groups = {
  before: await Promise.all(values.before.map(read)),
  candidate: await Promise.all(values.candidate.map(read)),
};
const reference = groups.before[0];
const all = [...groups.before, ...groups.candidate];
requireComparable(all.map((row) => row.pdf));
assert.equal(
  new Set(all.map((row) => row.pdf.buildSha256)).size,
  1,
  'Both policies require exactly the same UI build',
);
for (const [group, reports] of Object.entries(groups))
  for (const report of reports) {
    assert.equal(report.kind, 'ai-workflow-resource-benchmark');
    assert.deepEqual(report.sources, reference.sources);
    for (const field of ['model', 'fixture', 'host', 'runtimeVersions', 'workload'])
      assert.deepEqual(report.asr[field], reference.asr[field], field);
    assert.equal(report.asr.actualDevice, 'CPU');
    assert.equal(report.asr.fallback, '');
    assert.deepEqual(
      report.asr.transcriptions,
      reference.asr.transcriptions,
      'Fixed-input text/quality changed',
    );
    for (const [file, hash] of Object.entries(report.asr.sources))
      assert.equal(
        hash,
        file === 'backend/asr-ort.config'
          ? reports[0].asr.sources[file]
          : reference.asr.sources[file],
      );
    assert.deepEqual(
      report.demand,
      jointDemand([
        { name: 'pdf', report: report.pdf },
        { name: 'asr', report: report.asr },
      ]),
    );
    assert.equal(report.demand.unmatchedProcessIntervals, 0);
    for (const [name, ms] of Object.entries(report.inferenceOverlapMs)) {
      assert.equal(ms, inferenceOverlap(report.pdf, report.asr, name));
      assert.ok(ms > 0);
    }
  }
assert.notEqual(
  reference.asr.sources['backend/asr-ort.config'],
  groups.candidate[0].asr.sources['backend/asr-ort.config'],
);
const summarize = (reports) => ({
  count: reports.length,
  cpuSeconds: quantiles(reports.map((r) => r.demand.cpuSeconds)),
  elapsedMs: quantiles(reports.map((r) => r.demand.elapsedMs)),
  pdfCpuSeconds: quantiles(reports.map((r) => demandModel(r.pdf).totalCpuSeconds)),
  asrCpuSeconds: quantiles(reports.map((r) => demandModel(r.asr).totalCpuSeconds)),
  demand200MsP99: quantiles(reports.map((r) => r.demand.windows[200].coreEquivalent.p99)),
  demand200MsPeak: quantiles(reports.map((r) => r.demand.windows[200].coreEquivalent.max)),
  inferenceP50Ms: quantiles(
    reports.map(
      (r) =>
        quantiles(r.asr.phases.filter((p) => p.name.startsWith('transcribe/')).map((p) => p.wallMs))
          .p50,
    ),
  ),
  inferenceP95Ms: quantiles(
    reports.map(
      (r) =>
        quantiles(r.asr.phases.filter((p) => p.name.startsWith('transcribe/')).map((p) => p.wallMs))
          .p95,
    ),
  ),
  asrPeakWorkingSetMiB: quantiles(
    reports.map(
      (r) =>
        Math.max(...r.asr.samples.flatMap((s) => s.processes.map((p) => p.workingSetBytes))) /
        1048576,
    ),
  ),
  pdfPeakWorkingSetMiB: quantiles(
    reports.map((r) => Math.max(...r.pdf.rows.map((p) => p.memoryWorkingSetKbPeak)) / 1024),
  ),
  pdfPhases: reference.pdf.rows.map((phase) => ({
    name: phase.name,
    cpuSeconds: quantiles(
      reports.map((r) => r.pdf.rows.find((p) => p.name === phase.name).cpuSeconds),
    ),
    frameP95Ms: quantiles(
      reports.map((r) => r.pdf.rows.find((p) => p.name === phase.name).framesMs.p95),
    ),
    frameP99Ms: quantiles(
      reports.map((r) => r.pdf.rows.find((p) => p.name === phase.name).framesMs.p99),
    ),
  })),
});
const comparison = {
  schema: 1,
  kind: 'ai-workflow-comparison',
  source: { before: values.before, candidate: values.candidate },
  before: summarize(groups.before),
  candidate: summarize(groups.candidate),
  limitations: [
    'Observed CPU demand, not energy or whole-system power; collectors/coordinator and drivers excluded.',
    'Three paired runs are descriptive, not statistical significance. Both sides use the same frozen UI.',
    'Real models on authored audio alongside synthetic PDF gestures; no live microphone or real pen latency claim.',
  ],
};
await writeFile(values.output, JSON.stringify(comparison, null, 2) + '\n', { flag: 'wx' });
console.log(
  JSON.stringify({
    cpuSeconds: [comparison.before.cpuSeconds.p50, comparison.candidate.cpuSeconds.p50],
    elapsedMs: [comparison.before.elapsedMs.p50, comparison.candidate.elapsedMs.p50],
    asrCpuSeconds: [comparison.before.asrCpuSeconds.p50, comparison.candidate.asrCpuSeconds.p50],
    inferenceP95Ms: [comparison.before.inferenceP95Ms.p50, comparison.candidate.inferenceP95Ms.p50],
  }),
);
