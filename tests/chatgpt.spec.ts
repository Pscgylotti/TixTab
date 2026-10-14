import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
test('ChatGPT account chat: page context, streaming, isolated history and night portrait', async ({
  page,
}) => {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc
    .addPage([400, 550])
    .drawText('A formula can explain diffusion.', { x: 25, y: 475, size: 16, font });
  const bytes = Buffer.from(await doc.save());
  await page.addInitScript(() => {
    const calls: any[] = [];
    let active = 'account1',
      signed = false,
      reads = 0,
      welcome = false;
    Object.assign(window, {
      chatCalls: calls,
      surfaceDesktop: {
        onFullscreen: () => () => {},
        chatgpt: {
          run: async (r: any) => {
            calls.push(r);
            const status = () => ({
              accounts: signed
                ? [
                    {
                      id: 'account1',
                      email: 'reader@example.com',
                      name: 'Reader',
                      signedIn: true,
                      enabled: true,
                    },
                    {
                      id: 'account2',
                      email: 'other@example.com',
                      name: 'Other',
                      signedIn: true,
                      enabled: true,
                    },
                  ]
                : [],
              active: signed ? active : '',
              storage: 'encrypted',
              welcome: signed && !welcome,
            });
            if (r.action === 'status') return { ok: true, data: status() };
            if (r.action === 'login') {
              signed = true;
              return { ok: true, data: status() };
            }
            if (r.action === 'welcome') {
              welcome = true;
              return { ok: true, data: status() };
            }
            if (r.action === 'models')
              return {
                ok: true,
                data: [{ id: 'available-model', name: 'Available account model' }],
              };
            if (r.action === 'select') {
              active = r.id;
              return { ok: true, data: status() };
            }
            if (r.action === 'start') {
              reads = 0;
              return { ok: true, data: { id: 'test-job' } };
            }
            if (r.action === 'read') {
              reads++;
              return {
                ok: true,
                data: {
                  delta: reads === 1 ? 'Diffusion is ' : 'a spreading process.',
                  done: reads === 2,
                  error: '',
                },
              };
            }
            return { ok: true, data: true };
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page
    .locator('input[type=file][accept=".pdf,.tixtab"]')
    .setInputFiles({ name: 'Chat PDF.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'ChatGPT 阅读助手' });
  await panel.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await panel.getByRole('button', { name: '知道了', exact: true }).click();
  await expect(panel.getByLabel('聊天模型', { exact: true })).toHaveValue('available-model');
  await panel.getByRole('button', { name: '收起聊天', exact: true }).click();
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await page
    .locator('.textLayer span')
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
  await page.getByRole('button', { name: '询问 ChatGPT', exact: true }).click();
  await expect(panel.locator('.chat-context')).toContainText('选中文字 · 第 1 页');
  await expect(page.locator('.selection-flyout')).toHaveCount(0);
  await panel.getByRole('button', { name: '附加页面文字', exact: true }).click();
  await expect(panel.locator('.chat-context')).toContainText('第 1 页');
  expect(
    await page.evaluate(() => (window as any).chatCalls.some((r: any) => r.action === 'start')),
  ).toBe(false);
  await panel.getByLabel('向 ChatGPT 提问').fill('Explain diffusion');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.chat-message.assistant')).toContainText(
    'Diffusion is a spreading process.',
  );
  expect(
    await page.evaluate(
      () => (window as any).chatCalls.find((r: any) => r.action === 'start').messages[0].text,
    ),
  ).toContain('A formula can explain diffusion.');
  await panel.getByRole('button', { name: '附加页面图片', exact: true }).click();
  await expect(panel.locator('.chat-context')).toContainText('图片');
  await panel.getByLabel('向 ChatGPT 提问').fill('Explain this figure');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(2);
  expect(
    await page.evaluate(
      () =>
        (window as any).chatCalls.filter((r: any) => r.action === 'start')[1].messages.at(-1).image,
    ),
  ).toMatch(/^data:image\/jpeg;base64,/);
  await panel.getByRole('button', { name: '发送原 PDF 并总结', exact: true }).click();
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(3);
  const original = await page.evaluate(() =>
    (window as any).chatCalls.filter((r: any) => r.action === 'start')[2].messages.at(-1),
  );
  expect(original.file.name).toBe('Chat PDF.pdf');
  expect(original.file.data).toBe('data:application/pdf;base64,' + bytes.toString('base64'));
  expect(original.text).toContain('请先总结');
  await panel.getByLabel('向 ChatGPT 提问').fill('Follow up');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(4);
  expect(
    await page.evaluate(() =>
      (window as any).chatCalls
        .filter((r: any) => r.action === 'start')[3]
        .messages.some((m: any) => m.file),
    ),
  ).toBe(false);
  await panel.getByLabel('ChatGPT 账号').selectOption('account2');
  await expect(panel.locator('.chat-message')).toHaveCount(0);
  await panel.getByLabel('ChatGPT 账号').selectOption('account1');
  await expect(panel.locator('.chat-message')).toHaveCount(8);
  await panel.getByRole('button', { name: '收起聊天', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await expect(panel.locator('.chat-message')).toHaveCount(8);
  const before = await panel.locator('.chat-messages').evaluate((el) => el.clientHeight);
  await panel.getByRole('button', { name: '账号与模型', exact: true }).click();
  await expect(panel.getByLabel('聊天模型', { exact: true })).toBeHidden();
  await expect(panel.getByRole('button', { name: '管理 ChatGPT 用量', exact: true })).toBeHidden();
  expect(await panel.locator('.chat-messages').evaluate((el) => el.clientHeight)).toBeGreaterThan(
    before + 120,
  );
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(panel.getByLabel('向 ChatGPT 提问')).toBeInViewport();
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/chatgpt-night-portrait.png' });
  await panel.getByRole('button', { name: '收起聊天', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Open ChatGPT chat', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'ChatGPT reading assistant' }),
  ).toBeVisible();
  await expect(page.getByLabel('Ask ChatGPT')).toBeVisible();
});
test('ChatGPT is idle when closed and requires desktop bridge', async ({ page }) => {
  let remote = 0;
  page.on('request', (r) => {
    if (/openai\.com|chatgpt\.com/.test(r.url())) remote++;
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  expect(remote).toBe(0);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeDisabled();
  expect(remote).toBe(0);
});
test('continuous page tracking updates attachment, page entry navigates, and offline voice edits without sending', async ({
  page,
}) => {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 12; n++)
    doc
      .addPage([400, n % 2 ? 550 : 700])
      .drawText(`Unique content on page ${n}`, { x: 25, y: 475, font, size: 14 });
  await page.addInitScript(() => {
    let reads = 0;
    const calls: any[] = [];
    Object.assign(window, {
      chatCalls: calls,
      surfaceDesktop: {
        onFullscreen: () => () => {},
        chatgpt: {
          run: async (r: any) => {
            calls.push(r);
            if (r.action === 'status')
              return {
                ok: true,
                data: {
                  accounts: [{ id: 'a', email: 'test@example.com', signedIn: true, enabled: true }],
                  active: 'a',
                  storage: 'encrypted',
                  welcome: false,
                },
              };
            if (r.action === 'models') return { ok: true, data: [{ id: 'm', name: 'Model' }] };
            if (r.action === 'start') return { ok: true, data: { id: 'job' } };
            if (r.action === 'read')
              return { ok: true, data: { done: true, delta: 'Summary', error: '' } };
            return { ok: true, data: true };
          },
        },
        dictation: {
          run: async (r: any) => {
            calls.push({ voice: r.action });
            if (r.action === 'start') {
              reads = 0;
              return { ok: true, data: { id: 'voice' } };
            }
            if (r.action === 'read')
              return {
                ok: true,
                data: {
                  text: ++reads === 1 ? '请解释当前页面' : '',
                  ready: true,
                  done: true,
                  error: '',
                },
              };
            return { ok: true, data: true };
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles({
    name: 'Tracking.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await expect(page.getByLabel('聊天模型', { exact: true })).toHaveValue('m');
  await page.getByRole('button', { name: '账号与模型', exact: true }).click();
  const root = page.locator('.reading-view');
  await page.getByRole('button', { name: '附加页面文字', exact: true }).click();
  await expect(page.locator('.chat-context')).toContainText('第 1 页');
  const target = await root.evaluate((el) => {
    const cards = el.querySelectorAll<HTMLElement>('.reading-card'),
      second = cards[1];
    const next = parseFloat(second.style.top) + 30;
    el.scrollTop = next;
    return next;
  });
  await expect(page.getByLabel('聊天附件页码')).toHaveValue('2');
  await expect(page.locator('.page-navigation>span')).toHaveText('2 / 12');
  await expect(page.locator('.chat-context')).toContainText('第 1 页');
  await page.waitForTimeout(180);
  expect(await root.evaluate((el) => el.scrollTop)).toBeCloseTo(target, 0);
  await page.getByLabel('聊天附件页码').fill('6');
  await page.getByLabel('聊天附件页码').press('Enter');
  await expect(page.locator('.page-navigation>span')).toHaveText('6 / 12');
  await expect(page.getByLabel('聊天附件页码')).toHaveValue('6');
  await page.getByRole('button', { name: '附加页面文字', exact: true }).click();
  expect(
    await page.evaluate(() => (window as any).chatCalls.some((c: any) => c.action === 'start')),
  ).toBe(false);
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.getByLabel('向 ChatGPT 提问')).toHaveValue('请解释当前页面');
  expect(
    await page.evaluate(() => (window as any).chatCalls.some((c: any) => c.action === 'start')),
  ).toBe(false);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-message.assistant')).toHaveText(/Summary/);
  expect(
    await page.evaluate(
      () => (window as any).chatCalls.find((r: any) => r.action === 'start').messages.at(-1).text,
    ),
  ).toContain('Unique content on page 6');
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(page.getByLabel('向 ChatGPT 提问')).toBeInViewport();
  expect(
    await page
      .locator('.chat-messages')
      .evaluate((el) => el.clientHeight / el.parentElement!.clientHeight),
  ).toBeGreaterThan(0.65);
  await page.screenshot({ path: 'test-results/chatgpt-compact-tracking.png' });
});
test('voice language switches independently, waveform tracks input level and stops without sending', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let active: any;
    const jobs: Record<string, any> = {},
      calls: any[] = [];
    Object.assign(window, {
      voiceCalls: calls,
      surfaceDesktop: {
        onFullscreen: () => () => {},
        chatgpt: {
          run: async () => ({
            ok: true,
            data: { accounts: [], active: '', storage: 'encrypted', welcome: false },
          }),
        },
        dictation: {
          run: async (r: any) => {
            calls.push(r);
            if (r.action === 'start') {
              const id = crypto.randomUUID();
              active = jobs[id] = { language: r.language, stopped: false, n: 0 };
              return { ok: true, data: { id } };
            }
            if (r.action === 'stop') {
              if (active) active.stopped = true;
              return { ok: true, data: true };
            }
            const job = jobs[r.id];
            await new Promise((resolve) => setTimeout(resolve, 100));
            return {
              ok: true,
              data: {
                text:
                  ++job.n === 1
                    ? job.language === 'en-US'
                      ? 'Explain the formula'
                      : '解释公式'
                    : '',
                ready: true,
                done: job.stopped,
                error: '',
                level: job.n % 2 ? 80 : 15,
              },
            };
          },
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByRole('button', { name: '账号与模型', exact: true }).click();
  await page.getByLabel('语音输入语言').selectOption('en-US');
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.getByLabel('向 ChatGPT 提问')).toHaveValue('Explain the formula');
  const wave = page.getByRole('img', { name: '麦克风音量波形', exact: true });
  await expect(wave).toBeVisible();
  await expect
    .poll(() =>
      wave
        .locator('i')
        .last()
        .evaluate((el) => parseFloat(el.style.height)),
    )
    .toBeGreaterThan(8);
  await page.getByLabel('语音输入语言').selectOption('zh-CN');
  await expect(page.getByLabel('向 ChatGPT 提问')).toHaveValue('Explain the formula\n解释公式');
  expect(
    await page.evaluate(() =>
      (window as any).voiceCalls
        .filter((r: any) => r.action === 'start')
        .map((r: any) => r.language),
    ),
  ).toEqual(['en-US', 'zh-CN']);
  await page.setViewportSize({ width: 380, height: 800 });
  expect(await page.locator('.chat-panel').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/chat-voice-wave.png' });
  await page.getByRole('button', { name: '停止语音输入', exact: true }).click();
  await expect(wave).toHaveCount(0);
  await page.getByRole('button', { name: '收起聊天', exact: true }).click();
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await expect(page.getByLabel('语音输入语言')).toHaveValue('zh-CN');
});
