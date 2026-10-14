import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SpatialIndex, imageBounds } from './spatialIndex';
import type { ForegroundClip } from './foregroundViewport';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Page, Tool } from './model';
import {
  detectedUrls,
  readPageText,
  safeDocumentUrl,
  openDocumentUrl,
  type TextRect,
} from './documentNavigation';
import { useNavigation } from './DocumentNavigator';
import { t } from './i18n';
import { groupPageLinks, type PdfLink as Link } from './pdfLinkGroups';
import { refreshPenHover, registerPenTargets, usePenInteraction } from './penInteraction';
import { renderPolicy, subscribeAppearance } from './appearance';
let cachedLinks = new WeakMap<PDFDocumentProxy, Map<number, Promise<Link[]>>>();
subscribeAppearance(() => {
  if (renderPolicy().minimal) cachedLinks = new WeakMap();
});
function pageLinks(pdf: PDFDocumentProxy, sourceIndex: number) {
  let cache = cachedLinks.get(pdf);
  if (!cache) cachedLinks.set(pdf, (cache = new Map()));
  let request = cache.get(sourceIndex);
  if (!request) {
    request = (async () => {
      const page = await pdf.getPage(sourceIndex + 1),
        viewport = page.getViewport({ scale: 1 }),
        annotations = await page.getAnnotations({ intent: 'display' });
      const links: Link[] = annotations.flatMap((a, annotationIndex) => {
        if (a.subtype !== 'Link' || !Array.isArray(a.rect)) return [];
        const url = safeDocumentUrl(a.url ?? a.unsafeUrl ?? '');
        if (!url && !a.dest) return [];
        const boxes: number[][] = [];
        if (a.quadPoints?.length >= 8)
          for (let n = 0; n < a.quadPoints.length; n += 8) {
            const xs = [0, 2, 4, 6].map((i) => a.quadPoints[n + i]),
              ys = [1, 3, 5, 7].map((i) => a.quadPoints[n + i]);
            boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
          }
        else boxes.push(a.rect);
        return boxes.map((box) => {
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(box);
          return {
            rect: {
              x: Math.min(x1, x2),
              y: Math.min(y1, y2),
              width: Math.abs(x2 - x1),
              height: Math.abs(y2 - y1),
            },
            ...(url ? { url } : { dest: a.dest }),
            ...(boxes.length > 1 ? { group: `annotation-${annotationIndex}` } : {}),
          };
        });
      });
      const text = await readPageText(pdf, sourceIndex);
      for (const url of detectedUrls(text))
        for (const rect of url.rects)
          if (
            !links.some(
              (link) =>
                rect.x < link.rect.x + link.rect.width &&
                rect.x + rect.width > link.rect.x &&
                rect.y < link.rect.y + link.rect.height &&
                rect.y + rect.height > link.rect.y,
            )
          )
            links.push({ rect, url: url.url });
      return groupPageLinks(links);
    })();
    cache.set(sourceIndex, request);
    if (cache.size > (renderPolicy().minimal ? 2 : 128)) cache.delete(cache.keys().next().value!);
    void request.catch(() => {
      if (cache?.get(sourceIndex) === request) cache.delete(sourceIndex);
    });
  }
  return request;
}
export default function PdfNavigationLayer({
  page,
  pdf,
  tool,
  reading,
  clip,
  zoom,
}: {
  page: Page;
  pdf: PDFDocumentProxy | null;
  tool: Tool;
  reading: boolean;
  clip?: ForegroundClip;
  zoom: number;
}) {
  const penActive = usePenInteraction(page.id);
  const navigation = useNavigation(),
    [links, setLinks] = useState<Link[]>([]),
    [hoveredGroup, setHoveredGroup] = useState<string | null>(null),
    focus = useRef<HTMLDivElement>(null),
    enabled = tool === 'hand' || penActive;
  const index = useMemo(() => {
    const tree = new SpatialIndex<Link>((link) => imageBounds(link.rect));
    tree.update(links);
    return tree;
  }, [links]);
  const visibleLinks = clip === false ? [] : clip ? index.search(clip) : links;
  useLayoutEffect(() => {
    refreshPenHover();
  }, [penActive, links, hoveredGroup]);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!navigation || !pdf || page.sourceIndex === null) return;
    return registerPenTargets(page.id, {
      kind: 'link',
      hit: async (clientX, clientY) => {
        const links = await pageLinks(pdf, page.sourceIndex!);
        const bounds = layer.current?.getBoundingClientRect();
        if (!bounds?.width || !bounds.height) return null;
        const x = ((clientX - bounds.left) / bounds.width) * page.width;
        const y = ((clientY - bounds.top) / bounds.height) * page.height;
        const link = links.find(
          ({ rect }) =>
            x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height,
        );
        if (!link) return null;
        return () => {
          if (!link.url) navigation.destination(link.dest);
          else if (window.surfaceDesktop?.openDocumentUrl)
            void window.surfaceDesktop.openDocumentUrl(link.url);
          else window.open(link.url, '_blank', 'noopener,noreferrer');
        };
      },
    });
  }, [navigation, pdf, page.id, page.sourceIndex, page.width, page.height]);
  useEffect(() => {
    let cancelled = false;
    setLinks((old) => (old.length ? [] : old));
    if (navigation && enabled && pdf && page.sourceIndex !== null)
      void pageLinks(pdf, page.sourceIndex)
        .then((value) => {
          if (!cancelled) setLinks(value);
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pdf, page.sourceIndex, enabled]);
  const target = navigation?.target?.pageId === page.id ? navigation.target : null;
  useEffect(() => {
    if (reading && target && focus.current)
      focus.current.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [target, reading]);
  if (!navigation) return null;
  const rects = target?.hit?.rects ?? (target?.rect ? [target.rect] : []);
  const style = (rect: TextRect) => ({
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
  });
  return (
    <div
      ref={layer}
      className={`pdf-navigation-layer${penActive ? ' pen-interaction-active' : ''}`}
      style={{ '--link-outline-width': `${1 / zoom}px` } as React.CSSProperties}
    >
      {enabled &&
        visibleLinks.map((link, i) =>
          link.url ? (
            <a
              key={i}
              data-pen-interactive="link"
              style={style(link.rect)}
              className={`pdf-document-link ${hoveredGroup === link.group ? 'link-highlighted' : ''}`}
              data-link-group={link.group}
              onMouseEnter={() => setHoveredGroup(link.group ?? null)}
              onMouseLeave={() => setHoveredGroup(null)}
              onFocus={() => setHoveredGroup(link.group ?? null)}
              onBlur={() => setHoveredGroup(null)}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              aria-label={link.url}
              title={link.url}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                openDocumentUrl(e, link.url!);
              }}
            />
          ) : (
            <button
              key={i}
              data-pen-interactive="link"
              style={style(link.rect)}
              className={`pdf-document-link ${hoveredGroup === link.group ? 'link-highlighted' : ''}`}
              data-link-group={link.group}
              onMouseEnter={() => setHoveredGroup(link.group ?? null)}
              onMouseLeave={() => setHoveredGroup(null)}
              onFocus={() => setHoveredGroup(link.group ?? null)}
              onBlur={() => setHoveredGroup(null)}
              aria-label={t('跳转到引用')}
              title={t('跳转到引用')}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                navigation.destination(link.dest);
              }}
            />
          ),
        )}
      {rects.map((rect, i) => (
        <div
          key={i}
          ref={i === 0 ? focus : undefined}
          className={`pdf-search-mark ${target?.hit ? '' : 'destination-mark'}`}
          style={{
            left: rect.x,
            top: rect.y,
            width: Math.max(2, rect.width),
            height: Math.max(2, rect.height),
          }}
        />
      ))}
    </div>
  );
}
