import { _electron as electron, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { waitForPerformanceSettled } from './performance-settle.mjs';
import { primeCpuCounters, cpuIntervals, demandModel, quantiles } from './performance-demand.mjs';
const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    fixture: { type: 'string' },
    output: { type: 'string' },
    prepare: { type: 'boolean', default: false },
  },
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (!values.fixture) throw Error('Supply --fixture');
const fixtureFile = resolve(values.fixture);
if (values.prepare) {
  const pdf = await PDFDocument.create(),
    fonts = await Promise.all(
      [StandardFonts.Helvetica, StandardFonts.TimesRomanItalic, StandardFonts.Courier].map((font) =>
        pdf.embedFont(font),
      ),
    );
  pdf.setCreationDate(new Date('2026-10-14T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-10-14T00:00:00Z'));
  for (let number = 0; number < 12; number++) {
    const p = pdf.addPage([600, 800]);
    p.drawText(`Document page ${number + 1}`, { x: 48, y: 760, size: 18, font: fonts[0] });
    for (let line = 0; line < 44; line++)
      p.drawText(`competitive diffusion target ${line + 1}: a+b; naive cafe; affine flow.`, {
        x: 48,
        y: 720 - line * 14,
        size: 10,
        font: fonts[line % 3],
      });
    p.drawText('arXiv:2607.12358  author@example.org', { x: 48, y: 65, size: 11, font: fonts[0] });
  }
  await mkdir(dirname(fixtureFile), { recursive: true });
  await writeFile(fixtureFile, await pdf.save(), { flag: 'wx' });
  console.log(JSON.stringify({ fixture: fixtureFile, sha256: sha(await readFile(fixtureFile)) }));
  process.exit(0);
}
if (!values['app-dir'] || !values.output) throw Error('Supply frozen --app-dir and fresh --output');
const root = resolve(values['app-dir']),
  output = resolve(values.output),
  profile = await mkdtemp(join(tmpdir(), 'tixtab-text-workflow-'));
await mkdir(dirname(output), { recursive: true });
const app = await electron.launch({
  args: [root],
  env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
  timeout: 60000,
});
const samples = [],
  rows = [],
  errors = [];
let page,
  phaseName = 'setup',
  timer,
  sampling = false,
  currentSample;
const sample = () => {
  if (currentSample) return currentSample;
  currentSample = (async () => {
    const started = performance.now(),
      processes = await app.evaluate(({ app }) => app.getAppMetrics());
    samples.push({
      at: performance.now(),
      phase: phaseName,
      processes,
      collectMs: performance.now() - started,
    });
  })().finally(() => {
    currentSample = undefined;
  });
  return currentSample;
};
const click = (name) => page.getByRole('button', { name, exact: true }).click();
const settle = () => waitForPerformanceSettled(page, { timeoutMs: 60000 });
const snapshot = () => page.evaluate(() => window.tixtabPerformance.snapshot());
const phase = async (name, action) => {
  phaseName = name;
  await sample();
  const first = samples.length - 1,
    start = performance.now(),
    before = await snapshot();
  await page.evaluate(() => {
    window.textWorkflowFrames.frames = [];
    window.textWorkflowFrames.active = true;
    window.textWorkflowFrames.start();
  });
  await action();
  const checkpoint = await settle();
  await sample();
  const frames = await page.evaluate(() => {
    window.textWorkflowFrames.stop();
    return window.textWorkflowFrames.frames;
  });
  rows.push({
    name,
    wallMs: performance.now() - start,
    cpuSeconds: cpuIntervals(samples.slice(first)).reduce((sum, row) => sum + row.cpuSeconds, 0),
    framesMs: quantiles(frames),
    before,
    after: await snapshot(),
    checkpoint,
  });
  console.log(JSON.stringify({ phase: name, cpuSeconds: rows.at(-1).cpuSeconds }));
};
try {
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    localStorage.setItem('tixtab.performance.enabled', 'true');
    localStorage.setItem('surfacetab.powerMode', 'quality');
    localStorage.setItem('surfacetab.renderQuality', 'high');
    localStorage.setItem('surfacetab.night', 'false');
    localStorage.setItem('tixtab.preRenderRange', '1');
  });
  await page.reload();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
  );
  await page.evaluate(() => {
    window.textWorkflowFrames = {
      active: false,
      frames: [],
      handle: 0,
      stop() {
        this.active = false;
        cancelAnimationFrame(this.handle);
      },
      start() {
        cancelAnimationFrame(this.handle);
        let previous = performance.now();
        const tick = (time) => {
          if (!this.active) return;
          this.frames.push(time - previous);
          previous = time;
          this.handle = requestAnimationFrame(tick);
        };
        this.handle = requestAnimationFrame(tick);
      },
    };
  });
  await settle();
  const counterWarmup = await primeCpuCounters(
    async () => ({
      at: performance.now(),
      processes: await app.evaluate(({ app }) => app.getAppMetrics()),
    }),
    (ms) => page.waitForTimeout(ms),
  );
  sampling = true;
  const schedule = async () => {
    if (!sampling) return;
    try {
      await sample();
    } catch (error) {
      errors.push('collector: ' + error.message);
    }
    if (sampling) timer = setTimeout(schedule, 200);
  };
  await schedule();
  await phase('import-text-document', async () => {
    await page.locator('input[type=file]').setInputFiles(fixtureFile);
    await expect(page.locator('.sidebar-heading .count')).toHaveText('12');
    await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
    await click('适合页面');
  });
  await phase('search-all-pages', async () => {
    await page.keyboard.press('Control+f');
    await page.getByRole('textbox', { name: '搜索文档文字' }).fill('diffusion target');
    await expect(page.locator('.document-search-status [role=status]')).toHaveText('528 个结果');
    await click('页面');
  });
  await phase('repeat-hand-and-selection', async () => {
    for (let i = 0; i < 4; i++) {
      await click('移动');
      await settle();
      await click('选文');
      await expect(page.locator('.textLayer')).toContainText('competitive');
      await settle();
    }
  });
  await phase('read-pages-and-return', async () => {
    for (let i = 0; i < 4; i++) {
      await click('下一页');
      await settle();
    }
    for (let i = 0; i < 4; i++) {
      await click('上一页');
      await settle();
    }
  });
  await phase('reading-layouts', async () => {
    for (let repeat = 0; repeat < 2; repeat++)
      for (const mode of ['连续页面预览', '双页预览', '单页标注']) {
        await click(mode);
        await settle();
      }
  });
  await phase('night-and-day', async () => {
    await click('实验性夜间模式');
    await settle();
    await click('实验性夜间模式');
    await settle();
  });
  await phase('select-word-and-final-idle', async () => {
    const span = page
      .locator('.textLayer span')
      .filter({ hasText: /^competitive/ })
      .first();
    const at = await span.evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild, 0);
      range.setEnd(el.firstChild, 1);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.dblclick(at.x, at.y);
    assert.equal(await page.evaluate(() => getSelection().toString()), 'competitive');
    await click('关闭划词工具');
    await page.evaluate(() => window.textWorkflowFrames.stop());
    await page.waitForTimeout(2000);
  });
  sampling = false;
  clearTimeout(timer);
  await currentSample;
  const quality = await page.evaluate(() => ({
    spans: Array.from(document.querySelectorAll('.textLayer span')).map((el) => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent, rect: [r.x, r.y, r.width, r.height] };
    }),
    paper: document.querySelector('.paper').getBoundingClientRect().toJSON(),
    raster: (() => {
      const c = document.querySelector('.pdf-layer');
      return {
        width: c.width,
        height: c.height,
        data: Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data),
      };
    })(),
  }));
  quality.raster.sha256 = sha(Buffer.from(quality.raster.data));
  delete quality.raster.data;
  async function inventory(folder, prefix = '') {
    const files = [];
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory())
        files.push(...(await inventory(join(folder, entry.name), prefix + entry.name + '/')));
      else if (entry.isFile())
        files.push([prefix + entry.name, sha(await readFile(join(folder, entry.name)))]);
    }
    return files;
  }
  const runtime = [
      ...(await inventory(join(root, 'dist'), 'dist/')),
      ...(await inventory(join(root, 'electron'), 'electron/')),
      ['package.json', sha(await readFile(join(root, 'package.json')))],
    ],
    harnessFiles = [
      'scripts/benchmark-text-workflow.mjs',
      'scripts/performance-settle.mjs',
      'scripts/performance-demand.mjs',
    ],
    harness = createHash('sha256');
  for (const file of harnessFiles) harness.update(await readFile(file));
  const report = {
    schema: 1,
    label: values['app-dir'],
    harnessFiles,
    harnessSha256: harness.digest('hex'),
    sourceManifestSha256: sha(await readFile(join(root, 'SOURCE-MANIFEST.json'))),
    buildManifest: runtime,
    buildSha256: sha(JSON.stringify(runtime)),
    fixture: { sha256: sha(await readFile(fixtureFile)), pages: 12, matches: 528 },
    visuals: { width: 1440, height: 960, power: 'quality', quality: 'high', preRender: 1 },
    host: { cpu: cpus()[0].model, logicalProcessors: cpus().length, totalMemory: totalmem() },
    rows,
    samples,
    counterWarmup,
    errors,
    quality,
    finalLedger: await snapshot(),
    completionGate: { schema: 1, enabled: true, quietMs: 800, timeoutMs: 60000 },
    limits:
      'One descriptive workflow per build; no averaging, watts or battery claims. Electron process CPU includes collector/completion overhead, not non-Electron children. Source retention estimate is bounded but is not exact heap accounting. Raster/DOM capture occurs after resource sampling stops.',
  };
  report.demand = demandModel(report);
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  assert.deepEqual(errors, []);
  assert.equal(report.finalLedger.pending, 0);
  assert.equal(report.demand.unmatchedProcessIntervals, 0);
  console.log(
    JSON.stringify({
      output,
      cpu: report.demand.totalCpuSeconds,
      extractions: report.finalLedger.counters.pdfTextExtractions,
      hits: report.finalLedger.counters.pdfTextCacheHits,
    }),
  );
} finally {
  sampling = false;
  clearTimeout(timer);
  await currentSample?.catch(() => {});
  await app.close();
}
