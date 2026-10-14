import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { frameBudgetRows } from './trace-frame-budget.mjs';
import { quantiles, requireComparable } from './performance-demand.mjs';
const { values } = parseArgs({
  options: {
    trace: { type: 'string' },
    report: { type: 'string' },
    runtime: { type: 'string' },
    phase: { type: 'string' },
    output: { type: 'string' },
  },
});
for (const key of ['trace', 'report', 'runtime', 'phase', 'output']) assert(values[key], key);
const hash = (b) => createHash('sha256').update(b).digest('hex');
const traceBytes = await readFile(values.trace),
  reportBytes = await readFile(values.report);
const { traceEvents: events } = JSON.parse(traceBytes),
  report = JSON.parse(reportBytes);
requireComparable([report]);
assert.equal(resolve(report.tracePath), resolve(values.trace));
const start = events.find((e) => e.name === `workflow:${values.phase}:start`),
  end = events.find((e) => e.name === `workflow:${values.phase}:end`);
assert(start && end && end.ts > start.ts && start.pid === end.pid && start.tid === end.tid);
const files = new Map(),
  root = resolve(values.runtime);
for (const [file, h] of report.buildManifest) {
  const path = resolve(root, file),
    r = relative(root, path);
  assert(r && !r.startsWith('..') && !isAbsolute(r));
  const bytes = await readFile(path);
  assert.equal(hash(bytes), h, file);
  if (file.endsWith('.js'))
    files.set(file, { sha256: h, lines: bytes.toString('utf8').split('\n') });
}
const mappings = new Map();
const classify = (data) => {
  if (!data?.url?.startsWith('surfacetab://app/')) return null;
  const file = 'dist/' + new URL(data.url).pathname.slice(1),
    source = files.get(file);
  if (!source) return null;
  const line = data.lineNumber - 1,
    column = data.columnNumber - 1;
  const excerpt = source.lines[line]?.slice(column, column + 160) ?? '';
  const kind =
    excerpt.startsWith('()=>{this.') &&
    excerpt.slice(0, 90).includes('_nextBound().catch(this._cancelBound)')
      ? 'pdf'
      : excerpt.startsWith('()=>{') &&
          excerpt.includes('.flushSync(') &&
          excerpt.includes('for(const')
        ? 'foreground'
        : null;
  if (!kind) return null;
  const mapping = {
    kind,
    file,
    sha256: source.sha256,
    line: data.lineNumber,
    column: data.columnNumber,
    excerpt,
  };
  mappings.set(`${file}:${line}:${column}`, mapping);
  return mapping;
};
const rows = frameBudgetRows(events, start, end, classify);
const frames = rows.filter((r) => r.rafCount),
  pdf = frames.filter((r) => r.pdfCallbacks);
const summary = {
  phase: values.phase,
  rootCount: rows.length,
  rafRoots: frames.length,
  pdfRoots: pdf.length,
  multiplePdfRoots: pdf.filter((r) => r.pdfCallbacks > 1).length,
  maxPdfCallbacks: Math.max(0, ...pdf.map((r) => r.pdfCallbacks)),
  pdfWithForegroundRoots: pdf.filter((r) => r.foregroundCallbacks).length,
  pdfRootWallMs: quantiles(pdf.map((r) => r.rootWallMs)),
  pdfRafUnionMs: quantiles(pdf.map((r) => r.pdfRafUnionMs)),
  topRoots: rows.slice(0, 12),
};
await writeFile(
  values.output,
  JSON.stringify(
    {
      schema: 1,
      summary,
      mappings: [...mappings.values()],
      traceSha256: hash(traceBytes),
      reportSha256: hash(reportBytes),
      buildSha256: report.buildSha256,
      harnessSha256: hash(await readFile(new URL(import.meta.url))),
      helperSha256: hash(await readFile(new URL('./trace-frame-budget.mjs', import.meta.url))),
      intervalsSha256: hash(await readFile(new URL('./trace-intervals.mjs', import.meta.url))),
      limits:
        'One profiled trace; counts native RAF callbacks inside renderer RunTask spans, not presentation timestamps or CPU/energy. Callback identity requires a literal match at its frozen one-based source location. Category unions can overlap and must not be summed. Nested roots own callbacks once. Tracing overhead remains; compare untraced resources separately.',
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    ...summary,
    topRoots: summary.topRoots.slice(0, 4).map(({ callbacks, ...r }) => r),
    mappings: [...mappings.values()],
  }),
);
