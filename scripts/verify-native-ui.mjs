import assert from 'node:assert/strict';
export async function verifyNativeTexo(page) {
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on('pageerror', onError);
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '公式', exact: true }).click();
  await page.getByRole('button', { name: '公式设置', exact: true }).click();
  assert.equal(await page.getByLabel('公式识别后端').inputValue(), 'texo-native');
  const r = await page.locator('.formula-canvas').boundingBox();
  for (const [start, end] of [
    [0.45, 0.55],
    [0.55, 0.45],
  ]) {
    await page.mouse.move(r.x + r.width * start, r.y + r.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width * end, r.y + r.height * 0.65, { steps: 12 });
    await page.mouse.up();
  }
  await page.locator('.formula-canvas').screenshot({ path: 'test-results/native-texo-input.png' });
  await page.getByRole('button', { name: '识别并覆盖', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.formula-status')?.textContent.includes('请检查结果') ||
      document.querySelector('.formula-status')?.textContent.includes('无法完成'),
    null,
    { timeout: 180000 },
  );
  const status = await page.locator('.formula-status').textContent();
  assert.ok(status.includes('NPU + CPU'), status);
  assert.match((await page.locator('#latex').inputValue()).trim(), /^(?:[xX]|\\times)$/);
  const health = await page.evaluate(async () =>
    (await fetch('http://127.0.0.1:8766/health')).json(),
  );
  assert.equal(health.encoderDevice, 'NPU');
  assert.equal(health.loaded, true);
  console.log('Packaged native NPU encoder + CPU decoder:', status);
  await page.screenshot({ path: 'test-results/native-texo-npu.png' });
  // Force an unavailable native route and verify the real bundled CPU model still runs.
  await page.route('http://127.0.0.1:8766/health', (route) => route.abort());
  await page.getByRole('button', { name: '识别并覆盖', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.formula-status')?.textContent.includes('CPU (WASM)') ||
      document.querySelector('.formula-status')?.textContent.includes('无法完成'),
    null,
    { timeout: 180000 },
  );
  const fallback = await page.locator('.formula-status').textContent();
  assert.ok(fallback.includes('CPU (WASM)'), fallback);
  console.log('Packaged unavailable-native -> real WASM fallback:', fallback);
  assert.deepEqual(errors, []);
  await page.unroute('http://127.0.0.1:8766/health');
  await page
    .getByRole('dialog', { name: '手写公式' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  page.off('pageerror', onError);
}
