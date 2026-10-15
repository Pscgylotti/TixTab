import { test, expect } from '@playwright/test';

for (const native of [false, true]) {
  test(`review autofocus sets keyboard policy before first focus; native=${native}`, async ({
    page,
  }) => {
    await page.addInitScript((native) => {
      localStorage.setItem('surfacetab.nativeKeyboard', String(native));
      (window as any).reviewFocusModes = [];
      // Runs before app listeners and before MutationObserver preparation.
      document.addEventListener(
        'focusin',
        (event) => {
          const field = event.target as HTMLTextAreaElement;
          if (field.getAttribute('aria-label') === '便签内容')
            (window as any).reviewFocusModes.push(field.getAttribute('inputmode'));
        },
        true,
      );
    }, native);
    await page.goto('/');
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await page.getByRole('button', { name: '便签', exact: true }).click();
    const paper = (await page.locator('.paper').boundingBox())!;
    await page.mouse.move(paper.x + paper.width * 0.15, paper.y + paper.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(paper.x + paper.width * 0.5, paper.y + paper.height * 0.3, { steps: 4 });
    await page.mouse.up();
    const text = page.getByRole('textbox', { name: '便签内容', exact: true });
    await expect(text).toBeFocused();
    await expect(text).toHaveAttribute('inputmode', native ? 'text' : 'none');
    expect(await page.evaluate(() => (window as any).reviewFocusModes[0])).toBe(
      native ? 'text' : 'none',
    );
    await text.pressSequentially('Review');
    await expect(text).toHaveValue('Review');
    await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
    await page.getByRole('button', { name: '键盘设置', exact: true }).click();
    await page.getByLabel('使用系统触摸键盘', { exact: true }).setChecked(!native);
    await expect(text).toHaveAttribute('inputmode', !native ? 'text' : 'none');
    await page.getByRole('button', { name: '关闭屏幕键盘', exact: true }).click();
    await page.getByRole('button', { name: '关闭便签', exact: true }).click();
    await page.locator('.review-anchor').click();
    await expect(text).toBeFocused();
    await expect(text).toHaveValue('Review');
    expect(await page.evaluate(() => (window as any).reviewFocusModes.at(-1))).toBe(
      !native ? 'text' : 'none',
    );
    // The built-in keyboard still writes to the note when system keyboard is disabled.
    await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
    await page.getByRole('button', { name: '英文', exact: true }).click();
    await page.locator('.touch-keyboard [data-skbtn="q"]').click();
    await expect(text).toHaveValue(/q/);
  });
}

test('dynamic fields get synchronous pointer protection and removed fields restore their original policy', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const input = document.createElement('textarea');
    input.setAttribute('inputmode', 'text');
    document.body.append(input);
    // Same task: no mutation callback has run yet.
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen' }));
    const beforeFocus = input.getAttribute('inputmode');
    input.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { beforeFocus, removed: input.getAttribute('inputmode') };
  });
  expect(result).toEqual({ beforeFocus: 'none', removed: 'text' });
});
