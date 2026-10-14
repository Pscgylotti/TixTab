import { test, expect } from '@playwright/test';
import { waitForPerformanceSettled } from '../scripts/performance-settle.mjs';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');

test('completion diagnostics are absent by default and do not change selection cursor thickness', async ({
  page,
}) => {
  await page.goto('/');
  expect(await page.evaluate(() => window.tixtabPerformance)).toBeUndefined();
});

test('completion gate observes deferred PDF/copy/save work, real formula IDB writes, zoom and restore', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('tixtab.performance.enabled', 'true'));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
  await waitForPerformanceSettled(page);
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('Completion gate selection', { x: 85, y: 690, size: 20, font });
  doc.addPage([595, 842]).drawText('Second page', { x: 85, y: 690, size: 20, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'completion.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const imported = await waitForPerformanceSettled(page);
  expect(imported.ledger.pending).toBe(0);
  expect(imported.visibleBackgrounds).toBeGreaterThan(0);
  expect(imported.ledger.stages['pdf-raster'].completed).toBeGreaterThan(0);
  expect(imported.ledger.stages['workspace-transaction'].completed).toBeGreaterThan(0);
  expect(imported.ledger.counters.workspacePageWrites).toBeGreaterThan(0);
  await page.getByRole('button', { name: '选文', exact: true }).click();
  const box = (await page.locator('.textLayer span').first().boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await expect(page.locator('.pdf-selection-caret')).toBeVisible();
  const caret = await page.locator('.pdf-selection-caret').evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    shadow: getComputedStyle(el).boxShadow,
  }));
  expect(caret).toEqual({ width: 1, shadow: 'none' });
  for (const mode of ['连续页面预览', '双页预览', '单页标注']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await page.getByRole('button', { name: '放大', exact: true }).click();
    expect((await waitForPerformanceSettled(page)).ledger.pending).toBe(0);
  }
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  const night = await waitForPerformanceSettled(page);
  expect(night.ledger.stages['pdf-night'].completed).toBeGreaterThan(0);
  await page.getByRole('button', { name: '公式', exact: true }).click();
  const source = page.getByLabel('LaTeX · 可直接修改');
  await expect(source).toBeEnabled();
  await source.fill('x^2+1');
  await source.press('ArrowLeft');
  await page
    .getByRole('dialog', { name: '手写公式', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  const saved = await waitForPerformanceSettled(page);
  expect(saved.ledger.counters.formulaWrites).toBeGreaterThan(0);
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await expect(source).toHaveValue('x^2+1');
  expect(
    (await waitForPerformanceSettled(page)).ledger.stages['formula-load'].completed,
  ).toBeGreaterThan(1);
  const snapshot = await page.evaluate(() => window.tixtabPerformance!.snapshot());
  expect(JSON.stringify(snapshot)).not.toContain('x^2+1');
  expect(JSON.stringify(snapshot)).not.toContain('completion.pdf');
});

test('completion gate rejects missing diagnostics and pending work beyond its deadline', async ({
  page,
}) => {
  await page.goto('/');
  await expect(waitForPerformanceSettled(page, { timeoutMs: 1000 })).rejects.toThrow(
    'Completion diagnostics missing',
  );
  await page.addInitScript(() => localStorage.setItem('tixtab.performance.enabled', 'true'));
  await page.reload();
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
  await waitForPerformanceSettled(page);
  // An actual tracked async operation, not a made-up ready flag.
  await page.evaluate(async () => {
    const { trackPerformance } = await import('/src/performanceLedger.ts');
    void trackPerformance('pdf-page', () => new Promise((resolve) => setTimeout(resolve, 1200)));
  });
  await expect(waitForPerformanceSettled(page, { timeoutMs: 300, quietMs: 100 })).rejects.toThrow(
    'Workflow completion deadline exceeded',
  );
  const done = await waitForPerformanceSettled(page, { quietMs: 100 });
  expect(done.ledger.stages['pdf-page'].completed).toBe(1);
  expect(done.ledger.pending).toBe(0);
});
