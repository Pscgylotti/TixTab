import type { PdfiumPageInfo } from './pdfiumProtocol';
export interface ViewportOptions {
  scale: number;
  rotation?: number;
  offsetX?: number;
  offsetY?: number;
  dontFlip?: boolean;
}
/** Application page geometry; no renderer classes or object handles are retained. */
export class PdfViewport {
  readonly viewBox: number[];
  readonly userUnit: number;
  readonly scale: number;
  readonly rotation: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
  readonly transform: number[];
  readonly rawDims: { pageWidth: number; pageHeight: number; pageX: number; pageY: number };
  constructor(
    private page: PdfiumPageInfo,
    options: ViewportOptions,
  ) {
    this.viewBox = [...page.view];
    this.userUnit = page.userUnit;
    this.scale = options.scale;
    this.rotation = options.rotation ?? page.rotation;
    this.offsetX = options.offsetX ?? 0;
    this.offsetY = options.offsetY ?? 0;
    const rotation = ((this.rotation % 360) + 360) % 360;
    const linear = (
      { 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] } as Record<
        number,
        number[]
      >
    )[rotation];
    if (!linear) throw new Error('Page rotation must be a multiple of 90 degrees');
    const [x0, y0, x1, y1] = this.viewBox,
      s = this.scale * this.userUnit;
    const [a, b, c, d] = linear.map(
      (value, i) => value * s * (options.dontFlip && i >= 2 ? -1 : 1),
    );
    this.width = (rotation % 180 ? y1 - y0 : x1 - x0) * s;
    this.height = (rotation % 180 ? x1 - x0 : y1 - y0) * s;
    this.transform = [
      a,
      b,
      c,
      d,
      this.offsetX + this.width / 2 - (a * (x0 + x1)) / 2 - (c * (y0 + y1)) / 2,
      this.offsetY + this.height / 2 - (b * (x0 + x1)) / 2 - (d * (y0 + y1)) / 2,
    ];
    this.rawDims = { pageWidth: x1 - x0, pageHeight: y1 - y0, pageX: x0, pageY: y0 };
  }
  clone(options: Partial<ViewportOptions> = {}) {
    return new PdfViewport(this.page, {
      scale: this.scale,
      rotation: this.rotation,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
      ...options,
    });
  }
  convertToViewportPoint(x: number, y: number) {
    const [a, b, c, d, e, f] = this.transform;
    return [a * x + c * y + e, b * x + d * y + f];
  }
  convertToViewportRectangle(rect: number[]) {
    return [
      ...this.convertToViewportPoint(rect[0], rect[1]),
      ...this.convertToViewportPoint(rect[2], rect[3]),
    ];
  }
  convertToPdfPoint(x: number, y: number) {
    const [a, b, c, d, e, f] = this.transform,
      det = a * d - b * c;
    return [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det];
  }
}
