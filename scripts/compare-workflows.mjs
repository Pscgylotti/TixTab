import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { demandModel, quantiles, requireComparable } from './performance-demand.mjs';

const { values } = parseArgs({
  options: {
    baseline: { type: 'string', multiple: true },
    candidate: { type: 'string', multiple: true },
    output: { type: 'string', default: '.cache/performance-comparison.json' },
  },
});
if (!values.baseline?.length || !values.candidate?.length)
  throw Error('Supply --baseline and --candidate report paths (repeat for multiple runs).');
const read = async (paths) =>
  Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(path);
      return JSON.parse((path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
    }),
  );
const baseline = await read(values.baseline),
  candidate = await read(values.candidate);
requireComparable([...baseline, ...candidate]);
for (const group of [baseline, candidate])
  if (new Set(group.map((r) => r.buildSha256)).size !== 1)
    throw Error('Each A/B group must use one identical build; compare revisions separately.');
const summarize = (reports) => ({
  runs: reports.map((r) => ({
    label: r.label,
    createdAt: r.createdAt,
    buildSha256: r.buildSha256,
    demand: demandModel(r),
  })),
  cpuSeconds: quantiles(reports.map((r) => demandModel(r).totalCpuSeconds)),
  elapsedMs: quantiles(reports.map((r) => demandModel(r).elapsedMs)),
  phases: baseline[0].rows.map((r) => {
    const rows = reports.map((report) => report.rows.find((row) => row.name === r.name));
    return {
      name: r.name,
      cpuSeconds: quantiles(rows.map((r) => r.cpuSeconds)),
      wallMs: quantiles(rows.map((r) => r.wallMs)),
      mainThreadSeconds: quantiles(rows.map((r) => r.mainThreadSeconds)),
      frameP95Ms: quantiles(rows.map((r) => r.framesMs.p95)),
      frameP99Ms: quantiles(rows.map((r) => r.framesMs.p99)),
      frameMaxMs: quantiles(rows.map((r) => r.framesMs.max)),
      longTasksMaxMs: quantiles(rows.map((r) => r.longTasksMs.max)),
    };
  }),
});
const report = {
  schema: 1,
  createdAt: new Date().toISOString(),
  source: { baseline: values.baseline, candidate: values.candidate },
  baseline: summarize(baseline),
  candidate: summarize(candidate),
  notes: [
    'Median and range are descriptive; few runs do not establish statistical significance.',
    'CPU demand reduction does not prove power or energy reduction.',
    baseline[0].completionGate
      ? 'All phases contain completion snapshots and checkpoints for tracked application work, including after restore. This is not a GPU fence or a whole-system idle/energy measurement.'
      : 'Legacy workflow uses fixed settling waits and a five-second idle tail; these do not prove delayed work completion.',
  ],
};
const change = (a, b) => (a ? `${((b / a - 1) * 100).toFixed(1)}%` : 'n/a');
const number = (n) => (n === null ? 'n/a' : n.toFixed(3));
const markdown = [
  '# 渲染工作流资源对比',
  '',
  `基线 ${baseline.length} 轮，候选 ${candidate.length} 轮。固定样本、画质、窗口及脚本；下表为各轮中位数，原始采样与构建哈希见 JSON。`,
  '',
  `整段 CPU 时间：${number(report.baseline.cpuSeconds.p50)} → ${number(report.candidate.cpuSeconds.p50)} 秒（${change(report.baseline.cpuSeconds.p50, report.candidate.cpuSeconds.p50)}）。含测得的阶段间隙和空闲尾部。`,
  '',
  '| 操作 | CPU 秒 A → B | 变化 | 帧间隔 P95 ms A → B | P99 ms A → B |',
  '| --- | --- | --- | --- | --- |',
  ...report.baseline.phases.map((a, i) => {
    const b = report.candidate.phases[i];
    return `| ${a.name} | ${number(a.cpuSeconds.p50)} → ${number(b.cpuSeconds.p50)} | ${change(a.cpuSeconds.p50, b.cpuSeconds.p50)} | ${number(a.frameP95Ms.p50)} → ${number(b.frameP95Ms.p50)} | ${number(a.frameP99Ms.p50)} → ${number(b.frameP99Ms.p50)} |`;
  }),
  '',
  '需求模型为 CPU 部分代理，未校准为焦耳。GPU 进程 CPU 时间不代表 GPU 硬件活跃时间。200 ms/1 s 窗口按实际采样间隔均摊，不宣称捕捉到 50 ms 尖峰。未获得可靠整机功率，不能据此声称省电百分比。',
  '',
  baseline[0].completionGate
    ? '当前样本是合成的重负载文档。每阶段带应用任务完成门槛（含恢复后补绘/保存），不会将未完成的已跟踪任务计为就绪；仍不是 GPU 完成栅栏或整机空闲证明。实际笔延迟、扫描 PDF、其它对象操作、模型并发和更长周期仍需验收。'
    : '旧数据使用 1.2 s 静置和 5 s 尾部，不能单独证明异步队列已完成；不要与带任务完成门槛的新数据混用。',
  '',
].join('\n');
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
await writeFile(output.replace(/\.json$/, '') + '.md', markdown);
console.log(markdown);
