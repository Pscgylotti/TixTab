import { test, expect, type Page } from '@playwright/test';
async function draw(page: Page, y: number) {
  await page.locator('.formula-canvas').evaluate((el, y) => {
    const c = el as HTMLCanvasElement;
    c.setPointerCapture = () => {};
    const r = c.getBoundingClientRect(),
      base = {
        bubbles: true,
        pointerId: 9,
        pointerType: 'pen',
        button: 0,
        buttons: 1,
        pressure: 0.5,
      };
    const event = (type: string, x: number, dy = 0) =>
      c.dispatchEvent(
        new PointerEvent(type, {
          ...base,
          clientX: r.x + (x / 960) * r.width,
          clientY: r.y + ((y + dy) / c.height) * r.height,
        }),
      );
    event('pointerdown', 70);
    event('pointermove', 130, 20);
    event('pointermove', 190);
    event('pointerup', 190);
  }, y);
}
test('多行手写逐行串行识别、合并预览和插入，Uni-MuMER 显示 GPU 与 CPU 选择', async ({ page }) => {
  let calls = 0,
    active = 0;
  const images: string[] = [];
  await page.route('http://127.0.0.1:8766/**', async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: {
          engine: 'Texo OpenVINO',
          devices: [{ id: 'GPU', name: 'Intel' }],
          capabilities: ['unimumer-experimental', 'release-idle'],
        },
      });
    if (route.request().url().endsWith('/models/release'))
      return route.fulfill({ json: { ok: true, loaded: false } });
    expect(route.request().url()).toContain('/recognize-unimumer');
    expect(route.request().postDataJSON().device).toBe('GPU');
    active++;
    expect(active).toBe(1);
    images.push(route.request().postDataJSON().image);
    const n = ++calls;
    await new Promise((resolve) => setTimeout(resolve, 80));
    active--;
    await route.fulfill({
      json: {
        latex: n === 1 ? '$$x=1$$' : '\\[y=2\\]',
        encoderDevice: 'GPU',
        decoderDevice: 'GPU',
        timing: { totalMs: 100 },
        fallback: false,
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await expect(page.getByLabel('公式识别后端')).toBeHidden();
  await expect(page.getByRole('button', { name: '公式设置', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await page.getByLabel('公式识别后端').selectOption('unimumer');
  await expect(page.getByLabel('推理设备').locator('option')).toHaveCount(3);
  await page.getByLabel('推理设备').selectOption('GPU');
  await page.getByLabel('多行手写公式', { exact: true }).check();
  await draw(page, 100);
  const ink = await page
    .locator('.formula-canvas')
    .evaluate((el) => (el as HTMLCanvasElement).toDataURL());
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await expect(page.getByLabel('公式识别后端')).toBeHidden();
  expect(
    await page.locator('.formula-canvas').evaluate((el) => (el as HTMLCanvasElement).toDataURL()),
  ).toBe(ink);
  await draw(page, 350);
  await page.getByRole('button', { name: '识别手写公式', exact: true }).click();
  await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue(
    '\\begin{aligned}\nx=1 \\\\\ny=2\n\\end{aligned}',
  );
  expect(calls).toBe(2);
  expect(images.every((i) => i.startsWith('data:image/png;base64,'))).toBe(true);
  await expect(page.locator('.formula-status')).toContainText('识别行数：2');
  await expect(page.locator('.formula-preview .katex-error')).toHaveCount(0);
  await expect(page.locator('.formula-preview .mtable')).toBeVisible();
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await page.getByLabel('多行手写公式', { exact: true }).click();
  await expect(page.getByLabel('多行手写公式', { exact: true })).toBeChecked();
  await expect(page.locator('.formula-status')).toContainText('清空');
  await page.getByRole('button', { name: '插入当前页', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '手写公式' })).toHaveCount(0);
  await expect(page.locator('.placed-object img')).toHaveCount(1);
});
test('多行批处理取消不会覆盖既有公式，也不会继续发送后续行', async ({ page }) => {
  let calls = 0;
  await page.route('https://formula.test/**', async (route) => {
    const n = ++calls;
    if (n === 2) await new Promise((resolve) => setTimeout(resolve, 700));
    await route.fulfill({ json: { latex: n === 1 ? 'x=1' : 'y=2' } }).catch(() => {});
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  await page.getByLabel('公式识别后端').selectOption('web');
  await page.getByLabel('公式接口地址').fill('https://formula.test/recognize');
  await page.getByLabel('LaTeX · 可直接修改').fill('z=3');
  await page.getByLabel('多行手写公式', { exact: true }).check();
  for (const y of [70, 240, 440]) await draw(page, y);
  await page.getByRole('button', { name: '识别手写公式', exact: true }).click();
  await expect.poll(() => calls).toBe(2);
  await expect(page.getByLabel('LaTeX · 可直接修改')).toBeDisabled();
  await page.getByRole('button', { name: '取消识别', exact: true }).click();
  await page.waitForTimeout(800);
  expect(calls).toBe(2);
  await expect(page.getByLabel('LaTeX · 可直接修改')).toHaveValue('z=3');
  await expect(page.locator('.formula-status')).toHaveText('已取消');
  await page.getByRole('button', { name: '清空画板', exact: true }).click();
  await page.getByLabel('多行手写公式', { exact: true }).uncheck();
  await expect(page.locator('.formula-canvas')).toHaveAttribute('height', '320');
});
test('完全收起合并顶部区域，紧凑栏提供更多页面空间并保留恢复入口', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  for (const width of [560, 960, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole('button', { name: '收起顶部区域', exact: true }).click();
    await page.getByRole('button', { name: '收起工具栏', exact: true }).click();
    const previous = await page.locator('.canvas-container').evaluate((el) => el.clientHeight);
    await page.getByRole('button', { name: '收起底部工具', exact: true }).click();
    await expect(page.locator('.app-shell')).toHaveClass(/chrome-minimal/);
    expect(
      await page.locator('.canvas-container').evaluate((el) => el.clientHeight),
    ).toBeGreaterThan(previous + 40);
    expect((await page.locator('.document-tabs').boundingBox())!.height).toBeLessThanOrEqual(36);
    expect((await page.locator('.statusbar').boundingBox())!.height).toBeLessThanOrEqual(36);
    await page.getByRole('button', { name: '下一页', exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '公式', exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '公式', exact: true }).click();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '展开顶部区域', exact: true }).click();
    await page.getByRole('button', { name: '展开工具栏', exact: true }).click();
    await page.getByRole('button', { name: '展开底部工具', exact: true }).click();
  }
});
