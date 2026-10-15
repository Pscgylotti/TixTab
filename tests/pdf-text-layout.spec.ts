import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts, degrees } = createRequire(import.meta.url)('pdf-lib');

for (const backend of ['pdfjs', 'pdfium']) {
  test(`${backend}: vertical arXiv targets follow text, and selection survives view changes`, async ({
    page,
  }) => {
    await page.addInitScript(
      (backend) => localStorage.setItem('tixtab.pdfRenderBackend', backend),
      backend,
    );
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.TimesRoman);
    const p = doc.addPage([595, 842]);
    p.drawText('arXiv:2212.05032v3', { x: 60, y: 180, rotate: degrees(90), size: 18, font });
    p.drawText('First sentence with spaces.', { x: 130, y: 650, size: 18, font });
    doc.addPage([595, 842]);
    await page.goto('/');
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
    await page.locator('input[type=file]').setInputFiles({
      name: 'vertical-arxiv.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '文档名称' })).toHaveValue('vertical-arxiv');
    for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      await page.getByRole('button', { name: '移动', exact: true }).click();
      const link = page
        .locator('a.pdf-document-link[href="https://arxiv.org/abs/2212.05032v3"]')
        .first();
      await expect(link).toBeAttached();
      const target = (await link.boundingBox())!;
      expect(target.height).toBeGreaterThan(target.width * 5);
      if (backend === 'pdfium' && mode === '单页标注') {
        await page.keyboard.down('Alt');
        await page.screenshot({ path: 'test-results/vertical-arxiv-pdfium.png' });
        await page.keyboard.up('Alt');
      }
      await page.getByRole('button', { name: '选文', exact: true }).click();
      const span = page.locator('.pdf-text-run').filter({ hasText: 'arXiv:2212.05032v3' }).first();
      await expect(span).toBeAttached();
      const glyph = await span.evaluate((span) => {
        const range = document.createRange();
        range.setStart(span.firstChild!, 0);
        range.setEnd(span.firstChild!, 1);
        const r = range.getBoundingClientRect();
        const whole = span.getBoundingClientRect();
        return {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          box: { x: whole.x, y: whole.y, width: whole.width, height: whole.height },
        };
      });
      expect(Math.abs(glyph.box.x - target.x)).toBeLessThan(target.width);
      expect(Math.abs(glyph.box.y - target.y)).toBeLessThan(target.width);
      expect(Math.abs(glyph.box.height - target.height)).toBeLessThan(2);
      await page.mouse.dblclick(glyph.x, glyph.y);
      await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('arXiv');
      await page.getByRole('button', { name: '关闭划词工具' }).click();
    }
  });
}

test('app-owned text layout handles rotated crop/UserUnit, split words, line breaks, RTL and CJK without PDF.js loading', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { renderPdfTextDom } = await import('/src/pdfTextDom.ts');
    const { PdfViewport } = await import('/src/pdfViewport.ts');
    const { getLegacyPdfStats } = await import('/src/pdfLegacy.ts');
    const { glyphAtPoint } = await import('/src/textSelection.ts');
    const before = getLegacyPdfStats().opens;
    const root = document.createElement('div');
    root.className = 'textLayer';
    root.style.cssText = 'position:fixed;left:0;top:100px;z-index:1000';
    document.body.append(root);
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = false,
      dir = 'ltr',
    ) => ({ str, transform: [20, 0, 0, 20, x, y], width, height: 20, fontName: 'f', hasEOL, dir });
    const content: any = {
      items: [
        item('First', 80, 600, 50),
        item('word', 140, 600, 48, true),
        item('中文', 80, 570, 40),
        item('文本', 120, 570, 40, true),
        item('אבגד', 80, 540, 48, false, 'rtl'),
      ],
      styles: { f: { ascent: 0.8, fontFamily: 'serif' } },
    };
    renderPdfTextDom(
      root,
      content,
      new PdfViewport({ view: [20, 30, 620, 830], rotation: 0, userUnit: 0.75 }, { scale: 1 }),
    );
    const spans = root.querySelectorAll('.pdf-text-run'),
      range = document.createRange();
    range.setStart(spans[0].firstChild!, 0);
    range.setEnd(spans[3].firstChild!, 2);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const text = getSelection()!.toString();
    const rtlRange = document.createRange();
    rtlRange.setStart(spans[4].firstChild!, 0);
    rtlRange.setEnd(spans[4].firstChild!, 1);
    const r = rtlRange.getBoundingClientRect();
    const rtl = glyphAtPoint(root, r.x + r.width / 2, r.y + r.height / 2, true)?.start;
    const rotations = [];
    for (const rotation of [0, 90, 180, 270]) {
      renderPdfTextDom(
        root,
        content,
        new PdfViewport({ view: [20, 30, 620, 830], rotation, userUnit: 0.75 }, { scale: 1 }),
      );
      const b = root.querySelector('.pdf-text-run')!.getBoundingClientRect();
      rotations.push(rotation % 180 ? Math.abs(b.height - 37.5) : Math.abs(b.width - 37.5));
    }
    root.remove();
    getSelection()!.removeAllRanges();
    return { text, rtl, rotations, opens: getLegacyPdfStats().opens - before };
  });
  expect(result.text).toBe('First word\n中文文本');
  expect(result.rtl).toBe(0);
  expect(result.rotations.every((n) => n < 0.1)).toBe(true);
  expect(result.opens).toBe(0);
});
