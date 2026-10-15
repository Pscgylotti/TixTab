import { test, expect } from '@playwright/test';
test('pick color, inclusive RGB tolerance, reversible full-resolution transparency and reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.locator('.paper').evaluate(async (element) => {
    const c = document.createElement('canvas');
    c.width = 60;
    c.height = 20;
    const ctx = c.getContext('2d')!;
    for (const [i, color] of ['#ffffff', '#fcfdfe', '#fbffff'].entries()) {
      ctx.fillStyle = color;
      ctx.fillRect(i * 20, 0, 20, 20);
    }
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!))),
      data = new DataTransfer();
    data.items.add(new File([blob], 'key.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByLabel('图片对象', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '设置透明色', exact: true }).click();
  await expect(page.getByLabel('透明色范围', { exact: true })).toHaveValue('3');
  const source = page.getByAltText('透明色取色图', { exact: true });
  await source.click({ position: { x: 5, y: 5 } });
  await expect(page.getByLabel('透明颜色', { exact: true })).toHaveValue('#ffffff');
  await page.getByRole('button', { name: '应用透明色', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置透明色', exact: true })).toHaveCount(0);
  const image = page.locator('.placed-object img');
  const pixels = await image.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    const c = document.createElement('canvas');
    c.width = 60;
    c.height = 20;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(el, 0, 0, 60, 20);
    return [5, 25, 45].map((x) => ctx.getImageData(x, 5, 1, 1).data[3]);
  });
  expect(pixels).toEqual([0, 0, 255]);
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '对象', exact: true }).click();
  await page.locator('.placed-object').click();
  await page.getByRole('button', { name: '设置透明色', exact: true }).click();
  await expect(page.getByLabel('透明色范围', { exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: '恢复原图', exact: true }).click();
  const alpha = await image.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(el, 0, 0, 1, 1);
    return ctx.getImageData(0, 0, 1, 1).data[3];
  });
  expect(alpha).toBe(255);
});
