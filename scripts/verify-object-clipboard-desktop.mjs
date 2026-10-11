// Isolated desktop profiles; copy through the real Windows clipboard and restart the process.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const profile = await mkdtemp(join(tmpdir(), 'tixtab-clipboard-'));
let app;
const errors = [];
async function launch() {
  app = await electron.launch({
    executablePath: resolve(process.argv[2]),
    env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
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
try {
  let page = await launch();
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 50;
    c.getContext('2d').fillRect(0, 0, 50, 50);
    return c.toDataURL();
  });
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles({
    name: 'Native objects.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        name: 'Native objects',
        source: null,
        pages: Array.from({ length: 2 }, (_, n) => ({
          id: `p${n}`,
          sourceIndex: null,
          width: 600,
          height: 900,
          paper: 'plain',
          strokes: [
            {
              id: `ink${n}`,
              tool: 'pen',
              color: '#ff0000',
              size: 16,
              points: [
                [110, 120, 0.5],
                [150, 120, 0.8],
              ],
            },
          ],
          images: [
            {
              id: `a${n}`,
              data,
              kind: 'sketch',
              scene: { elements: [] },
              x: 100,
              y: 100,
              width: 60,
              height: 50,
            },
            {
              id: `b${n}`,
              data,
              kind: 'formula',
              latex: '\\RR',
              macros: { '\\RR': '\\mathbb{R}' },
              x: 220,
              y: 160,
              width: 60,
              height: 50,
            },
          ],
        })),
      }),
    ),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '双页预览', exact: true }).click();
  await page.getByRole('button', { name: '对象', exact: true }).click();
  const editor = page.locator('.reading-card[data-page-index="0"] .page-editor'),
    r = await editor.boundingBox();
  await page.mouse.move(r.x + (r.width * 70) / 600, r.y + (r.height * 70) / 900);
  await page.mouse.down();
  await page.mouse.move(r.x + (r.width * 320) / 600, r.y + (r.height * 260) / 900, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.object-selection')).toHaveAttribute('data-selected-count', '2');
  await page.getByRole('button', { name: '复制选中对象', exact: true }).click();
  assert.equal(
    await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find((i) => i.types.includes('text/html'));
      return (
        !!item && (await (await item.getType('text/html')).text()).includes('data-tixtab-objects')
      );
    }),
    true,
  );
  await page.getByRole('button', { name: '粘贴对象', exact: true }).click();
  await expect(editor.locator('.placed-object')).toHaveCount(4);
  await page.keyboard.press('Control+x');
  await expect(editor.locator('.placed-object')).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await expect(editor.locator('.placed-object')).toHaveCount(4);
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await app.close();
  app = null;
  page = await launch();
  await expect(page.locator('.reading-view')).toHaveClass(/reading-dual/);
  await page.getByRole('button', { name: '对象', exact: true }).click();
  const right = page.locator('.reading-card[data-page-index="1"] .page-editor'),
    bounds = await right.boundingBox();
  await page.mouse.click(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * 0.55);
  await page.keyboard.press('Control+v');
  await expect(right.locator('.placed-object')).toHaveCount(4);
  await expect(page.locator('.object-selection')).toHaveAttribute('data-selected-count', '2');
  const saved = await project(page),
    copies = saved.pages[1].images.slice(2);
  assert.deepEqual(
    copies.map((i) => i.kind),
    ['sketch', 'formula'],
  );
  assert.deepEqual(copies[0].scene, { elements: [] });
  assert.deepEqual(copies[1].macros, { '\\RR': '\\mathbb{R}' });
  assert.equal(new Set(saved.pages.flatMap((p) => p.images.map((i) => i.id))).size, 8);
  await page.getByRole('button', { name: '排列顺序', exact: true }).click();
  await page.getByRole('button', { name: '置于底层', exact: true }).click();
  assert.deepEqual(
    (await project(page)).pages[1].images.slice(0, 2).map((i) => i.id),
    copies.map((i) => i.id),
  );
  await page.keyboard.press('Control+z');
  await page.getByRole('button', { name: '选择手写层', exact: true }).click();
  await page.getByRole('button', { name: '置于底层', exact: true }).click();
  assert.equal((await project(page)).pages[1].inkLayer, 0);
  await page.keyboard.press('Control+]');
  assert.equal((await project(page)).pages[1].inkLayer, 1);
  await expect(page.locator('.save-state')).toContainText('已自动保存');
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.night === 'true');
  await page.evaluate(() => localStorage.setItem('surfacetab.locale', 'en'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(620, 960));
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await page.locator('.reading-card[data-page-index="1"] .placed-object').last().click();
  await page.getByRole('button', { name: 'Arrange objects', exact: true }).click();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/clipboard-desktop-night.png' });
  const inspector = await page.locator('.object-inspector').boundingBox();
  assert(
    inspector.x >= 0 && inspector.x + inspector.width <= (await page.evaluate(() => innerWidth)),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        windowsClipboard: true,
        toolbarReadWrite: true,
        multiObjectCutUndo: true,
        clipboardSurvivesProcessExit: true,
        rightPagePaste: true,
        editableMetadata: true,
        stackingUndo: true,
        nightNarrowLayout: true,
        handwritingLayerOrdering: true,
        rendererErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  if (app) await app.close();
}
