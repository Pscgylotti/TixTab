import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import assert from 'node:assert/strict';
const executable = resolve(process.argv[2] || 'node_modules/electron/dist/electron.exe');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const profile = await mkdtemp(join(tmpdir(), 'surfacetab-provider-desktop-'));
const out = resolve(
  process.env.SURFACETAB_PROVIDER_REPORT ||
    `test-results/providers-desktop${version.replaceAll('.', '')}.json`,
);
await mkdir(resolve(out, '..'), { recursive: true });
const secretNames = ['translation', 'speech', 'ocr', 'formula', 'other', 'google'];
const secrets = secretNames.flatMap((n) => [`fixture-${n}-key`, `fixture-${n}-header`]);
secrets.push('fixture-query-token');
let posts = [],
  heads = [],
  browser,
  child,
  currentPage,
  errors = [],
  modelRequests = 0,
  slowStream = false,
  abortedStreams = 0,
  preflights = 0,
  browserCorsBlocked = false;
function wav() {
  const b = Buffer.alloc(44 + 16000 * 2 * 10);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(b.length - 44, 40);
  return b;
}
const server = createServer(async (req, res) => {
  // Deliberately no CORS headers: the browser witness must fail while all four
  // GUI features use the main-process relay. Native requests send no cookies.
  if (req.method === 'OPTIONS') {
    preflights++;
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.url === '/cors-witness') {
    res.writeHead(200);
    res.end('{}');
    return;
  }
  assert.equal(req.headers.cookie, undefined);
  assert.equal(req.headers.referer, undefined);
  if (req.method === 'HEAD') {
    heads.push({ url: req.url, bodyBytes: 0 });
    req.on('data', (b) => {
      heads.at(-1).bodyBytes += b.length;
    });
    res.writeHead(405);
    res.end();
    return;
  }
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 2_000_000) throw new Error('Input too large');
    }
    const data = JSON.parse(raw);
    const kind =
      req.url === '/ocr'
        ? 'ocr'
        : req.url === '/v1/audio/speech'
          ? 'speech'
          : data.messages?.[0]?.content.includes('Translate')
            ? 'translation'
            : 'formula';
    assert.equal(req.headers.authorization, `Bearer fixture-${kind}-key`);
    assert.equal(req.headers['x-fixture'], `fixture-${kind}-header`);
    posts.push({
      kind,
      url: req.url,
      image:
        kind === 'ocr'
          ? data.image
          : kind === 'formula'
            ? data.messages?.[1]?.content?.[0]?.image_url?.url
            : undefined,
      model: data.model,
      voice: data.voice,
    });
    if (kind === 'speech') {
      assert.equal(data.input, 'The book is on the table.');
      assert.equal(data.voice, 'fixture-voice');
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(wav());
    } else if (kind === 'ocr') {
      assert.match(data.image, /^data:image\/png;base64,/);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'API OCR result' }));
    } else if (kind === 'formula') {
      assert.match(posts.at(-1).image, /^data:image\/png;base64,/);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: '\\frac{1}{2}' }, finish_reason: 'stop' }],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    } else {
      assert.equal(data.messages[1].content, 'The book is on the table.');
      assert.equal(data.stream, true);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '本地接口' } }] }) + '\n\n',
      );
      const timer = setTimeout(
        () =>
          res.end(
            'data: ' +
              JSON.stringify({
                choices: [{ delta: { content: '流式译文' }, finish_reason: 'stop' }],
              }) +
              '\n\ndata: [DONE]\n\n',
          ),
        slowStream ? 6000 : 600,
      );
      res.on('close', () => {
        clearTimeout(timer);
        if (!res.writableEnded) abortedStreams++;
      });
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"Invalid fixture request"}');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
async function launch() {
  await unlink(join(profile, 'DevToolsActivePort')).catch(() => {});
  child = spawn(
    executable,
    [...(executable.endsWith('electron.exe') ? [resolve('.')] : []), '--remote-debugging-port=0'],
    {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
    },
  );
  let port;
  for (let i = 0; i < 360 && !port; i++) {
    if (child.exitCode !== null) throw new Error('Fixture app exited');
    try {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    } catch {}
    if (!port) await delay(250);
  }
  assert.ok(port, 'No desktop DevTools port');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  currentPage = browser.contexts()[0].pages()[0];
  currentPage.on('pageerror', (e) => errors.push(e.message));
  currentPage.on('request', (r) => {
    if (r.url().includes('/models/')) modelRequests++;
  });
  await currentPage.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.ok(currentPage.url().startsWith('surfacetab://app/'));
  return currentPage;
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
  if (child) {
    for (let i = 0; i < 60 && child.exitCode === null; i++) await delay(100);
    if (child.exitCode === null) child.kill();
    child = null;
  }
}
async function select(page) {
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await page.locator('.textLayer span').first().waitFor();
  await page
    .locator('.textLayer span')
    .first()
    .evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
  await page
    .locator('.selection-actions')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await page.getByRole('button', { name: '翻译后端设置' }).click();
}
async function advanced(page, kind) {
  const root =
    kind === 'translation'
      ? page.locator('.provider-config>.provider-advanced')
      : kind === 'speech'
        ? page.locator('.speech-settings>.provider-advanced')
        : page.locator('.provider-advanced');
  if (!(await root.locator('fieldset').isVisible())) await root.locator('summary').click();
  return root;
}
async function save(page, kind) {
  const root = await advanced(page, kind);
  await root.getByRole('button', { name: '保存 API 设置', exact: true }).click();
  await expect(root.locator('.provider-storage')).toHaveText('密钥及请求头已加密保存在本机');
}
async function headers(page, kind) {
  const root = await advanced(page, kind);
  await root
    .getByLabel('自定义请求头（JSON）')
    .fill(JSON.stringify({ 'X-Fixture': `fixture-${kind}-header` }));
  await root.getByLabel('API 超时（秒）').fill('25');
  if (['translation', 'formula'].includes(kind)) await root.getByLabel('流式返回文本').check();
  await save(page, kind);
}
async function region(page) {
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const r = await page.locator('.paper').boundingBox();
  await page.mouse.move(r.x + r.width * 0.1, r.y + r.height * 0.12);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.9, r.y + r.height * 0.25, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('button', { name: '识别文字（OCR）', exact: true }).click();
  await page.getByRole('dialog', { name: '区域识别' }).waitFor();
}
async function draw(page) {
  const r = await page.locator('.formula-canvas').boundingBox();
  await page.mouse.move(r.x + r.width * 0.3, r.y + r.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.6, r.y + r.height * 0.7, { steps: 8 });
  await page.mouse.up();
}
try {
  let page = await launch();
  assert.equal(
    await page.evaluate(() => typeof window.surfaceDesktop.providerHttp.start),
    'function',
  );
  browserCorsBlocked = await page.evaluate(async (origin) => {
    try {
      await fetch(origin + '/cors-witness', {
        method: 'POST',
        headers: { 'X-Witness': 'fixture' },
        body: 'non-sensitive fixture',
      });
      return false;
    } catch {
      return true;
    }
  }, origin);
  assert.equal(browserCorsBlocked, true);
  assert.equal(preflights, 1);
  await browser
    .contexts()[0]
    .addCookies([{ url: origin, name: 'private-session-cookie', value: 'must-not-send' }]);
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([595, 842]).drawText('The book is on the table.', { x: 60, y: 700, size: 24, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'provider-fixture.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await select(page);
  await page.getByLabel('翻译后端类型').selectOption('web');
  await page.getByLabel('翻译接口地址').fill(origin + '/other?token=fixture-query-token');
  await page.getByLabel('翻译 API Key').fill('fixture-other-key');
  await save(page, 'translation');
  await page.getByLabel('翻译后端类型').selectOption('google');
  await page.getByLabel('翻译 API Key').fill('fixture-google-key');
  await save(page, 'translation');
  await page.getByLabel('翻译后端类型').selectOption('llm');
  await page.getByLabel('翻译接口地址').fill(origin + '/v1');
  await page.getByLabel('翻译模型').fill('fixture-translation-model');
  await page.getByLabel('翻译 API Key').fill('fixture-translation-key');
  await headers(page, 'translation');
  await page.locator('.speech-settings summary').first().click();
  await page.getByLabel('语音后端').selectOption('llm');
  await page.getByLabel('语音接口地址').fill(origin + '/v1');
  await page.getByLabel('语音模型').fill('fixture-speech-model');
  await page.getByLabel('语音 API Key').fill('fixture-speech-key');
  await page.getByLabel('声音 ID').fill('fixture-voice');
  await headers(page, 'speech');
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  await region(page);
  await page.getByLabel('OCR 后端').selectOption('web');
  await page.getByLabel('OCR 接口地址').fill(origin + '/ocr');
  await page.getByLabel('OCR API Key').fill('fixture-ocr-key');
  await headers(page, 'ocr');
  await page
    .getByRole('dialog', { name: '区域识别' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await page.getByLabel('公式识别后端').selectOption('llm');
  await page.getByLabel('公式接口地址').fill(origin + '/v1');
  await page.getByLabel('公式模型').fill('fixture-formula-model');
  await page.getByLabel('公式 API Key').fill('fixture-formula-key');
  await headers(page, 'formula');
  await page
    .getByRole('dialog', { name: '手写公式' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  assert.equal(posts.length, 0, 'Settings must not send selections or start inference');
  assert.equal(heads.length, 0);
  const plaintext = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  for (const secret of secrets) assert.ok(!plaintext.includes(secret), 'Secret in localStorage');
  const bytes = await readFile(join(profile, 'provider-settings.v1.enc'));
  for (const secret of secrets)
    assert.ok(!bytes.includes(Buffer.from(secret)), 'Secret in encrypted vault');
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Formula', exact: true }).click();
  await page.locator('.provider-advanced summary').click();
  await expect(
    page.getByRole('button', { name: 'Check connection (without selection)', exact: true }),
  ).toBeVisible();
  await page.locator('.provider-transport').scrollIntoViewIfNeeded();
  await expect(page.locator('.provider-transport')).toHaveText(
    'Desktop connects directly; the server does not need to enable CORS.',
  );
  await page.screenshot({ path: resolve(out, '../providers-desktop-en-night.png') });
  await page
    .getByRole('dialog', { name: 'Handwritten formula' })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('zh-CN');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  console.log(
    'Desktop four-feature settings / no inference / encrypted file / English night UI: passed',
  );
  await close();
  page = await launch();
  for (const feature of ['translation', 'speech', 'ocr', 'formula']) {
    const saved = await page.evaluate(
      (feature) => window.surfaceDesktop.loadProviderSettings(feature),
      feature,
    );
    assert.equal(saved.status, 'encrypted');
    const type = feature === 'ocr' ? 'web' : 'llm';
    assert.equal(saved.data.selected, type);
    assert.equal(saved.data.profiles[type].key, `fixture-${feature}-key`);
    assert.equal(saved.data.profiles[type].timeoutSeconds, 25);
  }
  console.log('Desktop restart / real OS decryption for four features: passed');
  await select(page);
  await expect(page.getByLabel('翻译 API Key')).toHaveValue('fixture-translation-key');
  const root = await advanced(page, 'translation');
  await root.getByRole('button', { name: '检查连接（不发送选区）' }).click();
  await expect(root).toContainText('服务器可达（HTTP 405）');
  assert.equal(heads.length, 1);
  assert.equal(posts.length, 0);
  assert.equal(heads[0].bodyBytes, 0);
  await page
    .locator('.translation-footer')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect(page.locator('.translation-result')).toHaveText('本地接口');
  await expect(page.locator('.translation-result')).toHaveText('本地接口流式译文');
  slowStream = true;
  await page
    .locator('.translation-footer')
    .getByRole('button', { name: '翻译', exact: true })
    .click();
  await expect(page.locator('.translation-result')).toHaveText('本地接口');
  await page.getByRole('button', { name: '取消翻译', exact: true }).click();
  await expect(page.locator('.translation-status')).toHaveText('已取消');
  await expect.poll(() => abortedStreams).toBe(1);
  slowStream = false;
  await page.locator('.speech-settings summary').first().click();
  await expect(page.getByLabel('语音 API Key')).toHaveValue('fixture-speech-key');
  await page.getByRole('button', { name: '朗读选区' }).click();
  await page.getByRole('button', { name: '暂停朗读' }).waitFor();
  await page.getByRole('button', { name: '暂停朗读' }).click();
  await page.getByRole('button', { name: '继续朗读' }).click();
  await page.getByRole('button', { name: '停止朗读' }).click();
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  await region(page);
  await expect(page.getByLabel('OCR API Key')).toHaveValue('fixture-ocr-key');
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  await expect(page.getByLabel('识别结果 · 可修改')).toHaveValue('API OCR result');
  await page
    .getByRole('dialog', { name: '区域识别' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await expect(page.getByLabel('公式 API Key')).toHaveValue('fixture-formula-key');
  await draw(page);
  await page.getByRole('button', { name: '识别并覆盖', exact: true }).click();
  await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('\\frac{1}{2}');
  await page
    .getByRole('dialog', { name: '手写公式' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  assert.deepEqual(
    posts.map((p) => p.kind),
    ['translation', 'translation', 'speech', 'ocr', 'formula'],
  );
  assert.equal(modelRequests, 0);
  assert.equal(preflights, 1);
  console.log(
    'Desktop actual no-CORS HTTP relay / SSE partial+final / audio playback / image OCR+formula / no cookies: passed',
  );
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  const download = await downloadPromise,
    project = await readFile(await download.path());
  for (const secret of secrets)
    assert.ok(!project.includes(Buffer.from(secret)), 'Secret in exported project');
  await select(page);
  const current = await advanced(page, 'translation');
  await current.getByRole('button', { name: '清除当前后端凭据' }).click();
  await save(page, 'translation');
  await close();
  page = await launch();
  const cleared = await page.evaluate(() =>
    window.surfaceDesktop.loadProviderSettings('translation'),
  );
  assert.equal(cleared.data.profiles.llm.key, '');
  assert.equal(cleared.data.profiles.llm.headers, '');
  assert.equal(cleared.data.profiles.web.key, 'fixture-other-key');
  assert.equal(cleared.data.profiles.google.key, 'fixture-google-key');
  assert.deepEqual(errors, []);
  const report = {
    nativeRelay: true,
    corsAllowedByFixture: false,
    browserCorsBlocked,
    nativePreflightRequests: preflights - 1,
    cookiesOmitted: true,
    version: JSON.parse(await readFile('package.json', 'utf8')).version,
    executable,
    osEncryption: 'Electron safeStorage async; real restart decryption passed',
    features: 4,
    restarts: 2,
    settingsTriggeredInference: false,
    secretsInPlaintextMetadata: false,
    secretsInExport: false,
    headRequests: heads.length,
    taskKinds: posts.map((p) => p.kind),
    streamPartialAndFinal: true,
    actualStreamCancellation: abortedStreams === 1,
    speechApiAudioPauseResume: true,
    imageInputsVerified: true,
    clearCredentialsIsolated: true,
    modelRequests,
    rendererErrors: errors,
  };
  await writeFile(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await close();
  await new Promise((r) => server.close(r));
}
