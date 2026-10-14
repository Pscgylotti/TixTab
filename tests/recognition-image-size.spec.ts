import { expect, test } from '@playwright/test';

test('large screenshots and bitmap OCR produce PNGs within native OCR limits', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { capturePage } = await import('/src/capturePage.ts' as string),
      { scanBitmapPages } = await import('/src/bitmapOcr.ts' as string),
      { blankPage } = await import('/src/model.ts' as string);
    const dimensions = async (data: string) => {
      const bitmap = await createImageBitmap(await (await fetch(data)).blob());
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    };
    const p = blankPage();
    const capture = await dimensions(
      await capturePage(p, null, { x: 0, y: 0, width: 2001, height: 2000 }),
    );
    const longCapture = await dimensions(
      await capturePage(p, null, { x: 0, y: 0, width: 10_000, height: 100 }),
    );
    const source = document.createElement('canvas');
    source.width = 3001;
    source.height = 2000;
    source.getContext('2d')!.fillText('OCR size boundary', 10, 30);
    p.images = [
      {
        id: 'large-picture',
        kind: 'image',
        data: source.toDataURL('image/png'),
        x: 100,
        y: 100,
        width: 300,
        height: 200,
      },
    ];
    source.width = source.height = 1;
    let submitted: { width: number; height: number } | undefined;
    let saved: typeof p | undefined;
    await scanBitmapPages([p], null, {
      signal: new AbortController().signal,
      replace: false,
      recognize: async (data: string) => {
        submitted = await dimensions(data);
        const { width: w, height: h } = submitted;
        if (w * h > 4_000_000 || Math.max(w, h) > 8192)
          throw new Error('PNG image exceeds 4 million pixels');
        return {
          text: 'OCR size boundary',
          engine: 'test',
          lines: [{ text: 'OCR size boundary', polygon: [0, 0, w, 0, w, h, 0, h] }],
        };
      },
      onPage: (next: typeof p) => (saved = next),
      onImage: () => {},
    });
    return { capture, longCapture, submitted, ocr: saved?.images[0].ocr };
  });
  for (const size of [result.capture, result.longCapture, result.submitted!]) {
    expect(size.width * size.height).toBeLessThanOrEqual(4_000_000);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(8192);
  }
  expect(result.ocr?.text).toBe('OCR size boundary');
  expect(result.ocr?.lines[0].polygon).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
});
