import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile, writeFile, readdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
const native = process.env.TIXTAB_SELECTION_NATIVE === '1';
const selectionTest = native
  ? test.extend({
      page: async ({}, use, testInfo) => {
        const appDir = resolve(process.env.TIXTAB_SELECTION_APP_DIR || '.');
        const profile = await mkdtemp(join(tmpdir(), 'tixtab-selection-'));
        const app = await electron.launch({
          args: [appDir],
          env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
          timeout: 60000,
        });
        const errors: string[] = [];
        let contain: string[] = [];
        try {
          const page = await app.firstWindow();
          page.on('pageerror', (e) => errors.push(String(e)));
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
          );
          await use(page);
          contain = await page
            .locator('.paper,.reading-paper')
            .evaluateAll((nodes) => nodes.map((el) => getComputedStyle(el).contain));
          expect(errors).toEqual([]);
        } finally {
          await app.close();
          const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
          const inventory = async (dir: string, prefix = ''): Promise<[string, string][]> => {
            const rows: [string, string][] = [];
            for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
              a.name.localeCompare(b.name),
            )) {
              if (e.isDirectory())
                rows.push(...(await inventory(join(dir, e.name), prefix + e.name + '/')));
              else if (e.isFile())
                rows.push([prefix + e.name, sha(await readFile(join(dir, e.name)))]);
            }
            return rows;
          };
          const runtime = [
            ...(await inventory(join(appDir, 'dist'), 'dist/')),
            ...(await inventory(join(appDir, 'electron'), 'electron/')),
            ['package.json', sha(await readFile(join(appDir, 'package.json')))],
          ];
          await writeFile(
            testInfo.outputPath('native-selection-binding.json'),
            JSON.stringify(
              {
                appDir,
                sourceManifestSha256: sha(await readFile(join(appDir, 'SOURCE-MANIFEST.json'))),
                runtime,
                harnessSha256: sha(await readFile(new URL(import.meta.url))),
                contain,
                errors,
              },
              null,
              2,
            ),
          );
        }
      },
    })
  : test;

selectionTest(
  'mouse and hovering pen preview the same paragraph start in margins, with gutters, columns and zoom',
  async ({ page }) => {
    if (native) await page.reload();
    else await page.goto('/');
    await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595, 842]);
    p.drawText('Earlier title must stay unselected', { x: 80, y: 770, size: 20, font });
    // Deliberately different DOM and visual ordering, like scientific PDF gutters.
    for (let i = 0; i < 5; i++) p.drawText(`00${i}`, { x: 22, y: 690 - i * 22, size: 10, font });
    p.drawText('Step caching accelerates', { x: 85, y: 690, size: 14, font });
    p.drawText('the next line of this paragraph.', { x: 85, y: 668, size: 14, font });
    p.drawText('Right column begins here', { x: 340, y: 690, size: 14, font });
    p.drawText('Another line', { x: 340, y: 668, size: 14, font });
    doc.addPage([595, 842]);
    await page.locator('input[type=file]').setInputFiles({
      name: 'paragraph-start.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await page.getByRole('button', { name: '选文', exact: true }).click();
    for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      for (const zoom of [0, 1]) {
        if (zoom) await page.getByRole('button', { name: '放大', exact: true }).click();
        for (const [text, word] of [
          ['Step caching accelerates', 'Step'],
          ['Right column begins here', 'Right'],
        ]) {
          const span = page.locator('.textLayer span').filter({ hasText: text }).first();
          await span.scrollIntoViewIfNeeded();
          const b = await span.evaluate((el, word) => {
            const node = el.firstChild!,
              range = document.createRange();
            range.setStart(node, 0);
            range.setEnd(node, 1);
            const first = range.getBoundingClientRect();
            range.setStart(node, word.length - 1);
            range.setEnd(node, word.length);
            const last = range.getBoundingClientRect();
            return {
              x: first.left - Math.min(20, first.height * 0.6),
              y: first.top + first.height / 2,
              start: first.left,
              end: last.left + last.width * 0.7,
            };
          }, word);
          await page.mouse.move(b.x, b.y);
          await expect(page.locator('.pdf-selection-caret')).toBeVisible();
          expect(
            Math.abs((await page.locator('.pdf-selection-caret').boundingBox())!.x - b.start),
          ).toBeLessThan(1);
          expect(await page.evaluate(() => getSelection()?.toString())).toBe('');
          if (mode === '单页标注' && zoom === 0 && word === 'Step')
            await page.screenshot({ path: '.cache/selection-hover.png' });
          await page.mouse.down();
          await expect(page.locator('.pdf-selection-caret')).toHaveCount(0);
          await page.mouse.move(b.end, b.y, { steps: 6 });
          await page.mouse.up();
          expect(await page.evaluate(() => getSelection()?.toString())).toBe(word);
          await page.getByRole('button', { name: '关闭划词工具' }).click();
          if (word === 'Step') {
            const end = await page
              .locator('.textLayer span')
              .filter({ hasText: 'the next line of this paragraph.' })
              .first()
              .evaluate((el) => {
                const r = document.createRange();
                r.setStart(el.firstChild!, 2);
                r.setEnd(el.firstChild!, 3);
                const rect = r.getBoundingClientRect();
                return { x: rect.left + rect.width * 0.7, y: rect.top + rect.height / 2 };
              });
            await page.mouse.move(b.x, b.y);
            await page.mouse.down();
            await page.mouse.move(end.x, end.y, { steps: 6 });
            await page.mouse.up();
            expect(
              (await page.evaluate(() => getSelection()?.toString()))?.replace(/\s+/g, ' '),
            ).toMatch(/^Step caching accelerates\s*the$/);
            await page.getByRole('button', { name: '关闭划词工具' }).click();
          }
          const layer = span.locator('xpath=ancestor::div[contains(@class,"textLayer")]');
          await layer.evaluate(
            (el, b) =>
              el.dispatchEvent(
                new PointerEvent('pointermove', {
                  bubbles: true,
                  pointerType: 'pen',
                  pointerId: 91,
                  buttons: 0,
                  clientX: b.x,
                  clientY: b.y,
                }),
              ),
            b,
          );
          await expect(page.locator('.pdf-selection-caret')).toBeVisible();
          expect(
            Math.abs((await page.locator('.pdf-selection-caret').boundingBox())!.x - b.start),
          ).toBeLessThan(1);
          await layer.evaluate((el, b) => {
            el.setPointerCapture = () => {};
            for (const [type, x] of [
              ['pointerdown', b.x],
              ['pointermove', b.end],
              ['pointerup', b.end],
            ] as const)
              el.dispatchEvent(
                new PointerEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  pointerType: 'pen',
                  pointerId: 91,
                  button: 0,
                  buttons: type === 'pointerup' ? 0 : 1,
                  clientX: x,
                  clientY: b.y,
                }),
              );
          }, b);
          expect(await page.evaluate(() => getSelection()?.toString())).toBe(word);
          await page.getByRole('button', { name: '关闭划词工具' }).click();
        }
      }
    }
    const layer = page.locator('.textLayer').first(),
      box = (await layer.boundingBox())!;
    await page.mouse.move(box.x + box.width - 10, box.y + 20);
    await expect(page.locator('.pdf-selection-caret')).toHaveCount(0);
    await layer.evaluate((el) =>
      el.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerType: 'touch',
          pointerId: 92,
          buttons: 0,
        }),
      ),
    );
    await expect(page.locator('.pdf-selection-caret')).toHaveCount(0);
  },
);

test('geometry lookup preserves RTL, rotated text, interior fragments and reverse selection', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { glyphAtPoint, glyphCaret, selectGlyphs, invalidateTextLayout } =
      await import('/src/textSelection.ts');
    const root = document.createElement('div');
    root.style.cssText =
      'position:fixed;left:40px;top:150px;width:700px;height:600px;z-index:1000;background:white';
    const add = (text: string, style: string, dir = '') => {
      const span = document.createElement('span');
      span.textContent = text;
      span.dir = dir;
      span.style.cssText = `position:absolute;white-space:pre;font:24px Arial;${style}`;
      root.append(span);
      return span;
    };
    const first = add('alpha', 'left:80px;top:40px');
    const next = add('beta', 'left:150px;top:40px');
    const rtl = add('אבגד', 'left:300px;top:120px', 'rtl');
    const rotated = add(
      'rotation',
      'left:500px;top:240px;transform:rotate(90deg);transform-origin:0 0;--rotate:90deg',
    );
    document.body.append(root);
    const char = (el: HTMLElement, n: number) => {
      const r = document.createRange();
      r.setStart(el.firstChild!, n);
      r.setEnd(el.firstChild!, n + 1);
      return r.getBoundingClientRect();
    };
    const a = char(first, 0),
      z = char(first, 4);
    const anchor = glyphAtPoint(root, z.left + z.width / 2, z.top + z.height / 2, true)!;
    const focus = glyphAtPoint(root, a.left + a.width / 2, a.top + a.height / 2, true)!;
    selectGlyphs(anchor, focus);
    const reverse = getSelection()!.toString();
    getSelection()!.removeAllRanges();
    const n = next.getBoundingClientRect();
    const interior = glyphAtPoint(root, n.left - 10, n.top + n.height / 2, true);
    const r = char(rtl, 0),
      rot = char(rotated, 0);
    const rh = glyphAtPoint(root, r.left + r.width / 2, r.top + r.height / 2, true)!;
    const oh = glyphAtPoint(root, rot.left + rot.width / 2, rot.top + rot.height / 2, true)!;
    const caret = glyphCaret(rh);
    root.style.left = '70px';
    const moved = first.getBoundingClientRect();
    const pan = glyphAtPoint(root, moved.left - 15, moved.top + moved.height / 2, true);
    invalidateTextLayout(root);
    root.remove();
    return {
      reverse,
      interior: interior?.node === next.firstChild,
      rtl: rh.start,
      rotated: oh.start,
      caret: Math.abs(caret.left - r.right),
      pan: pan?.start,
    };
  });
  expect(result.caret).toBeLessThan(0.1);
  expect({ ...result, caret: 0 }).toEqual({
    reverse: 'alpha',
    interior: false,
    rtl: 0,
    rotated: 0,
    caret: 0,
    pan: 0,
  });
});
