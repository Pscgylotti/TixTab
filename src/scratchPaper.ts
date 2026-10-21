import { blankPage, uid, type Notebook, type Page, type Point, type Stroke } from './model';
import { t } from './i18n';
export interface ScratchPaper {
  id: string;
  name: string;
  customName?: boolean;
  page: Page;
  view: { x: number; y: number; zoom: number };
}
export const MAX_SCRATCH_PAPERS = 10;
/** Localize generated labels without changing saved content or custom names. */
export function scratchPaperName(paper: Pick<ScratchPaper, 'name' | 'customName'>) {
  const match = !paper.customName && /^草稿纸([1-9]\d*)$/.exec(paper.name);
  return match && Number(match[1]) <= MAX_SCRATCH_PAPERS ? t('草稿纸{0}', match[1]) : paper.name;
}
export function newScratchPaper(existing: readonly ScratchPaper[]) {
  if (existing.length >= MAX_SCRATCH_PAPERS) throw Error(t('最多创建十张草稿纸'));
  let number = 1;
  while (existing.some((p) => p.name === `草稿纸${number}` || p.name === `Draft ${number}`))
    number++;
  const page = { ...blankPage(20000, 20000), paperColor: '#ffffff' };
  return { id: uid(), name: `草稿纸${number}`, page, view: { x: 10000, y: 10000, zoom: 1 } };
}
export const editablePages = (n: Notebook) => [
  ...n.pages,
  ...(n.scratchPapers ?? []).map((p) => p.page),
];
export function replaceEditablePage(n: Notebook, page: Page): Notebook {
  if (n.pages.some((p) => p.id === page.id))
    return { ...n, pages: n.pages.map((p) => (p.id === page.id ? page : p)) };
  return {
    ...n,
    scratchPapers: n.scratchPapers?.map((p) => (p.page.id === page.id ? { ...p, page } : p)),
  };
}
export interface PaperHit {
  page: Page;
  rect: DOMRect;
}
/** PDF sheets have priority over the independently transformed scratch sheet. */
export function visiblePaperHits(n: Notebook): PaperHit[] {
  const pages = editablePages(n),
    hits: PaperHit[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(
    '.canvas-container .paper,.canvas-container .reading-paper',
  )) {
    if (!el.getClientRects().length || el.closest('[hidden]')) continue;
    const id = el.dataset.pageId || el.closest<HTMLElement>('[data-page-id]')?.dataset.pageId;
    const page = pages.find((p) => p.id === id);
    if (page) hits.push({ page, rect: el.getBoundingClientRect() });
  }
  return hits.sort((a, b) => Number(n.pages.includes(b.page)) - Number(n.pages.includes(a.page)));
}
export function paperHit(hits: PaperHit[], x: number, y: number) {
  return hits.find(({ rect: r }) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
}
/** Visit screen-space runs in foreground order, including gaps with no sheet. */
export function visitPaperSegments(
  a: Point,
  b: Point,
  hits: PaperHit[],
  visit: (hit: PaperHit | undefined, from: Point, to: Point) => void,
) {
  const stops = [0, 1];
  for (const { rect: r } of hits)
    for (const [axis, edge] of [
      [0, r.left],
      [0, r.right],
      [1, r.top],
      [1, r.bottom],
    ]) {
      const d = b[axis] - a[axis];
      if (d) {
        const t = (edge - a[axis]) / d;
        if (t > 0 && t < 1) stops.push(t);
      }
    }
  stops.sort((a, b) => a - b);
  const at = (t: number): Point => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  for (let j = 1; j < stops.length; j++) {
    if (stops[j] - stops[j - 1] < 1e-9) continue;
    const mid = at((stops[j] + stops[j - 1]) / 2);
    visit(paperHit(hits, mid[0], mid[1]), at(stops[j - 1]), at(stops[j]));
  }
}
export function scratchInsertionAnchor(n: Notebook) {
  const viewport = document.querySelector('.canvas-container')?.getBoundingClientRect();
  if (!viewport) return null;
  const x = viewport.left + viewport.width / 2,
    y = viewport.top + viewport.height / 2;
  const hit = paperHit(visiblePaperHits(n), x, y);
  return hit
    ? {
        pageId: hit.page.id,
        x: ((x - hit.rect.left) * hit.page.width) / hit.rect.width,
        y: ((y - hit.rect.top) * hit.page.height) / hit.rect.height,
      }
    : null;
}
/** Split crossing segments at sheet boundaries instead of losing samples outside
 * the page or joining distant runs across the PDF on the background. */
export function splitScratchStroke(
  source: Page,
  stroke: Stroke,
  origin: DOMRect,
  hits: PaperHit[],
) {
  const output = new Map<string, Stroke[]>();
  let last: { pageId: string; stroke: Stroke } | undefined;
  const point = ([x, y, p]: Point): Point => [
    origin.left + (x * origin.width) / source.width,
    origin.top + (y * origin.height) / source.height,
    p,
  ];
  const screen = stroke.points.map(point);
  const append = (hit: PaperHit | undefined, a: Point, b: Point) => {
    if (!hit) {
      last = undefined;
      return;
    }
    const scale = hit.page.width / hit.rect.width;
    const convert = ([x, y, p]: Point): Point => [
      (x - hit.rect.left) * scale,
      ((y - hit.rect.top) * hit.page.height) / hit.rect.height,
      p,
    ];
    if (last?.pageId !== hit.page.id) {
      const next: Stroke = {
        ...stroke,
        id: uid(),
        size: Math.min(100, ((stroke.size * origin.width) / source.width) * scale),
        points: [convert(a)],
      };
      const pieces = output.get(hit.page.id) ?? [];
      pieces.push(next);
      output.set(hit.page.id, pieces);
      last = { pageId: hit.page.id, stroke: next };
    }
    last!.stroke.points.push(convert(b));
  };
  if (screen.length === 1)
    append(paperHit(hits, ...(screen[0].slice(0, 2) as [number, number])), screen[0], screen[0]);
  for (let i = 1; i < screen.length; i++) {
    visitPaperSegments(screen[i - 1], screen[i], hits, append);
  }
  return output;
}
