import type { TextRect } from './documentNavigation';
export interface PdfLink {
  rect: TextRect;
  url?: string;
  dest?: unknown;
  group?: string;
}
/** Adjacent fragments of the same link share hover state, without joining
 * separate citations to the same target elsewhere on a page. */
export function groupPageLinks(links: PdfLink[]) {
  const previous = new Map<string, PdfLink>();
  return links.map((link, i) => {
    const key = link.url ?? JSON.stringify(link.dest),
      last = previous.get(key),
      a = last?.rect,
      b = link.rect,
      line = a && Math.max(a.height, b.height),
      adjacent =
        a &&
        line &&
        (Math.abs(a.y - b.y) < line * 0.5
          ? Math.abs(b.x - a.x - a.width) < line * 2
          : Math.abs(a.y - b.y) <= line * 2.5);
    const value = {
      ...link,
      group: link.group ?? (adjacent ? last?.group : undefined) ?? `link-${i}`,
    };
    previous.set(key, value);
    return value;
  });
}
