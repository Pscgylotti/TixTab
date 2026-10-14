import { expect, test } from '@playwright/test';

test('OCR drag selection keeps word spaces, line breaks and CJK spacing in copy and translation', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const source = await page.evaluate(async () => {
    const { newNotebook, blankPage } = await import('/src/model.ts' as string),
      { normalizeOcr } = await import('/src/ocrLayout.ts' as string);
    const notebook = newNotebook();
    notebook.name = 'OCR spacing';
    notebook.pages = [blankPage(600, 800)];
    const canvas = document.createElement('canvas');
    canvas.width = 440;
    canvas.height = 150;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 440, 150);
    ctx.fillStyle = 'black';
    ctx.font = '18px Arial';
    const entries = [
      {
        text: 'A first remark  about couplings',
        words: ['A', 'first', 'remark', 'about', 'couplings'],
      },
      {
        text: 'there is the trivial coupling.',
        words: ['there', 'is', 'the', 'trivial', 'coupling.'],
      },
      { text: '中文连续文字', words: ['中文', '连续', '文字'] },
    ];
    const lines = entries.map((line, index) => {
      const y = 10 + index * 40;
      ctx.fillText(line.text, 10, y + 18);
      let offset = 0;
      const words = line.words.map((text) => {
        const start = line.text.indexOf(text, offset);
        offset = start + text.length;
        const x = 10 + ctx.measureText(line.text.slice(0, start)).width;
        const right = x + ctx.measureText(text).width;
        return { text, polygon: [x, y, right, y, right, y + 22, x, y + 22] };
      });
      return { text: line.text, polygon: [10, y, 420, y, 420, y + 22, 10, y + 22], words };
    });
    notebook.pages[0].images = [
      {
        id: 'picture',
        kind: 'image',
        data: canvas.toDataURL(),
        x: 80,
        y: 100,
        width: 440,
        height: 150,
        ocr: normalizeOcr(entries.map((e) => e.text).join('\n'), lines, 440, 150, 'Tesseract'),
      },
    ];
    return JSON.stringify(notebook);
  });
  await page.locator('input[type=file]').setInputFiles({
    name: 'spacing.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(source),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const expected = 'A first remark  about couplings\nthere is the trivial coupling.';
  for (const view of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.getByRole('button', { name: '选文', exact: true }).click();
    const words = page.locator('.bitmap-text-word');
    await expect(words).toHaveCount(13);
    const drag = async (first: number, last: number, reverse = false) => {
      const start = await words.nth(first).evaluate((el) => {
        const r = document.createRange();
        r.setStart(el.firstChild!, 0);
        r.setEnd(el.firstChild!, 1);
        const b = r.getBoundingClientRect();
        return { x: b.x + b.width * 0.2, y: b.y + b.height / 2 };
      });
      const end = await words.nth(last).evaluate((el) => {
        const node = el.firstChild as Text,
          r = document.createRange();
        r.setStart(node, node.length - 1);
        r.setEnd(node, node.length);
        const b = r.getBoundingClientRect();
        return { x: b.x + b.width * 0.8, y: b.y + b.height / 2 };
      });
      const a = reverse ? end : start,
        b = reverse ? start : end;
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 8 });
      await page.mouse.up();
    };
    await drag(0, 9);
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(expected);
    await page.keyboard.press('Control+c');
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(
      expected,
    );
    await page.getByRole('button', { name: '翻译', exact: true }).click();
    expect(await page.locator('.translation-source').textContent()).toBe(expected);
    await page.getByRole('button', { name: '关闭划词工具' }).click();
    await drag(0, 9, true);
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(expected);
    await page.getByRole('button', { name: '复制选区', exact: true }).click();
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(
      expected,
    );
    await page.getByRole('button', { name: '关闭划词工具' }).click();
    await drag(10, 12);
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('中文连续文字');
    await page.getByRole('button', { name: '关闭划词工具' }).click();
  }
});
