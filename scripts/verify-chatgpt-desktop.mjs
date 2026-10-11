// Isolated profile; real Electron IPC + Windows encryption, with OAuth/API fixtures.
// Does not read existing ChatGPT sessions, open a browser, or consume subscription usage.
import { _electron as electron } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'desktop-test',
  alg: 'RS256',
  use: 'sig',
};
const profile = await mkdtemp(join(tmpdir(), 'surfacetab-chat-qa-'));
const executablePath = process.env.SURFACETAB_EXECUTABLE;
const launch = () =>
  electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
    timeout: 60000,
  });
// Actual Electron network response: no Content-Type, chunked SSE over loopback.
const fixtureMarkdown = String.raw`## Desktop stream verified.

**Markdown ready**

\[
v_t(x)=f_t(x)-\frac{1}{2}g_t^2s_t(x)
\]

~~~python
print(1)
~~~

[Reference](https://example.com/paper)
`;
const streamServer = createServer((req, res) => {
  req.resume();
  res.write(
    'data: ' +
      JSON.stringify({ type: 'response.output_text.delta', delta: fixtureMarkdown }) +
      '\n\n',
  );
  setTimeout(
    () => res.end('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'),
    25,
  );
});
await new Promise((resolve) => streamServer.listen(0, '127.0.0.1', resolve));
const streamURL = `http://127.0.0.1:${streamServer.address().port}/responses`;
let app = await launch();
const errors = [];
async function fixture(app) {
  await app.evaluate(
    async ({ net, shell }, { jwk, streamURL }) => {
      globalThis.chatQA = { auth: '', bodies: [], calls: 0 };
      const original = net.fetch.bind(net);
      shell.openExternal = async (url) => {
        globalThis.chatQA.auth = url;
      };
      net.fetch = async (url, options = {}) => {
        if (
          !String(url).startsWith('https://auth.openai.com/') &&
          !String(url).startsWith('https://api.openai.com/')
        )
          return original(url, options);
        globalThis.chatQA.calls++;
        if (url.endsWith('/oauth/token')) {
          return Response.json(globalThis.chatQA.token);
        }
        if (url.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
        if (url.endsWith('/models'))
          return Response.json({
            models: [
              {
                slug: 'desktop-available',
                display_name: 'Desktop available model',
                visibility: 'list',
              },
            ],
          });
        if (url.endsWith('/responses')) {
          globalThis.chatQA.bodies.push(JSON.parse(options.body));
          const response = await original(streamURL, options);
          if (response.headers.get('content-type'))
            throw Error('Fixture unexpectedly includes Content-Type');
          return response;
        }
        throw new Error('Unexpected QA route');
      };
    },
    { jwk, streamURL },
  );
}
try {
  let page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  if (process.env.SURFACETAB_CHECK_OPENAI_NETWORK === '1') {
    const connectivity = await app.evaluate(async ({ net }) => {
      try {
        const r = await net.fetch('https://auth.openai.com/.well-known/openid-configuration', {
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) return { status: r.status };
        const d = await r.json();
        return {
          status: r.status,
          issuerMatches: d.issuer === 'https://auth.openai.com',
          jwksMatches: d.jwks_uri === 'https://auth.openai.com/.well-known/jwks.json',
        };
      } catch {
        return { reachable: false };
      }
    });
    console.log('Public OpenAI discovery (no credentials):', JSON.stringify(connectivity));
  }
  await fixture(app);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await page.waitForTimeout(100);
  let auth;
  for (let i = 0; i < 30; i++) {
    auth = await app.evaluate(() => globalThis.chatQA.auth);
    if (auth) break;
    await page.waitForTimeout(50);
  }
  assert.ok(auth);
  const url = new URL(auth);
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  const raw = [
    { alg: 'RS256', kid: 'desktop-test' },
    {
      iss: 'https://auth.openai.com',
      aud: 'oaiapp_desktop_fixture',
      sub: 'desktop-test-subject',
      email: 'desktop-qa@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: url.searchParams.get('nonce'),
    },
  ]
    .map((x) => Buffer.from(JSON.stringify(x)).toString('base64url'))
    .join('.');
  const token = {
    access_token: 'desktop-fixture-access',
    refresh_token: 'desktop-fixture-refresh',
    id_token: raw + '.' + sign('RSA-SHA256', Buffer.from(raw), privateKey).toString('base64url'),
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'openid email profile chatgpt.tokens.use.direct',
  };
  await app.evaluate((_electron, token) => {
    globalThis.chatQA.token = token;
  }, token);
  const callback = new URL(url.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({
    code: 'desktop-code',
    client_id: 'oaiapp_desktop_fixture',
    state: url.searchParams.get('state'),
  }).toString();
  assert.equal((await fetch(callback)).status, 200);
  await page.getByRole('button', { name: '知道了', exact: true }).click();
  await page.getByLabel('聊天模型', { exact: true }).waitFor();
  const original = await PDFDocument.create();
  original.addPage([400, 550]);
  const originalBytes = Buffer.from(await original.save());
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles({
    name: 'Original desktop.pdf',
    mimeType: 'application/pdf',
    buffer: originalBytes,
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByLabel('聊天模型', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => typeof window.surfaceDesktop?.dictation?.run), 'function');
  await page.getByLabel('向 ChatGPT 提问').fill('Test this integration');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page
    .locator('.chat-message.assistant')
    .filter({ hasText: 'Desktop stream verified.' })
    .first()
    .waitFor();
  const sent = await app.evaluate(() => globalThis.chatQA.bodies);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].store, false);
  assert.equal(sent[0].stream, true);
  assert.equal(sent[0].model, 'desktop-available');
  await page.getByRole('button', { name: '发送原 PDF 并总结', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.chat-message.assistant').length === 2 &&
      document.querySelector('.chat-messages')?.getAttribute('aria-busy') === 'false',
  );
  await page.locator('.chat-message.assistant .katex-display').first().waitFor();
  assert.equal(await page.locator('.chat-message.assistant h2').count(), 2);
  assert.equal(await page.locator('.katex-error').count(), 0);
  assert.equal(await page.getByRole('button', { name: '复制代码', exact: true }).count(), 2);
  await page.getByRole('link', { name: 'Reference', exact: true }).first().click();
  assert.equal(await app.evaluate(() => globalThis.chatQA.auth), 'https://example.com/paper');
  const originalSent = await app.evaluate(() =>
    globalThis.chatQA.bodies
      .at(-1)
      .input.at(-1)
      .content.find((c) => c.type === 'input_file'),
  );
  assert.equal(originalSent.filename, 'Original desktop.pdf');
  assert.equal(
    originalSent.file_data,
    'data:application/pdf;base64,' + originalBytes.toString('base64'),
  );
  await page.getByRole('button', { name: '账号与模型', exact: true }).click();
  assert.equal(await page.getByLabel('聊天模型', { exact: true }).isVisible(), false);
  assert.equal(
    await page.getByRole('button', { name: '管理 ChatGPT 用量', exact: true }).isVisible(),
    false,
  );
  const rendererStatus = await page.evaluate(() =>
    window.surfaceDesktop.chatgpt.run({ action: 'status' }),
  );
  assert.equal(rendererStatus.data.storage, 'encrypted');
  assert.ok(!JSON.stringify(rendererStatus).includes('fixture-access'));
  const bytes = await readFile(join(profile, 'chatgpt.v1.enc'));
  assert.ok(!bytes.includes(Buffer.from('desktop-fixture-access')));
  assert.ok(!bytes.includes(Buffer.from('desktop-fixture-refresh')));
  assert.ok(!bytes.includes(Buffer.from('desktop-qa@example.com')));
  // Real renderer navigation must abort jobs and retain encrypted login across restart.
  await page.reload();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page
    .locator('.chat-message.assistant')
    .filter({ hasText: 'Desktop stream verified.' })
    .first()
    .waitFor();
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await fixture(app);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  assert.equal(await page.locator('.chat-account-toggle').getAttribute('aria-expanded'), 'false');
  await page.locator('.chat-account-toggle').click();
  await page.getByLabel('ChatGPT 账号', { exact: true }).waitFor();
  await page
    .locator('.chat-message.assistant')
    .filter({ hasText: 'Desktop stream verified.' })
    .first()
    .waitFor();
  assert.equal(await page.getByRole('dialog', { name: '正在使用 ChatGPT 订阅额度' }).count(), 0);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(768, 1024),
  );
  const box = await page.getByLabel('向 ChatGPT 提问').boundingBox();
  assert.ok(box && box.width > 200 && box.x >= 0 && box.y + box.height <= 1024);
  await page.screenshot({
    path: process.env.SURFACETAB_CHAT_SCREENSHOT || 'test-results/chatgpt-desktop.png',
  });
  await page.getByRole('button', { name: '收起聊天', exact: true }).click();
  assert.equal(await page.locator('.chat-panel').count(), 0);
  assert.deepEqual(errors, []);
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 12; i++) pdf.addPage([600, 900]);
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles({
    name: 'Kinetic check.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  const root = page.locator('.reading-view');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await page.waitForTimeout(120);
  const cdp = await page.context().newCDPSession(page),
    r = await root.boundingBox(),
    x = Math.round(r.x + r.width / 2),
    y = Math.round(r.y + r.height * 0.65);
  const touch = (type, positions) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: positions.map((v, id) => ({ x: x + id * 80, y: v, id })),
    });
  await touch('touchStart', [y]);
  for (let n = 1; n <= 6; n++) {
    await page.waitForTimeout(20);
    await touch('touchMove', [y - n * 30]);
  }
  await touch('touchEnd', []);
  const released = await root.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(160);
  assert.ok((await root.evaluate((el) => el.scrollTop)) > released + 60);
  await touch('touchStart', [y]);
  const stopped = await root.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(100);
  assert.ok(Math.abs((await root.evaluate((el) => el.scrollTop)) - stopped) < 1);
  await touch('touchEnd', []);
  assert.ok(
    (await root.evaluate((el) =>
      Math.abs(el.getBoundingClientRect().bottom - el.parentElement.getBoundingClientRect().bottom),
    )) < 1,
  );
  assert.equal(await page.title(), 'TixTab · Thinking over Screen');
  await page.getByRole('button', { name: '适合页面', exact: true }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(errors, []);
  const helper = executablePath
    ? join(executablePath, '../resources/app.asar.unpacked/electron/dictation.ps1')
    : join(process.cwd(), 'electron/dictation.ps1');
  const recognized = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-SelfTest'],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  assert.match(recognized, /TEST [A-Za-z0-9+/=]+/);
  console.log(
    'Actual Windows offline dictation: generated WAV recognized locally, no microphone capture; passed.',
  );
  console.log(
    'Actual Electron reading: touch inertia, retouch stop, transparent control gaps, full-height viewport and Thinking over Screen title passed.',
  );
  console.log(
    'Actual Electron ChatGPT: loopback OAuth + PKCE + signed identity + IPC + encrypted Windows storage + actual headerless network SSE + original PDF + collapsible account + restart + local history + night portrait + rendered Markdown/KaTeX/code/reference link passed.',
  );
  console.log('Renderer errors: none. Real account authorization/inference not exercised.');
} finally {
  await app.close();
  streamServer.closeAllConnections();
  await new Promise((resolve) => streamServer.close(resolve));
}
