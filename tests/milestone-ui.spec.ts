import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');

async function settings(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  return page.getByRole('dialog', { name: '设置与笔诊断' });
}
test('blank page options live in insertion dialog; colored patterns persist in all views and themes', async ({
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
  const controls = page.getByRole('group', { name: '页面操作' });
  expect(await controls.getByRole('button').count()).toBe(3);
  const boxes = await controls
    .getByRole('button')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThan(2);
  for (const [label, kind] of [
    ['空白', 'plain'],
    ['点阵', 'dots'],
    ['格子', 'grid'],
    ['横线', 'lines'],
    ['细密格子', 'fine-grid'],
  ]) {
    await controls.getByRole('button', { name: '插入空白页', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '插入空白页', exact: true });
    await dialog.getByRole('button', { name: label, exact: true }).click();
    await dialog.getByRole('button', { name: '纸张颜色 #fff7e6', exact: true }).click();
    await dialog.getByRole('button', { name: '插入页面', exact: true }).click();
    await expect(page.locator('.paper')).toHaveClass(new RegExp(`paper-${kind}`));
    await expect(page.locator('.paper')).toHaveCSS('background-color', 'rgb(255, 247, 230)');
  }
  const dialog = await settings(page);
  await expect(dialog.getByText('空白页纸张', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await expect(page.locator('.reading-paper.paper-fine-grid')).toBeVisible();
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await expect(page.locator('.reading-paper.paper-fine-grid')).not.toHaveCSS(
    'background-color',
    'rgb(255, 247, 230)',
  );
  await page.getByRole('button', { name: '双页预览', exact: true }).click();
  await expect(page.locator('.reading-paper.paper-fine-grid')).toBeVisible();
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  await expect(page.locator('.paper')).toHaveClass(/paper-fine-grid/);
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
        return saved?.notebook.pages.at(-1)?.paperColor;
      }),
    )
    .toBe('#fff7e6');
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PDF', exact: true }).click();
  await (await saved).saveAs('.cache/page-editing/paper-styles.pdf');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.locator('.paper')).toHaveClass(/paper-fine-grid/);
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
