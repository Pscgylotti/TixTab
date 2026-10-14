import { cpuIntervals, quantiles } from './performance-demand.mjs';

/** Align observed process CPU on wall time; concurrent coverage is not the denominator. */
export function jointDemand(sources) {
  const tagged = sources.flatMap(({ name, report }) => {
    if (
      !Number.isFinite(report.clock?.timeOriginUnixMs) ||
      !Number.isFinite(report.clock.wallOffsetAtEndMs) ||
      Math.abs(report.clock.wallOffsetAtEndMs) > 5
    )
      throw Error(`Missing or unstable clock alignment for ${name}`);
    const origin = report.clock.timeOriginUnixMs;
    return cpuIntervals(report.samples).map((row) => ({
      ...row,
      source: name,
      start: origin + row.start,
      end: origin + row.end,
    }));
  });
  if (!tagged.length) throw Error('No measured intervals');
  const origin = Math.min(...tagged.map((row) => row.start));
  const end = Math.max(...tagged.map((row) => row.end));
  const windows = Object.fromEntries(
    [200, 1000].map((width) => {
      const values = [];
      for (let start = origin; start < end; start += width) {
        const stop = Math.min(start + width, end),
          coverage = {};
        let cpuSeconds = 0;
        for (const interval of tagged) {
          const overlap = Math.max(
            0,
            Math.min(stop, interval.end) - Math.max(start, interval.start),
          );
          if (!overlap) continue;
          cpuSeconds += (interval.cpuSeconds * overlap) / (interval.end - interval.start);
          coverage[interval.source] = (coverage[interval.source] || 0) + overlap;
        }
        values.push({
          start: start - origin,
          end: stop - origin,
          cpuSeconds,
          coreEquivalent: (cpuSeconds * 1000) / (stop - start),
          coverage,
        });
      }
      return [
        width,
        { coreEquivalent: quantiles(values.map((row) => row.coreEquivalent)), values },
      ];
    }),
  );
  return {
    originUnixMs: origin,
    elapsedMs: end - origin,
    cpuSeconds: tagged.reduce((sum, row) => sum + row.cpuSeconds, 0),
    unmatchedProcessIntervals: tagged.filter((row) => row.unmatched).length,
    windows,
    energyJoules: null,
    gpuActiveSeconds: null,
    npuActiveSeconds: null,
    limitations: [
      'Observed Electron processes plus inference Python; excludes OS/driver, coordinator and collector CPU.',
      'Wall clocks anchored to monotonic sample origins; >5 ms observed clock drift rejects alignment.',
      '200 ms/1 s windows interpolate actual CPU samples; cannot recover shorter spikes.',
      'No samples outside each process measurement window; bootstrap and serialization can be unmeasured.',
      'Partial CPU demand, not watts, joules, whole-system energy, or battery life.',
    ],
  };
}

export function inferenceOverlap(pdf, asr, phaseName) {
  const samples = pdf.samples.filter((sample) => sample.phase === phaseName);
  if (!samples.length) throw Error(`Missing PDF phase ${phaseName}`);
  const start = pdf.clock.timeOriginUnixMs + samples[0].at;
  const end = pdf.clock.timeOriginUnixMs + samples.at(-1).at;
  const tasks = asr.phases.filter((phase) => phase.name.startsWith('transcribe/'));
  return tasks.reduce(
    (sum, task) =>
      sum +
      Math.max(
        0,
        Math.min(end, asr.clock.timeOriginUnixMs + task.endMs) -
          Math.max(start, asr.clock.timeOriginUnixMs + task.startMs),
      ),
    0,
  );
}
