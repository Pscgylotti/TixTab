import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performanceFixture, readPerformanceFixture } from './performance-fixture.mjs';
import { waitForPerformanceSettled } from './performance-settle.mjs';
import { primeCpuCounters } from './performance-demand.mjs';
import { objectWorkflow } from './object-workflow.mjs';

const { values } = parseArgs({
  options: {
    executable: { type: 'string' },
    'app-dir': { type: 'string' },
    output: { type: 'string', default: '.cache/performance-workflow.json' },
    label: { type: 'string', default: 'baseline' },
    strokes: { type: 'string', default: '3000' },
    'fixture-file': { type: 'string' },
    'night-reading': { type: 'boolean', default: false },
    'object-editing': { type: 'boolean', default: false },
    'reading-scale-cycles': { type: 'boolean', default: false },
    trace: { type: 'boolean', default: false },
  },
});
const fixture = values['fixture-file']
  ? await readPerformanceFixture(values['fixture-file'])
  : await performanceFixture({ strokes: Number(values.strokes) });
const profile = await mkdtemp(join(tmpdir(), 'tixtab-perf-'));
// Real disk-backed File objects avoid a large DevTools/base64 transfer inside
// the import phase. File reading, parsing, persistence and rendering stay measured.
const fixturePath = values['fixture-file']
  ? resolve(values['fixture-file'])
  : join(profile, 'performance.tixtab');
if (!values['fixture-file']) await writeFile(fixturePath, fixture.bytes, { flag: 'wx' });
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
const app = await electron.launch({
  ...(values.executable
    ? { executablePath: resolve(values.executable), args: [] }
    : { args: [values['app-dir'] ?? '.'] }),
  env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
  timeout: 60000,
});
const rows = [],
  samples = [],
  errors = [];
let sampling = false,
  sampleTimer,
  phaseName = 'setup';
const percentiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? null,
  };
};
let page,
  cdp,
  counterWarmup,
  checkpoints = [];
const sample = async () => {
  const before = performance.now();
  const processes = await app.evaluate(({ app }) => app.getAppMetrics());
  samples.push({
    at: performance.now(),
    phase: phaseName,
    collectMs: performance.now() - before,
    processes,
  });
};
const metrics = async () =>
  Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]),
  );
const phase = async (name, action) => {
  phaseName = name;
  checkpoints = [];
  const completionBefore = await page.evaluate(() => window.tixtabPerformance.snapshot());
  await sample();
  const first = samples.length - 1,
    before = await metrics(),
    started = performance.now();
  await page.evaluate(
    ({ capture, name }) => {
      window.qaPerf.stopFrames();
      window.qaPerf.frames = [];
      window.qaPerf.longTasks = [];
      window.qaPerf.startedAt = performance.now();
      performance.mark(`workflow:${name}:start`);
      window.qaPerf.captureFrames = capture;
      if (capture) window.qaPerf.startFrames();
    },
    { capture: !name.includes('idle'), name },
  );
  await action();
  await page.evaluate((name) => performance.mark(`workflow:${name}:end`), name);
  const ended = performance.now(),
    after = await metrics();
  await sample();
  const ui = await page.evaluate(() => ({
    frames: window.qaPerf.frames,
    longTasks: window.qaPerf.longTasks,
  }));
  const slice = samples.slice(first);
  const cpuByPid = new Map();
  for (const s of slice)
    for (const p of s.processes) {
      const cumulative = p.cpu.cumulativeCPUUsage;
      if (typeof cumulative !== 'number') continue;
      const range = cpuByPid.get(p.pid) ?? { type: p.type, start: cumulative, end: cumulative };
      range.end = cumulative;
      cpuByPid.set(p.pid, range);
    }
  const row = {
    name,
    wallMs: ended - started,
    cpuSeconds: [...cpuByPid.values()].reduce((sum, p) => sum + Math.max(0, p.end - p.start), 0),
    cpuByType: Object.fromEntries(
      [...new Set([...cpuByPid.values()].map((p) => p.type))].map((type) => [
        type,
        [...cpuByPid.values()]
          .filter((p) => p.type === type)
          .reduce((sum, p) => sum + Math.max(0, p.end - p.start), 0),
      ]),
    ),
    sampledCpuPercent: percentiles(
      slice.slice(1).map((s) => s.processes.reduce((sum, p) => sum + p.cpu.percentCPUUsage, 0)),
    ),
    memoryWorkingSetKbPeak: Math.max(
      ...slice.map((s) => s.processes.reduce((sum, p) => sum + p.memory.workingSetSize, 0)),
    ),
    mainThreadSeconds: after.TaskDuration - before.TaskDuration,
    scriptSeconds: after.ScriptDuration - before.ScriptDuration,
    layoutSeconds: after.LayoutDuration - before.LayoutDuration,
    styleSeconds: after.RecalcStyleDuration - before.RecalcStyleDuration,
    framesMs: percentiles(ui.frames),
    longTasksMs: percentiles(ui.longTasks),
    completionBefore,
    completionAfter: await page.evaluate(() => window.tixtabPerformance.snapshot()),
    checkpoints,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
};
const waitSettled = async () => {
  const result = await waitForPerformanceSettled(page);
  checkpoints.push(result);
  return result;
};
const click = (name) => page.getByRole('button', { name, exact: true }).click();
try {
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  // Fix visual policy independently from actual AC/battery state before any measured work.
  await page.evaluate(() => {
    localStorage.setItem('surfacetab.powerMode', 'quality');
    localStorage.setItem('surfacetab.renderQuality', 'high');
    localStorage.setItem('surfacetab.night', 'false');
    localStorage.setItem('tixtab.performance.enabled', 'true');
  });
  await page.reload();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
  );
  cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.evaluate(() => {
    window.qaPerf = { frames: [], longTasks: [], running: true, captureFrames: false };
    let previous = performance.now(),
      handle = 0;
    const tick = (now) => {
      if (!window.qaPerf.running || !window.qaPerf.captureFrames) return;
      window.qaPerf.frames.push(now - previous);
      previous = now;
      handle = requestAnimationFrame(tick);
    };
    window.qaPerf.startFrames = () => {
      previous = performance.now();
      handle = requestAnimationFrame(tick);
    };
    window.qaPerf.stopFrames = () => cancelAnimationFrame(handle);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.startTime >= window.qaPerf.startedAt)
          window.qaPerf.longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
  if (values.trace)
    await app.evaluate(async ({ contentTracing }) =>
      contentTracing.startRecording({
        included_categories: [
          'toplevel',
          'devtools.timeline',
          'disabled-by-default-devtools.timeline',
          'blink.user_timing',
          'v8',
          'disabled-by-default-v8.cpu_profiler',
          'cc',
          'gpu',
          'electron',
        ],
      }),
    );
  // Application startup is outside this interactive workflow. Finish its tracked
  // work and initialize asynchronous process counters before idle-before/import.
  // Archive the warmup separately; never repair/discard a measured interval.
  await waitSettled();
  counterWarmup = await primeCpuCounters(
    async () => ({
      processes: await app.evaluate(({ app }) => app.getAppMetrics()),
      at: performance.now(),
    }),
    (ms) => page.waitForTimeout(ms),
  );
  sampling = true;
  const schedule = async () => {
    if (!sampling) return;
    try {
      await sample();
    } catch {}
    if (sampling) sampleTimer = setTimeout(schedule, 200);
  };
  await schedule();
  await waitSettled();
  await phase('idle-before', () => page.waitForTimeout(2500));
  await phase('import-mixed-document', async () => {
    await page.locator('input[accept=".pdf,.tixtab"]').setInputFiles(fixturePath);
    await expect(page.locator('.sidebar-heading .count')).toHaveText(
      String(fixture.description.pages),
    );
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await click('适合页面');
    await waitSettled();
  });
  const objectDownloads = values['object-editing']
    ? await objectWorkflow({
        app,
        destinations: {
          project: join(profile, 'objects.tixtab'),
          pdf: join(profile, 'objects.pdf'),
        },
        page,
        phase,
        waitSettled,
        click,
        fixture,
      })
    : [];
  const pen = async (count, eraser = false) => {
    await page
      .locator('.page-editor')
      .first()
      .evaluate(
        async (el, { count, eraser }) => {
          el.setPointerCapture = () => {};
          const r = el.getBoundingClientRect(),
            frame = () => new Promise(requestAnimationFrame);
          for (let i = 0; i < count; i++) {
            const base = {
              bubbles: true,
              pointerId: 19,
              pointerType: 'pen',
              button: eraser ? 5 : 0,
              buttons: eraser ? 32 : 1,
              pressure: 0.65,
            };
            const dispatch = (type, j) =>
              el.dispatchEvent(
                new PointerEvent(type, {
                  ...base,
                  clientX: r.x + r.width * (0.12 + j * 0.018),
                  clientY: r.y + r.height * (0.15 + (i % 12) * 0.04 + Math.sin(j) * 0.004),
                }),
              );
            dispatch('pointerdown', 0);
            for (let j = 1; j <= 12; j++) {
              dispatch('pointermove', j);
              if (j % 4 === 0) await frame();
            }
            dispatch('pointerup', 12);
            await frame();
          }
        },
        { count, eraser },
      );
  };
  await phase('write-30-strokes', async () => {
    await click('钢笔');
    await pen(30);
    await waitSettled();
  });
  await phase('erase-8-sweeps', async () => {
    await pen(8, true);
    await waitSettled();
  });
  await phase('undo-redo', async () => {
    for (const key of ['Control+z', 'Control+z', 'Control+y', 'Control+y']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(100);
    }
    await waitSettled();
  });
  await phase('continuous-scroll-roundtrip', async () => {
    await click('连续页面预览');
    await page.locator('.reading-view').evaluate(async (el) => {
      for (const direction of [1, -1])
        for (let i = 0; i < 35; i++) {
          el.scrollTop += direction * 100;
          await new Promise(requestAnimationFrame);
        }
    });
    await waitSettled();
  });
  if (values['night-reading']) {
    await phase('night-page-turn-reading', async () => {
      await page.locator('.reading-view').evaluate((el) => {
        el.scrollTop = 0;
      });
      await waitSettled();
      await click('实验性夜间模式');
      for (let i = 0; i < fixture.description.pages; i++) {
        if (i) await click('下一页');
        await expect(page.locator('.page-navigation > span')).toHaveText(
          new RegExp(`^${i + 1}\\s*/\\s*${fixture.description.pages}$`),
        );
        await waitSettled();
        await expect(
          page.locator(`.reading-card[data-page-index="${i}"] .reading-pdf`),
        ).toHaveAttribute('data-rendered-night', 'true');
      }
      // Restore the original workflow state, including all delayed visible work.
      await click('实验性夜间模式');
      await page.locator('.reading-view').evaluate((el) => {
        el.scrollTop = 0;
      });
      await waitSettled();
    });
  }
  await phase('facing-zoom', async () => {
    await click('双页预览');
    await page.locator('.reading-view').evaluate(async (el) => {
      const r = el.getBoundingClientRect();
      for (const direction of [-1, 1])
        for (let i = 0; i < 8; i++) {
          el.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              ctrlKey: true,
              deltaY: direction * 20,
              clientX: r.x + r.width * 0.5,
              clientY: r.y + r.height * 0.5,
            }),
          );
          await new Promise(requestAnimationFrame);
        }
    });
    await waitSettled();
  });
  if (values['reading-scale-cycles']) {
    await phase('reading-zoom-settle-cycle', async () => {
      // Separate actual pauses from a burst that returns to its initial zoom
      // before the debounce expires. Exercise both same and new pixel buckets.
      for (const zoom of [1.05, 1.1, 1.02, 0.82, 1.08]) {
        await page.locator('.reading-view').evaluate((el, zoom) => {
          const paper = el.querySelector('.reading-paper'),
            content = paper.querySelector('.reading-content'),
            width = parseFloat(content.style.width),
            current = paper.getBoundingClientRect().width / width,
            r = el.getBoundingClientRect();
          el.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              ctrlKey: true,
              deltaY: -Math.log(zoom / current) / 0.008,
              clientX: r.x + r.width / 2,
              clientY: r.y + r.height / 2,
            }),
          );
        }, zoom);
        await waitSettled();
      }
    });
  }
  await phase('night-day-roundtrip', async () => {
    await click('实验性夜间模式');
    await waitSettled();
    await click('实验性夜间模式');
    await waitSettled();
  });
  await phase('formula-edit-and-save', async () => {
    await click('公式');
    const source = page.getByLabel('LaTeX · 可直接修改');
    await expect(source).toBeEnabled();
    await page.locator('.formula-canvas').evaluate((el) => {
      el.setPointerCapture = () => {};
      const r = el.getBoundingClientRect(),
        base = {
          bubbles: true,
          pointerId: 23,
          pointerType: 'pen',
          button: 0,
          buttons: 1,
          pressure: 0.6,
        };
      for (let i = 0; i < 200; i++) {
        const dispatch = (type, j) =>
          el.dispatchEvent(
            new PointerEvent(type, {
              ...base,
              clientX: r.x + (i % 20) * 15 + j * 4,
              clientY: r.y + 20 + Math.floor(i / 20) * 14,
            }),
          );
        dispatch('pointerdown', 0);
        dispatch('pointermove', 2);
        dispatch('pointerup', 3);
      }
    });
    await source.fill('\\int_0^1 x^2 dx = \\frac{1}{3}');
    for (let i = 0; i < 50; i++) {
      await source.press(i % 2 ? 'ArrowRight' : 'ArrowLeft');
    }
    await page
      .getByRole('dialog', { name: '手写公式', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await waitSettled();
  });
  await phase('idle-tail', async () => {
    await page.waitForTimeout(5000);
    await waitSettled();
  });
  await phase('hidden-idle', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await page.waitForTimeout(2500);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await waitSettled();
  });
  sampling = false;
  clearTimeout(sampleTimer);
  await page.evaluate(() => {
    window.qaPerf.running = false;
  });
  const tracePath = values.trace
    ? await app.evaluate(
        async ({ contentTracing }, path) => contentTracing.stopRecording(path),
        output.replace(/\.json$/, '.trace.json'),
      )
    : null;
  // Preserve authored outputs after sampling; reading/hashing them must not
  // compete with measured interactions. The app's serialize/export/download
  // work itself has already completed inside the corresponding phase.
  for (const artifact of objectDownloads) {
    const bytes = await readFile(artifact.path);
    artifact.path =
      output.replace(/\.json$/, '') +
      (artifact.kind === 'project' ? '.objects.tixtab' : '.objects.pdf');
    await writeFile(artifact.path, bytes, { flag: 'wx' });
    artifact.sha256 = createHash('sha256').update(bytes).digest('hex');
    artifact.bytes = bytes.length;
  }
  const visuals = await page.evaluate(() => ({
    dpr: devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    power: localStorage.getItem('surfacetab.powerMode'),
    quality: localStorage.getItem('surfacetab.renderQuality'),
  }));
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const diff = execFileSync('git', ['diff', '--binary'], { maxBuffer: 50_000_000 });
  const executableHash = values.executable
    ? createHash('sha256')
        .update(await readFile(resolve(values.executable)))
        .digest('hex')
    : null;
  const appDirectory = values.executable
    ? dirname(resolve(values.executable))
    : resolve(values['app-dir'] ?? '.');
  const hashFiles = async (directory, prefix = '') => {
    const result = [];
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name),
        name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) result.push(...(await hashFiles(path, `${name}/`)));
      else if (entry.isFile())
        result.push([
          name,
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        ]);
    }
    return result;
  };
  const buildManifest = values.executable
    ? [
        [
          'resources/app.asar',
          createHash('sha256')
            .update(await readFile(join(appDirectory, 'resources/app.asar')))
            .digest('hex'),
        ],
      ]
    : [
        ...(await hashFiles(join(appDirectory, 'dist'), 'dist/')),
        ...(await hashFiles(join(appDirectory, 'electron'), 'electron/')),
      ];
  const report = {
    schema: 1,
    label: values.label,
    createdAt: new Date().toISOString(),
    revision,
    trackedDiffSha256: createHash('sha256').update(diff).digest('hex'),
    executable: values.executable ?? appDirectory,
    executableHash,
    buildManifest,
    buildSha256: createHash('sha256').update(JSON.stringify(buildManifest)).digest('hex'),
    harnessSha256: createHash('sha256')
      .update(await readFile(new URL(import.meta.url)))
      .update(await readFile(new URL('./performance-settle.mjs', import.meta.url)))
      .update(await readFile(new URL('./performance-demand.mjs', import.meta.url)))
      .update(await readFile(new URL('./performance-fixture.mjs', import.meta.url)))
      .update(await readFile(new URL('./object-workflow.mjs', import.meta.url)))
      .digest('hex'),
    harnessFiles: [
      'scripts/benchmark-workflow.mjs',
      'scripts/performance-settle.mjs',
      'scripts/performance-demand.mjs',
      'scripts/performance-fixture.mjs',
      'scripts/object-workflow.mjs',
    ],
    clock: {
      timeOriginUnixMs: performance.timeOrigin,
      wallOffsetAtEndMs: Date.now() - (performance.timeOrigin + performance.now()),
    },
    completionGate: { schema: 1, quietMs: 800, timeoutMs: 30_000, pollMs: 100, enabled: true },
    host: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0].model,
      logicalProcessors: cpus().length,
      totalMemory: totalmem(),
    },
    fixture: fixture.description,
    visuals,
    rows,
    samples,
    counterWarmup,
    errors,
    objectDownloads,
    tracePath,
    model: {
      measured: [
        'process CPU seconds',
        'process CPU interval percentages',
        'working set',
        'main thread task/script/layout time',
        'rAF gaps',
        'long tasks',
      ],
      energyJoules: null,
      gpuActiveSeconds: null,
      npuActiveSeconds: null,
      explanation:
        'CPU seconds are an uncalibrated demand proxy, not energy. No watts or battery-life claim. Includes Electron process tree only; this workflow does not launch models. GPU-process CPU time is not GPU device activity. Windows idleWakeupsPerSecond is unavailable. Polling overhead, completion diagnostics and tracing are included; compare identical settings. Completion requires tracked application work pending=0, visible PDF/tile/image readiness, 800ms stable revision and two compositor frames, including after window restore; this is not a GPU fence. Does not wait for the 60s night-worker resource-release timer or establish whole-system idle. Idle phases do not schedule continuous rAF probes. Processes that exit between samples may be undercounted. Synthetic pen events do not measure physical pen latency.',
    },
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  if (errors.length) throw Error(`Renderer errors: ${errors.join('; ')}`);
  console.log(`Saved ${output}`);
} finally {
  sampling = false;
  clearTimeout(sampleTimer);
  await app.close();
}
