import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
async function prepare(page: Page) {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('competitive', { x: 230, y: 440, size: 24, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'selection-layout.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '选文', exact: true }).click();
}
async function select(page: Page) {
  const point = await page
    .locator('.textLayer span')
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild!, 2);
      range.setEnd(el.firstChild!, 3);
      const box = range.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
  await page.mouse.dblclick(point.x, point.y);
  await expect(page.locator('.selection-flyout')).toBeVisible();
  expect(
    await page.locator('.selection-flyout').evaluate((el) => {
      const panel = el.getBoundingClientRect(),
        last = el.querySelector('.selection-actions')!.lastElementChild!.getBoundingClientRect();
      return panel.right - last.right < 15;
    }),
  ).toBe(true);
  return point;
}
async function checkGeometry(page: Page) {
  await expect
    .poll(() =>
      page.locator('.selection-flyout').evaluate((el) => {
        const panel = el.getBoundingClientRect(),
          range = getSelection()!.getRangeAt(0).getBoundingClientRect();
        return (
          panel.x >= 0 &&
          panel.y >= 0 &&
          panel.right <= innerWidth &&
          panel.bottom <= innerHeight &&
          !(
            panel.x < range.right &&
            panel.right > range.x &&
            panel.y < range.bottom &&
            panel.bottom > range.y
          )
        );
      }),
    )
    .toBe(true);
}

test('blank page clicks dismiss selection flyout; controls preserve it in every view', async ({
  page,
}) => {
  await prepare(page);
  for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await select(page);
    await page.getByRole('button', { name: '翻译', exact: true }).click();
    await page.getByRole('button', { name: '翻译后端设置', exact: true }).click();
    await expect(page.locator('.selection-flyout')).toBeVisible();
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('competitive');
    const blank = (await page.locator('.textLayer').first().boundingBox())!;
    await page.mouse.click(blank.x + blank.width - 25, blank.y + 25);
    await expect(page.locator('.selection-flyout')).toHaveCount(0);
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('');
    await select(page);
    await page
      .locator('.textLayer')
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const init = {
          bubbles: true,
          pointerType: 'pen',
          pointerId: 78,
          button: 0,
          clientX: r.right - 25,
          clientY: r.top + 25,
        };
        el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1, pressure: 0.5 }));
        el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pressure: 0 }));
      });
    await expect(page.locator('.selection-flyout')).toHaveCount(0);
  }
});

test('resident native translation starts on the first flyout Translate click', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('surfacetab.opusExperimental', 'true'));
  let translations = 0;
  await page.route('http://127.0.0.1:8766/**', async (route) => {
    if (route.request().url().endsWith('/health'))
      await route.fulfill({
        json: {
          ok: true,
          engine: 'Texo OpenVINO',
          devices: [],
          capabilities: ['translate-experimental'],
          loaded: true,
          modelKind: ['opus', 'en-zh'],
        },
      });
    else if (route.request().url().endsWith('/translate')) {
      translations++;
      await route.fulfill({
        json: {
          translation: '有竞争力的',
          encoderDevice: 'NPU',
          decoderDevice: 'CPU',
          timing: { totalMs: 1 },
        },
      });
    } else await route.fulfill({ json: {} });
  });
  await prepare(page);
  await select(page);
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(page.locator('.translation-result')).toContainText('有竞争力的');
  expect(translations).toBe(1);
});
test('writing hand switches panel side, survives reload and preserves selection during controls', async ({
  page,
}) => {
  await prepare(page);
  const point = await select(page);
  await checkGeometry(page);
  await expect(page.locator('.selection-flyout')).toHaveAttribute('data-placement', 'left');
  const panel = (await page.locator('.selection-flyout').boundingBox())!;
  expect(panel.x + panel.width).toBeLessThan(point.x - 32);
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(page.getByLabel('远程失败回退本地', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '翻译后端设置', exact: true }).click();
  await page.getByLabel('远程失败回退本地', { exact: true }).uncheck();
  await page.getByRole('button', { name: '翻译后端设置', exact: true }).click();
  await expect(page.getByLabel('远程失败回退本地', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '翻译后端设置', exact: true }).click();
  await expect(page.getByLabel('远程失败回退本地', { exact: true })).not.toBeChecked();
  await page.getByLabel('远程失败回退本地', { exact: true }).check();
  await page.getByRole('button', { name: '翻译后端设置', exact: true }).click();
  await checkGeometry(page);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('competitive');
  await page.getByRole('button', { name: '关闭划词工具' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('书写惯用手').selectOption('left');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await select(page);
  await expect(page.locator('.selection-flyout')).toHaveAttribute('data-placement', 'right');
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await select(page);
  await expect(page.locator('.selection-flyout')).toHaveAttribute('data-writing-hand', 'left');
  await checkGeometry(page);
});
test('expanded settings fit night portrait and short windows with reachable 44px controls', async ({
  page,
}) => {
  await prepare(page);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await select(page);
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await page.getByRole('button', { name: '翻译后端设置', exact: true }).click();
  await page.getByLabel('翻译后端类型').selectOption('llm');
  for (const size of [
    { width: 560, height: 900 },
    { width: 768, height: 600 },
    { width: 1440, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await checkGeometry(page);
    const controls = await page
      .locator('.selection-flyout :is(button,a,select)')
      .evaluateAll((els) =>
        els.map((el) => {
          const box = el.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
      );
    expect(controls.every((box) => box.width >= 44 && box.height >= 44)).toBe(true);
    await page.locator('.translation-footer .primary').scrollIntoViewIfNeeded();
    await expect(page.locator('.translation-footer .primary')).toBeInViewport();
    const light = await page.locator('.selection-flyout').evaluate((root) =>
      [root, ...root.querySelectorAll('*')]
        .filter((el) => {
          const rgb = getComputedStyle(el)
            .backgroundColor.match(/[\d.]+/g)
            ?.map(Number);
          return rgb?.slice(0, 3).every((n) => n > 170) && (rgb[3] ?? 1) > 0.3;
        })
        .map((el) => el.className),
    );
    expect(light).toEqual([]);
  }
  await page.setViewportSize({ width: 560, height: 900 });
  await page.screenshot({ path: 'test-results/selection-layout-night-portrait.png' });
});
test('panel follows reading scroll and avoids the floating keyboard while preserving selection', async ({
  page,
}) => {
  await prepare(page);
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await select(page);
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await page.getByRole('button', { name: '屏幕键盘', exact: true }).click();
  await expect(page.locator('.touch-keyboard')).toBeVisible();
  await checkGeometry(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const p = document.querySelector('.selection-flyout')!.getBoundingClientRect(),
          k = document.querySelector('.touch-keyboard')!.getBoundingClientRect();
        return !(p.x < k.right && p.right > k.x && p.y < k.bottom && p.bottom > k.y);
      }),
    )
    .toBe(true);
  const text = await page.evaluate(() => getSelection()?.toString());
  await page.locator('.reading-view').evaluate((el) => {
    el.scrollTop += 100;
  });
  await checkGeometry(page);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(text);
});
