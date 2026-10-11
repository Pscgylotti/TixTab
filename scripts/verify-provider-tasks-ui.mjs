import assert from 'node:assert/strict';

// Native responses are controlled fixtures: this verifies packaged task UI and
// cancellation, not NPU inference or recognition quality.
export async function verifyProviderTasksUi(page) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let requests = 0,
    modelRequests = 0,
    releaseRequests = 0;
  const onRequest = (request) => {
    if (request.url().includes('/models/texo/')) modelRequests++;
  };
  page.on('request', onRequest);
  const routeHandler = async (route) => {
    if (route.request().url().endsWith('/health')) {
      await route.fulfill({
        json: {
          engine: 'Texo OpenVINO',
          devices: [{ id: 'NPU', name: 'fixture NPU' }],
          capabilities: ['release-idle'],
        },
      });
      return;
    }
    if (route.request().url().endsWith('/models/release')) {
      releaseRequests++;
      assert.deepEqual(route.request().postDataJSON(), { action: 'release-idle' });
      await route.fulfill({
        json: { ok: true, engine: 'SurfaceTab model lifecycle', loaded: false, released: true },
      });
      return;
    }
    requests++;
    await gate;
    await route
      .fulfill({
        json: {
          latex: 'x',
          encoderDevice: 'NPU',
          decoderDevice: 'CPU',
          fallback: false,
          timing: { totalMs: 24 },
        },
      })
      .catch(() => {});
  };
  await page.route('http://127.0.0.1:8766/**', routeHandler);
  try {
    await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    await page.getByRole('button', { name: '公式', exact: true }).click();
    await page.getByRole('button', { name: '公式设置', exact: true }).click();
    await page.getByLabel('公式识别后端').selectOption('texo-native');
    const bounds = await page.locator('.formula-canvas').boundingBox();
    await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.6, {
      steps: 5,
    });
    await page.mouse.up();
    await page.getByRole('button', { name: '识别手写公式', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('.formula-status')?.textContent.includes('本地加速识别中'),
    );
    await page.getByRole('button', { name: '任务与后端', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '任务与后端', exact: true });
    await panel.locator('.task-card[data-phase=running]').waitFor();
    await panel.getByRole('button', { name: '取消任务 公式识别', exact: true }).click();
    await panel.locator('.task-card[data-phase=cancelled]').waitFor();
    release();
    assert.equal(modelRequests, 0, 'Cancel must not start a second model');
    await panel.getByRole('button', { name: '关闭任务面板' }).click();
    assert.equal(await page.locator('.formula-status').textContent(), '已取消');
    assert.equal(
      await page.getByRole('button', { name: '识别手写公式', exact: true }).isEnabled(),
      true,
    );
    await page.getByRole('button', { name: '识别手写公式', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#latex')?.value === 'x');
    await page.getByRole('button', { name: '任务与后端', exact: true }).click();
    const completed = panel.locator('.task-card[data-phase=completed]');
    await completed.waitFor();
    assert.ok((await completed.textContent()).includes('NPU + CPU'));
    assert.equal(requests, 2);
    assert.equal(modelRequests, 0);
    await panel.getByRole('button', { name: '释放闲置模型内存', exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector('.task-memory')
        ?.textContent.includes('闲置模型已释放，再次使用时按需加载。'),
    );
    assert.equal(releaseRequests, 1);
    assert.equal(requests, 2);
    assert.deepEqual(
      await panel.evaluate((root) =>
        [root, ...root.querySelectorAll('*')].flatMap((el) => {
          const s = getComputedStyle(el),
            r = el.getBoundingClientRect(),
            rgb = s.backgroundColor.match(/[\d.]+/g)?.map(Number);
          return r.width > 6 &&
            r.height > 6 &&
            rgb?.slice(0, 3).every((v) => v > 170) &&
            (rgb.length < 4 || rgb[3] > 0.3)
            ? [el.className]
            : [];
        }),
      ),
      [],
    );
    await page.screenshot({ path: 'test-results/packaged-provider-tasks-night.png' });
    await panel.getByRole('button', { name: '关闭任务面板' }).click();
    await page
      .getByRole('dialog', { name: '手写公式' })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    console.log(
      'Packaged task panel / cancellation / retry / memory release / actual-route metadata fixture / dark surfaces: verified',
    );
  } finally {
    release();
    page.off('request', onRequest);
    await page.unroute('http://127.0.0.1:8766/**', routeHandler);
  }
}
