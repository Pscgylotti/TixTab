import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFObjectParser,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib';
import ByteStream from 'pdf-lib/es/core/parser/ByteStream';
import { multiply, transformPolygon } from './pdfNightGeometry';
import { inlineImageEnd } from './pdfInlineImage';

export type SourceRef = [number, number];
/** Metadata only: never keep decoded image bytes in the reader's index. */
export interface SourceImage {
  polygon: number[];
  width: number;
  height: number;
  owner: SourceRef;
  ref?: SourceRef;
  inline?: { stream: SourceRef; start: number; end: number; dict: string };
}
const identity = [1, 0, 0, 1, 0, 0];
const name = PDFName.of;
const get = (d: PDFDict, key: string) => d.lookup(name(key));
const num = (d: PDFDict, key: string, fallback = 0) => {
  const value = get(d, key);
  return value instanceof PDFNumber ? value.asNumber() : fallback;
};
const array = (d: PDFDict, key: string, fallback: number[]) => {
  const value = get(d, key);
  return value instanceof PDFArray ? value.asArray().map((n) => Number(n.toString())) : fallback;
};
const white = (n: number) => [0, 9, 10, 12, 13, 32].includes(n);
const delimiter = (n: number) => white(n) || [40, 41, 60, 62, 91, 93, 123, 125, 47, 37].includes(n);
const keys: Record<string, string> = {
  W: 'Width',
  H: 'Height',
  BPC: 'BitsPerComponent',
  CS: 'ColorSpace',
  IM: 'ImageMask',
  F: 'Filter',
  DP: 'DecodeParms',
  D: 'Decode',
  I: 'Interpolate',
};
const names: Record<string, string> = {
  G: 'DeviceGray',
  RGB: 'DeviceRGB',
  CMYK: 'DeviceCMYK',
  I: 'Indexed',
  Fl: 'FlateDecode',
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode',
};
function expand(value: PDFObject): PDFObject {
  if (value instanceof PDFName) return name(names[value.decodeText()] ?? value.decodeText());
  if (value instanceof PDFArray)
    for (let i = 0; i < value.size(); i++) value.set(i, expand(value.get(i)));
  return value;
}
export function sourceRef(ref: PDFRef): SourceRef {
  return [ref.objectNumber, ref.generationNumber];
}
export const lookupRef = (doc: PDFDocument, ref: SourceRef) =>
  doc.context.lookup(PDFRef.of(...ref));

/** Parse drawing operators, not pixels. Strings/arrays are parsed as PDF
 * objects so operator-looking bytes inside text cannot affect the CTM. */
export async function sourceImages(doc: PDFDocument, check = () => {}) {
  const refs = new WeakMap<PDFObject, PDFRef>();
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) refs.set(object, ref);
  const result: SourceImage[][] = [],
    native: boolean[] = [];
  for (const page of doc.getPages()) {
    const images: SourceImage[] = [];
    let safe = true,
      operations = 0;
    const add = (
      dict: PDFDict,
      matrix: number[],
      owner: PDFRef,
      locator: Pick<SourceImage, 'ref' | 'inline'>,
    ) => {
      const mask = get(dict, 'ImageMask');
      if (mask instanceof PDFBool && mask.asBoolean()) {
        safe = false;
        return;
      }
      const width = num(dict, 'Width'),
        height = num(dict, 'Height');
      if (!(width > 0 && height > 0) || !matrix.every(Number.isFinite)) return;
      if (images.length >= 4096) throw new Error('PDF image count limit');
      images.push({
        polygon: transformPolygon([0, 0, 1, 0, 1, 1, 0, 1], matrix),
        width,
        height,
        owner: sourceRef(owner),
        ...locator,
      });
    };
    const walk = async (
      streams: PDFRawStream[],
      resources: PDFDict | undefined,
      owner: PDFRef,
      initial: number[],
      ancestors: Set<PDFRawStream>,
    ) => {
      if (ancestors.size > 32) throw new Error('PDF image nesting limit');
      let matrix = initial;
      const stack: number[][] = [];
      for (const stream of streams) {
        check();
        const data = decodePDFRawStream(stream).decode();
        if (data.length > 32_000_000) throw new Error('PDF content size limit');
        const bytes = ByteStream.of(data),
          parser = PDFObjectParser.forByteStream(
            bytes as unknown as Parameters<typeof PDFObjectParser.forByteStream>[0],
            doc.context,
          );
        let operands: PDFObject[] = [];
        while (!bytes.done()) {
          while (!bytes.done()) {
            if (white(bytes.peek())) bytes.next();
            else if (bytes.peek() === 37) {
              while (!bytes.done() && ![10, 13].includes(bytes.next())) {}
            } else break;
          }
          if (bytes.done()) break;
          if (++operations > 1_000_000) throw new Error('PDF content operation limit');
          if (operations % 2048 === 0) {
            await new Promise<void>((r) => setTimeout(r, 0));
            check();
          }
          const start = bytes.offset(),
            c = bytes.peek();
          if ([47, 40, 60, 91, 43, 45, 46].includes(c) || (c >= 48 && c <= 57)) {
            operands.push(parser.parseObject());
            if (operands.length > 4096) throw new Error('PDF operand limit');
            continue;
          }
          while (!bytes.done() && !delimiter(bytes.peek())) bytes.next();
          if (bytes.offset() === start) {
            bytes.next();
            operands = [];
            continue;
          }
          const op = new TextDecoder('latin1').decode(data.subarray(start, bytes.offset()));
          if (op === 'q') stack.push(matrix);
          else if (op === 'Q') matrix = stack.pop() ?? matrix;
          else if (op === 'cm' && operands.length >= 6)
            matrix = multiply(
              matrix,
              operands.slice(-6).map((n) => Number(n.toString())),
            );
          else if (op === 'gs') safe = false;
          else if (op === 'Do' && operands[0] instanceof PDFName) {
            const objects = resources?.lookup(name('XObject'));
            const object = objects instanceof PDFDict ? objects.lookup(operands[0]) : undefined;
            if (object instanceof PDFRawStream) {
              const subtype = get(object.dict, 'Subtype'),
                ref = refs.get(object);
              if (subtype === name('Image') && ref)
                add(object.dict, matrix, owner, { ref: sourceRef(ref) });
              else if (subtype === name('Form') && !ancestors.has(object)) {
                const own = get(object.dict, 'Resources');
                await walk(
                  [object],
                  own instanceof PDFDict ? own : resources,
                  own instanceof PDFDict && ref ? ref : owner,
                  multiply(matrix, array(object.dict, 'Matrix', identity)),
                  new Set([...ancestors, object]),
                );
              }
            }
          } else if (op === 'BI') {
            safe = false;
            const dict = doc.context.obj({ Type: 'XObject', Subtype: 'Image' });
            for (;;) {
              while (white(bytes.peek())) bytes.next();
              if (
                bytes.peek() === 73 &&
                bytes.peekAhead(1) === 68 &&
                delimiter(bytes.peekAhead(2))
              ) {
                bytes.next();
                bytes.next();
                break;
              }
              const key = parser.parseObject();
              if (!(key instanceof PDFName)) throw new Error('PDF inline image dictionary invalid');
              dict.set(
                name(keys[key.decodeText()] ?? key.decodeText()),
                expand(parser.parseObject()),
              );
            }
            if (bytes.next() === 13 && bytes.peek() === 10) bytes.next();
            const first = bytes.offset(),
              end = inlineImageEnd(data, first, dict, resources);
            bytes.moveTo(end);
            while (white(bytes.peek())) bytes.next();
            if (bytes.next() !== 69 || bytes.next() !== 73)
              throw new Error('PDF inline image terminator missing');
            const ref = refs.get(stream);
            if (!ref) throw new Error('PDF inline image stream reference missing');
            add(dict, matrix, owner, {
              inline: { stream: sourceRef(ref), start: first, end, dict: dict.toString() },
            });
          }
          operands = [];
        }
      }
    };
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents
            .asArray()
            .map((r) => doc.context.lookup(r))
            .filter((r): r is PDFRawStream => r instanceof PDFRawStream)
        : contents instanceof PDFRawStream
          ? [contents]
          : [];
    await walk(streams, page.node.Resources(), page.ref, identity, new Set());
    const annotations = page.node.Annots();
    if (annotations)
      for (const entry of annotations.asArray()) {
        const annotation = doc.context.lookup(entry);
        if (!(annotation instanceof PDFDict) || num(annotation, 'F') & (1 | 2 | 32)) continue;
        const ap = get(annotation, 'AP');
        let appearance = ap instanceof PDFDict ? get(ap, 'N') : undefined;
        if (appearance instanceof PDFDict) {
          const state = get(annotation, 'AS');
          appearance = state instanceof PDFName ? appearance.lookup(state) : undefined;
        }
        if (!(appearance instanceof PDFRawStream)) continue;
        safe = false;
        const rect = array(annotation, 'Rect', [0, 0, 0, 0]),
          bbox = array(appearance.dict, 'BBox', [0, 0, 1, 1]),
          am = array(appearance.dict, 'Matrix', identity);
        const corners = transformPolygon(
          [bbox[0], bbox[1], bbox[2], bbox[1], bbox[2], bbox[3], bbox[0], bbox[3]],
          am,
        );
        const xs = corners.filter((_, i) => !(i % 2)),
          ys = corners.filter((_, i) => i % 2);
        const x = Math.min(...xs),
          y = Math.min(...ys),
          w = Math.max(...xs) - x,
          h = Math.max(...ys) - y;
        const sx = w ? (rect[2] - rect[0]) / w : 1,
          sy = h ? (rect[3] - rect[1]) / h : 1;
        const own = get(appearance.dict, 'Resources'),
          ref = refs.get(appearance);
        await walk(
          [appearance],
          own instanceof PDFDict ? own : page.node.Resources(),
          own instanceof PDFDict && ref ? ref : page.ref,
          multiply([sx, 0, 0, sy, rect[0] - x * sx, rect[1] - y * sy], am),
          new Set([appearance]),
        );
      }
    result.push(images);
    native.push(safe);
  }
  return { images: result, native };
}
