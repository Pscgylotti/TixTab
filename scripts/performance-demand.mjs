/** CPU-only partial demand model. Deliberately does not invent energy or GPU/NPU counters. */
export function quantiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? null,
  };
}

export function cpuIntervals(samples) {
  const ordered = [...samples].sort((a, b) => a.at - b.at);
  return ordered.slice(1).flatMap((end, i) => {
    const start = ordered[i];
    if (end.at <= start.at) return [];
    const previous = new Map(start.processes.map((p) => [p.pid, p]));
    let cpuSeconds = 0,
      unmatched = 0;
    for (const p of end.processes) {
      const before = previous.get(p.pid),
        a = before?.cpu.cumulativeCPUUsage,
        b = p.cpu.cumulativeCPUUsage;
      if (typeof a !== 'number' || typeof b !== 'number' || b < a) {
        unmatched++;
        continue;
      }
      cpuSeconds += b - a;
      previous.delete(p.pid);
    }
    unmatched += previous.size;
    return [{ start: start.at, end: end.at, cpuSeconds, unmatched, phase: end.phase }];
  });
}

/** Initialize Windows' asynchronous process counters before the task window.
 * Preserve every warmup reading; any later anomaly still invalidates a run.
 */
export async function primeCpuCounters(read, wait, { intervalMs = 200, maxReads = 26 } = {}) {
  const samples = [];
  let stablePairs = 0;
  for (let i = 0; i < maxReads; i++) {
    if (i) await wait(intervalMs);
    samples.push(await read());
    if (samples.length < 2) continue;
    const pair = samples.slice(-2);
    const identities = (sample) => sample.processes.map((p) => `${p.pid}:${p.creationTime}`).sort();
    const deltas = cpuIntervals(pair);
    const stable =
      pair.every((s) => s.processes.length > 0) &&
      JSON.stringify(identities(pair[0])) === JSON.stringify(identities(pair[1])) &&
      pair.every((s) => s.processes.every((p) => Number.isFinite(p.cpu.cumulativeCPUUsage))) &&
      deltas.length === 1 &&
      deltas[0].unmatched === 0;
    stablePairs = stable ? stablePairs + 1 : 0;
    if (stablePairs === 2) return { schema: 1, intervalMs, maxReads, stablePairs, samples };
  }
  throw Error(`Process counters did not initialize: ${JSON.stringify(samples)}`);
}

export function demandWindows(intervals, windowMs, logicalProcessors) {
  if (!intervals.length) return [];
  const origin = intervals[0].start,
    end = intervals.at(-1).end,
    windows = [];
  for (let start = origin; start < end; start += windowMs) {
    const stop = Math.min(end, start + windowMs);
    let seconds = 0,
      coveredMs = 0;
    for (const interval of intervals) {
      const overlap = Math.max(0, Math.min(stop, interval.end) - Math.max(start, interval.start));
      if (!overlap) continue;
      seconds += (interval.cpuSeconds * overlap) / (interval.end - interval.start);
      coveredMs += overlap;
    }
    windows.push({
      start,
      end: stop,
      coveredMs,
      cpuSeconds: seconds,
      coreEquivalent: coveredMs ? (seconds * 1000) / coveredMs : null,
      machinePercent: coveredMs ? (seconds * 100000) / coveredMs / logicalProcessors : null,
    });
  }
  return windows;
}

export function demandModel(report) {
  const intervals = cpuIntervals(report.samples),
    elapsedMs = intervals.length ? intervals.at(-1).end - intervals[0].start : 0,
    totalCpuSeconds = intervals.reduce((sum, row) => sum + row.cpuSeconds, 0);
  const windows = Object.fromEntries(
    [200, 1000].map((ms) => {
      const values = demandWindows(intervals, ms, report.host.logicalProcessors);
      return [
        ms,
        {
          coreEquivalent: quantiles(values.map((v) => v.coreEquivalent)),
          aboveOneCoreMs: values
            .filter((v) => v.coreEquivalent > 1)
            .reduce((n, v) => n + v.coveredMs, 0),
          values,
        },
      ];
    }),
  );
  return {
    elapsedMs,
    totalCpuSeconds,
    averageCoreEquivalent: elapsedMs ? (totalCpuSeconds * 1000) / elapsedMs : null,
    partialDemand: {
      cpuCoefficient: 1,
      value: totalCpuSeconds,
      unit: 'CPU-seconds',
      calibrated: false,
    },
    energyJoules: null,
    gpuActiveSeconds: null,
    npuActiveSeconds: null,
    ioBytes: null,
    memoryTransferBytes: null,
    wakeups: null,
    samplingGapMs: quantiles(intervals.map((v) => v.end - v.start)),
    collectorMs: quantiles(report.samples.map((v) => v.collectMs)),
    unmatchedProcessIntervals: intervals.filter((v) => v.unmatched).length,
    windows,
    explanation:
      'D = a*CPU + b*GPU-active + c*NPU-active + d*memory-transfer + e*I/O + f*wakeups. Only CPU time is observed here; missing terms stay null. This partial D is not joules. Window demand assumes uniform CPU use within each actual sampling interval; 200 ms windows do not recover sub-interval peaks, and 50 ms peaks are not reported. Includes measured inter-phase gaps and idle tails; exited/short-lived processes can be undercounted. Working-set sums are not unique physical memory. Whole-device power, thermal state and non-Electron model children are not measured by this harness.',
  };
}

export function requireComparable(reports) {
  const first = reports[0];
  if (!first) throw Error('No reports');
  for (const report of reports) {
    if (
      !/^[a-f0-9]{64}$/.test(report.harnessSha256 ?? '') ||
      !/^[a-f0-9]{64}$/.test(report.buildSha256 ?? '') ||
      !/^[a-f0-9]{64}$/.test(report.fixture?.sha256 ?? '') ||
      !report.samples?.length
    )
      throw Error(`${report.label}: missing measured samples or provenance`);
    if (report.errors.length) throw Error(`${report.label}: renderer errors`);
    if (report.completionGate) {
      if (report.completionGate.schema !== 1 || report.completionGate.enabled !== true)
        throw Error(`${report.label}: invalid completion gate`);
      for (const row of report.rows) {
        if (row.completionAfter?.pending !== 0 || !row.completionAfter?.stages)
          throw Error(`${report.label}: unfinished completion phase ${row.name}`);
        if (
          Object.values(row.completionAfter.stages).some((stage) => stage.failed || stage.pending)
        )
          throw Error(`${report.label}: failed/pending completion work in ${row.name}`);
        if (row.name !== 'idle-before' && !row.checkpoints?.length)
          throw Error(`${report.label}: missing completion checkpoint ${row.name}`);
        for (const checkpoint of row.checkpoints ?? [])
          if (
            checkpoint.ledger?.pending !== 0 ||
            checkpoint.quietMs !== report.completionGate.quietMs
          )
            throw Error(`${report.label}: invalid completion checkpoint ${row.name}`);
      }
    }
    for (const [name, value] of Object.entries({
      harness: report.harnessSha256 === first.harnessSha256,
      completionGate:
        JSON.stringify(report.completionGate) === JSON.stringify(first.completionGate),
      fixture: JSON.stringify(report.fixture) === JSON.stringify(first.fixture),
      visualPolicy: JSON.stringify(report.visuals) === JSON.stringify(first.visuals),
      cpu:
        report.host.cpu === first.host.cpu &&
        report.host.logicalProcessors === first.host.logicalProcessors,
      phases:
        JSON.stringify(report.rows.map((r) => r.name)) ===
        JSON.stringify(first.rows.map((r) => r.name)),
    }))
      if (!value) throw Error(`${report.label}: incompatible ${name}`);
  }
}
