import { createServer } from 'node:http';
import assert from 'node:assert/strict';
export async function verifyFormulaUi(page) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.match(body.image, /^data:image\/png;base64,/);
    requests.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ latex: requests.length === 1 ? 'x=1' : 'y=2' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.getByRole('button', { name: '公式', exact: true }).click();
    await page.getByRole('button', { name: '公式设置', exact: true }).click();
    await page.getByLabel('公式识别后端').selectOption('unimumer');
    assert.equal(await page.getByLabel('推理设备').locator('option').count(), 3);
    await page.getByLabel('公式识别后端').selectOption('web');
    await page
      .getByLabel('公式接口地址')
      .fill(`http://127.0.0.1:${server.address().port}/recognize`);
    await page.getByLabel('多行手写公式', { exact: true }).check();
    await page.locator('.formula-canvas').evaluate((c) => {
      c.setPointerCapture = () => {};
      const r = c.getBoundingClientRect();
      for (const y of [100, 350]) {
        const event = (type, x, dy = 0) =>
          c.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              pointerType: 'pen',
              pointerId: 9,
              button: 0,
              buttons: 1,
              pressure: 0.5,
              clientX: r.x + (x / 960) * r.width,
              clientY: r.y + ((y + dy) / c.height) * r.height,
            }),
          );
        event('pointerdown', 80);
        event('pointermove', 140, 20);
        event('pointermove', 200);
        event('pointerup', 200);
      }
    });
    await page.getByRole('button', { name: '识别手写公式', exact: true }).click();
    const latex = '\\begin{aligned}\nx=1 \\\\\ny=2\n\\end{aligned}';
    await page.waitForFunction((value) => document.querySelector('#latex')?.value === value, latex);
    assert.equal(requests.length, 2);
    assert.equal(await page.locator('.formula-preview .katex-error').count(), 0);
    const count = await page.locator('.placed-object').count();
    await page.getByRole('button', { name: '插入当前页', exact: true }).click();
    await page.getByRole('dialog', { name: '手写公式' }).waitFor({ state: 'hidden' });
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.placed-object').length === expected,
      count + 1,
    );
    console.log(
      'Actual packaged multiline formula: two serialized local HTTP requests through desktop relay, aligned preview, insertion and Uni-MuMER device options: passed',
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
