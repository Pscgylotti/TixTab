import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);

async function mock(page: import('@playwright/test').Page) {
  await page.addInitScript(() =>
    Object.assign(window, {
      chatCalls: [],
      surfaceDesktop: {
        onFullscreen: () => () => {},
        chatgpt: {
          run: async (r: any) => {
            (window as any).chatCalls.push(r);
            if (r.action === 'status')
              return {
                ok: true,
                data: {
                  accounts: [
                    { id: 'a', email: 'reader@example.com', signedIn: true, enabled: true },
                  ],
                  active: 'a',
                  storage: 'session',
                  welcome: false,
                },
              };
            if (r.action === 'models')
              return { ok: true, data: [{ id: 'vision', name: 'Vision' }] };
            if (r.action === 'start') return { ok: true, data: { id: 'test' } };
            if (r.action === 'read') return { ok: true, data: { delta: 'Compared.', done: true } };
            return { ok: true, data: true };
          },
        },
      },
    }),
  );
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 4; i++)
    pdf.addPage([400, 550]).drawText(`Unique content page ${i}`, { x: 20, y: 470, font, size: 14 });
  await page.locator('input[accept=".pdf,.tixtab"]').setInputFiles({
    name: 'Pages.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await expect(page.getByLabel('聊天模型', { exact: true })).toHaveValue('vision');
}

test('three explicit pages stay attached across navigation; images reach the provider only once', async ({
  page,
}) => {
  await mock(page);
  await page.getByLabel('聊天附件页码').fill('1, 3-4');
  await page.getByRole('button', { name: '附加页面文字', exact: true }).click();
  await expect(page.locator('.chat-context')).toHaveCount(3);
  await page.getByLabel('聊天附件页码').fill('2');
  await page.getByRole('button', { name: '附加页面文字', exact: true }).click();
  await expect(page.locator('.chat-status')).toContainText('最多附加三页');
  await expect(page.locator('.chat-context')).toHaveCount(3);
  await page.getByLabel('向 ChatGPT 提问').fill('Compare page text');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(1);
  const textTurn = await page.evaluate(() =>
    (window as any).chatCalls.find((r: any) => r.action === 'start').messages.at(-1),
  );
  for (const n of [1, 3, 4]) expect(textTurn.text).toContain(`Unique content page ${n}`);
  expect(textTurn.image).toBeUndefined();
  await page.getByLabel('聊天附件页码').fill('1,3-4');
  await page.getByRole('button', { name: '附加页面图片', exact: true }).click();
  await expect(page.locator('.chat-context')).toHaveCount(3);
  await page
    .getByLabel('聊天独立图片附件')
    .setInputFiles({ name: 'figure.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.chat-image-attachment')).toHaveCount(1);
  await page.getByLabel('向 ChatGPT 提问').fill('Compare these pages');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(2);
  const turn = await page.evaluate(() =>
    (window as any).chatCalls.filter((r: any) => r.action === 'start')[1].messages.at(-1),
  );
  expect(turn.text).toContain('[PDF page 4]');
  expect(turn.image).toMatch(/^data:image\/jpeg;base64,/);
  expect(turn.images).toHaveLength(3);
  await page.getByLabel('向 ChatGPT 提问').fill('Continue');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(3);
  const prior = await page.evaluate(
    () => (window as any).chatCalls.filter((r: any) => r.action === 'start')[2].messages,
  );
  expect(prior.every((m: any) => !m.image && !m.images)).toBe(true);
  await page.setViewportSize({ width: 560, height: 900 });
  await expect(page.getByLabel('向 ChatGPT 提问')).toBeInViewport();
  await page.screenshot({ path: 'test-results/chat-attachments-portrait.png' });
});

test('image paste attaches to the independent chat window and leaves PDF objects untouched', async ({
  page,
}) => {
  await mock(page);
  const pending = page.waitForEvent('popup');
  await page.getByRole('button', { name: '在独立悬浮窗中打开', exact: true }).click();
  const popup = await pending;
  await popup.getByLabel('向 ChatGPT 提问').evaluate((el, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    clipboard.setData('text/plain', 'image fallback text');
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }),
    );
  }, png.toString('base64'));
  await expect(popup.locator('.chat-image-attachment')).toHaveCount(1);
  await expect(popup.getByLabel('向 ChatGPT 提问')).toHaveValue('');
  await expect(page.locator('.placed-object')).toHaveCount(0);
  await popup.getByRole('button', { name: '发送', exact: true }).click();
  await expect(popup.locator('.chat-message.assistant')).toContainText('Compared.');
  expect(
    await page.evaluate(
      () => (window as any).chatCalls.find((r: any) => r.action === 'start').messages.at(-1).image,
    ),
  ).toMatch(/^data:image\/jpeg;base64,/);
  await popup.getByRole('button', { name: '停靠到侧栏', exact: true }).click();
});

test('capture offers real image copy before OCR and the copied image can be pasted into chat', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mock(page);
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  const r = (await page.locator('.paper').boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.1, r.y + r.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.6, r.y + r.height * 0.3, { steps: 4 });
  await page.mouse.up();
  const preview = page.getByRole('dialog', { name: '截图预览', exact: true });
  await expect(preview).toBeVisible();
  await expect(page.getByLabel('OCR 后端')).toHaveCount(0);
  await preview.getByRole('button', { name: '复制图片', exact: true }).click();
  await expect(preview.getByRole('status')).toContainText('图片已复制');
  expect(await page.evaluate(async () => (await navigator.clipboard.read())[0].types)).toContain(
    'image/png',
  );
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByLabel('向 ChatGPT 提问').focus();
  await page.keyboard.press('Control+v');
  await expect(page.locator('.chat-image-attachment')).toHaveCount(1);
  await expect(page.locator('.placed-object')).toHaveCount(0);
});
