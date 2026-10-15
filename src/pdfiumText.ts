import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import type { TextContent } from './pdfTextContent';
type Item = Extract<TextContent['items'][number], { str: string }>;
/** PDFium text and font metrics; extracted results hold no native handles. */
export async function nativeText(
  api: WrappedPdfiumModule,
  page: number,
  check: () => void,
): Promise<TextContent> {
  const text = api.FPDFText_LoadPage(page);
  if (!text) throw new Error('PDFium text unavailable');
  const m = api.pdfium,
    p = m.wasmExports.malloc(1152);
  try {
    const count = api.FPDFText_CountChars(text);
    if (count > 250000) throw new Error('PDF page text limit exceeded');
    const items: Item[] = [],
      styles: TextContent['styles'] = {};
    let current: Item | undefined,
      owner = 0;
    for (let i = 0; i < count; i++) {
      if (i % 1024 === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
        check();
      }
      const unicode = api.FPDFText_GetUnicode(text, i);
      if (!unicode || unicode > 0x10ffff) continue;
      let str = String.fromCodePoint(unicode);
      if (str === '\r' || str === '\n') {
        if (items.length) items.at(-1)!.hasEOL = true;
        current = undefined;
        continue;
      }
      if (unicode >= 0xfb00 && unicode <= 0xfb06)
        str = ['ff', 'fi', 'fl', 'ffi', 'ffl', 'st', 'st'][unicode - 0xfb00];
      const object = api.FPDFText_GetTextObject(text, i);
      if (!object && /\s/.test(str)) {
        if (current) {
          current.str += str;
          current.width += current.height * 0.25;
        }
        continue;
      }
      if (!api.FPDFText_GetCharOrigin(text, i, p, p + 8)) continue;
      const x = m.getValue(p, 'double'),
        y = m.getValue(p + 8, 'double');
      const size = api.FPDFText_GetFontSize(text, i);
      if (!(size > 0) || !api.FPDFText_GetMatrix(text, i, p + 16)) continue;
      const matrix = Array.from(
        { length: 4 },
        (_, j) => m.getValue(p + 16 + j * 4, 'float') * size,
      );
      const height = Math.hypot(matrix[2], matrix[3]),
        length = Math.hypot(matrix[0], matrix[1]);
      if (!(height > 0 && length > 0)) continue;
      const nx = matrix[0] / length,
        ny = matrix[1] / length;
      const fontName = `pdfium-${object}`;
      if (!styles[fontName]) {
        const font = api.FPDFTextObj_GetFont(object);
        const nameLength = api.FPDFText_GetFontInfo(text, i, p + 128, 1024, p + 64);
        const flags = m.getValue(p + 64, 'i32');
        const name = nameLength > 0 ? m.UTF8ToString(p + 128, Math.min(1023, nameLength - 1)) : '';
        const ascent =
          font && api.FPDFFont_GetAscent(font, size, p + 68)
            ? m.getValue(p + 68, 'float') / size
            : 0.8;
        const descent =
          font && api.FPDFFont_GetDescent(font, size, p + 72)
            ? m.getValue(p + 72, 'float') / size
            : -0.2;
        styles[fontName] = {
          fontFamily:
            flags & 1 || /Courier|Mono|CMTT/i.test(name)
              ? 'monospace'
              : flags & 2 || /Times|Serif|CMR|CMMI/i.test(name)
                ? 'serif'
                : 'sans-serif',
          ascent,
          descent,
          vertical: false,
        };
      }
      if (
        current &&
        (owner !== object ||
          Math.abs((x - current.transform[4]) * -ny + (y - current.transform[5]) * nx) >
            height * 0.2)
      )
        current = undefined;
      if (!current) {
        current = {
          str: '',
          dir: /[\u0590-\u08ff]/.test(str) ? 'rtl' : 'ltr',
          width: 0,
          height,
          fontName,
          transform: [...matrix, x, y],
          hasEOL: false,
        };
        items.push(current);
        owner = object;
      }
      current.str += str;
      let advance = height * 0.5;
      if (api.FPDFText_GetLooseCharBox(text, i, p + 80)) {
        const left = m.getValue(p + 80, 'float'),
          top = m.getValue(p + 84, 'float'),
          right = m.getValue(p + 88, 'float'),
          bottom = m.getValue(p + 92, 'float');
        advance = Math.max(
          ...[
            [left, top],
            [right, top],
            [left, bottom],
            [right, bottom],
          ].map(([cx, cy]) => (cx - x) * nx + (cy - y) * ny),
        );
      }
      const offset = (x - current.transform[4]) * nx + (y - current.transform[5]) * ny;
      current.width = Math.max(current.width, Math.abs(offset) + Math.max(0, advance));
    }
    return { items, styles, lang: null };
  } finally {
    m.wasmExports.free(p);
    api.FPDFText_ClosePage(text);
  }
}
