import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
async function setup(page: Page) {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc
    .addPage([400, 550])
    .drawText('First PDF page about diffusion.', { x: 25, y: 475, size: 16, font });
  doc
    .addPage([400, 550])
    .drawText('Second PDF page with experiments.', { x: 25, y: 475, size: 16, font });
  const buffer = Buffer.from(await doc.save());
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page
    .locator('input[type=file][accept=".pdf,.tixtab"]')
    .setInputFiles({ name: 'API paper.pdf', mimeType: 'application/pdf', buffer });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByLabel('聊天接入方式', { exact: true }).selectOption('api');
  const panel = page.getByRole('complementary', { name: 'AI 阅读助手' });
  await panel.getByLabel('聊天 API 地址', { exact: true }).fill('https://chat.test/v1');
  await panel.getByLabel('聊天 API 模型', { exact: true }).fill('local-small');
  await panel.getByLabel('聊天 API 密钥', { exact: true }).fill('test-secret');
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  return { panel, buffer };
}
test('API chat streams markdown, retains history, and sends text/image/original PDF with explicit capabilities', async ({
  page,
}) => {
  const requests: { headers: Record<string, string>; body: any }[] = [];
  await page.route('https://chat.test/**', async (route) => {
    requests.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
    await route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"choices":[{"delta":{"content":"## Summary\\n\\n**Diffusion** explained."}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    });
  });
  const { panel, buffer } = await setup(page);
  await panel.getByLabel('向 LLM 提问').fill('Explain this');
  await panel.getByRole('button', { name: '附加页面文字', exact: true }).click();
  await expect(panel.locator('.chat-context')).toContainText('第 1 页');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.chat-message.assistant h2')).toHaveText('Summary');
  expect(requests[0].headers.authorization).toBe('Bearer test-secret');
  expect(requests[0].body.model).toBe('local-small');
  expect(requests[0].body.messages[0].content).toContain('First PDF page about diffusion.');
  await panel.getByRole('button', { name: '附加页面图片', exact: true }).click();
  await panel.getByLabel('向 LLM 提问').fill('This image');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(2);
  expect(requests[1].body.messages.at(-1).content[1].image_url.url).toMatch(
    /^data:image\/jpeg;base64,/,
  );
  await panel.getByRole('button', { name: '发送原 PDF 并总结', exact: true }).click();
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(3);
  expect(requests[2].body.messages.at(-1).content).toContain('Second PDF page with experiments.');
  expect(requests[2].body.messages.at(-1).content).toContain('2 of 2 pages');
  await panel.getByText('API 高级设置', { exact: true }).click();
  await panel.getByLabel('PDF 发送方式', { exact: true }).selectOption('file');
  await panel.getByRole('button', { name: '发送原 PDF 并总结', exact: true }).click();
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(4);
  expect(requests[3].body.messages.at(-1).content[1].file).toEqual({
    filename: 'API paper.pdf',
    file_data: 'data:application/pdf;base64,' + buffer.toString('base64'),
  });
  await panel.getByLabel('聊天 API 模型', { exact: true }).fill('other');
  await expect(panel.locator('.chat-message')).toHaveCount(0);
  await panel.getByLabel('聊天 API 模型', { exact: true }).fill('local-small');
  await expect(panel.locator('.chat-message')).toHaveCount(8);
  await panel.getByLabel('聊天接入方式', { exact: true }).selectOption('chatgpt');
  await expect(page.locator('.chat-message')).toHaveCount(0);
  await page.getByLabel('聊天接入方式', { exact: true }).selectOption('api');
  await expect(panel.locator('.chat-message')).toHaveCount(8);
  await expect
    .poll(() => page.evaluate(() => JSON.stringify(localStorage)))
    .not.toContain('test-secret');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await expect(panel.locator('.chat-message')).toHaveCount(8);
  await expect(panel.getByLabel('聊天 API 密钥', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.setViewportSize({ width: 560, height: 900 });
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await panel.getByRole('button', { name: '账号与模型', exact: true }).click();
  await expect(panel.getByLabel('聊天 API 模型')).toBeHidden();
  await expect(panel.getByLabel('向 LLM 提问')).toBeInViewport();
  await page.screenshot({ path: 'test-results/chat-api-night-portrait.png' });
});
test('incomplete API responses keep partial markdown and do not contaminate the next context', async ({
  page,
}) => {
  const requests: any[] = [];
  await page.route('https://chat.test/**', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"choices":[{"delta":{"content":"**Partial** response"}}]}\n\n',
    });
  });
  const { panel } = await setup(page);
  await panel.getByLabel('向 LLM 提问').fill('First');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.chat-message.assistant strong')).toHaveText('Partial');
  await expect(panel).toContainText('API 回答未完成');
  await panel.getByLabel('向 LLM 提问').fill('Next');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.chat-message.assistant')).toHaveCount(2);
  expect(requests[1].messages.some((m: any) => m.role === 'assistant')).toBe(false);
});
