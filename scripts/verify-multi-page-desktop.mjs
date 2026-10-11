// Real process restart with an isolated profile; no user documents or settings are touched.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import assert from 'node:assert/strict';
const executablePath = resolve(process.argv[2]);
const profile = await mkdtemp(join(tmpdir(), 'tixtab-edit-restart-'));
const errors = [];
let app;
async function launch() {
  app = await electron.launch({
    executablePath,
    env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  return page;
}
async function project(page) {
  return page.evaluate(async () => {
    const create = URL.createObjectURL,
      click = HTMLAnchorElement.prototype.click;
    let blob;
    URL.createObjectURL = (value) => {
      blob = value;
      return create(value);
    };
    HTMLAnchorElement.prototype.click = () => {};
    try {
      document.querySelector('button[aria-label="保存工程"]').click();
      return JSON.parse(await blob.text());
    } finally {
      URL.createObjectURL = create;
      HTMLAnchorElement.prototype.click = click;
    }
  });
}
async function pen(page, index) {
  const editor = page.locator(`.reading-card[data-page-index="${index}"] .page-editor`);
  // Windows pen pointer protocol with pressure; this is not a physical Slim Pen test.
  await editor.evaluate((el) => {
    el.setPointerCapture = () => {};
    const r = el.getBoundingClientRect(),
      base = {
        bubbles: true,
        cancelable: true,
        pointerType: 'pen',
        pointerId: 73,
        button: 0,
        buttons: 1,
        clientY: r.y + r.height * 0.45,
      };
    el.dispatchEvent(
      new PointerEvent('pointerdown', { ...base, clientX: r.x + r.width * 0.3, pressure: 0.25 }),
    );
    el.dispatchEvent(
      new PointerEvent('pointermove', { ...base, clientX: r.x + r.width * 0.6, pressure: 0.75 }),
    );
    el.dispatchEvent(
      new PointerEvent('pointerup', {
        ...base,
        clientX: r.x + r.width * 0.6,
        pressure: 0,
        buttons: 0,
      }),
    );
  });
}
const results = [];
try {
  let page = await launch();
  const doc = await PDFDocument.create();
  for (let i = 0; i < 6; i++) doc.addPage([600, 900]);
  await page
    .locator('input[type=file][accept=".pdf,.surfacetab"]')
    .setInputFiles({
      name: 'Restart ink.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '第 3 页', exact: true }).click();
  for (const mode of ['dual', 'continuous']) {
    await page
      .getByRole('button', { name: mode === 'dual' ? '双页预览' : '连续页面预览', exact: true })
      .click();
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    await pen(page, 2);
    const before = (await project(page)).pages[2].strokes.length;
    await expect(page.locator('.save-state')).toContainText('已自动保存');
    await app.close();
    app = undefined;
    page = await launch();
    await expect(page.locator('.reading-view')).toHaveClass(new RegExp(`reading-${mode}`));
    await expect(page.locator('.page-navigation > span')).toHaveText('3 / 6');
    await pen(page, 2);
    const notebook = await project(page);
    assert.equal(notebook.pages[2].strokes.length, before + 1);
    assert.deepEqual(
      notebook.pages[2].strokes.at(-1).points.map((p) => p[2]),
      [0.25, 0.75],
    );
    if (mode === 'dual') {
      await pen(page, 3);
      assert.equal((await project(page)).pages[3].strokes.length, 1);
      await expect(page.locator('.page-navigation > span')).toHaveText('3 / 6');
      await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
      await expect(page.locator('.page-navigation > span')).toHaveText('3 / 6');
    }
    results.push({
      mode,
      processRestart: true,
      directInk: true,
      pressurePreserved: true,
      pagePreserved: true,
    });
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ results, rendererErrors: errors, physicalPenTested: false }, null, 2),
  );
} finally {
  await app?.close();
}
