import { invalidatePdfBitmap, isRetiredPdfBitmap } from './pdfRenderCache';

// A cached raster is immutable. Exactly one display may mount the original;
// concurrent displays copy it rather than moving it out of another view.
const owners = new WeakMap<HTMLCanvasElement, PdfBitmapDisplay>();

export class PdfBitmapDisplay {
  private shown: HTMLCanvasElement | null = null;
  private source: HTMLCanvasElement | null = null;
  private disposed = false;
  private preview: HTMLCanvasElement | null = null;
  private previewFor: HTMLCanvasElement | null = null;

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
    this.showPreview();
    this.recover();
  };

  private release() {
    this.shown?.removeEventListener('contextlost', this.lost);
    if (this.source && owners.get(this.source) === this) owners.delete(this.source);
    this.shown?.remove();
    if (this.shown && this.shown !== this.source && this.shown !== this.preview)
      this.shown.width = this.shown.height = 1;
    else if (this.shown && isRetiredPdfBitmap(this.shown)) this.shown.width = this.shown.height = 1;
    this.shown = null;
    this.source = null;
    this.previewFor = null;
  }

  /** Only zoom/visibility transitions request a CPU backup; ordinary display
   * keeps its zero-copy path. Repeated zoom frames reuse the same small backup. */
  retainPreview() {
    if (
      this.disposed ||
      !this.shown ||
      this.shown === this.preview ||
      this.previewFor === this.source ||
      this.shown.width <= 1
    )
      return;
    const source = this.shown;
    const ratio = Math.min(
      1,
      640 / source.width,
      Math.sqrt(160000 / (source.width * source.height)),
    );
    const preview = (this.preview ??= document.createElement('canvas'));
    preview.width = Math.max(1, Math.floor(source.width * ratio));
    preview.height = Math.max(1, Math.floor(source.height * ratio));
    preview
      .getContext('2d', { willReadFrequently: true })!
      .drawImage(source, 0, 0, preview.width, preview.height);
    preview.className = this.className;
    preview.dataset.renderedNight = source.dataset.renderedNight;
    if (source.dataset.pdfBackend) preview.dataset.pdfBackend = source.dataset.pdfBackend;
    preview.dataset.transitionPreview = 'true';
    preview.setAttribute('aria-hidden', 'true');
    this.previewFor = this.source;
  }

  showPreview() {
    if (this.disposed) return;
    // A lost GPU raster cannot be read back; use the CPU backup made before zoom.
    const preview = this.preview;
    this.release();
    if (preview && preview.width > 1 && preview.height > 1) {
      this.shown = preview;
      this.host.replaceChildren(preview);
    } else this.clear();
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
    if (this.preview) this.preview.width = this.preview.height = 1;
    this.preview = null;
    canvas.className = this.className;
    if (source.dataset.pdfBackend) canvas.dataset.pdfBackend = source.dataset.pdfBackend;
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
    if (this.preview) this.preview.width = this.preview.height = 1;
    this.preview = null;
    const placeholder = document.createElement('canvas');
    placeholder.width = placeholder.height = 1;
    placeholder.className = this.className;
    placeholder.setAttribute('aria-hidden', 'true');
    this.host.replaceChildren(placeholder);
  }

  dispose() {
    if (this.disposed) return;
    this.release();
    if (this.preview) this.preview.width = this.preview.height = 1;
    this.preview = null;
    this.host.replaceChildren();
    this.disposed = true;
  }
}
