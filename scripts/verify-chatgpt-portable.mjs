// Verify the actual self-extracting EXE with an isolated profile and no account login.
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractFile } from '@electron/asar';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const executable = resolve(process.argv[2]),
  profile = await mkdtemp(join(tmpdir(), 'surfacetab-chat-portable-'));
const launcher = spawn(executable, ['--remote-debugging-port=0'], {
  windowsHide: true,
  stdio: 'ignore',
  env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
});
let browser;
try {
  let port;
  for (let n = 0; n < 360 && !port; n++) {
    try {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    } catch {}
    if (!port) await delay(250);
    if (launcher.exitCode !== null) throw new Error('Portable exited before opening its window');
  }
  assert.ok(port);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0],
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(await page.title(), 'TixTab · Thinking over Screen');
  assert.equal(await page.evaluate(() => typeof window.surfaceDesktop.chatgpt.run), 'function');
  assert.equal(await page.evaluate(() => typeof window.surfaceDesktop.dictation.run), 'function');
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 12; n++)
    doc.addPage([600, 900]).drawText(`Portable page ${n}`, { font, size: 16, x: 40, y: 800 });
  await page.locator('input[type=file][accept=".pdf,.surfacetab"]').setInputFiles({
    name: 'Portable.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.page-navigation>span')?.textContent?.trim().startsWith('3'),
  );
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).waitFor();
  await page.getByRole('button', { name: '账号与模型', exact: true }).click();
  await page.getByLabel('语音输入语言').selectOption('en-US');
  await page.getByLabel('聊天附件页码').fill('6');
  await page.getByLabel('聊天附件页码').press('Enter');
  await page.waitForFunction(() =>
    document.querySelector('.page-navigation>span')?.textContent?.trim().startsWith('6'),
  );
  await page.getByRole('button', { name: '附加页面文字', exact: true }).click();
  assert.ok((await page.locator('.chat-context').textContent()).includes('第 6 页'));
  assert.equal(
    await page.getByRole('button', { name: '发送原 PDF 并总结', exact: true }).isEnabled(),
    false,
  );
  await page.getByRole('button', { name: '收起聊天', exact: true }).click();
  await page.reload();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  assert.equal(await page.locator('.chat-account-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.getByLabel('语音输入语言').inputValue(), 'en-US');
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.night === 'true');
  assert.equal(await page.locator('html').getAttribute('data-night'), 'true');
  const raw = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p=Get-CimInstance Win32_Process; $ids=@(${launcher.pid}); 1..5|ForEach-Object{$ids+=@($p|Where-Object{$ids -contains $_.ParentProcessId}|ForEach-Object{$_.ProcessId})}; @($p|Where-Object{$ids -contains $_.ProcessId -and $_.Name -eq 'TixTab.exe'}|Select-Object ProcessId,ExecutablePath)|ConvertTo-Json -Compress`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const owned = [JSON.parse(raw)].flat();
  assert.ok(owned.length);
  const archives = [
    ...new Set(owned.map((p) => resolve(p.ExecutablePath, '../resources/app.asar'))),
  ];
  assert.equal(archives.length, 1);
  const archive = archives[0],
    lite = /-lite-x64\.exe$/i.test(executable);
  execFileSync(
    process.execPath,
    ['scripts/verify-package.mjs', archive, ...(lite ? ['--lite'] : [])],
    { stdio: 'pipe', windowsHide: true },
  );
  execFileSync(
    process.execPath,
    ['scripts/verify-built-assets.mjs', archive, ...(lite ? ['--lite'] : [])],
    { stdio: 'pipe', windowsHide: true },
  );
  const sha = (x) => createHash('sha256').update(x).digest('hex');
  for (const file of [
    'electron/main.cjs',
    'electron/preload.cjs',
    'electron/chatgpt.cjs',
    'electron/dictation.cjs',
    'electron/dictation.ps1',
  ])
    assert.equal(sha(extractFile(archive, normalize(file))), sha(await readFile(file)), file);
  const helper = join(archive + '.unpacked', 'electron/dictation.ps1');
  assert.match(
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-SelfTest'],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 },
    ),
    /TEST /,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Actual portable: extraction, exact build/model/source hashes, ChatGPT/dictation IPC, collapsed account persistence, independent voice language, continuous page 3 entry and attachment page 6, night mode, offline WAV recognition passed. No account login, microphone capture, or paid inference. Renderer errors: none.',
  );
} finally {
  if (browser) {
    try {
      const cdp = await browser.newBrowserCDPSession();
      await Promise.race([cdp.send('Browser.close').catch(() => {}), delay(2000)]);
    } catch {}
    await Promise.race([browser.close().catch(() => {}), delay(2000)]);
  }
  for (let n = 0; n < 40 && launcher.exitCode === null; n++) await delay(250);
  if (launcher.exitCode === null) launcher.kill();
}
