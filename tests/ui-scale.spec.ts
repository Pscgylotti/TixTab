import { expect, test } from '@playwright/test';

test('UI scale commits on release, persists and resets; English labels are supported', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).__uiScaleCalls = [];
    window.surfaceDesktop = {
      onFullscreen: () => () => {},
      setUiScale: (value: number) => {
        (window as any).__uiScaleCalls.push(value);
        return true;
      },
    } as any;
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const scale = page.getByRole('slider', { name: '界面放大倍率', exact: true });
  await expect(scale).toHaveValue('2');
  await expect(scale).toHaveAttribute('min', '0.5');
  await expect(scale).toHaveAttribute('max', '4');
  await scale.fill('0.5');
  expect(await page.evaluate(() => localStorage.getItem('tixtab.uiScale'))).toBeNull();
  await scale.dispatchEvent('pointerup');
  expect(await page.evaluate(() => localStorage.getItem('tixtab.uiScale'))).toBe('0.5');
  await scale.fill('4');
  await scale.dispatchEvent('pointerup');
  expect(await page.evaluate(() => (window as any).__uiScaleCalls.at(-1))).toBe(4);
  await page.reload();
  expect(await page.evaluate(() => (window as any).__uiScaleCalls[0])).toBe(4);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(scale).toHaveValue('4');
  await page.getByRole('button', { name: '恢复默认界面倍率', exact: true }).click();
  await expect(scale).toHaveValue('2');
  await page.getByLabel('界面语言 / Interface language', { exact: true }).selectOption('en');
  await expect(page.getByRole('slider', { name: 'Interface scale', exact: true })).toHaveValue('2');
  await page.screenshot({ path: '.cache/ui-scale-settings.png' });
});
