import { invalidatePdfBitmap, isRetiredPdfBitmap } from './pdfRenderCache';

// A cached raster is immutable. Exactly one display may mount the original;
// concurrent displays copy it rather than moving it out of another view.
const owners = new WeakMap<HTMLCanvasElement, PdfBitmapDisplay>();

export class PdfBitmapDisplay {
  private shown: HTMLCanvasElement | null = null;
  private source: HTMLCanvasElement | null = null;
  private disposed = false;

  constructor(
    private host: HTMLElement,
    private className: string,
    private recover: () => void,
  ) {
    this.clear();
  }

  private lost = () => {
    if (this.disposed) return;
    if (this.shown === this.source && this.source) invalidatePdfBitmap(this.source);
    this.clear();
    this.recover();
  };

  private release() {
    this.shown?.removeEventListener('contextlost', this.lost);
    if (this.source && owners.get(this.source) === this) owners.delete(this.source);
    this.shown?.remove();
    if (this.shown && this.shown !== this.source) this.shown.width = this.shown.height = 1;
    else if (this.shown && isRetiredPdfBitmap(this.shown)) this.shown.width = this.shown.height = 1;
    this.shown = null;
    this.source = null;
  }

  show(source: HTMLCanvasElement, night: boolean) {
    if (this.disposed) return;
    if (source === this.source && this.shown?.parentNode === this.host) return;
    const owner = owners.get(source);
    const borrowed = (!owner || owner === this) && (!source.parentNode || owner === this);
    const canvas = borrowed ? source : document.createElement('canvas');
    if (!borrowed) {
      // Finish the fallback copy before releasing the previous visible image.
      canvas.width = source.width;
      canvas.height = source.height;
      canvas.getContext('2d')!.drawImage(source, 0, 0);
    }
    this.release();
    if (borrowed) owners.set(source, this);
    canvas.className = this.className;
    canvas.dataset.renderedNight = String(night);
    canvas.setAttribute('aria-hidden', 'true');
    canvas.addEventListener('contextlost', this.lost);
    this.shown = canvas;
    this.source = source;
    this.host.replaceChildren(canvas);
  }

  clear() {
    if (this.disposed) return;
    this.release();
    const placeholder = document.createElement('canvas');
    placeholder.width = placeholder.height = 1;
    placeholder.className = this.className;
    placeholder.setAttribute('aria-hidden', 'true');
    this.host.replaceChildren(placeholder);
  }

  dispose() {
    if (this.disposed) return;
    this.release();
    this.host.replaceChildren();
    this.disposed = true;
  }
}
