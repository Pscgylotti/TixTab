/** Image polygons in PDF coordinates. Stencil/image masks intentionally follow text colors.
 * Complex transparency/clipping and text painted over an image remain experimental. */
export type Matrix = number[];
export type ImagePolygon = number[];
export const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
export function transformPolygon(p: ImagePolygon, m: Matrix) {
  return p.map((_, i) =>
    i % 2 ? m[1] * p[i - 1] + m[3] * p[i] + m[5] : m[0] * p[i] + m[2] * p[i + 1] + m[4],
  );
}
export function imagePolygons(
  ops: { fnArray: number[]; argsArray: unknown[][] },
  names: Record<string, number>,
  onImage?: (polygon: ImagePolygon, operatorIndex: number, groupIndex?: number) => void,
): ImagePolygon[] {
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [],
    result: ImagePolygon[] = [];
  const annotations: { matrix: Matrix; depth: number }[] = [];
  const add = (m: Matrix, operatorIndex: number, groupIndex?: number) => {
    if (m.every(Number.isFinite) && result.length < 4096) {
      const polygon = transformPolygon([0, 0, 1, 0, 1, 1, 0, 1], m);
      result.push(polygon);
      onImage?.(polygon, operatorIndex, groupIndex);
    }
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i],
      a = ops.argsArray[i];
    if (fn === names.beginAnnotation) {
      // PDF.js resets annotation appearances to the page's initial transform;
      // they do not inherit the preceding page-content CTM.
      annotations.push({ matrix, depth: stack.length });
      matrix = multiply(a[2] as number[], a[3] as number[]);
    } else if (fn === names.endAnnotation) {
      const state = annotations.pop();
      if (state) {
        matrix = state.matrix;
        stack.length = state.depth;
      }
    } else if (fn === names.save) stack.push([...matrix]);
    else if (fn === names.restore) matrix = stack.pop() ?? matrix;
    else if (fn === names.transform) matrix = multiply(matrix, a as number[]);
    else if (fn === names.paintFormXObjectBegin || fn === names.beginGroup) {
      stack.push([...matrix]);
      const m = fn === names.beginGroup ? (a[0] as { matrix?: number[] })?.matrix : a[0];
      if (m) matrix = multiply(matrix, m as number[]);
    } else if (fn === names.paintFormXObjectEnd || fn === names.endGroup)
      matrix = stack.pop() ?? matrix;
    else if (fn === names.paintImageXObject || fn === names.paintInlineImageXObject) add(matrix, i);
    else if (fn === names.paintImageXObjectRepeat) {
      const positions = a[3] as number[];
      for (let j = 0; j < positions.length; j += 2)
        add(
          multiply(matrix, [Number(a[1]), 0, 0, Number(a[2]), positions[j], positions[j + 1]]),
          i,
          j / 2,
        );
    } else if (fn === names.paintInlineImageXObjectGroup)
      for (const [j, entry] of (a[1] as { transform: number[] }[]).entries())
        add(multiply(matrix, entry.transform), i, j);
  }
  return result;
}
export function polygonBox(p: ImagePolygon) {
  const xs = p.filter((_, i) => i % 2 === 0),
    ys = p.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
