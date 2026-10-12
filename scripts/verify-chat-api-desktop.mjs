// Isolated desktop acceptance: actual HTTP relay, encrypted settings and process restart.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import assert from 'node:assert/strict';

const executablePath = resolve(process.argv[2]);
const profile = await mkdtemp(join(tmpdir(), 'tixtab-chat-api-'));
const errors = [],
  requests = [];
let app,
  slow = false,
  cancellations = 0;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer fixture-chat-key');
    assert.equal(req.headers['x-fixture'], 'fixture-chat-header');
    assert.equal(req.headers.cookie, undefined);
    let raw = '';
    for await (const bytes of req) raw += bytes;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); // Deliberately no CORS permission.
    res.write('data: {"choices":[{"delta":{"content":"**Desktop** response"}}]}\n\n');
    const timer = setTimeout(
      () =>
        res.end(
          'data: {"choices":[{"delta":{"content":" complete"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
      slow ? 30000 : 180,
    );
    res.on('close', () => {
      clearTimeout(timer);
      if (!res.writableEnded) cancellations++;
    });
  } catch (e) {
    errors.push(e.message);
    res.writeHead(500);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/v1`;
async function launch() {
  app = await electron.launch({
    executablePath,
    env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  return page;
}
try {
  let page = await launch();
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc
    .addPage([400, 550])
    .drawText('Actual desktop PDF context.', { x: 25, y: 475, size: 16, font });
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles({
    name: 'Desktop API.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByLabel('聊天接入方式', { exact: true }).selectOption('api');
  await page.getByLabel('聊天 API 地址').fill(url);
  await page.getByLabel('聊天 API 模型').fill('fixture-model');
  await page.getByLabel('聊天 API 密钥').fill('fixture-chat-key');
  await page.getByText('API 高级设置', { exact: true }).click();
  await page.getByLabel('聊天 API 请求头（JSON）').fill('{"X-Fixture":"fixture-chat-header"}');
  await page.getByRole('button', { name: '保存 API 设置', exact: true }).click();
  await expect(page.locator('.chat-api-settings [role=status]')).toHaveText(
    '密钥及请求头已加密保存在本机',
  );
  await page.getByRole('button', { name: '发送原 PDF 并总结', exact: true }).click();
  await expect(page.locator('.chat-message.assistant')).toContainText('Desktop response complete');
  assert.ok(requests[0].messages[0].content.includes('Actual desktop PDF context.'));
  assert.equal(requests[0].model, 'fixture-model');
  assert.ok(
    !(await readFile(join(profile, 'provider-settings.v1.enc')))
      .toString()
      .includes('fixture-chat-key'),
  );
  assert.ok(
    !(await page.evaluate(() => JSON.stringify(localStorage))).includes('fixture-chat-key'),
  );
  await app.close();
  app = undefined;
  page = await launch();
  await expect(page.getByRole('tab')).toHaveCount(1);
  if (!(await page.locator('.chat-panel').isVisible()))
    await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await expect(page.getByLabel('聊天接入方式', { exact: true })).toHaveValue('api');
  await expect(page.getByLabel('聊天 API 密钥')).toHaveValue('fixture-chat-key');
  await expect(page.locator('.chat-message.assistant')).toContainText('Desktop response complete');
  slow = true;
  await page.getByLabel('向 LLM 提问').fill('Cancel slow answer');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-message.assistant').last()).toContainText('Desktop response');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await expect.poll(() => cancellations).toBe(1);
  await expect(page.locator('.chat-message.assistant').last()).toContainText('Desktop response');
  assert.equal(requests[1].messages.filter((m) => m.role === 'assistant').length, 1);
  // Native detached window uses the same API controls and history, without another request.
  const popup = app.waitForEvent('window');
  await page.getByRole('button', { name: '在独立悬浮窗中打开', exact: true }).click();
  await popup;
  const detached = app.windows().find((w) => w !== page);
  assert.ok(detached);
  await expect(detached.getByLabel('向 LLM 提问')).toBeVisible();
  await expect(detached.locator('.chat-message.assistant')).toHaveCount(2);
  assert.equal(requests.length, 2);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        encryptedReopen: true,
        desktopRelayNoCors: true,
        streamedMarkdown: true,
        originalPdfText: true,
        cancelledConnection: true,
        partialRetained: true,
        detachedWindow: true,
        emptyStarterReplaced: true,
        rendererErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
