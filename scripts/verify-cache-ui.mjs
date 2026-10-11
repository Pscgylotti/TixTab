import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

// Safe on the user's real cache: only inspect metadata and cancel confirmation.
// Deletion is verified separately with a temporary LOCALAPPDATA fixture.
export async function verifyCacheUi(page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '磁盘缓存管理', exact: true }).click();
  assert.equal(await page.locator('.cache-card').count(), 0);
  await page.getByRole('button', { name: '统计缓存', exact: true }).click();
  await expect(page.locator('.cache-card')).toHaveCount(8, { timeout: 35000 });
  assert.deepEqual(
    (
      await page.locator('.cache-card').evaluateAll((els) => els.map((el) => el.dataset.cacheId))
    ).sort(),
    [
      'texo-compiled',
      'opus-compiled',
      'ocr-compiled',
      'piper-compiled',
      'extracted',
      'browser-transformers',
      'browser-tesseract',
      'browser-piper',
    ].sort(),
  );
  for (const id of ['browser-transformers', 'browser-tesseract', 'browser-piper'])
    assert.doesNotMatch(
      await page.locator(`[data-cache-id=${id}]`).innerText(),
      /缓存服务不可用|缓存操作失败/,
      'Browser storage metadata unavailable: ' + id,
    );
  const sizes = await page
    .locator('.cache-manager button')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  assert.ok(sizes.every((h) => h >= 44));
  await page.getByRole('button', { name: '关闭缓存管理' }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Disk cache management', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Disk cache management' })).toBeVisible();
  await page.getByRole('button', { name: 'Close cache management' }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('zh-CN');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  console.log(
    'Packaged cache manager / on-demand native metadata / browser categories / 44px / English: verified; real caches unchanged',
  );
}
