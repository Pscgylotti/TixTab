import { readFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { demandModel, quantiles } from './performance-demand.mjs';

const root = resolve(process.argv[2] || 'docs/performance/2026-10-13-asr-baseline');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(join(root, 'MANIFEST.json'), 'utf8'));
const entries = new Map();
for (const entry of manifest.files) {
  const path = resolve(root, entry.file),
    local = relative(root, path);
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local));
  assert.ok(!entries.has(entry.file), `Duplicate manifest entry: ${entry.file}`);
  const bytes = await readFile(path);
  assert.equal(bytes.length, entry.bytes);
  assert.equal(digest(bytes), entry.sha256, entry.file);
  if (entry.originalSha256) {
    const raw = gunzipSync(bytes);
    assert.equal(raw.length, entry.originalBytes);
    assert.equal(digest(raw), entry.originalSha256);
  }
  if (entry.rawSha256) {
    const raw = gunzipSync(bytes);
    assert.equal(raw.length, entry.rawBytes);
    assert.equal(digest(raw), entry.rawSha256);
  }
  entries.set(entry.file, entry);
}
if (manifest.kind === 'asr-thread-policy-archive') {
  const readJson = async (file) => {
    const bytes = await readFile(join(root, file));
    return JSON.parse(file.endsWith('.gz') ? gunzipSync(bytes) : bytes);
  };
  const sources = {};
  const reports = { before: [], candidate: [] };
  for (const group of ['before', 'candidate']) {
    sources[group] = await readJson(`${group}/SOURCE-MANIFEST.json`);
    for (const [file, hash] of Object.entries(sources[group].files))
      assert.equal(entries.get(`${group}/${file}.gz`).rawSha256, hash);
    const policy = gunzipSync(
      await readFile(join(root, `${group}/backend/asr-ort.config.gz`)),
    ).toString('utf8');
    const value = group === 'before' ? '1' : '0';
    for (const kind of ['intra', 'inter'])
      assert.ok(policy.includes(`SessionConfig.session.${kind}_op.allow_spinning=${value}`));
    for (const language of ['en-US', 'zh-CN'])
      for (let n = 1; n <= 3; n++) {
        const report = await readJson(`raw/${group}-${language}-${n}.json.gz`);
        assert.equal(report.collector.type, 'independent-process');
        assert.equal(report.actualDevice, 'CPU');
        assert.equal(report.fallback, '');
        assert.deepEqual(report.workload, { repeats: 3, idleSeconds: 5, betweenSeconds: 1 });
        for (const [file, hash] of Object.entries(report.sources))
          assert.equal(
            hash,
            file.startsWith('backend/')
              ? sources[group].files[file]
              : entries.get(`sources/${file}.gz`).rawSha256,
          );
        reports[group].push(report);
      }
  }
  assert.deepEqual(Object.keys(sources.before.files), Object.keys(sources.candidate.files));
  assert.deepEqual(
    Object.keys(sources.before.files).filter(
      (file) => sources.before.files[file] !== sources.candidate.files[file],
    ),
    ['backend/asr-ort.config'],
  );
  const comparison = await readJson('evidence/asr-spin-comparison.json');
  for (const row of comparison.summaries) {
    for (const group of ['before', 'candidate']) {
      const measured = reports[group].filter((r) => r.transcriptions[0].language === row.language);
      assert.equal(measured.length, row[group].count);
      assert.deepEqual(
        row[group].cpuSeconds,
        quantiles(measured.map((r) => demandModel(r).totalCpuSeconds)),
      );
      assert.deepEqual(
        row[group].idleCpuSeconds,
        quantiles(
          measured.map((r) =>
            r.phases
              .filter((p) => p.name.startsWith('idle-'))
              .reduce((s, p) => s + p.cpuSeconds, 0),
          ),
        ),
      );
      for (const phase of row[group].phases)
        for (const key of ['cpuSeconds', 'wallMs'])
          assert.deepEqual(
            phase[key],
            quantiles(measured.map((r) => r.phases.find((p) => p.name === phase.name)[key])),
          );
    }
    const text = reports.before
      .find((r) => r.transcriptions[0].language === row.language)
      .transcriptions.map((t) => t.text);
    for (const report of [...reports.before, ...reports.candidate].filter(
      (r) => r.transcriptions[0].language === row.language,
    ))
      assert.deepEqual(
        report.transcriptions.map((t) => t.text),
        text,
      );
  }
  const quality = await readJson('evidence/asr-spin-quality.json');
  assert.equal(
    quality.harnessSha256,
    entries.get('sources/scripts/verify-asr-thread-policy.py.gz').rawSha256,
  );
  assert.deepEqual(quality.sources, sources);
  assert.equal(quality.rows.length, 8);
  assert.ok(quality.rows.every((row) => row.equal && row.text.before === row.text.candidate));
  const pkg = await readJson('sources/package.json.gz');
  assert.ok(
    pkg.build.extraFiles.find((row) => row.from === 'backend').filter.includes('asr-ort.config'),
  );
  console.log(
    JSON.stringify({
      passed: true,
      archive: root,
      reports: 12,
      qualityVariants: 8,
      artifacts: entries.size,
    }),
  );
} else {
  const summary = JSON.parse(await readFile(join(root, 'summary.json'), 'utf8'));
  assert.equal(summary.kind, 'asr-baseline-summary');
  assert.equal(summary.reportCount, summary.runs.length);
  assert.equal(entries.size, manifest.files.length);
  const median = (values) => {
    const sorted = values.toSorted((a, b) => a - b),
      middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const stats = (values) => ({
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    count: values.length,
  });
  const sourceHash = (name) => {
    const entry = entries.get(`sources/${name}`);
    assert.ok(entry, `Missing frozen source: ${name}`);
    return entry.sha256;
  };
  for (const row of summary.runs) {
    assert.ok(entries.has(row.file));
    const report = JSON.parse(gunzipSync(await readFile(join(root, row.file))));
    assert.equal(report.collector.type, 'independent-process');
    assert.equal(report.kind, 'asr-resource-benchmark');
    assert.deepEqual(report.host, summary.host);
    assert.deepEqual(report.runtimeVersions, summary.runtimeVersions);
    for (const [name, hash] of Object.entries(report.sources)) assert.equal(sourceHash(name), hash);
    const phase = (name) => report.phases.find((p) => p.name === name);
    assert.equal(row.loadMs, phase('load-model').wallMs);
    assert.equal(row.loadCpuSeconds, phase('load-model').cpuSeconds);
    assert.equal(row.residentIdleCpuSeconds, phase('idle-resident').cpuSeconds);
    assert.equal(row.releasedIdleCpuSeconds, phase('idle-released').cpuSeconds);
    assert.equal(row.residentWorkingSetBytes, phase('idle-resident').workingSetBytesAfter);
    assert.equal(row.releasedWorkingSetBytes, phase('idle-released').workingSetBytesAfter);
    assert.equal(
      row.maximumSamplingGapMs,
      Math.max(...report.samples.slice(1).map((s, i) => s.at - report.samples[i].at)),
    );
    assert.equal(
      row.compileCacheBytes,
      report.cache.afterInference.reduce((n, f) => n + f.bytes, 0),
    );
    const recomputed = demandModel(report);
    assert.equal(row.cpuSeconds, recomputed.totalCpuSeconds);
    assert.equal(row.cpuDemand200MsP99, recomputed.windows[200].coreEquivalent.p99);
    assert.equal(row.cpuDemand200MsPeak, recomputed.windows[200].coreEquivalent.max);
    for (const language of row.languages) {
      const utterances = report.transcriptions.filter((t) => t.language === language);
      assert.equal(utterances.length, 3);
      assert.deepEqual(
        row.transcriptions[language].text,
        utterances.map((t) => t.text),
      );
      assert.equal(row.transcriptions[language].firstMs, phase(`transcribe/${language}/0`).wallMs);
      assert.equal(
        row.transcriptions[language].warmMs,
        median([1, 2].map((i) => phase(`transcribe/${language}/${i}`).wallMs)),
      );
      assert.equal(
        row.transcriptions[language].firstCpuSeconds,
        phase(`transcribe/${language}/0`).cpuSeconds,
      );
      assert.equal(
        row.transcriptions[language].warmCpuSeconds,
        median([1, 2].map((i) => phase(`transcribe/${language}/${i}`).cpuSeconds)),
      );
    }
  }
  for (const group of summary.groups) {
    const rows = summary.runs.filter(
      (row) => `${row.engine}/${row.device}/${row.mode}/${row.languages.join('+')}` === group.key,
    );
    assert.equal(rows.length, group.runs);
    for (const [key, value] of Object.entries(group)) {
      if (key === 'key' || key === 'runs' || key === 'transcriptions') continue;
      assert.deepEqual(value, stats(rows.map((row) => row[key])), `${group.key}/${key}`);
    }
    for (const [language, fields] of Object.entries(group.transcriptions))
      for (const [name, value] of Object.entries(fields))
        assert.deepEqual(value, stats(rows.map((row) => row.transcriptions[language][name])));
  }
  const protocol = JSON.parse(
    await readFile(join(root, 'evidence/asr-lifecycle-native-round3.json'), 'utf8'),
  );
  for (const [name, hash] of Object.entries(protocol.sources)) assert.equal(sourceHash(name), hash);
  assert.equal(protocol.workers.length, 2);
  assert.equal(protocol.workers[0].events.filter((e) => e.event === 'loaded').length, 1);
  assert.equal(protocol.sessions.length, 3);
  assert.ok(protocol.sessions[1].stopRequested && protocol.sessions[1].text.length > 3);
  assert.ok(protocol.idleAfterDoneMs >= 29500 && protocol.idleAfterDoneMs <= 35000);
  console.log(
    JSON.stringify({
      passed: true,
      archive: root,
      reports: summary.reportCount,
      groups: summary.groups.length,
      verifiedArtifacts: entries.size,
      protocolSessions: protocol.sessions.length,
    }),
  );
}
