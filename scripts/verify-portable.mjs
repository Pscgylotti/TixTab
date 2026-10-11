import { verifyNativeTexo } from './verify-native-ui.mjs';
import { verifyProviderTasksUi } from './verify-provider-tasks-ui.mjs';
import { verifyUiFeatures } from './verify-ui-features.mjs';
import { verifySelectionUi } from './verify-selection-ui.mjs';
import { verifyNativeOpus } from './verify-native-opus.mjs';
import { verifyNativeOcr } from './verify-native-ocr.mjs';
import { verifyNativeTts } from './verify-native-tts.mjs';
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyPdfUi } from './verify-pdf-ui.mjs';
import { verifyPdfWorkerUi } from './verify-pdf-worker-ui.mjs';
import { verifyDocumentUi } from './verify-document-ui.mjs';
import { verifyFormulaUi } from './verify-formula-ui.mjs';
import { verifyCacheUi } from './verify-cache-ui.mjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import assert from 'node:assert/strict';

// NSIS launchers do not forward Electron's inspector stderr. Connect to the
// extracted application's own DevTools port instead of launching it a second time.
const executable = resolve(
  process.argv[2] ||
    `release/${JSON.parse(await readFile('package.json', 'utf8')).version}/TixTab-${JSON.parse(await readFile('package.json', 'utf8')).version}-x64.exe`,
);
const profile = await mkdtemp(join(tmpdir(), 'surfacetab-portable-'));
const launcher = spawn(executable, ['--remote-debugging-port=0'], {
  env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
  windowsHide: true,
  stdio: 'ignore',
});
let browser;
try {
  let port,
    elapsed = 0;
  while (!port && elapsed < 90000) {
    if (launcher.exitCode !== null)
      throw new Error(`Portable launcher exited: ${launcher.exitCode}`);
    try {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    } catch {}
    if (!port) {
      await delay(250);
      elapsed += 250;
    }
  }
  assert.ok(port, 'Portable application did not expose its test port');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0],
    page = context.pages()[0] ?? (await context.waitForEvent('page')),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.ok(page.url().startsWith('surfacetab://app/'));
  assert.equal(
    await page.evaluate(() => typeof window.surfaceDesktop?.toggleFullscreen),
    'function',
  );
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await page.getByRole('button', { name: '退出全屏', exact: true }).waitFor();
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await page.getByRole('button', { name: '全屏', exact: true }).waitFor();
  console.log('Portable extraction / custom protocol / preload / fullscreen: verified');
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await page.getByLabel('文档名称', { exact: true }).fill('便携版持久化');
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.workspace-document').length === 2);
  await page.getByRole('button', { name: '关闭工作空间' }).click();
  await page.reload();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(await page.getByLabel('文档名称', { exact: true }).inputValue(), '便携版持久化');
  console.log('Portable workspace persistence: verified');
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([595, 842]).drawText('competitive environment', { x: 70, y: 700, size: 25, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'pen-check.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await page.locator('.textLayer span').waitFor();
  const box = await page
    .locator('.textLayer span')
    .first()
    .evaluate((el) => {
      const r = document.createRange(),
        n = el.firstChild;
      r.setStart(n, 0);
      r.setEnd(n, 1);
      const a = r.getBoundingClientRect();
      r.setStart(n, 10);
      r.setEnd(n, 11);
      const b = r.getBoundingClientRect();
      return { x: a.left + a.width * 0.8, y: a.top + a.height / 2, end: b.left + b.width * 0.7 };
    });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    pointerType: 'pen',
    force: 0.5,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: box.end,
    y: box.y,
    buttons: 1,
    pointerType: 'pen',
    force: 0.5,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.end,
    y: box.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    pointerType: 'pen',
  });
  assert.equal(await page.evaluate(() => getSelection()?.toString()), 'competitive');
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  console.log('Portable trusted pen protocol selection includes first glyph: verified');
  for (let i = 0; i < 4; i++)
    await page.getByRole('button', { name: '插入空白页', exact: true }).click();
  await page.locator('.page-list').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.getByRole('button', { name: '第 1 页', exact: true }).click();
  await page.getByRole('button', { name: '双页预览', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.reading-card')?.getAttribute('data-page-index') === '2',
  );
  await page.getByRole('button', { name: '向前移动一页', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.reading-card')?.getAttribute('data-page-index') === '1',
  );
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForFunction(
    () => document.querySelector('.reading-card')?.getAttribute('data-page-index') === '2',
  );
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await page.locator('.page-list').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.getByRole('button', { name: '第 5 页', exact: true }).click();
  await page.locator('.reading-card[data-page-index="4"]').waitFor({ state: 'visible' });
  assert.ok((await page.locator('.reading-card').count()) < 5);
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  console.log(
    'Portable dual-page step / single-page pairing / virtual reading navigation: verified',
  );
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByLabel('LaTeX · 可直接修改').fill('');
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  assert.equal(await page.getByLabel('键盘大小').count(), 0);
  await page.locator('.hg-button[data-skbtn="{shift}"]').click();
  await page.locator('.hg-button[data-skbtn="|"]').click();
  assert.equal(await page.getByLabel('LaTeX · 可直接修改').inputValue(), '|');
  await page.screenshot({ path: 'test-results/portable-verified.png' });
  console.log('Portable keyboard / settings / pipe: verified');
  await verifyUiFeatures(page);
  await verifySelectionUi(page);
  await verifyProviderTasksUi(page);
  await verifyCacheUi(page);
  await verifyPdfUi(page);
  await verifyPdfWorkerUi(page);
  await verifyDocumentUi(page);
  await verifyFormulaUi(page);
  // Verify the actual launcher's extracted payload, not only the staging folder.
  // Derive it strictly from this launcher's live descendants; do not inspect an
  // unrelated running TixTab window or guess a temporary directory.
  const processes = JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    ),
  );
  const descendants = new Set([launcher.pid]);
  for (let pass = 0; pass < 32; pass++) {
    let changed = false;
    for (const p of processes)
      if (descendants.has(p.ParentProcessId) && !descendants.has(p.ProcessId)) {
        descendants.add(p.ProcessId);
        changed = true;
      }
    if (!changed) break;
  }
  const owned = processes.filter(
    (p) =>
      descendants.has(p.ProcessId) &&
      p.ProcessId !== launcher.pid &&
      p.Name === 'TixTab.exe' &&
      p.ExecutablePath,
  );
  assert.ok(owned.length, 'Actual portable application must be a live launcher descendant');
  const payloads = new Set(owned.map((p) => resolve(p.ExecutablePath, '../resources/app.asar')));
  assert.equal(payloads.size, 1, 'Owned application processes must share one payload');
  const archive = [...payloads][0],
    lite = /-lite-x64\.exe$/i.test(executable);
  const modelReport = execFileSync(
    process.execPath,
    ['scripts/verify-package.mjs', archive, ...(lite ? ['--lite'] : [])],
    { encoding: 'utf8', windowsHide: true },
  );
  const assetsReport = execFileSync(
    process.execPath,
    ['scripts/verify-built-assets.mjs', archive, ...(lite ? ['--lite'] : [])],
    { encoding: 'utf8', windowsHide: true },
  );
  console.log('Actual portable extracted payload SHA256:', modelReport.trim(), assetsReport.trim());
  if (process.env.SURFACETAB_VERIFY_OCR === '1') await verifyNativeOcr(page);
  if (process.env.SURFACETAB_VERIFY_TTS === '1') await verifyNativeTts(page);
  if (process.env.SURFACETAB_VERIFY_OPUS === '1') {
    const result = await verifyNativeOpus(page);
    await writeFile('test-results/native-opus028-portable.json', JSON.stringify(result, null, 2));
    console.log('Portable native OPUS:', JSON.stringify(result));
  }
  if (process.env.SURFACETAB_VERIFY_NATIVE === '1') await verifyNativeTexo(page);
  assert.deepEqual(errors, []);
  console.log('Portable renderer errors: none');
} finally {
  if (browser) {
    try {
      const session = await browser.newBrowserCDPSession();
      await Promise.race([session.send('Browser.close').catch(() => {}), delay(2000)]);
    } catch {}
    await Promise.race([browser.close().catch(() => {}), delay(2000)]);
  }
  // Only our launcher is targeted. Browser.close shuts down its extracted app,
  // then the launcher removes its temporary application directory.
  for (let i = 0; i < 40 && launcher.exitCode === null; i++) await delay(250);
  if (launcher.exitCode === null) launcher.kill();
}
