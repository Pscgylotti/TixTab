import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { jointDemand, inferenceOverlap } from './joint-demand.mjs';
import { requireComparable, cpuIntervals } from './performance-demand.mjs';

const { values } = parseArgs({
  options: {
    backend: { type: 'string' },
    'app-dir': { type: 'string' },
    output: { type: 'string' },
    label: { type: 'string' },
  },
});
if (!values.backend || !values['app-dir'] || !values.output || !values.label)
  throw Error(
    'Supply --backend FROZEN_BACKEND --app-dir FROZEN_UI --output NEW_JSON --label LABEL',
  );
const output = resolve(values.output),
  prefix = output.replace(/\.json$/, '');
if (prefix === output) throw Error('Output must end in .json');
await mkdir(dirname(output), { recursive: true });
for (const path of [output, prefix + '.pdf.json', prefix + '.asr.json']) {
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists) throw Error('Never overwrite a measured job: ' + path);
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceNames = [
  'scripts/benchmark-ai-workflow.mjs',
  'scripts/benchmark-workflow.mjs',
  'scripts/benchmark-asr.py',
  'scripts/performance-demand.mjs',
  'scripts/performance-settle.mjs',
  'scripts/joint-demand.mjs',
];
const sources = async () =>
  Object.fromEntries(
    await Promise.all(sourceNames.map(async (name) => [name, hash(await readFile(name))])),
  );
const before = await sources();
const children = [];
let asrPromise;
function launch(exe, args, name, onLine) {
  const child = spawn(exe, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  children.push(child);
  let log = '',
    buffer = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    log += text;
    buffer += text;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (onLine) {
        try {
          onLine(JSON.parse(line));
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }
  });
  child.stderr.on('data', (chunk) => (log += chunk.toString('utf8')));
  return new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      try {
        await writeFile(prefix + '.' + name + '.log', log, { flag: 'wx' });
        if (code !== 0) reject(Error(`${name} exited ${code}/${signal}: ${log.slice(-1500)}`));
        else done();
      } catch (error) {
        reject(error);
      }
    });
  });
}
const killOwned = () => {
  for (const child of children)
    if (child.exitCode === null && child.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {}
    }
};
const timer = setTimeout(killOwned, 120000);
try {
  const pdfPromise = launch(
    process.execPath,
    [
      'scripts/benchmark-workflow.mjs',
      '--app-dir',
      resolve(values['app-dir']),
      '--output',
      prefix + '.pdf.json',
      '--label',
      values.label,
    ],
    'pdf',
    (row) => {
      if (row.name === 'idle-before' && !asrPromise) {
        asrPromise = launch(
          join(process.env.USERPROFILE, '.surfacetab/asr-runtime/Scripts/python.exe'),
          [
            'scripts/benchmark-asr.py',
            '--engine',
            'sensevoice-small',
            '--device',
            'CPU',
            '--language',
            'zh-CN',
            '--mode',
            'cold',
            '--backend-root',
            resolve(values.backend),
            '--samples',
            resolve('.cache/asr-round3-samples'),
            '--cache-root',
            resolve('.cache/ai-workflow-isolated-cache'),
            '--repeats',
            '10',
            '--between-seconds',
            '1',
            '--idle-seconds',
            '10',
            '--output',
            prefix + '.asr.json',
          ],
          'asr',
        );
        // Observe an early backend failure before the PDF process finishes.
        asrPromise.catch(() => {});
      }
    },
  );
  await pdfPromise;
  assert.ok(asrPromise, 'PDF workflow never reached its measured idle checkpoint');
  await asrPromise;
  const pdf = JSON.parse(await readFile(prefix + '.pdf.json', 'utf8'));
  const asr = JSON.parse(await readFile(prefix + '.asr.json', 'utf8'));
  requireComparable([pdf]);
  for (const [name, report] of [
    ['pdf', pdf],
    ['asr', asr],
  ])
    assert.equal(
      cpuIntervals(report.samples).filter((interval) => interval.unmatched).length,
      0,
      `${name}: process churn left incomplete CPU intervals; retain component evidence and reject run`,
    );
  assert.equal(asr.actualDevice, 'CPU');
  assert.equal(asr.fallback, '');
  assert.equal(asr.transcriptions.length, 10);
  assert.ok(asr.transcriptions.every((row) => row.text.length > 3));
  const overlap = Object.fromEntries(
    ['continuous-scroll-roundtrip', 'facing-zoom'].map((name) => [
      name,
      inferenceOverlap(pdf, asr, name),
    ]),
  );
  for (const [name, ms] of Object.entries(overlap))
    assert.ok(ms > 0, `No actual inference overlap with ${name}`);
  assert.deepEqual(await sources(), before, 'Measured harness changed while running');
  const result = {
    schema: 1,
    kind: 'ai-workflow-resource-benchmark',
    label: values.label,
    createdAt: new Date().toISOString(),
    sources: before,
    pdf,
    asr,
    inferenceOverlapMs: overlap,
    demand: jointDemand([
      { name: 'pdf', report: pdf },
      { name: 'asr', report: asr },
    ]),
    limitations: [
      'Synthetic PDF pointer workflow with real frozen ASR model calls on authored WAVs; no live microphone or ASR UI IPC.',
      'Ten complete transcriptions, intermittent waits, explicit model release and released-idle tail included.',
      'Same UI build in both policies; real energy, hardware GPU/NPU activity and OS/driver processes unmeasured.',
    ],
  };
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(
    JSON.stringify({
      output,
      label: values.label,
      cpuSeconds: result.demand.cpuSeconds,
      elapsedMs: result.demand.elapsedMs,
      inferenceOverlapMs: overlap,
      passed: true,
    }),
  );
} catch (error) {
  killOwned();
  throw error;
} finally {
  clearTimeout(timer);
}
