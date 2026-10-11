import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
import { preservationFixture } from '../scripts/pdf-preservation-fixture.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

test('export preserves source document fields, annotations, navigation, metadata and rotated page pixels', async ({
  page,
}) => {
  const bytes = Array.from(await preservationFixture());
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const result = await page.evaluate(async (bytes) => {
    const { importPdf, exportPdf, loadPdf } = await import('/src/pdf.ts' as string);
    const { notebook, pdf } = await importPdf(new Uint8Array(bytes), 'preservation.pdf');
    // Reorder, remove the last source page and insert one blank page.
    notebook.pages = [
      notebook.pages[3],
      {
        id: 'blank',
        sourceIndex: null,
        width: 300,
        height: 500,
        strokes: [],
        images: [],
        paper: 'plain',
      },
      notebook.pages[0],
      notebook.pages[1],
      notebook.pages[2],
    ];
    const outputBytes = await exportPdf(notebook),
      output = await loadPdf(outputBytes),
      errors = [];
    for (const [newIndex, oldIndex] of [
      [0, 3],
      [2, 0],
      [3, 1],
      [4, 2],
    ]) {
      const data = [];
      for (const [doc, index] of [
        [pdf, oldIndex],
        [output, newIndex],
      ]) {
        const p = await doc.getPage(index + 1),
          vp = p.getViewport({ scale: 0.5 }),
          c = document.createElement('canvas');
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        await p.render({ canvas: c, viewport: vp, annotationMode: 1 }).promise;
        data.push(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data);
      }
      let error = 0;
      for (let i = 0; i < data[0].length; i++) error += Math.abs(data[0][i] - data[1][i]);
      errors.push(error / data[0].length);
    }
    const fields = await output.getFieldObjects(),
      dest = await output.getDestination('retained');
    const annotations = await (await output.getPage(3)).getAnnotations();
    const text = await (await output.getPage(3)).getTextContent();
    const out = {
      fieldObjects: fields,
      bytes: Array.from(outputBytes),
      errors,
      fields: Object.keys(fields ?? {}),
      values: Object.fromEntries(
        Object.entries(fields ?? {}).map(([key, entries]: any) => [
          key,
          entries.find((entry: any) => entry.value !== undefined)?.value,
        ]),
      ),
      labels: await output.getPageLabels(),
      destIndex: dest ? await output.getPageIndex(dest[0]) : null,
      removedDest: await output.getDestination('removed'),
      annotations: annotations.map((a: any) => ({
        subtype: a.subtype,
        contents: a.contentsObj?.str,
        url: a.url,
        dest: a.dest,
      })),
      text: text.items.map((i: any) => i.str).join(' '),
    };
    await pdf.destroy();
    await output.destroy();
    return out;
  }, bytes);
  await mkdir('tmp/pdfs', { recursive: true });
  await writeFile('tmp/pdfs/preservation-export.pdf', new Uint8Array(result.bytes));
  expect(result.fields.sort()).toEqual(
    ['checked', 'group', 'group.field-0', 'group.field-1', 'group.field-2', 'group.field-3'].sort(),
  );
  expect(result.values['group.field-0']).toBe('value-0');
  expect(result.values['checked']).toBe('Yes');
  expect(
    result.errors.every((n) => n < 0.1),
    JSON.stringify(result.errors),
  ).toBe(true);
  expect(result.destIndex).toBe(0);
  expect(result.removedDest).toBeNull();
  expect(result.labels).toEqual(['11', '2', 'section-iii', 'section-iv', '10']);
  expect(result.annotations.some((a: any) => a.contents === 'Original note 1')).toBe(true);
  expect(result.annotations.some((a: any) => a.url === 'https://example.com/reference')).toBe(true);
  expect(result.annotations.some((a: any) => a.dest === 'removed')).toBe(false);
  expect(result.text).toContain('Original page 1');
  const output = await PDFDocument.load(new Uint8Array(result.bytes), { updateMetadata: false });
  expect(output.getTitle()).toBe('Preserved document title');
  expect(output.getAuthor()).toBe('TixTab fixture');
  expect(output.getCreationDate()?.toISOString()).toBe('2024-03-02T12:00:00.000Z');
  await mkdir('tmp/pdfs', { recursive: true });
  await writeFile('tmp/pdfs/preservation-export.pdf', new Uint8Array(result.bytes));
});

test('ink and inserted images keep visual coordinates across crop, rotation and UserUnit', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const results = await page.evaluate(
    async (bytes) => {
      const { importPdf, exportPdf, loadPdf } = await import('/src/pdf.ts' as string);
      const { notebook, pdf } = await importPdf(new Uint8Array(bytes), 'geometry.pdf');
      const image = document.createElement('canvas');
      image.width = 80;
      image.height = 40;
      const ctx = image.getContext('2d')!;
      ctx.fillStyle = '#00c000';
      ctx.fillRect(0, 0, 80, 40);
      notebook.pages = notebook.pages.slice(0, 4);
      for (const p of notebook.pages) {
        p.strokes = [
          {
            id: 'red',
            tool: 'pen',
            color: '#f00000',
            size: 10,
            points: [
              [80, 100, 0.5],
              [140, 130, 0.5],
            ],
          },
        ];
        p.images = [
          {
            id: 'green',
            kind: 'sketch',
            data: image.toDataURL(),
            x: 150,
            y: 150,
            width: 80,
            height: 40,
          },
        ];
      }
      const outputBytes = await exportPdf(notebook),
        out = await loadPdf(outputBytes),
        results = [];
      const { requestPdfBitmap } = await import('/src/pdfRenderCache.ts' as string);
      // ENABLE_FORMS omits widget painting: PDF.js otherwise reorders widgets above
      // stamps. Compare complete widget appearances separately in the first test.
      for (let i = 1; i <= 4; i++) {
        const p = await out.getPage(i),
          vp = p.getViewport({ scale: 1 }),
          c = document.createElement('canvas');
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        await p.render({ canvas: c, viewport: vp, annotationMode: 2 }).promise;
        const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let count = 0,
          x = 0,
          y = 0;
        for (let k = 0; k < data.length; k += 4)
          if (data[k] > 150 && data[k + 1] < 60 && data[k + 2] < 60) {
            count++;
            x += (k / 4) % c.width;
            y += Math.floor(k / 4 / c.width);
          }
        const greenPoints = [];
        for (let k = 0; k < data.length; k += 4)
          if (data[k] < 30 && data[k + 1] > 150 && data[k + 2] < 30)
            greenPoints.push([(k / 4) % c.width, Math.floor(k / 4 / c.width)]);
        const night = await requestPdfBitmap(out, i - 1, 1, 0, true).promise;
        results.push({
          nightGreen: Array.from(night.getContext('2d')!.getImageData(190, 155, 1, 1).data),
          index: i,
          count,
          x: x / count,
          y: y / count,
          green: Array.from(c.getContext('2d')!.getImageData(190, 170, 1, 1).data),
          greenBounds: greenPoints.length
            ? [
                Math.min(...greenPoints.map((p) => p[0])),
                Math.min(...greenPoints.map((p) => p[1])),
                Math.max(...greenPoints.map((p) => p[0])),
                Math.max(...greenPoints.map((p) => p[1])),
              ]
            : [],
          png: c.toDataURL(),
        });
      }
      await pdf.destroy();
      await out.destroy();
      return { results, bytes: Array.from(outputBytes) };
    },
    Array.from(await preservationFixture()),
  );
  await mkdir('tmp/pdfs', { recursive: true });
  await writeFile('tmp/pdfs/overlay-export.pdf', new Uint8Array(results.bytes));
  for (const result of results.results) {
    await writeFile(
      `tmp/pdfs/overlay-${result.index}.png`,
      Buffer.from(result.png.split(',')[1], 'base64'),
    );
    expect(result.count).toBeGreaterThan(100);
    expect(result.x).toBeGreaterThan(100);
    expect(result.x).toBeLessThan(125);
    expect(result.y).toBeGreaterThan(108);
    expect(result.y).toBeLessThan(125);
    expect(result.green).toEqual([0, 192, 0, 255]);
    expect(result.greenBounds).toEqual([150, 150, 229, 189]);
    expect(result.nightGreen).toEqual([0, 119, 0, 255]);
  }
});
