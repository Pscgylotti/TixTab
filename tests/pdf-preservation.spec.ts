import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, PDFName, PDFDict, PDFString, PDFHexString } = createRequire(import.meta.url)(
  'pdf-lib',
);
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
      errors = [],
      diagnostics = [];
    for (const [newIndex, oldIndex] of [
      [0, 3],
      [2, 0],
      [3, 1],
      [4, 2],
    ]) {
      const data = [],
        images = [];
      let width = 0;
      for (const [doc, index] of [
        [pdf, oldIndex],
        [output, newIndex],
      ]) {
        const p = await doc.getPage(index + 1),
          vp = p.getViewport({ scale: 0.5 }),
          c = document.createElement('canvas');
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        await p.render({ canvas: c, viewport: vp, widgets: true }).promise;
        data.push(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data);
        images.push(c.toDataURL());
        width = c.width;
      }
      let error = 0;
      const vp = (await pdf.getPage(oldIndex + 1)).getViewport({ scale: 0.5 });
      const [x0, y0, x1, y1] = vp.convertToViewportRectangle([50, 45, 210, 70]);
      // Removing a destination deliberately removes its visible link border.
      // Exclude only that known annotation rectangle from pixel preservation.
      for (let i = 0; i < data[0].length; i++) {
        const x = Math.floor(i / 4) % width,
          y = Math.floor(Math.floor(i / 4) / width);
        if (
          oldIndex === 0 &&
          x >= Math.min(x0, x1) - 1 &&
          x <= Math.max(x0, x1) + 1 &&
          y >= Math.min(y0, y1) - 1 &&
          y <= Math.max(y0, y1) + 1
        )
          continue;
        error += Math.abs(data[0][i] - data[1][i]);
      }
      errors.push(error / data[0].length);
      if (error / data[0].length > 0.1) {
        const xs = [],
          ys = [];
        for (let n = 0; n < data[0].length; n += 4)
          if ([0, 1, 2].some((c) => Math.abs(data[0][n + c] - data[1][n + c]) > 16)) {
            xs.push((n / 4) % width);
            ys.push(Math.floor(n / 4 / width));
          }
        diagnostics.push({
          newIndex,
          oldIndex,
          images,
          bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          pixels: xs.length,
        });
      }
    }
    const dest = await output.getDestination('retained');
    const annotations = await (await output.getPage(3)).getAnnotations();
    const text = await (await output.getPage(3)).getTextContent();
    const out = {
      bytes: Array.from(outputBytes),
      errors,
      diagnostics,
      destIndex: dest
        ? typeof dest[0] === 'number'
          ? dest[0]
          : await output.getPageIndex(dest[0])
        : null,
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
  for (const item of result.diagnostics) {
    for (let i = 0; i < item.images.length; i++)
      await writeFile(
        `tmp/pdfs/preservation-${item.oldIndex}-${i}.png`,
        Buffer.from(item.images[i].split(',')[1], 'base64'),
      );
    console.log(JSON.stringify({ page: item.oldIndex, bbox: item.bbox, pixels: item.pixels }));
  }
  expect(
    result.errors.every((n) => n < 0.1),
    JSON.stringify(result.errors),
  ).toBe(true);
  expect(result.destIndex).toBe(0);
  expect(result.removedDest).toBeNull();
  expect(result.annotations.some((a: any) => a.url === 'https://example.com/reference')).toBe(true);
  expect(result.annotations.some((a: any) => a.dest === 'removed')).toBe(false);
  expect(result.text).toContain('Original page 1');
  const output = await PDFDocument.load(new Uint8Array(result.bytes), { updateMetadata: false });
  const decode = (value: any) =>
    value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString
      ? value.decodeText()
      : undefined;
  const fields = Object.fromEntries(
    output
      .getForm()
      .acroForm.getAllFields()
      .map(([field]: any) => [field.getFullyQualifiedName(), decode(field.V())]),
  );
  expect(Object.keys(fields).sort()).toEqual(
    ['checked', 'group', 'group.field-0', 'group.field-1', 'group.field-2', 'group.field-3'].sort(),
  );
  expect(fields['group.field-0']).toBe('value-0');
  expect(fields.checked).toBe('Yes');
  const nums = output.catalog.lookup(PDFName.of('PageLabels'), PDFDict).lookup(PDFName.of('Nums'));
  const labels = [];
  for (let i = 0; i < nums.size(); i += 2) {
    const spec = nums.lookup(i + 1, PDFDict);
    labels.push([
      nums.lookup(i).asNumber(),
      decode(spec.lookup(PDFName.of('S'))),
      spec.lookup(PDFName.of('St')).asNumber(),
      decode(spec.lookup(PDFName.of('P'))),
    ]);
  }
  expect(labels).toEqual([
    [0, 'D', 11, undefined],
    [1, 'D', 2, undefined],
    [2, 'r', 3, 'section-'],
    [3, 'r', 4, 'section-'],
    [4, 'D', 10, undefined],
  ]);
  const annotations = output
    .getPage(2)
    .node.Annots()
    .asArray()
    .map((ref: any) => output.context.lookup(ref, PDFDict));
  expect(
    annotations.some((a: any) => decode(a.lookup(PDFName.of('Contents'))) === 'Original note 1'),
  ).toBe(true);

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
      // Omit the separate widget pass for overlay geometry checks; static form
      // appearances are checked independently in the preservation fixture.
      for (let i = 1; i <= 4; i++) {
        const p = await out.getPage(i),
          vp = p.getViewport({ scale: 1 }),
          c = document.createElement('canvas');
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        await p.render({ canvas: c, viewport: vp, widgets: false }).promise;
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
