import { test, expect, type Page } from '@playwright/test';
async function fixture(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
  const notebook = await page.evaluate(async () => {
    const m = await import('/src/model.ts' as string),
      n = m.newNotebook();
    n.name = 'Score gestures';
    n.pages = [0, 1, 2].map((index) => ({
      ...m.blankPage(600, 800),
      id: `score-${index}`,
      score: {
        version: 1,
        engine: 'import',
        musicxml: '<score-partwise/>',
        tempo: 120,
        duration: 12,
        positioning: 'layout',
        systems: [0, 1, 2].map((i) => ({ x: 0.1, y: 0.12 + i * 0.3, width: 0.8, height: 0.12 })),
        notes: Array.from({ length: 6 }, (_, i) => ({
          id: `note-${i}`,
          sourceId: `note-${i}`,
          midi: 60 + i,
          beat: i * 2,
          duration: 2,
          measure: String(i + 1),
          part: 'p',
          system: Math.floor(i / 2),
          region: {
            x: 0.2 + (i % 2) * 0.4,
            y: 0.16 + Math.floor(i / 2) * 0.3,
            width: 0.02,
            height: 0.03,
          },
        })),
      },
    }));
    n.musicPlayer = { open: true, output: 'internal' };
    return n;
  });
  await page.locator('input[type=file]').setInputFiles({
    name: 'Score gestures.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(notebook)),
  });
  await expect(page.getByRole('textbox', { name: '文档名称', exact: true })).toHaveValue(
    'Score gestures',
  );
  await expect(page.getByLabel('五线谱播放器', { exact: true })).toBeVisible();
}
for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
  test(`fullscreen score taps seek real playback, while dragging does not seek in ${mode}`, async ({
    page,
  }) => {
    await fixture(page);
    await page.getByRole('button', { name: mode, exact: true }).click();
    await page.getByRole('button', { name: '展示全屏', exact: true }).click();
    const layer = page.locator(
      '.presentation-view .music-score-layer[data-score-page-id="score-0"]',
    );
    await expect(layer).toBeAttached();
    const rect = (await layer.boundingBox())!,
      x = rect.x + rect.width * 0.61,
      y = rect.y + rect.height * 0.18;
    await page.mouse.click(x, y);
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await import('/src/musicTransport.ts' as string)).getScoreCursor().beat,
        ),
      )
      .toBe(2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 60, y + 30, { steps: 5 });
    await page.mouse.up();
    expect(
      await page.evaluate(
        async () => (await import('/src/musicTransport.ts' as string)).getScoreCursor().beat,
      ),
    ).toBe(2);
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('乐谱进度', { exact: true })).toHaveValue('2');
  });
}
test('continuous presentation reveals the current system with intermediate scroll frames and no page-top snap', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  await page.getByRole('button', { name: '展示全屏', exact: true }).click();
  const view = page.locator('.presentation-view .reading-view');
  await expect(view).toBeVisible();
  await view.evaluate((el) => {
    (window as any).scoreScrolls = [];
    el.addEventListener('scroll', () => (window as any).scoreScrolls.push(el.scrollTop));
  });
  const before = await view.evaluate((el) => el.scrollTop);
  await page.evaluate(async () => {
    const t = await import('/src/musicTransport.ts' as string);
    t.getScoreCursor().seek('score-0', 8, 'note-4');
  });
  await expect.poll(() => view.evaluate((el) => el.scrollTop)).toBeGreaterThan(before + 400);
  await expect
    .poll(() => page.evaluate(() => (window as any).scoreScrolls.length))
    .toBeGreaterThan(3);
  const rowPosition = () =>
    page
      .locator('.presentation-view .music-score-layer[data-score-page-id="score-0"]')
      .evaluate((el) => {
        const box = el.getBoundingClientRect();
        return box.top + box.height * 0.72;
      });
  await expect.poll(rowPosition).toBeCloseTo(960 * 0.22, -1);
  const rowTop = await view.evaluate((el) => el.scrollTop);
  await page.evaluate(async () => {
    const t = await import('/src/musicTransport.ts' as string);
    t.getScoreCursor().seek('score-0', 10, 'note-5');
  });
  await expect
    .poll(async () => Math.abs((await view.evaluate((el) => el.scrollTop)) - rowTop))
    .toBeLessThanOrEqual(2);
  await page.evaluate(async () => {
    const t = await import('/src/musicTransport.ts' as string);
    t.getScoreCursor().seek('score-1', 0, 'note-0');
  });
  await expect(page.locator('.presentation-view')).toHaveAttribute('data-page-index', '1');
  await expect
    .poll(() =>
      page
        .locator('.presentation-view .music-score-layer[data-score-page-id="score-1"]')
        .evaluate((el) => {
          const b = el.getBoundingClientRect();
          return b.top + b.height * 0.12;
        }),
    )
    .toBeCloseTo(960 * 0.22, -1);
});
