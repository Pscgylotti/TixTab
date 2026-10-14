import { test, expect } from '@playwright/test';
test('haptics intensity persists and pen contact on the page interaction layer starts/stops feedback', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).__hapticCalls = [];
    (window as any).surfaceDesktop = {
      onFullscreen: () => () => {},
      penHaptics: {
        run: async (action: string, value: unknown) => {
          (window as any).__hapticCalls.push([action, value]);
          return 'supported';
        },
        onStatus: () => () => {},
      },
    };
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('笔触振动反馈', { exact: true }).check();
  const slider = page.getByRole('slider', { name: '振动强度' });
  await slider.fill('75');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('tixtab.penHapticStrength')))
    .toBe('0.75');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.page-editor').dispatchEvent('pointerdown', {
    pointerType: 'pen',
    pointerId: 91,
    button: 0,
    buttons: 1,
    pressure: 0.5,
    clientX: 700,
    clientY: 500,
  });
  await page.locator('.page-editor').dispatchEvent('pointerup', {
    pointerType: 'pen',
    pointerId: 91,
    button: 0,
    buttons: 0,
    clientX: 700,
    clientY: 500,
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__hapticCalls.some((c: any) => c[0] === 'start' && c[1] === 'pen'),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__hapticCalls.some((c: any) => c[0] === 'stop')),
    )
    .toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('slider', { name: '振动强度' })).toHaveValue('75');
});
test('pen preview reserves fixed space at both ends of the nonlinear slider; fullscreen precedes expand', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const slider = page.getByRole('slider', { name: '笔触粗细' });
  await slider.focus();
  await slider.press('Home');
  const slot = page.locator('.size-preview-slot'),
    before = await slot.boundingBox(),
    input = await slider.boundingBox();
  await slider.press('End');
  expect(await slot.boundingBox()).toEqual(before);
  expect(await slider.boundingBox()).toEqual(input);
  await slider.press('Home');
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', '0.55');
  await page.getByRole('button', { name: '收起顶部区域', exact: true }).click();
  const full = (await page.locator('.header-fullscreen').boundingBox())!,
    expand = (await page.getByRole('button', { name: '展开顶部区域', exact: true }).boundingBox())!;
  expect(full.x + full.width).toBeLessThanOrEqual(expand.x + 1);
  expect(Math.abs(full.y - expand.y)).toBeLessThan(2);
});
test('Excalidraw eraser trail uses the viewport origin while its canvas is inset', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '草图', exact: true }).click();
  const canvas = page.locator('.sketch-editor canvas.interactive');
  await expect(canvas).toBeVisible();
  const bounds = (await canvas.boundingBox())!;
  expect(bounds.y).toBeGreaterThan(30);
  const overlay = page.locator('.sketch-editor .SVGLayer');
  const rect = (await overlay.boundingBox())!;
  expect(rect.x).toBe(0);
  expect(rect.y).toBe(0);
  await page.locator('.sketch-editor [data-testid="toolbar-eraser"]').check({ force: true });
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 15, bounds.y + bounds.height / 2, {
    steps: 3,
  });
  await expect(overlay.locator('path').last()).toHaveAttribute('d', /[ML]/);
  const path = (await overlay.locator('path').last().boundingBox())!;
  expect(Math.abs(path.y + path.height / 2 - (bounds.y + bounds.height / 2))).toBeLessThan(10);
  await page.mouse.up();
});
test('bitmap OCR parallel setting defaults to one, persists and is gated to Tesseract', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  await page.getByRole('button', { name: '解析位图', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '解析位图' });
  await dialog.locator('summary').click();
  const threads = dialog.getByLabel('并行任务数');
  await expect(threads).toHaveValue('1');
  await threads.selectOption('4');
  await dialog.getByLabel('OCR 后端').selectOption('native');
  await expect(threads).toBeDisabled();
  await dialog.getByLabel('OCR 后端').selectOption('local');
  await expect(threads).toBeEnabled();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  await page.getByRole('button', { name: '解析位图', exact: true }).click();
  await dialog.locator('summary').click();
  await expect(dialog.getByLabel('并行任务数')).toHaveValue('4');
});
