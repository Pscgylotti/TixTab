import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { Page } from './model';
import { drawStrokes } from './ink';
import { t } from './i18n';
export interface ChatContext {
  label: string;
  text: string;
  pageId: string;
  pageNumber: number;
  image?: string;
  kind?: 'text' | 'image';
}
const cache: { page: Page; pdf: PDFDocumentProxy | null; image: string }[] = [];
export function clearChatImages() {
  cache.length = 0;
}
export async function pageChatContext(
  page: Page,
  pdf: PDFDocumentProxy | null,
  index: number,
  kind: 'text' | 'image',
  signal: AbortSignal,
): Promise<ChatContext> {
  const check = () => {
    if (signal.aborted) throw new Error('cancelled');
  };
  check();
  const context: ChatContext = {
    label: t('第 {0} 页', index + 1),
    text: `[PDF page ${index + 1}]`,
    pageId: page.id,
    pageNumber: index + 1,
  };
  const source = pdf && page.sourceIndex !== null ? await pdf.getPage(page.sourceIndex + 1) : null;
  check();
  if (kind === 'text') {
    const text = source ? await source.getTextContent() : null;
    check();
    const content =
      text?.items
        .map((i) => ('str' in i ? i.str + ('hasEOL' in i && i.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .slice(0, 16000) || '';
    const formula = page.images
      .filter((i) => i.kind === 'formula' && i.latex)
      .map((i) => i.latex)
      .join('\n')
      .slice(0, 8000);
    const boxes = page.images
      .filter((i) => i.kind === 'text')
      .map((i) => i.textBox?.content || '')
      .join('\n')
      .slice(0, 8000);
    if (!content.trim() && !formula && !boxes) throw new Error('page-no-text');
    context.text += `\n${content}${formula ? `\n[Inserted formulas]\n${formula}` : ''}${boxes ? `\n[Inserted text boxes]\n${boxes}` : ''}\n[Only page text, text boxes and inserted LaTeX are included. Ink and figures are not included.]`;
    return context;
  }
  const hit = cache.find((c) => c.page === page && c.pdf === pdf);
  if (hit) {
    context.image = hit.image;
    context.text += '\n[Attached page image includes PDF content and TixTab annotations.]';
    return context;
  }
  const scale = Math.min(1.7, Math.sqrt(1200000 / (page.width * page.height))),
    canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(page.width * scale));
  canvas.height = Math.max(1, Math.ceil(page.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let render: RenderTask | undefined;
  const cancel = () => render?.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (source) {
      render = source.render({ canvas, viewport: source.getViewport({ scale }) });
      await render.promise;
    }
    check();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (const placed of page.images) {
      const image = new Image();
      image.src = placed.displayData ?? placed.data;
      await image.decode();
      check();
      ctx.drawImage(image, placed.x, placed.y, placed.width, placed.height);
    }
    drawStrokes(ctx, page.strokes);
    check();
    const data = canvas.toDataURL('image/jpeg', 0.85);
    if (data.length > 3000000) throw new Error('input-limit');
    cache.unshift({ page, pdf, image: data });
    cache.length = Math.min(cache.length, 3);
    context.image = data;
    context.text += '\n[Attached page image includes PDF content and TixTab annotations.]';
    return context;
  } finally {
    signal.removeEventListener('abort', cancel);
    canvas.width = canvas.height = 0;
  }
}
