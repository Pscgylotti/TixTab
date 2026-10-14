import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { demandModel, quantiles } from './performance-demand.mjs';

const { values } = parseArgs({
  options: {
    before: { type: 'string', multiple: true },
    candidate: { type: 'string', multiple: true },
    output: { type: 'string' },
  },
});
if (!values.before?.length || !values.candidate?.length || !values.output)
  throw Error('Use --before REPORT --candidate REPORT (repeat for runs) --output NEW_JSON');
const read = async (path) => {
  const bytes = await readFile(path);
  return JSON.parse(path.endsWith('.gz') ? gunzipSync(bytes) : bytes);
};
const groups = {
  before: await Promise.all(values.before.map(read)),
  candidate: await Promise.all(values.candidate.map(read)),
};
const reference = groups.before[0];
for (const [group, reports] of Object.entries(groups)) {
  for (const report of reports) {
    assert.equal(report.kind, 'asr-resource-benchmark');
    assert.equal(report.collector.type, 'independent-process');
    assert.equal(report.engine, reference.engine);
    assert.equal(report.actualDevice, reference.actualDevice);
    assert.equal(report.requestedDevice, reference.requestedDevice);
    assert.equal(report.fallback, '');
    for (const field of ['host', 'runtimeVersions', 'fixture', 'model', 'workload'])
      assert.deepEqual(report[field], reference[field], `Incompatible ${field}`);
    assert.deepEqual(Object.keys(report.sources), Object.keys(reference.sources));
    for (const [file, hash] of Object.entries(report.sources)) {
      if (file !== 'backend/asr-ort.config') assert.equal(hash, reference.sources[file], file);
      else assert.equal(hash, reports[0].sources[file], `Mixed policy in ${group}`);
    }
  }
}
assert.notEqual(
  reference.sources['backend/asr-ort.config'],
  groups.candidate[0].sources['backend/asr-ort.config'],
);
const languages = [...new Set(reference.transcriptions.map((row) => row.language))];
// A run contains one fixed SenseVoice language; compare each language separately.
for (const report of [...groups.before, ...groups.candidate])
  for (const language of report.transcriptions.map((row) => row.language))
    if (!languages.includes(language)) languages.push(language);
const summaries = languages.map((language) => {
  const selected = Object.fromEntries(
    Object.entries(groups).map(([group, reports]) => [
      group,
      reports.filter((report) => report.transcriptions[0].language === language),
    ]),
  );
  assert.equal(selected.before.length, selected.candidate.length);
  assert.ok(selected.before.length > 0);
  const phaseNames = selected.before[0].phases.map((row) => row.name);
  const text = selected.before[0].transcriptions.map((row) => row.text);
  for (const report of [...selected.before, ...selected.candidate]) {
    assert.deepEqual(
      report.phases.map((row) => row.name),
      phaseNames,
    );
    assert.deepEqual(
      report.transcriptions.map((row) => row.text),
      text,
      'Output changed across fixed-input runs',
    );
  }
  const summarize = (reports) => ({
    count: reports.length,
    cpuSeconds: quantiles(reports.map((report) => demandModel(report).totalCpuSeconds)),
    elapsedMs: quantiles(reports.map((report) => demandModel(report).elapsedMs)),
    idleCpuSeconds: quantiles(
      reports.map((report) =>
        report.phases
          .filter((p) => p.name.startsWith('idle-'))
          .reduce((sum, p) => sum + p.cpuSeconds, 0),
      ),
    ),
    collectorCpuSeconds: quantiles(reports.map((report) => report.collector.cpuSeconds)),
    demand200MsP99: quantiles(
      reports.map((report) => demandModel(report).windows[200].coreEquivalent.p99),
    ),
    demand200MsPeak: quantiles(
      reports.map((report) => demandModel(report).windows[200].coreEquivalent.max),
    ),
    phases: phaseNames.map((name) => ({
      name,
      cpuSeconds: quantiles(
        reports.map((report) => report.phases.find((row) => row.name === name).cpuSeconds),
      ),
      wallMs: quantiles(
        reports.map((report) => report.phases.find((row) => row.name === name).wallMs),
      ),
    })),
  });
  return {
    language,
    before: summarize(selected.before),
    candidate: summarize(selected.candidate),
    outputsEqual: true,
  };
});
await writeFile(
  values.output,
  JSON.stringify(
    {
      schema: 1,
      kind: 'asr-policy-comparison',
      source: { before: values.before, candidate: values.candidate },
      summaries,
      limitations: [
        'Small paired resource experiment, not statistical significance or energy measurement.',
        'Same pinned model, two threads and decoding; only the runtime spin policy differs.',
        'Clean authored TTS samples and strict policy output equality are not an accuracy benchmark.',
      ],
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify(
    summaries.map((row) => ({
      language: row.language,
      cpuSeconds: [row.before.cpuSeconds.p50, row.candidate.cpuSeconds.p50],
      idleCpuSeconds: [row.before.idleCpuSeconds.p50, row.candidate.idleCpuSeconds.p50],
    })),
  ),
);
