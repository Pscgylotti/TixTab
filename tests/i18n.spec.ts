import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
async function english(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Paper and pen' })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}
test('界面中英文即时切换并持久保存，文档内容不翻译，延迟加载面板和 Excalidraw 均为英文', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await english(page);
  await page.getByLabel('Document name', { exact: true }).fill('中文资料 competitive');
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Objects', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Manage workspace' }).click();
  const workspace = page.getByRole('dialog', { name: 'Workspace manager' });
  await expect(workspace).toContainText('local documents');
  await expect(
    workspace.getByRole('button', { name: 'Open document 中文资料 competitive' }),
  ).toBeVisible();
  await expect(
    workspace.getByRole('button', { name: 'Pin 中文资料 competitive', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close workspace' }).click();
  await page.getByRole('button', { name: 'Formula', exact: true }).click();
  const formula = page.getByRole('dialog', { name: 'Handwritten formula' });
  await expect(page.getByLabel('LaTeX · Editable')).toBeVisible();
  await page.getByRole('button', { name: 'Formula settings', exact: true }).click();
  await page.locator('.macro-library summary').click();
  await expect(page.getByLabel('Predefined commands', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'On-screen keyboard', exact: true }).click();
  await expect(page.locator('.hg-button[data-skbtn="{space}"]')).toHaveText('Space');
  await page.getByRole('button', { name: 'Close keyboard' }).click();
  await formula.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Sketch', exact: true }).click();
  await expect(page.locator('.excalidraw')).toBeVisible();
  await expect(page.locator('.excalidraw').getByTitle('Selection')).toBeVisible();
  await page.getByRole('button', { name: 'Save sketch and close' }).click();
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByLabel('Document name', { exact: true })).toHaveValue(
    '中文资料 competitive',
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('zh-CN');
  await expect(page.getByRole('heading', { name: '纸张与笔输入' })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: '对象', exact: true })).toBeVisible();
  await expect(page.getByLabel('文档名称', { exact: true })).toHaveValue('中文资料 competitive');
  expect(errors).toEqual([]);
});
test('英文划词翻译和朗读设置，以及 560px 竖屏按钮无水平溢出', async ({ page }) => {
  await english(page);
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('competitive environment', { x: 70, y: 700, size: 25, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'english.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select text', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('competitive environment');
  await page.locator('.textLayer span').first().dblclick();
  const tools = page.getByRole('dialog', { name: 'Text tools' });
  await expect(tools).toBeVisible();
  await tools.getByRole('button', { name: 'Translate', exact: true }).click();
  await page.getByRole('button', { name: 'Translation backend settings' }).click();
  await expect(page.getByLabel('Translation backend type')).toBeVisible();
  await expect(page.locator('.speech-settings summary')).toHaveText('Reading backend');
  await expect(page.locator('.translation-source')).toContainText(/competitive|environment/);
  await page.getByRole('button', { name: 'Close text tools' }).click();
  for (const width of [560, 768, 960]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.waitForTimeout(100);
    const overflow = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '.topbar button,.toolbar button,.workspace-controls button,.insert-dock button,.page-navigation button',
        ),
      )
        .filter((el) => el.offsetParent !== null)
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left < -1 || r.right > innerWidth + 1;
        })
        .map((el) => el.getAttribute('aria-label') || el.textContent),
    );
    expect(overflow).toEqual([]);
  }
  await page.screenshot({ path: 'test-results/english-portrait.png' });
});
