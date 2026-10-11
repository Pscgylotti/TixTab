import { test, expect, type Page } from '@playwright/test';

async function seed(page: Page) {
  await page.evaluate(async () => {
    const cache = await caches.open('transformers-cache');
    await cache.put(
      '/models/fixture.onnx',
      new Response('fixture', { headers: { 'content-length': '7' } }),
    );
    await cache.put('/models/no-size.onnx', new Response('unknown size'));
    await (await caches.open('personal-cache')).put('/personal-note', new Response('keep'));
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('keyval-store');
      req.onupgradeneeded = () => req.result.createObjectStore('keyval');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result,
          tx = db.transaction('keyval', 'readwrite'),
          store = tx.objectStore('keyval');
        store.put(new Uint8Array([1, 2, 3]), './eng.traineddata');
        store.put(new Uint8Array([4, 5]), 'chi_sim.traineddata');
        store.put(
          { name: 'Legacy notebook', pages: [{ id: 'preserve-me' }] },
          'surfacetab-notebook-v1',
        );
        store.put('keep personal', 'other-key');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    const root = await navigator.storage.getDirectory(),
      piper = await root.getDirectoryHandle('piper', { create: true });
    for (const name of [
      'en_US-lessac-low.onnx',
      'en_US-lessac-low.onnx.json',
      'zh_CN-huayan-x_low.onnx',
      'zh_CN-huayan-x_low.onnx.json',
      'personal.onnx',
    ]) {
      const file = await piper.getFileHandle(name, { create: true }),
        writer = await file.createWritable();
      await writer.write('fixture');
      await writer.close();
    }
    const file = await root.getFileHandle('workspace-sentinel', { create: true }),
      writer = await file.createWritable();
    await writer.write('keep');
    await writer.close();
  });
}

async function open(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '磁盘缓存管理', exact: true }).click();
}

test('cache inspection is on demand, no weights load, supports English night portrait and confirmation', async ({
  page,
}) => {
  let weights = 0;
  page.on('request', (r) => {
    if (/\.(onnx|traineddata|wasm)(?:\?|$)/.test(r.url())) weights++;
  });
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await seed(page);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await open(page);
  await expect(page.locator('.cache-card')).toHaveCount(0);
  await page.getByRole('button', { name: '统计缓存', exact: true }).click();
  await expect(page.locator('.cache-card')).toHaveCount(3);
  await expect(page.locator('[data-cache-id=browser-transformers]')).toContainText(
    '1 项大小未统计',
  );
  await expect(page.locator('[data-cache-id=browser-tesseract]')).toContainText('2 个文件');
  await expect(page.locator('[data-cache-id=browser-tesseract]')).toContainText(
    '保留 2 项其它数据',
  );
  await expect(page.locator('[data-cache-id=browser-piper]')).toContainText('4 个文件');
  await page.locator('[data-cache-id=browser-piper] button').click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory(),
        piper = await root.getDirectoryHandle('piper');
      return (await piper.getFileHandle('en_US-lessac-low.onnx')).kind;
    }),
  ).toBe('file');
  await page.setViewportSize({ width: 560, height: 900 });
  expect(
    await page.locator('.cache-manager').evaluate((root) =>
      [root, ...root.querySelectorAll('*')].flatMap((el) => {
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el),
          v = s.backgroundColor.match(/[\d.]+/g)?.map(Number);
        return r.width > 6 &&
          r.height > 6 &&
          r.bottom > 0 &&
          r.top < innerHeight &&
          s.visibility !== 'hidden' &&
          v &&
          v.slice(0, 3).every((n) => n > 170) &&
          (v.length < 4 || v[3] > 0.3)
          ? [el.className]
          : [];
      }),
    ),
  ).toEqual([]);
  expect(
    await page
      .locator('.cache-manager button')
      .evaluateAll((els) => els.every((el) => el.getBoundingClientRect().height >= 44)),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/caches-night-portrait.png' });
  await page.getByRole('button', { name: '关闭缓存管理' }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Disk cache management', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Disk cache management' })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect caches', exact: true }).click();
  await expect(page.locator('[data-cache-id=browser-transformers]')).toContainText(
    'size unavailable for 1 items',
  );
  expect(weights).toBe(0);
});

test('browser cleanup preserves legacy notes, workspace data, other caches and unknown voice files', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await seed(page);
  await open(page);
  for (const id of ['browser-tesseract', 'browser-piper', 'browser-transformers']) {
    await page.getByRole('button', { name: '统计缓存', exact: true }).click();
    await page.locator(`[data-cache-id=${id}] button`).click();
    await page.getByRole('button', { name: '确认清理缓存', exact: true }).click();
    await expect(page.locator('.cache-manager [role=status]')).toHaveText(
      '缓存已清理；再次使用时按需重新生成。',
    );
  }
  expect(
    await page.evaluate(async () => {
      const values = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = indexedDB.open('keyval-store');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result,
            tx = db.transaction('keyval'),
            store = tx.objectStore('keyval'),
            out: Record<string, unknown> = {};
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (row) {
              out[String(row.key)] = row.value;
              row.continue();
            }
          };
          tx.oncomplete = () => {
            db.close();
            resolve(out);
          };
        };
      });
      const root = await navigator.storage.getDirectory(),
        piper = await root.getDirectoryHandle('piper');
      const names: string[] = [];
      for await (const [name] of (piper as any).entries()) names.push(name);
      return {
        values,
        names,
        transformers: await caches.has('transformers-cache'),
        personal: await (
          await caches.open('personal-cache')
        )
          .match('/personal-note')
          .then((r) => r?.text()),
        workspace: await (
          await root.getFileHandle('workspace-sentinel')
        )
          .getFile()
          .then((f) => f.text()),
      };
    }),
  ).toEqual({
    values: {
      'surfacetab-notebook-v1': { name: 'Legacy notebook', pages: [{ id: 'preserve-me' }] },
      'other-key': 'keep personal',
    },
    names: ['personal.onnx'],
    transformers: false,
    personal: 'keep',
    workspace: 'keep',
  });
  await page.getByRole('button', { name: '关闭缓存管理' }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '管理工作空间' }).click();
  await expect(page.locator('.workspace-document')).toHaveCount(1);
});

test('cross-window cache maintenance waits for model use and queued cancellation preserves data', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await seed(page);
  await page.evaluate(async () => {
    const { withModelCacheUse } = await import('/src/cacheAccess.ts' as string);
    const state = window as any;
    state.cacheHeld = false;
    void withModelCacheUse(async () => {
      state.cacheHeld = true;
      await new Promise<void>((resolve) => {
        state.releaseCache = resolve;
      });
    }, new AbortController().signal);
  });
  await expect.poll(() => page.evaluate(() => (window as any).cacheHeld)).toBe(true);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('.busy-overlay')).toHaveCount(0);
  await open(other);
  await other.getByRole('button', { name: '统计缓存', exact: true }).click();
  await other.locator('[data-cache-id=browser-transformers] button').click();
  await other.getByRole('button', { name: '确认清理缓存', exact: true }).click();
  await expect(other.locator('.cache-manager [role=status]')).toHaveText(
    '等待本地任务完成后清理缓存…',
  );
  await expect
    .poll(() =>
      other.evaluate(async () =>
        (await navigator.locks.query()).pending.some(
          (lock) => lock.name === 'surfacetab-model-cache-v1',
        ),
      ),
    )
    .toBe(true);
  await other.getByRole('button', { name: '取消任务' }).click();
  await expect(other.locator('.cache-manager [role=status]')).toHaveText(
    '已取消，可能已清理部分缓存；请重新统计。',
  );
  expect(await page.evaluate(() => caches.has('transformers-cache'))).toBe(true);
  await other.getByRole('button', { name: '统计缓存', exact: true }).click();
  await other.locator('[data-cache-id=browser-transformers] button').click();
  await other.getByRole('button', { name: '确认清理缓存', exact: true }).click();
  await expect
    .poll(() =>
      other.evaluate(async () =>
        (await navigator.locks.query()).pending.some(
          (lock) => lock.name === 'surfacetab-model-cache-v1',
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => (window as any).releaseCache());
  await expect(other.locator('.cache-manager [role=status]')).toHaveText(
    '缓存已清理；再次使用时按需重新生成。',
  );
  expect(await page.evaluate(() => caches.has('transformers-cache'))).toBe(false);
  await other.close();
});
