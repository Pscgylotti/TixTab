import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { preservationFixture } from './pdf-preservation-fixture.mjs';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');

// Real UI and real Worker instances, including in ASAR. Hold only transport for
// screenshots; cancellation during loading and success run the actual worker.
export async function verifyPdfWorkerUi(page) {
  const viewport = page.viewportSize();
  await page.evaluate(() => {
    const originalWorker = window.Worker,
      originalClick = HTMLAnchorElement.prototype.click;
    const qa = (window.__pdfWorkerQa = {
      originalWorker,
      originalClick,
      workers: [],
      files: [],
      hold: false,
      fail: false,
      cancelLoading: false,
    });
    window.Worker = class extends originalWorker {
      constructor(url, options) {
        const exporting = String(url).includes('pdfExport.worker');
        if (exporting && qa.fail) {
          qa.fail = false;
          throw new Error('Injected worker creation failure');
        }
        super(url, options);
        if (exporting) {
          this.record = { terminated: 0, posted: 0, stages: [] };
          qa.workers.push(this.record);
          this.addEventListener('message', ({ data }) => {
            if (data.type === 'progress') {
              this.record.stages.push(data.progress.stage);
              if (qa.cancelLoading && data.progress.stage === 'loading') {
                qa.cancelLoading = false;
                document.querySelector('.pdf-export-progress button')?.click();
              }
            }
          });
        }
      }
      postMessage(value, transfers) {
        if (this.record) {
          if (qa.hold) return;
          this.record.posted++;
        }
        return super.postMessage(value, transfers);
      }
      terminate() {
        if (this.record) this.record.terminated++;
        return super.terminate();
      }
    };
    HTMLAnchorElement.prototype.click = function () {
      if (this.href.startsWith('blob:') && /\.(pdf|tixtab)$/i.test(this.download)) {
        const f = { name: this.download, bytes: null };
        qa.files.push(f);
        void fetch(this.href)
          .then((r) => r.arrayBuffer())
          .then((b) => (f.bytes = Array.from(new Uint8Array(b))));
        return;
      }
      return originalClick.call(this);
    };
  });
  const files = () => page.evaluate(() => window.__pdfWorkerQa.files.length);
  const download = async (button) => {
    const count = await files();
    await button.click();
    await page.waitForFunction(
      (i) => window.__pdfWorkerQa.files[i]?.bytes !== null && !!window.__pdfWorkerQa.files[i],
      count,
    );
    return Buffer.from(await page.evaluate((i) => window.__pdfWorkerQa.files[i].bytes, count));
  };
  try {
    await page.getByRole('button', { name: '单页标注', exact: true }).click();
    if (await page.getByRole('button', { name: '展开页面栏', exact: true }).count())
      await page.getByRole('button', { name: '展开页面栏', exact: true }).click();
    await page.locator('input[type=file]').setInputFiles({
      name: 'worker-ui.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await preservationFixture()),
    });
    await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '插入空白页', exact: true }).click();
    await page
      .getByRole('dialog', { name: '插入空白页', exact: true })
      .getByRole('button', { name: '插入页面', exact: true })
      .click();
    const before = await download(page.getByRole('button', { name: '保存工程', exact: true }));
    if (
      (await page
        .getByRole('button', { name: '实验性夜间模式', exact: true })
        .getAttribute('aria-pressed')) !== 'true'
    )
      await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    await page.setViewportSize({ width: 560, height: 900 });
    await page.evaluate(() => (window.__pdfWorkerQa.hold = true));
    const count = await files();
    await page.getByRole('button', { name: '导出 PDF', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'PDF 导出进度', exact: true });
    await modal.waitFor();
    await page.waitForFunction(() => window.__pdfWorkerQa.workers.length === 1);
    assert.equal(
      await modal.evaluate((el) => getComputedStyle(el).backgroundColor),
      'rgb(30, 36, 47)',
    );
    const cancel = modal.getByRole('button', { name: '取消导出', exact: true }),
      box = await cancel.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= 560);
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/pdf-worker-night-portrait.png' });
    await page.keyboard.press('Escape');
    await modal.waitFor({ state: 'hidden' });
    assert.equal(await files(), count);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('界面语言 / Interface language').selectOption('en');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
    const english = page.getByRole('dialog', { name: 'PDF export progress', exact: true });
    await english.waitFor();
    await page.waitForFunction(() => window.__pdfWorkerQa.workers.length === 2);
    await page.screenshot({ path: 'test-results/pdf-worker-english-portrait.png' });
    await english.getByRole('button', { name: 'Cancel export', exact: true }).click();
    await english.waitFor({ state: 'hidden' });
    assert.equal(await files(), count);
    // Actual worker failure must release busy state and permit the next export.
    await page.evaluate(() => {
      window.__pdfWorkerQa.hold = false;
      window.__pdfWorkerQa.fail = true;
    });
    await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
    await page
      .getByText(
        'Export failed: Background PDF export is unavailable. Try again or restart the app.',
        { exact: true },
      )
      .waitFor();
    assert.equal(await files(), count);
    await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
    // Stop a real running worker when its loading progress arrives, rather than
    // only cancelling a held transport or synthetic promise.
    await page.evaluate(() => (window.__pdfWorkerQa.cancelLoading = true));
    await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
    await page.getByText('PDF export cancelled', { exact: true }).waitFor();
    await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
    assert.equal(await files(), count);
    const after = await download(page.getByRole('button', { name: 'Save project', exact: true }));
    assert.deepEqual(after, before, 'Cancel/failure must leave editable project and source intact');
    const output = await download(page.getByRole('button', { name: 'Export PDF', exact: true }));
    assert.equal((await PDFDocument.load(output)).getPageCount(), 6);
    const workers = await page.evaluate(() => window.__pdfWorkerQa.workers);
    assert.equal(workers.length, 4);
    assert.ok(workers.every((w) => w.terminated === 1));
    assert.ok(workers[2].stages.includes('loading'));
    assert.ok(workers[3].stages.includes('saving'));
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('界面语言 / Interface language').selectOption('zh-CN');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    console.log(
      'Actual UI PDF worker: Escape/button/running-worker cancellation, no cancelled download, creation-failure retry, unchanged project, success; English/night/560px/44px; all 4 workers terminated once',
    );
  } finally {
    await page.evaluate(() => {
      const qa = window.__pdfWorkerQa;
      if (qa) {
        window.Worker = qa.originalWorker;
        HTMLAnchorElement.prototype.click = qa.originalClick;
        delete window.__pdfWorkerQa;
      }
    });
    if (viewport) await page.setViewportSize(viewport);
  }
}
