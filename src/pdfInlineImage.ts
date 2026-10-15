import { PDFArray, PDFDict, PDFName, PDFNumber } from 'pdf-lib';
const get = (d: PDFDict, key: string) => d.lookup(PDFName.of(key));
const num = (d: PDFDict, key: string, fallback = 0) => {
  const v = get(d, key);
  return v instanceof PDFNumber ? v.asNumber() : fallback;
};
const white = (n: number) => [0, 9, 10, 12, 13, 32].includes(n);

/** Locate a zlib stream's end without inflating or allocating image pixels. */
function flateEnd(data: Uint8Array, start: number) {
  let bit = (start + 2 + (data[start + 1] & 32 ? 4 : 0)) * 8;
  const read = (n: number) => {
    if (bit + n > data.length * 8) throw new Error('Truncated inline Flate stream');
    let value = 0;
    for (let i = 0; i < n; i++, bit++) value |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    return value;
  };
  const tree = (lengths: number[]) => {
    const counts = new Array<number>(16).fill(0),
      next = counts.slice(),
      table = new Map<number, number>();
    for (const l of lengths) if (l) counts[l]++;
    let code = 0;
    for (let i = 1; i < 16; i++) {
      code = (code + counts[i - 1]) << 1;
      next[i] = code;
    }
    lengths.forEach((length, symbol) => {
      if (!length) return;
      let c = next[length]++,
        reversed = 0;
      for (let i = 0; i < length; i++) {
        reversed = (reversed << 1) | (c & 1);
        c >>= 1;
      }
      table.set((1 << length) | reversed, symbol);
    });
    return () => {
      let c = 0;
      for (let length = 1; length <= 15; length++) {
        c |= read(1) << (length - 1);
        const symbol = table.get((1 << length) | c);
        if (symbol !== undefined) return symbol;
      }
      throw new Error('Invalid inline Flate code');
    };
  };
  const extraLength = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
  ];
  let last = 0;
  do {
    last = read(1);
    const type = read(2);
    if (type === 0) {
      bit = Math.ceil(bit / 8) * 8;
      const length = read(16),
        inverse = read(16);
      if ((length ^ inverse) !== 65535) throw new Error('Invalid inline Flate block');
      bit += length * 8;
      if (bit > data.length * 8) throw new Error('Truncated inline Flate block');
      continue;
    }
    let literals: number[], distances: number[];
    if (type === 1) {
      literals = Array.from({ length: 288 }, (_, i) =>
        i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8,
      );
      distances = new Array(32).fill(5);
    } else if (type === 2) {
      const nl = read(5) + 257,
        nd = read(5) + 1,
        nc = read(4) + 4;
      // RFC 1951 code-length alphabet order.
      const alphabet = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const lengths = new Array<number>(19).fill(0);
      for (let i = 0; i < nc; i++) lengths[alphabet[i]] = read(3);
      const symbol = tree(lengths),
        values: number[] = [];
      while (values.length < nl + nd) {
        const s = symbol();
        if (s < 16) values.push(s);
        else {
          const n = s === 16 ? read(2) + 3 : s === 17 ? read(3) + 3 : read(7) + 11;
          if (s === 16 && !values.length) throw new Error('Invalid inline Flate repeat');
          const value = s === 16 ? values[values.length - 1] : 0;
          for (let i = 0; i < n; i++) values.push(value);
        }
      }
      if (values.length !== nl + nd) throw new Error('Invalid inline Flate tree');
      literals = values.slice(0, nl);
      distances = values.slice(nl);
    } else throw new Error('Invalid inline Flate block type');
    const literal = tree(literals),
      distance = tree(distances);
    for (;;) {
      const s = literal();
      if (s === 256) break;
      if (s < 256) continue;
      if (s > 285) throw new Error('Invalid inline Flate length');
      read(extraLength[s - 257]);
      const d = distance();
      if (d > 29) throw new Error('Invalid inline Flate distance');
      read(d < 4 ? 0 : (d >> 1) - 1);
    }
  } while (!last);
  return Math.ceil(bit / 8) + 4;
}

export function inlineImageEnd(
  data: Uint8Array,
  start: number,
  dict: PDFDict,
  resources?: PDFDict,
) {
  let filter = get(dict, 'Filter');
  if (filter instanceof PDFArray) filter = filter.lookup(0);
  const f = filter instanceof PDFName ? filter.decodeText() : '';
  let end: number | undefined;
  if (!f) {
    let cs = get(dict, 'ColorSpace');
    if (
      cs instanceof PDFName &&
      !['DeviceGray', 'DeviceRGB', 'DeviceCMYK'].includes(cs.decodeText())
    ) {
      const colors = resources?.lookup(PDFName.of('ColorSpace'));
      if (colors instanceof PDFDict) cs = colors.lookup(cs);
    }
    const family = cs instanceof PDFArray ? cs.lookup(0)?.toString() : cs?.toString();
    let channels = ['/DeviceRGB', '/CalRGB', '/Lab'].includes(family ?? '')
      ? 3
      : family === '/DeviceCMYK'
        ? 4
        : 1;
    if (cs instanceof PDFArray && family === '/ICCBased') {
      const profile = cs.lookup(1) as { dict?: PDFDict };
      if (profile?.dict) channels = num(profile.dict, 'N', 1);
    }
    if (cs instanceof PDFArray && family === '/DeviceN') {
      const components = cs.lookup(1);
      if (components instanceof PDFArray) channels = components.size();
    }
    end =
      start +
      Math.ceil((num(dict, 'Width') * channels * num(dict, 'BitsPerComponent', 1)) / 8) *
        num(dict, 'Height');
  } else if (f === 'FlateDecode') end = flateEnd(data, start);
  else if (f === 'DCTDecode') {
    let i = start;
    while (i + 1 < data.length) {
      if (data[i++] !== 255) continue;
      while (data[i] === 255) i++;
      const marker = data[i++];
      if (marker === 217) {
        end = i;
        break;
      }
      if (marker === 0 || marker === 216 || marker === 1 || (marker >= 208 && marker <= 215))
        continue;
      if (i + 1 >= data.length) break;
      const length = (data[i] << 8) | data[i + 1];
      if (length < 2) break;
      i += length;
    }
  } else if (f === 'ASCIIHexDecode' || f === 'ASCII85Decode') {
    for (let i = start; i < data.length; i++) {
      if (
        (f === 'ASCIIHexDecode' && data[i] === 62) ||
        (f === 'ASCII85Decode' && data[i] === 126 && data[i + 1] === 62)
      ) {
        end = i + (f === 'ASCIIHexDecode' ? 1 : 2);
        break;
      }
    }
  } else if (f === 'RunLengthDecode') {
    let i = start;
    while (i < data.length) {
      const length = data[i++];
      if (length === 128) {
        end = i;
        break;
      }
      i += length < 128 ? length + 1 : 1;
    }
  } else if (f === 'LZWDecode') {
    let bit = start * 8,
      width = 9,
      count = 258,
      first = true;
    const parms = get(dict, 'DecodeParms');
    const early = parms instanceof PDFDict ? num(parms, 'EarlyChange', 1) : 1;
    while (bit + width <= data.length * 8) {
      let code = 0;
      for (let j = 0; j < width; j++, bit++)
        code = (code << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
      if (code === 257) {
        end = Math.ceil(bit / 8);
        break;
      }
      if (code === 256) {
        width = 9;
        count = 258;
        first = true;
        continue;
      }
      if (!first && count < 4096) {
        count++;
        if (count + early === 1 << width && width < 12) width++;
      }
      first = false;
    }
  }
  const terminator = (offset: number) => {
    let i = offset;
    while (white(data[i])) i++;
    return (
      data[i] === 69 &&
      data[i + 1] === 73 &&
      (i + 2 === data.length || white(data[i + 2]) || data[i + 2] === 47)
    );
  };
  if (end !== undefined && terminator(end)) return end;
  // CCITT/JPX and damaged producer files: accept only a delimited EI followed
  // by plausible drawing syntax, never arbitrary binary bytes containing EI.
  for (let i = start + 1; i + 2 < data.length; i++) {
    if (!white(data[i - 1]) || data[i] !== 69 || data[i + 1] !== 73 || !white(data[i + 2]))
      continue;
    let j = i + 2;
    while (white(data[j])) j++;
    if (j === data.length || /[\d+\-./qQBTEMCSRGWfnsh%]/.test(String.fromCharCode(data[j])))
      return i - 1;
  }
  throw new Error('PDF inline image data boundary unavailable');
}
