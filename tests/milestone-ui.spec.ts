import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');

async function settings(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  return page.getByRole('dialog', { name: '设置与笔诊断' });
}
test('paper choice works on original PDFs for new blank pages and persists in all views/themes', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles({
    name: 'Paper.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('.paper')).toHaveAttribute('data-pdf-source', '0');
  let dialog = await settings(page);
  await dialog.getByRole('button', { name: '横线', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '横线', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog).toContainText('纸张设置应用于新插入的空白页');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.paper')).toHaveClass(/paper-plain/);
  await page.getByRole('button', { name: '插入空白页', exact: true }).click();
  await expect(page.locator('.paper')).toHaveClass(/paper-lines/);
  for (const night of [false, true]) {
    if (night) await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    for (const view of ['单页标注', '连续页面预览', '双页预览']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      for (const [label, kind] of [
        ['纯白', 'plain'],
        ['点阵', 'dots'],
        ['横线', 'lines'],
      ]) {
        dialog = await settings(page);
        await dialog.getByRole('button', { name: label, exact: true }).click();
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        const blank = page
          .locator('.paper[data-pdf-source=""],.reading-paper[data-pdf-source=""]')
          .first();
        await expect(blank).toHaveClass(new RegExp(`paper-${kind}`));
        const pattern = await blank.evaluate(
          (el) =>
            getComputedStyle(el, el.classList.contains('paper') ? '::after' : null).backgroundImage,
        );
        expect(kind === 'plain' ? pattern === 'none' : pattern.includes('gradient')).toBe(true);
      }
    }
  }
  // Wait for the actual workspace transaction, rather than assuming a UI click saved to disk.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { listWorkspace, loadWorkspaceDocument } = await import(
          '/src/workspaceStore.ts' as string
        );
        const { documents } = await listWorkspace();
        const saved = await loadWorkspaceDocument(
          documents.find((d: { name: string }) => d.name === 'Paper')!.id,
          false,
        );
        return `${saved?.meta.view.mode}:${saved?.notebook.pages[1]?.paper}`;
      }),
    )
    .toBe('dual:lines');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.locator('.reading-paper.paper-lines')).toHaveCount(1);
  await page.getByRole('button', { name: '插入空白页', exact: true }).click();
  await expect(page.locator('.reading-paper.paper-lines')).toHaveCount(1);
});

test('pen/touch long press offers clipboard editing in password and ordinary fields without changing values on open', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '打开 ChatGPT 聊天', exact: true }).click();
  await page.getByLabel('聊天接入方式', { exact: true }).selectOption('api');
  const key = page.getByLabel('聊天 API 密钥', { exact: true });
  await key.fill('old-fixture');
  await key.evaluate((el: HTMLInputElement) => el.setSelectionRange(0, el.value.length));
  await page.evaluate(() => navigator.clipboard.writeText('new-fixture'));
  await key.evaluate((el) =>
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'pen',
        pointerId: 22,
        button: 0,
        clientX: el.getBoundingClientRect().left + 10,
        clientY: el.getBoundingClientRect().top + 10,
      }),
    ),
  );
  const menu = page.getByRole('menu', { name: '文本编辑' });
  await expect(menu).toBeVisible();
  await expect(key).toHaveValue('old-fixture');
  await expect(menu.getByRole('menuitem', { name: '复制', exact: true })).toBeDisabled();
  await menu.getByRole('menuitem', { name: '粘贴', exact: true }).click();
  await expect(key).toHaveValue('new-fixture');
  await expect(menu).toHaveCount(0);
  const model = page.getByLabel('聊天 API 模型', { exact: true });
  await model.fill('fixture model');
  await model.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '全选', exact: true }).click();
  await menu.getByRole('menuitem', { name: '复制', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('fixture model');
  // Moving a finger before the hold threshold scrolls/selects normally and never opens the menu.
  await model.evaluate((el) => {
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        pointerId: 23,
        button: 0,
      }),
    );
    el.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'touch',
        pointerId: 23,
        clientX: 30,
      }),
    );
    el.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 23 }),
    );
  });
  await page.waitForTimeout(550);
  await expect(menu).toHaveCount(0);
});
