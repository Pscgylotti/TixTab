import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  ChevronRight,
  ListTree,
  Search,
  X,
  Files,
} from 'lucide-react';
import type { PDFDocumentProxy } from './pdfTypes';
import { uid, type Notebook } from './model';
import { t, useLocale } from './i18n';
import {
  findObjectText,
  findBitmapText,
  findText,
  readPageText,
  resolveDestination,
  safeDocumentUrl,
  openDocumentUrl,
  type SearchHit,
  type TextRect,
} from './documentNavigation';
import './documentNavigation.css';
import { useScrollViewport } from './useScrollViewport';
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const pattern = query
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return (
    <>
      {text
        .split(new RegExp(`(${pattern})`, 'giu'))
        .map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}
    </>
  );
}
function SearchResults({
  hits,
  active,
  numbers,
  onSelect,
  query,
}: {
  hits: SearchHit[];
  active: number;
  numbers: Map<string, number>;
  onSelect: (hit: SearchHit) => void;
  query: string;
}) {
  const root = useRef<HTMLDivElement>(null),
    [viewport] = useScrollViewport(root),
    rowHeight = 60;
  const [hover, setHover] = useState<{
    hit: SearchHit;
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hidePreview = () => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(null), 180);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const preview = (hit: SearchHit, element: HTMLElement) => {
    clearTimeout(hoverTimer.current);
    const rect = element.getBoundingClientRect(),
      width = Math.min(420, innerWidth - 24),
      left = Math.max(
        12,
        Math.min(
          innerWidth - width - 12,
          rect.right + width + 20 <= innerWidth ? rect.right + 8 : rect.left - width - 8,
        ),
      );
    setHover({ hit, left, width, top: Math.max(12, Math.min(innerHeight - 260, rect.top)) });
  };
  useEffect(() => {
    if (!hover) return;
    const hide = (event: Event) => {
      if (!(event.target instanceof Element && event.target.closest('.document-context-preview')))
        setHover(null);
    };
    addEventListener('scroll', hide, true);
    addEventListener('resize', hide);
    return () => {
      removeEventListener('scroll', hide, true);
      removeEventListener('resize', hide);
    };
  }, [hover]);
  const first = Math.max(0, Math.floor(viewport.top / rowHeight) - 3),
    last = Math.min(
      hits.length,
      Math.ceil((viewport.top + (viewport.height || 600)) / rowHeight) + 3,
    );
  useEffect(() => {
    const el = root.current;
    if (!el || active < 0) return;
    const top = active * rowHeight;
    if (top < el.scrollTop || top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top;
  }, [active]);
  return (
    <div className="document-search-results" ref={root} onMouseLeave={hidePreview}>
      <div style={{ height: hits.length * rowHeight, position: 'relative' }}>
        {hits.slice(first, last).map((hit, i) => (
          <button
            key={hit.key}
            className={first + i === active ? 'active' : ''}
            style={{ position: 'absolute', top: (first + i) * rowHeight, height: rowHeight }}
            onClick={() => onSelect(hit)}
            onMouseEnter={(e) => preview(hit, e.currentTarget)}
            onFocus={(e) => preview(hit, e.currentTarget)}
            onBlur={() => setHover(null)}
            aria-describedby={hover?.hit.key === hit.key ? 'document-search-context' : undefined}
          >
            <small>{t('第 {0} 页', numbers.get(hit.pageId))}</small>
            <span>
              <HighlightedText text={hit.text} query={query} />
            </span>
          </button>
        ))}
      </div>
      {hover &&
        createPortal(
          <div
            id="document-search-context"
            className="document-context-preview"
            role="tooltip"
            onMouseEnter={() => clearTimeout(hoverTimer.current)}
            onMouseLeave={hidePreview}
            style={{ left: hover.left, top: hover.top, width: hover.width }}
          >
            <small>{t('第 {0} 页', numbers.get(hover.hit.pageId))}</small>
            <div>
              <HighlightedText text={hover.hit.context ?? hover.hit.text} query={query} />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
type Target = { pageId: string; rect?: TextRect; hit?: SearchHit; serial: number };
export const NavigationContext = createContext<{
  target: Target | null;
  destination: (destination: unknown) => void;
  report: (message: string) => void;
} | null>(null);
export const useNavigation = () => useContext(NavigationContext);
type Outline = { title: string; dest?: unknown; url?: string | null; items: Outline[] };
const outlines = new WeakMap<PDFDocumentProxy, Promise<Outline[]>>();
function OutlineRow({
  item,
  depth = 0,
  onDestination,
}: {
  item: Outline;
  depth?: number;
  onDestination: (dest: unknown) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  if (depth > 32) return null;
  const url = item.url ? safeDocumentUrl(item.url) : null;
  return (
    <li>
      <div className="document-outline-row" style={{ paddingLeft: depth * 12 }}>
        <button
          className="icon-button outline-toggle"
          disabled={!item.items?.length}
          aria-label={t(open ? '收起章节' : '展开章节')}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={14} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
        </button>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" onClick={(e) => openDocumentUrl(e, url)}>
            {item.title}
          </a>
        ) : (
          <button disabled={!item.dest} onClick={() => onDestination(item.dest)}>
            {item.title}
          </button>
        )}
      </div>
      {open && item.items?.length > 0 && (
        <ul>
          {item.items.map((child, i) => (
            <OutlineRow key={i} item={child} depth={depth + 1} onDestination={onDestination} />
          ))}
        </ul>
      )}
    </li>
  );
}
export function useDocumentNavigation({
  notebook,
  pdf,
  index,
  documentId,
  commit,
  onSelect,
  notify,
}: {
  notebook: Notebook;
  pdf: PDFDocumentProxy | null;
  index: number;
  documentId: string;
  commit: (n: Notebook) => void;
  onSelect: (index: number) => void;
  notify: (s: string) => void;
}) {
  useLocale();
  const [mode, setMode] = useState<'pages' | 'search' | 'outline' | 'bookmarks'>('pages'),
    [query, setQuery] = useState(''),
    [hits, setHits] = useState<SearchHit[]>([]),
    [searching, setSearching] = useState(false),
    [searched, setSearched] = useState(0),
    [error, setError] = useState(''),
    [outline, setOutline] = useState<Outline[]>([]),
    [target, setTarget] = useState<Target | null>(null),
    [historyVersion, setHistoryVersion] = useState(0);
  const current = useRef({ notebook, index, onSelect, notify, pdf });
  current.current = { notebook, index, onSelect, notify, pdf };
  const history = useRef<{ ids: string[]; at: number }>({ ids: [], at: -1 }),
    serial = useRef(0);
  const go = useMemo(
    () =>
      (pageId: string, rect?: TextRect, hit?: SearchHit, remember = true) => {
        const c = current.current,
          next = c.notebook.pages.findIndex((p) => p.id === pageId);
        if (next < 0) {
          c.notify(t('目标页面已删除'));
          return;
        }
        if (remember) {
          const h = history.current,
            previous = c.notebook.pages[c.index]?.id;
          h.ids = h.ids.slice(0, h.at + 1);
          if (previous && h.ids.at(-1) !== previous) h.ids.push(previous);
          if (h.ids.at(-1) !== pageId) h.ids.push(pageId);
          h.ids = h.ids.slice(-100);
          h.at = h.ids.length - 1;
          setHistoryVersion((v) => v + 1);
        }
        c.onSelect(next);
        setTarget({ pageId, rect, hit, serial: ++serial.current });
      },
    [],
  );
  const value = useMemo(
    () => ({
      target,
      report: (s: string) => current.current.notify(s),
      destination: (dest: unknown) => {
        const document = current.current.pdf;
        if (!document) return;
        void resolveDestination(document, dest)
          .then((result) => {
            if (document !== current.current.pdf) return;
            const page =
              result &&
              current.current.notebook.pages.find((p) => p.sourceIndex === result.sourceIndex);
            if (page && result) go(page.id, result.rect);
            else current.current.notify(t('目标页面已删除或无法定位'));
          })
          .catch(() => current.current.notify(t('无法打开文档链接')));
      },
    }),
    [target, go],
  );
  useEffect(() => {
    setQuery('');
    setHits([]);
    setTarget(null);
    setError('');
    history.current = { ids: [], at: -1 };
    setHistoryVersion((v) => v + 1);
  }, [documentId]);
  // Pen strokes preserve image references: writing must not restart a search.
  const searchPages = useRef(notebook.pages);
  if (
    searchPages.current.length !== notebook.pages.length ||
    notebook.pages.some((p, i) => {
      const old = searchPages.current[i];
      return (
        p.id !== old.id ||
        p.sourceIndex !== old.sourceIndex ||
        p.images !== old.images ||
        p.bitmapOcr !== old.bitmapOcr
      );
    })
  )
    searchPages.current = notebook.pages;
  const pages = searchPages.current;
  const pageNumbers = useMemo(() => new Map(pages.map((p, i) => [p.id, i + 1])), [pages]);
  useEffect(() => {
    let cancelled = false;
    setError('');
    if (mode !== 'search' || !query.trim()) {
      setSearching(false);
      setHits([]);
      setTarget((value) => (value?.hit ? null : value));
      return;
    }
    setSearching(true);
    setHits([]);
    setSearched(0);
    const timer = setTimeout(
      () =>
        void (async () => {
          const results: SearchHit[] = [];
          for (let i = 0; i < pages.length; i++) {
            if (cancelled) return;
            const page = pages[i];
            if (pdf && page.sourceIndex !== null) {
              const text = await readPageText(pdf, page.sourceIndex);
              if (cancelled) return;
              results.push(...findText(text, query.trim(), page.id));
            }
            results.push(...findObjectText(page, query.trim()));
            results.push(...findBitmapText(page, query.trim()));
            if (results.length >= 2000) {
              results.length = 2000;
              break;
            }
            if (i % 8 === 0 || i === pages.length - 1) {
              setHits([...results]);
              setSearched(i + 1);
            }
            // A single page task at a time; let input/rendering run between pages.
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          if (!cancelled) {
            setHits(results);
            setSearching(false);
            setSearched(pages.length);
          }
        })().catch(() => {
          if (!cancelled) {
            setError(t('部分页面文字无法读取'));
            setSearching(false);
          }
        }),
      220,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, query, pdf, pages]);
  useEffect(() => {
    if (mode !== 'outline' || !pdf) return;
    let cancelled = false;
    setOutline([]);
    setError('');
    let request = outlines.get(pdf);
    if (!request) {
      request = pdf.getOutline().then((items) => items ?? []);
      outlines.set(pdf, request);
    }
    void request
      .then((items) => {
        if (!cancelled) setOutline(items);
      })
      .catch(() => {
        if (!cancelled) setError(t('目录无法读取'));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, pdf]);
  const activeHit = hits.findIndex((h) => h.key === target?.hit?.key),
    selectHit = (at: number) => {
      const hit = hits[(at + hits.length) % hits.length];
      if (hit) go(hit.pageId, hit.rects[0], hit);
    };
  const travel = (direction: number) => {
    const h = history.current;
    let at = h.at + direction;
    while (at >= 0 && at < h.ids.length) {
      if (notebook.pages.some((p) => p.id === h.ids[at])) {
        h.at = at;
        setHistoryVersion((v) => v + 1);
        go(h.ids[at], undefined, undefined, false);
        return;
      }
      at += direction;
    }
  };
  const tabs = [
    ['pages', Files, '页面'],
    ['search', Search, '全文搜索'],
    ['outline', ListTree, '目录'],
    ['bookmarks', Bookmark, '书签'],
  ] as const;
  const header = (
    <div className="document-nav-tabs" data-history={historyVersion}>
      {tabs.map(([id, Icon, label]) => (
        <button
          key={id}
          className={`icon-button ${mode === id ? 'active' : ''}`}
          title={t(label)}
          aria-label={t(label)}
          aria-pressed={mode === id}
          onClick={() => setMode(id)}
        >
          <Icon size={17} />
        </button>
      ))}
      <span />
      <button
        className="icon-button"
        aria-label={t('返回上一位置')}
        title={t('返回上一位置')}
        disabled={history.current.at <= 0}
        onClick={() => travel(-1)}
      >
        <ArrowLeft size={15} />
      </button>
      <button
        className="icon-button"
        aria-label={t('前进到下一位置')}
        title={t('前进到下一位置')}
        disabled={history.current.at >= history.current.ids.length - 1}
        onClick={() => travel(1)}
      >
        <ArrowRight size={15} />
      </button>
    </div>
  );
  const bookmarks = (notebook.bookmarks ?? []).filter((b) =>
    notebook.pages.some((p) => p.id === b.pageId),
  );
  const panel =
    mode === 'pages' ? null : (
      <div className="document-nav-panel">
        {mode === 'search' && (
          <>
            <label className="document-search-input">
              <Search size={18} />
              <input
                autoFocus
                aria-label={t('搜索文档文字')}
                placeholder={t('搜索文档文字')}
                value={query}
                maxLength={300}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    selectHit(activeHit + (e.shiftKey ? -1 : 1));
                  }
                }}
              />
              <button
                className="icon-button"
                aria-label={t('清空搜索')}
                onClick={() => setQuery('')}
              >
                <X size={14} />
              </button>
            </label>
            <div className="document-search-status">
              <span role="status">
                {searching
                  ? t('正在搜索 {0}/{1}', searched, pages.length)
                  : t('{0} 个结果', hits.length)}
                {hits.length === 2000 ? '+' : ''}
              </span>
              <button
                className="icon-button"
                disabled={!hits.length}
                aria-label={t('上一个结果')}
                onClick={() => selectHit(activeHit - 1)}
              >
                <ArrowLeft size={14} />
              </button>
              <button
                className="icon-button"
                disabled={!hits.length}
                aria-label={t('下一个结果')}
                onClick={() => selectHit(activeHit + 1)}
              >
                <ArrowRight size={14} />
              </button>
            </div>
            <SearchResults
              query={query}
              hits={hits}
              active={activeHit}
              numbers={pageNumbers}
              onSelect={(hit) => go(hit.pageId, hit.rects[0], hit)}
            />
          </>
        )}
        {mode === 'outline' && (
          <>
            {!outline.length && <p className="document-nav-empty">{t('文档没有目录')}</p>}
            <ul className="document-outline">
              {outline.map((item, i) => (
                <OutlineRow key={i} item={item} onDestination={value.destination} />
              ))}
            </ul>
          </>
        )}
        {mode === 'bookmarks' && (
          <>
            <button
              className="document-add-bookmark"
              onClick={() =>
                commit({
                  ...notebook,
                  bookmarks: [
                    ...(notebook.bookmarks ?? []),
                    {
                      id: uid(),
                      pageId: notebook.pages[index].id,
                      title: t('第 {0} 页', index + 1),
                    },
                  ],
                })
              }
            >
              <Bookmark size={15} />
              {t('添加当前页书签')}
            </button>
            {bookmarks.map((b) => (
              <div className="document-bookmark" key={b.id}>
                <button
                  className="icon-button"
                  aria-label={t('打开书签')}
                  onClick={() => go(b.pageId)}
                >
                  <Bookmark size={15} />
                </button>
                <input
                  aria-label={t('书签名称')}
                  value={b.title}
                  maxLength={200}
                  onChange={(e) =>
                    commit({
                      ...notebook,
                      bookmarks: notebook.bookmarks!.map((v) =>
                        v.id === b.id ? { ...v, title: e.target.value } : v,
                      ),
                    })
                  }
                />
                <button
                  className="icon-button"
                  aria-label={t('删除书签')}
                  onClick={() =>
                    commit({
                      ...notebook,
                      bookmarks: notebook.bookmarks!.filter((v) => v.id !== b.id),
                    })
                  }
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </>
        )}
        {!!error && <p role="status">{error}</p>}
      </div>
    );
  return { mode, setMode, header, panel, value, go };
}
