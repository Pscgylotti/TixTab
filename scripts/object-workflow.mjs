import { expect } from '@playwright/test';

/** Actual UI actions, awaited through commit, decode, persistence and download.
 * No project bytes or screenshots cross DevTools inside these measured phases.
 */
export async function objectWorkflow({
  app,
  destinations,
  page,
  phase,
  waitSettled,
  click,
  fixture,
}) {
  if (fixture.description.profile !== 'object-edit' || fixture.description.objects !== 240)
    throw Error('Object editing requires the fixed object-edit fixture');
  const root = page.locator('.page-editor .object-layer').first();
  const selection = page.locator('.object-selection');
  const gesture = async (selector, from, to, steps = 24) => {
    await page
      .locator(selector)
      .first()
      .evaluate(
        async (el, { from, to, steps }) => {
          el.setPointerCapture = () => {};
          const r = el.closest('.page-editor').getBoundingClientRect();
          const base = {
            bubbles: true,
            pointerId: 37,
            pointerType: 'pen',
            button: 0,
            buttons: 1,
            pressure: 0.6,
          };
          const dispatch = (type, x, y) =>
            el.dispatchEvent(
              new PointerEvent(type, {
                ...base,
                clientX: r.x + (x / 595) * r.width,
                clientY: r.y + (y / 842) * r.height,
              }),
            );
          dispatch('pointerdown', ...from);
          for (let i = 1; i <= steps; i++) {
            dispatch(
              'pointermove',
              from[0] + ((to[0] - from[0]) * i) / steps,
              from[1] + ((to[1] - from[1]) * i) / steps,
            );
            await new Promise(requestAnimationFrame);
          }
          dispatch('pointerup', ...to);
          await new Promise(requestAnimationFrame);
        },
        { from, to, steps },
      );
  };
  const box = () =>
    selection.evaluate((el) => ({
      x: parseFloat(el.style.left),
      y: parseFloat(el.style.top),
      width: parseFloat(el.style.width),
      height: parseFloat(el.style.height),
    }));
  const downloads = [];
  // Electron native downloads do not emit Playwright's Chromium download event.
  // Direct them to the isolated profile and await the native completion state.
  await app.evaluate(({ BrowserWindow }, destinations) => {
    globalThis.qaObjectDownloads = [];
    BrowserWindow.getAllWindows()[0].webContents.session.on('will-download', (_, item) => {
      const kind = item.getFilename().endsWith('.pdf') ? 'pdf' : 'project';
      const record = {
        kind,
        path: destinations[kind],
        name: item.getFilename(),
        state: 'progressing',
      };
      globalThis.qaObjectDownloads.push(record);
      item.setSavePath(record.path);
      item.once('done', (_, state) => {
        record.state = state;
      });
    });
  }, destinations);
  const completedDownload = async (kind) => {
    let record;
    await expect
      .poll(
        async () => {
          record = await app.evaluate(
            (_, kind) => globalThis.qaObjectDownloads.find((r) => r.kind === kind),
            kind,
          );
          return record?.state;
        },
        { timeout: 60000, intervals: [100] },
      )
      .toBe('completed');
    downloads.push(record);
  };
  await phase('objects-select-move-resize', async () => {
    await click('对象');
    await gesture('.object-layer', [5, 5], [580, 820]);
    await expect(selection).toHaveAttribute('data-selected-count', '240');
    await gesture('.object-selection', [290, 400], [307, 410]);
    const before = await box();
    await gesture(
      '.object-handle.se',
      [before.x + before.width, before.y + before.height],
      [before.x + before.width - 40, before.y + before.height - 60],
    );
    await waitSettled();
    await expect(selection).toHaveAttribute('data-selected-count', '240');
  });
  await phase('objects-group-and-order', async () => {
    await click('组合选中对象');
    await expect(root).toHaveAttribute('data-total-objects', '1', { timeout: 30000 });
    await expect(selection).toHaveAttribute('data-selected-count', '1');
    await waitSettled();
    await click('排列顺序');
    for (let i = 0; i < 4; i++) {
      await click(i % 2 ? '上移一层' : '下移一层');
      await expect(page.getByRole('group', { name: '排列顺序', exact: true })).toBeVisible();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await click('排列顺序');
    await waitSettled();
  });
  await phase('objects-ungroup-undo-redo', async () => {
    await click('取消对象组合');
    await expect(root).toHaveAttribute('data-total-objects', '240');
    await page.keyboard.press('Control+z');
    await expect(root).toHaveAttribute('data-total-objects', '1');
    await page.keyboard.press('Control+y');
    await expect(root).toHaveAttribute('data-total-objects', '240');
    await waitSettled();
    // Re-select through the visible marquee, then leave a group for project/PDF export.
    await page.keyboard.press('Escape');
    await gesture('.object-layer', [5, 5], [580, 820]);
    await expect(selection).toHaveAttribute('data-selected-count', '240');
    await click('组合选中对象');
    await expect(root).toHaveAttribute('data-total-objects', '1', { timeout: 30000 });
    await waitSettled();
  });
  await phase('objects-project-and-pdf-export', async () => {
    await page.keyboard.press('Control+s');
    await completedDownload('project');
    await click('导出 PDF');
    await completedDownload('pdf');
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await waitSettled();
    await page.keyboard.press('Escape');
  });
  return downloads;
}
