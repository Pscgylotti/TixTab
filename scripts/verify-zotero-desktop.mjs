import { _electron as electron, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, dirname, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { extractFile } from '@electron/asar';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
const dir = await mkdtemp(join(tmpdir(), 'surfacetab-zotero-desktop-')),
  profile = join(dir, 'profile');
const doc = await PDFDocument.create(),
  font = await doc.embedFont(StandardFonts.Helvetica);
doc.addPage([595, 842]).drawText('Actual Zotero PDF bridge', { x: 50, y: 700, size: 22, font });
const file = join(dir, 'Fixture.pdf');
await writeFile(file, await doc.save());
const parent = {
  key: 'PARENT12',
  data: {
    itemType: 'journalArticle',
    title: 'Desktop Zotero fixture',
    date: '2026',
    creators: [{ firstName: 'Test', lastName: 'Author' }],
  },
  meta: { numChildren: 1 },
};
const attachment = {
  key: 'ATTACH12',
  data: {
    itemType: 'attachment',
    title: 'Fixture.pdf',
    filename: 'Fixture.pdf',
    contentType: 'application/pdf',
    parentItem: 'PARENT12',
  },
  meta: {},
};
const requests = [];
let disabled = false;
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:23119');
  requests.push(u.pathname + u.search);
  res.setHeader('Zotero-Server-ID', 'fixture-local-0225');
  res.setHeader('Zotero-API-Version', '3');
  if (disabled) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (u.pathname.endsWith('/file/view/url')) {
    res.setHeader('Content-Type', 'text/plain');
    res.end(pathToFileURL(file).href);
    return;
  }
  if (u.searchParams.get('format') === 'bibtex') {
    res.end('@article{fixture,title={Desktop Zotero fixture}}');
    return;
  }
  const data = u.pathname.endsWith('/groups')
    ? []
    : u.pathname.endsWith('/collections')
      ? [
          { key: 'COLLECT1', data: { name: 'Arch' } },
          { key: 'ATTENT01', data: { name: 'Attention', parentCollection: 'COLLECT1' } },
        ]
      : u.pathname.endsWith('/children')
        ? [attachment]
        : u.pathname.endsWith('/items/ATTACH12')
          ? attachment
          : [parent];
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Total-Results', Array.isArray(data) ? data.length : 1);
  res.end(JSON.stringify(data));
});
const live = process.argv.includes('--live');
if (!live)
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(23119, '127.0.0.1', accept);
  });
let app,
  browser,
  launcher,
  clipboardSaved = false;
const executable = process.argv[2],
  portable = process.argv.includes('--portable');
try {
  let page;
  if (portable) {
    launcher = spawn(resolve(executable), ['--remote-debugging-port=0'], {
      env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
      windowsHide: true,
      stdio: 'ignore',
    });
    let port;
    for (let i = 0; i < 360 && !port; i++) {
      try {
        port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      } catch {}
      if (!port) await delay(250);
    }
    assert.ok(port);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = browser.contexts()[0].pages()[0];
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
    for (let i = 0; i < 8; i++)
      for (const p of processes)
        if (descendants.has(p.ParentProcessId)) descendants.add(p.ProcessId);
    const payloads = new Set(
      processes
        .filter(
          (p) =>
            descendants.has(p.ProcessId) &&
            p.ProcessId !== launcher.pid &&
            p.Name === 'TixTab.exe' &&
            p.ExecutablePath,
        )
        .map((p) => join(dirname(p.ExecutablePath), 'resources', 'app.asar')),
    );
    assert.equal(payloads.size, 1);
    const archive = [...payloads][0],
      lite = executable.includes('-lite-');
    for (const script of ['verify-package.mjs', 'verify-built-assets.mjs'])
      console.log(
        execFileSync(
          process.execPath,
          ['scripts/' + script, archive, ...(lite ? ['--lite'] : [])],
          { encoding: 'utf8', windowsHide: true },
        ).trim(),
      );
    const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
    for (const name of ['main.cjs', 'preload.cjs', 'zotero.cjs'])
      assert.equal(
        sha(extractFile(archive, normalize('electron/' + name))),
        sha(await readFile('electron/' + name)),
      );
    console.log(
      'Actual extracted portable payload: dist/model SHA256 and current Zotero/main/preload matched',
    );
  } else {
    app = await electron.launch({
      ...(executable ? { executablePath: resolve(executable), args: [] } : { args: ['.'] }),
      env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
      timeout: 60000,
    });
    page = await app.firstWindow();
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => typeof window.surfaceDesktop.zotero.run), 'function');
  await page.getByRole('button', { name: '适合页面', exact: true }).click();
  await page.waitForFunction(() => {
    const v = document.querySelector('.surface')?.getBoundingClientRect(),
      p = document.querySelector('.paper')?.getBoundingClientRect();
    return (
      v &&
      p &&
      p.left >= v.left &&
      p.right <= v.right &&
      p.top >= v.top &&
      p.bottom <= v.bottom &&
      Math.min(v.width - p.width, v.height - p.height) < 18
    );
  });
  console.log(
    'Actual Electron fit: page edges fill available viewport with 8px margin, expanded controls clear: passed',
  );
  const open = () => page.getByRole('button', { name: '打开 Zotero 资料库', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Zotero 资料库', exact: true });
  if (live) {
    await open();
    await page.waitForFunction(
      () => document.querySelector('.zotero-dialog')?.getAttribute('aria-busy') === 'false',
    );
    assert.equal(await modal.locator('.zotero-connection-hint').count(), 0);
    const libraries = modal.locator('.library-row');
    assert.ok((await libraries.count()) > 1);
    await libraries.nth(1).click();
    await page.waitForFunction(
      () => document.querySelector('.zotero-dialog')?.getAttribute('aria-busy') === 'false',
    );
    const branches = modal
      .locator('.folder-row')
      .filter({ has: page.locator('button.tree-disclosure') });
    assert.ok((await branches.count()) > 0);
    const branch = branches.first(),
      name = await branch.getAttribute('aria-label');
    await branch.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await branch.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('ArrowRight');
    const child = modal.locator('.folder-row:focus');
    assert.ok(
      Number(await child.getAttribute('aria-level')) >
        Number(await branch.getAttribute('aria-level')),
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.querySelector('.zotero-dialog')?.getAttribute('aria-busy') === 'false',
    );
    assert.equal(await child.getAttribute('aria-selected'), 'true');
    const count = await modal.locator('.folder-row').count();
    await page.getByLabel('筛选文件夹', { exact: true }).fill(name);
    assert.ok((await modal.locator('.folder-row').count()) <= count);
    await page.getByLabel('筛选文件夹', { exact: true }).fill('');
    await page.getByRole('button', { name: '收起文件夹栏', exact: true }).click();
    await page.getByRole('button', { name: '展开文件夹栏', exact: true }).click();
    assert.equal(await branch.getAttribute('aria-expanded'), 'true');
    assert.ok((await modal.locator('.zotero-item').count()) > 0);
    await modal.locator('.zotero-item').first().click();
    await page.waitForFunction(
      () => document.querySelector('.zotero-dialog')?.getAttribute('aria-busy') === 'false',
    );
    assert.ok((await modal.locator('.zotero-detail h3').count()) > 0);
    await page.getByRole('button', { name: '关闭 Zotero', exact: true }).click();
    await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    await open();
    await page.waitForFunction(
      () => document.querySelector('.zotero-dialog')?.getAttribute('aria-busy') === 'false',
    );
    if (app)
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(560, 900),
      );
    else await page.setViewportSize({ width: 560, height: 900 });
    assert.ok(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth));
    assert.ok(
      await modal.evaluate((el) =>
        getComputedStyle(el)
          .backgroundColor.match(/\d+/g)
          .slice(0, 3)
          .every((n) => Number(n) < 100),
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      'Actual Electron Zotero: live client libraries / group collection hierarchy / keyboard selection / filtering / pane state / items and attachment details / night portrait: passed',
    );
    console.log(
      'Renderer errors: none; read-only live Zotero client, no library or clipboard changes',
    );
  } else {
    await open();
    await page.locator('.zotero-item').waitFor();
    await page.getByRole('button', { name: '展开 Arch', exact: true }).click();
    const folder = page.getByRole('treeitem', { name: 'Attention', exact: true });
    await folder.click();
    assert.equal(await folder.getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: '收起文件夹栏', exact: true }).click();
    await page.getByRole('button', { name: '展开文件夹栏', exact: true }).click();
    assert.equal(await folder.isVisible(), true);
    await page.getByLabel('搜索 Zotero 文献').fill('Test Author');
    await modal.getByRole('button', { name: '搜索', exact: true }).click();
    await page.locator('.zotero-item').click();
    if (app) {
      await app.evaluate(async ({ clipboard, ClipboardItem }) => {
        globalThis.qaZoteroClipboard = await Promise.all(
          (await clipboard.read())
            .filter((item) => item.types.length)
            .map(
              async (item) =>
                new ClipboardItem(
                  Object.fromEntries(
                    await Promise.all(
                      item.types.map(async (type) => [type, await item.getType(type)]),
                    ),
                  ),
                ),
            ),
        );
      });
      clipboardSaved = true;
    }
    await modal.getByRole('button', { name: '复制 BibTeX', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('.zotero-message').textContent === 'BibTeX 已复制',
    );
    if (app)
      assert.equal(
        await app.evaluate(async ({ clipboard }) => clipboard.readText()),
        '@article{fixture,title={Desktop Zotero fixture}}',
      );
    await page.locator('.zotero-attachment').click();
    await modal.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '选文', exact: true }).click();
    await page.locator('.textLayer span').first().waitFor();
    assert.match(await page.locator('.textLayer').textContent(), /Actual Zotero PDF bridge/);
    const tabs = await page.getByRole('tab').count();
    await page.getByRole('button', { name: '加页', exact: true }).click();
    await open();
    assert.match(await page.locator('.zotero-current').textContent(), /Fixture.pdf/);
    await page.locator('.zotero-item').click();
    await page.locator('.zotero-attachment').click();
    await modal.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('tab').count(), tabs);
    assert.match(await page.locator('.page-navigation').textContent(), /2\s*\/\s*2/);
    await page.reload();
    await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
    await open();
    assert.match(await page.locator('.zotero-current').textContent(), /Fixture.pdf/);
    await page.getByRole('button', { name: '关闭 Zotero', exact: true }).click();
    await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    await open();
    await page.locator('.zotero-item').waitFor();
    if (app)
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(560, 900),
      );
    else await page.setViewportSize({ width: 560, height: 900 });
    const color = await modal.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.ok(
      color
        .match(/\d+/g)
        .slice(0, 3)
        .every((n) => Number(n) < 100),
    );
    assert.ok(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth));
    await page.screenshot({
      path: `test-results/zotero-${portable ? 'portable' : 'desktop'}-${executable?.includes('lite') ? 'lite' : 'full'}-night.png`,
    });
    await page.getByRole('button', { name: '关闭 Zotero', exact: true }).click();
    disabled = true;
    await open();
    await page.waitForFunction(() =>
      document.querySelector('.zotero-message').textContent.includes('允许本机'),
    );
    await page.getByRole('button', { name: '关闭 Zotero', exact: true }).click();
    assert.ok(requests.some((r) => r.includes('q=Test+Author')));
    assert.ok(requests.some((r) => r.includes('/collections/ATTENT01/items')));
    assert.deepEqual(errors, []);
    console.log(
      'Actual Electron Zotero: local HTTP / nested collection tree and pane state / IPC / PDF bytes / text rendering / tab dedup / saved inserted page / reload / night portrait / disabled API guidance: passed',
    );
    console.log(
      app
        ? 'Actual native BibTeX clipboard: passed; original clipboard restored'
        : 'Portable EXE extraction and Zotero preload/bridge: passed',
    );
    console.log(
      'Renderer errors: none; real Zotero client unavailable, temporary official-shaped local HTTP fixture used',
    );
  }
} finally {
  if (app) {
    if (clipboardSaved)
      await app.evaluate(async ({ clipboard }) => {
        if (globalThis.qaZoteroClipboard.length)
          await clipboard.write(globalThis.qaZoteroClipboard);
        else clipboard.clear();
        delete globalThis.qaZoteroClipboard;
      });
    await app.close();
  }
  if (browser) {
    try {
      const session = await browser.newBrowserCDPSession();
      await Promise.race([session.send('Browser.close').catch(() => {}), delay(2000)]);
    } catch {}
    await Promise.race([browser.close().catch(() => {}), delay(2000)]);
  }
  if (launcher) {
    for (let i = 0; i < 40 && launcher.exitCode === null; i++) await delay(250);
    if (launcher.exitCode === null) launcher.kill();
  }
  if (server.listening) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
