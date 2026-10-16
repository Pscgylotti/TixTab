import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { preservationFixture, signatureGuardFixture } from './pdf-preservation-fixture.mjs';
const { PDFDocument, PDFName, PDFDict } = createRequire(import.meta.url)('pdf-lib');
const n = (value) => PDFName.of(value);

// Exercise the real UI and capture its final download Blob before the OS save
// dialog. No application modules are imported in the renderer; works in ASAR.
export async function verifyPdfUi(page) {
  const viewport = page.viewportSize();
  await page.evaluate(() => {
    const original = HTMLAnchorElement.prototype.click;
    window.__surfacePdfQa = { original, files: [] };
    HTMLAnchorElement.prototype.click = function () {
      if (this.href.startsWith('blob:') && /\.(pdf|tixtab)$/i.test(this.download)) {
        const file = { name: this.download, bytes: null };
        window.__surfacePdfQa.files.push(file);
        void fetch(this.href)
          .then((r) => r.arrayBuffer())
          .then((b) => {
            file.bytes = Array.from(new Uint8Array(b));
          });
        return;
      }
      return original.call(this);
    };
  });
  const exported = async (action) => {
    const count = await page.evaluate(() => window.__surfacePdfQa.files.length);
    await action();
    await page.waitForFunction(
      (count) =>
        window.__surfacePdfQa.files.length > count &&
        window.__surfacePdfQa.files[count].bytes !== null,
      count,
    );
    return Buffer.from(
      await page.evaluate((count) => window.__surfacePdfQa.files[count].bytes, count),
    );
  };
  const importBytes = async (bytes, name) => {
    await page
      .locator('input[type=file]')
      .setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
    await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  };
  try {
    await page.getByRole('button', { name: '单页标注', exact: true }).click();
    if (await page.getByRole('button', { name: '展开页面栏', exact: true }).count())
      await page.getByRole('button', { name: '展开页面栏', exact: true }).click();
    const source = Buffer.from(await preservationFixture());
    await importBytes(source, 'preserve-ui.pdf');
    assert.deepEqual(
      await exported(() => page.getByRole('button', { name: '导出 PDF', exact: true }).click()),
      source,
      'No-op export must be byte-identical',
    );
    await page.getByRole('button', { name: '插入空白页', exact: true }).click();
    await page
      .getByRole('dialog', { name: '插入空白页', exact: true })
      .getByRole('button', { name: '插入页面', exact: true })
      .click();
    await page.getByRole('button', { name: '第 2 页', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '上移', exact: true }).click();
    await page.locator('.page-list').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.getByRole('button', { name: '第 6 页', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    await page
      .getByRole('alertdialog', { name: '删除页面', exact: true })
      .getByRole('button', { name: '确认删除', exact: true })
      .click();
    await page.locator('.page-list').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.getByRole('button', { name: '第 2 页', exact: true }).click();
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    const r = await page.locator('.paper').boundingBox();
    await page.mouse.move(r.x + r.width * 0.2, r.y + r.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width * 0.4, r.y + r.height * 0.3, { steps: 6 });
    await page.mouse.up();
    await page.getByRole('button', { name: '公式', exact: true }).click();
    await page.getByLabel('LaTeX · 可直接修改', { exact: true }).fill('x^2');
    await page.getByRole('button', { name: '插入当前页', exact: true }).click();
    const bytes = await exported(() =>
        page.getByRole('button', { name: '导出 PDF', exact: true }).click(),
      ),
      doc = await PDFDocument.load(bytes, { updateMetadata: false });
    assert.equal(doc.getPageCount(), 5);
    assert.equal(doc.getTitle(), 'Preserved document title');
    const form = doc.getForm();
    assert.equal(form.getTextField('group.field-0').getText(), 'value-0');
    assert.equal(form.getCheckBox('checked').isChecked(), true);
    assert.equal(
      form.getFields().some((f) => f.getName() === 'group.field-4'),
      false,
    );
    const annotations = doc
      .getPage(1)
      .node.Annots()
      .asArray()
      .map((raw) => doc.context.lookup(raw, PDFDict));
    assert.ok(
      annotations.some((a) => a.get(n('Subtype'))?.toString() === '/Stamp' && a.has(n('AP'))),
    );
    assert.ok(annotations.some((a) => a.get(n('Subtype'))?.toString() === '/Text'));
    assert.ok(
      annotations.some((a) => a.lookupMaybe(n('A'), PDFDict)?.get(n('S'))?.toString() === '/URI'),
    );
    const project = JSON.parse(
      (
        await exported(() => page.getByRole('button', { name: '保存工程', exact: true }).click())
      ).toString('utf8'),
    );
    assert.deepEqual(Buffer.from(project.source, 'base64'), source);
    assert.ok(project.pages[1].strokes.length);
    assert.ok(project.pages[1].images.length);
    await mkdir('tmp/pdfs', { recursive: true });
    await writeFile('tmp/pdfs/ui-preservation-export.pdf', bytes);
    await importBytes(bytes, 'reopened-export.pdf');
    await page.getByRole('button', { name: '第 2 页', exact: true }).click();
    await page.getByRole('button', { name: '选文', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('.textLayer')?.textContent.includes('Original page 1'),
    );
    console.log(
      'Actual UI PDF export: byte-identical no-op, insert/reorder/delete, searchable source, fields/values/AP, notes/URI and vector stamp preserved',
    );

    const signed = Buffer.from(await signatureGuardFixture());
    await importBytes(signed, 'signature-guard.pdf');
    assert.deepEqual(
      await exported(() => page.getByRole('button', { name: '导出 PDF', exact: true }).click()),
      signed,
    );
    await page.getByRole('button', { name: '插入空白页', exact: true }).click();
    await page
      .getByRole('dialog', { name: '插入空白页', exact: true })
      .getByRole('button', { name: '插入页面', exact: true })
      .click();
    const count = await page.evaluate(() => window.__surfacePdfQa.files.length);
    if (
      (await page
        .getByRole('button', { name: '实验性夜间模式', exact: true })
        .getAttribute('aria-pressed')) !== 'true'
    )
      await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    await page.setViewportSize({ width: 560, height: 900 });
    await page.getByRole('button', { name: '导出 PDF', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导出含签名的修改副本', exact: true });
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => window.__surfacePdfQa.files.length), count);
    const surfaces = await dialog.evaluate((root) =>
      [root, ...root.querySelectorAll('*')].flatMap((el) => {
        const s = getComputedStyle(el),
          c = s.backgroundColor.match(/[\d.]+/g)?.map(Number);
        return c && c.slice(0, 3).every((v) => v > 190) && (c.length < 4 || c[3] > 0.5)
          ? [s.backgroundColor]
          : [];
      }),
    );
    assert.deepEqual(surfaces, []);
    for (const button of await dialog.getByRole('button').all()) {
      const box = await button.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= 560);
    }
    await page.screenshot({ path: 'test-results/pdf-signed-night-portrait.png' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(
      await page.evaluate(() => window.__surfacePdfQa.files.length),
      count,
      'Cancel must not export',
    );
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('界面语言 / Interface language').selectOption('en');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
    const english = page.getByRole('dialog', { name: 'Export a modified signed PDF', exact: true });
    await english.waitFor();
    assert.ok((await english.textContent()).includes('signature'));
    await page.screenshot({ path: 'test-results/pdf-signed-english-portrait.png' });
    const modified = await exported(() =>
      english.getByRole('button', { name: 'Export modified copy', exact: true }).click(),
    );
    assert.equal((await PDFDocument.load(modified)).getPageCount(), 2);
    assert.notDeepEqual(modified, signed);
    const signedProject = JSON.parse(
      (
        await exported(() =>
          page.getByRole('button', { name: 'Save project', exact: true }).click(),
        )
      ).toString('utf8'),
    );
    assert.deepEqual(Buffer.from(signedProject.source, 'base64'), signed);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('界面语言 / Interface language').selectOption('zh-CN');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    console.log(
      'Actual UI signature guard: unchanged bytes, no export before confirmation, cancel, explicit modified copy, unchanged source; English/night/560px/44px verified (synthetic signature only)',
    );
  } finally {
    if (!page.isClosed())
      await page.evaluate(() => {
        if (window.__surfacePdfQa) {
          HTMLAnchorElement.prototype.click = window.__surfacePdfQa.original;
          delete window.__surfacePdfQa;
        }
      });
    if (viewport) await page.setViewportSize(viewport);
  }
}
