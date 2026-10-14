import type { Page } from './model';
import { groupLeaves } from './objectGroup';
import type { OcrAnnotation, OcrWord } from './ocrLayout';
import { imageCorners } from './objectRotation';

/** OCR uses top-left image coordinates; PDF image quads start at bottom-left. */
export function projectOcrPolygon(points: number[], image: number[], pdf = false) {
  const origin = pdf ? 6 : 0,
    right = pdf ? 4 : 2,
    down = pdf ? 0 : 6;
  return points.map((_, i) => {
    const u = points[i - (i % 2)],
      v = points[i - (i % 2) + 1],
      axis = i % 2;
    return (
      image[origin + axis] +
      u * (image[right + axis] - image[origin + axis]) +
      v * (image[down + axis] - image[origin + axis])
    );
  });
}
export interface BitmapTextLine extends OcrWord {
  key: string;
  words?: OcrWord[];
}
/** Preserve the OCR line's actual spacing (including CJK), rather than adding spaces per box. */
export function bitmapSelectionWords(line: BitmapTextLine) {
  let offset = 0;
  const words: (OcrWord & { before: string; after?: string })[] = [];
  for (const word of line.words ?? []) {
    const index = line.text.indexOf(word.text, offset);
    if (index < 0) return [{ ...line, before: '' }];
    words.push({ ...word, before: line.text.slice(offset, index) });
    offset = index + word.text.length;
  }
  if (!words.length) return [{ ...line, before: '' }];
  words[words.length - 1].after = line.text.slice(offset);
  return words;
}
export function bitmapTextLines(page: Page): BitmapTextLine[] {
  const result: BitmapTextLine[] = [];
  const add = (ocr: OcrAnnotation, polygon: number[], key: string, pdf = false) => {
    for (const [i, line] of ocr.lines.entries()) {
      result.push({
        key: `${key}:${i}`,
        text: line.text,
        polygon: projectOcrPolygon(line.polygon, polygon, pdf),
        words: line.words?.map((word) => ({
          text: word.text,
          polygon: projectOcrPolygon(word.polygon, polygon, pdf),
        })),
      });
    }
  };
  for (const b of page.bitmapOcr ?? []) add(b.result, b.polygon, `pdf:${b.imageIndex}`, true);
  for (const image of page.images.flatMap(groupLeaves))
    if (image.ocr) add(image.ocr, imageCorners(image), image.id);
  return result;
}
