import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
const version = JSON.parse(await readFile('package.json', 'utf8')).version,
  lite = process.argv.includes('--lite');
const executable = resolve(
    process.argv[2] || `release/${version}/lite/TixTab-${version}-lite-x64.exe`,
  ),
  profile = await mkdtemp(join(tmpdir(), 'surfacetab-model-library-'));
const catalog = JSON.parse(await readFile('electron/model-catalog.json', 'utf8')),
  fixture = catalog.models.find((m) => m.id === 'tesseract');
const errors = [];
let launcher,
  browser,
  page,
  modelReads = 0;
async function launch() {
  launcher = spawn(executable, ['--remote-debugging-port=0'], {
    env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
    windowsHide: true,
    stdio: 'ignore',
  });
  let port;
  for (let n = 0; n < 360 && !port; n++) {
    if (launcher.exitCode !== null) throw new Error('Model verifier app exited');
    try {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    } catch {}
    if (!port) await delay(250);
  }
  assert.ok(port);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser.contexts()[0].pages()[0];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (/\/models\//.test(r.url())) modelReads++;
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
}
async function close() {
  if (browser) {
    try {
      const session = await browser.newBrowserCDPSession();
      await Promise.race([session.send('Browser.close').catch(() => {}), delay(2000)]);
    } catch {}
    await Promise.race([browser.close().catch(() => {}), delay(2000)]);
    browser = null;
  }
  if (launcher) {
    for (let n = 0; n < 60 && launcher.exitCode === null; n++) await delay(100);
    if (launcher.exitCode === null) launcher.kill();
    launcher = null;
  }
}
async function manager() {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '本地模型管理', exact: true }).click();
  await page.locator('.model-card').first().waitFor();
}
async function dismiss() {
  await page.getByRole('button', { name: '关闭模型管理' }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
}
const report = { version, executable, lite, catalogBundles: 8, modelFiles: 33 };
try {
  await mkdir('test-results', { recursive: true });
  await launch();
  const initial = await page.evaluate(() => window.surfaceDesktop.models.list());
  assert.equal(initial.length, 8);
  assert.ok(initial.every((m) => m.source === (lite ? 'missing' : 'bundled')));
  await manager();
  assert.equal(modelReads, 0);
  report.openingLoadedNoWeights = true;
  await assert.rejects(() =>
    page.evaluate(() => window.surfaceDesktop.models.run('../escape', 'remove')),
  );
  if (lite) {
    const texo = page.locator('[data-model-id=texo]');
    await texo.getByRole('button', { name: '下载', exact: true }).click();
    await page.getByRole('button', { name: '确认下载' }).click();
    await page.waitForFunction(
      () => Number(document.querySelector('.model-progress progress')?.getAttribute('value')) > 0,
      null,
      { timeout: 180000 },
    );
    await page.getByRole('button', { name: '取消任务' }).click();
    await expect(page.locator('.model-message')).toHaveText('已取消', { timeout: 30000 });
    await expect(texo).toContainText('未安装');
    report.actualPartialDownloadCancellation = true;
    const card = page.locator('[data-model-id=tesseract]');
    await card.getByRole('button', { name: '下载', exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: '下载模型？' })).toBeVisible();
    await page.getByRole('button', { name: '确认下载' }).click();
    await expect(card).toContainText('已下载 · 离线可用', { timeout: 180000 });
    await expect(card).toContainText('SHA256 已校验');
    report.downloadedBytes = fixture.bytes;
    report.fileHashes = [];
    for (const f of fixture.files) {
      const bytes = await readFile(
          join(profile, 'model-library/v1', fixture.id, fixture.revision, f.path),
        ),
        digest = createHash('sha256').update(bytes).digest('hex');
      assert.equal(bytes.length, f.bytes);
      assert.equal(digest, f.sha256);
      report.fileHashes.push({ file: f.path, sha256: digest });
    }
    await card.getByRole('button', { name: '校验文件' }).click();
    await expect(page.locator('.model-message')).toHaveText('模型操作已完成。');
    report.actualDownloadAndManualVerification = true;
    await dismiss();
    await close();
    await (
      await import('node:fs/promises')
    )
      .unlink(join(profile, 'DevToolsActivePort'))
      .catch(() => {});
    await launch();
    const saved = await page.evaluate(() => window.surfaceDesktop.models.list());
    assert.equal(saved.find((m) => m.id === 'tesseract').source, 'downloaded');
    report.restartPersistence = true;
    await browser.contexts()[0].route(/^https?:\/\//, (route) => route.abort());
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([600, 800]).drawText('TixTab 12345', { x: 70, y: 650, size: 30, font });
    await page.locator('input[type=file]').setInputFiles({
      name: 'managed-ocr.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    });
    await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
    const r = await page.locator('.paper').boundingBox();
    await page.mouse.move(r.x + r.width * 0.08, r.y + r.height * 0.13);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width * 0.9, r.y + r.height * 0.27, { steps: 5 });
    await page.mouse.up();
    await page.getByLabel('OCR 后端').selectOption('local');
    await page.getByRole('button', { name: '开始识别', exact: true }).click();
    await expect(page.getByLabel('识别结果 · 可修改')).toHaveValue(/TixTab\s+12345/, {
      timeout: 90000,
    });
    report.actualOfflineOcr = await page.getByLabel('识别结果 · 可修改').inputValue();
    await page
      .getByRole('dialog', { name: '区域识别' })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    await page.setViewportSize({ width: 560, height: 900 });
    await manager();
    await page.locator('[data-model-id=tesseract] summary').click();
    await page.screenshot({ path: 'test-results/models-lite-night.png' });
    await page
      .locator('[data-model-id=tesseract]')
      .getByRole('button', { name: '删除下载副本' })
      .click();
    await page.getByRole('button', { name: '确认删除' }).click();
    await expect(page.locator('[data-model-id=tesseract]')).toContainText('未安装');
    report.actualRemoval = true;
    await dismiss();
    await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
    const area = await page.locator('.paper').boundingBox();
    await page.mouse.move(area.x + area.width * 0.08, area.y + area.height * 0.13);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width * 0.9, area.y + area.height * 0.27, { steps: 5 });
    await page.mouse.up();
    await page.getByRole('button', { name: '开始识别', exact: true }).click();
    await expect(page.locator('.ocr-task-status')).toContainText('本地模型尚未安装');
    report.removalPreventsCachedOcr = true;
  } else {
    const card = page.locator('[data-model-id=texo]');
    await expect(card.getByRole('button', { name: '下载', exact: true })).toBeDisabled();
    await expect(card.getByRole('button', { name: '删除下载副本' })).toBeDisabled();
    await card.getByRole('button', { name: '校验文件' }).click();
    await expect(card).toContainText('SHA256 已校验', { timeout: 30000 });
    assert.equal(modelReads, 0);
    report.bundledVerificationWithoutInference = true;
  }
  assert.deepEqual(errors, []);
  report.rendererErrors = errors;
  await writeFile(
    `test-results/models-${lite ? 'lite' : 'offline'}-${version}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await close();
}
