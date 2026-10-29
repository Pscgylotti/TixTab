import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { StickyNote, Trash2, X } from 'lucide-react';
import { DocumentEditContext } from './DocumentEditContext';
import { uid, type Page, type ReviewNote, type Tool } from './model';
import { t, useLocale } from './i18n';
import { useNativeKeyboard } from './nativeKeyboard';
import { reviewConnector } from './reviewGeometry';
import './pageEditing.css';

export default function ReviewLayer({
  page,
  tool,
  zoom,
  onChange,
  selected,
  onSelect: setSelected,
}: {
  page: Page;
  tool: Tool;
  zoom: number;
  onChange: (page: Page) => void;
  selected: string | null;
  onSelect: Dispatch<SetStateAction<string | null>>;
}) {
  useLocale();
  const nativeKeyboard = useNativeKeyboard();
  const context = useContext(DocumentEditContext);
  const root = useRef<HTMLDivElement>(null);
  const canManipulate = tool === 'hand' || tool === 'object';
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [hover, setHover] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReviewNote['region'] | null>(null);
  const [adjusted, setAdjusted] = useState<{ id: string; region: ReviewNote['region'] } | null>(
    null,
  );
  const adjusting = useRef<{
    pointer: number;
    id: string;
    x: number;
    y: number;
    region: ReviewNote['region'];
    corner?: string;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const cardContact = useRef<{
    pointer: number;
    id: string;
    x: number;
    y: number;
    offset: { x: number; y: number };
    moved: boolean;
  } | null>(null);
  const [cardPreview, setCardPreview] = useState<{
    id: string;
    offset: { x: number; y: number };
  } | null>(null);
  const [text, setText] = useState('');
  const draftText = useRef<{ id: string; text: string } | null>(null);
  const savedText = useRef<{ id: string; text: string } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverNote = (id: string | null) => {
    clearTimeout(hoverTimer.current);
    if (id) setHover(id);
    else hoverTimer.current = setTimeout(() => setHover(null), 160);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const contact = useRef<{ id: number; x: number; y: number } | null>(null);
  const [bounds, setBounds] = useState<DOMRect | null>(null);
  const notes = page.reviews ?? [];
  const note = notes.find((n) => n.id === selected);
  useEffect(() => {
    const ids = new Set(notes.map((n) => n.id));
    setClosed((old) =>
      [...old].some((id) => !ids.has(id)) ? new Set([...old].filter((id) => ids.has(id))) : old,
    );
  }, [page.reviews]);
  const scratchHost = root.current?.closest('.scratch-viewport');
  const scratch = !!scratchHost;
  const dual = !scratch && context?.mode === 'dual';
  useEffect(() => {
    setSelected(null);
    setClosed(new Set());
    setHover(null);
    adjusting.current = null;
    setAdjusted(null);
    cardContact.current = null;
    setCardPreview(null);
  }, [page.id, dual]);
  useEffect(() => {
    if (!adjusted && !cardPreview) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        adjusting.current = null;
        setAdjusted(null);
        cardContact.current = null;
        setCardPreview(null);
      }
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [!!adjusted, !!cardPreview]);
  useEffect(() => {
    setText(note?.text ?? '');
    draftText.current = note ? { id: note.id, text: note.text } : null;
    savedText.current = note ? { id: note.id, text: note.text } : null;
  }, [note]);
  useLayoutEffect(() => {
    if (!notes.length && !draft) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = root.current?.getBoundingClientRect();
      if (next)
        setBounds((old) =>
          old && ['x', 'y', 'width', 'height'].every((k) => old[k as 'x'] === next[k as 'x'])
            ? old
            : next,
        );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    if (root.current) observer.observe(root.current);
    // Panning transforms do not emit resize. Only active notes subscribe to page style changes.
    const mutation = new MutationObserver(schedule);
    let el: HTMLElement | null = root.current;
    for (let i = 0; el && i < 5; i++, el = el.parentElement)
      mutation.observe(el, { attributes: true, attributeFilter: ['style'] });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutation.disconnect();
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [notes.length, draft, zoom, dual]);
  const point = (e: PointerEvent) => {
    const r = root.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(page.width, ((e.clientX - r.left) / r.width) * page.width)),
      y: Math.max(0, Math.min(page.height, ((e.clientY - r.top) / r.height) * page.height)),
    };
  };
  const region = (e: PointerEvent) => {
    const p = point(e),
      c = contact.current!;
    return {
      x: Math.min(c.x, p.x),
      y: Math.min(c.y, p.y),
      width: Math.abs(p.x - c.x),
      height: Math.abs(p.y - c.y),
    };
  };
  const adjust = (e: PointerEvent) => {
    const c = adjusting.current!,
      p = point(e),
      dx = p.x - c.x,
      dy = p.y - c.y;
    if (Math.hypot(dx, dy) * zoom > 3) c.moved = true;
    const r = c.region;
    if (!c.corner)
      return {
        ...r,
        x: Math.max(0, Math.min(page.width - r.width, r.x + dx)),
        y: Math.max(0, Math.min(page.height - r.height, r.y + dy)),
      };
    let left = r.x,
      top = r.y,
      right = r.x + r.width,
      bottom = r.y + r.height;
    if (c.corner.includes('w')) left = Math.max(0, Math.min(right - 4, r.x + dx));
    if (c.corner.includes('e')) right = Math.min(page.width, Math.max(left + 4, right + dx));
    if (c.corner.includes('n')) top = Math.max(0, Math.min(bottom - 4, r.y + dy));
    if (c.corner.includes('s')) bottom = Math.min(page.height, Math.max(top + 4, bottom + dy));
    return { x: left, y: top, width: right - left, height: bottom - top };
  };
  const save = () => {
    const draft = draftText.current;
    // Focus/select/close events may run before the new textarea state is painted.
    // Persist only the latest draft owned by this note, never another render's text.
    if (
      note &&
      draft?.id === note.id &&
      draft.text !== note.text &&
      !(savedText.current?.id === note.id && savedText.current.text === draft.text)
    ) {
      savedText.current = { ...draft };
      onChange({
        ...page,
        reviews: notes.map((n) => (n.id === note.id ? { ...n, text: draft.text } : n)),
      });
    }
  };
  useEffect(() => {
    if (!note || text === note.text) return;
    const timer = setTimeout(save, 650);
    return () => clearTimeout(timer);
  }, [note, text]);
  useEffect(() => {
    if (tool !== 'hand') save();
    if (!canManipulate) {
      adjusting.current = null;
      setAdjusted(null);
      cardContact.current = null;
      setCardPreview(null);
      contact.current = null;
      setDraft(null);
    }
  }, [tool]);
  // Keep side cards in screen units, outside the clipped PDF paper and independent of zoom.
  const canvasHost = scratchHost ?? root.current?.closest('.canvas-container');
  const canvas = canvasHost?.getBoundingClientRect();
  const visibleNotes = notes.filter(
    (n) => !closed.has(n.id) && (!dual || n.id === selected || n.id === hover),
  );
  const width = 240;
  let lastBottom = -Infinity;
  return (
    <>
      <div
        ref={root}
        className={`review-layer ${tool === 'review' ? 'placing' : ''}`}
        onPointerDown={(e) => {
          if (tool !== 'review' || e.button !== 0 || (e.target as HTMLElement).closest('button'))
            return;
          e.preventDefault();
          e.stopPropagation();
          contact.current = { id: e.pointerId, ...point(e) };
          e.currentTarget.setPointerCapture(e.pointerId);
          setDraft({ ...point(e), width: 0, height: 0 });
        }}
        onPointerMove={(e) => {
          if (adjusting.current?.pointer === e.pointerId) {
            e.preventDefault();
            e.stopPropagation();
            setAdjusted({ id: adjusting.current.id, region: adjust(e) });
            return;
          }
          if (contact.current?.id === e.pointerId) {
            e.stopPropagation();
            setDraft(region(e));
          }
        }}
        onPointerUp={(e) => {
          const c = adjusting.current;
          if (c?.pointer === e.pointerId) {
            e.stopPropagation();
            const next = adjust(e);
            adjusting.current = null;
            setAdjusted(null);
            suppressClick.current = c.moved;
            if (c.moved)
              onChange({
                ...page,
                reviews: notes.map((n) => (n.id === c.id ? { ...n, region: next } : n)),
              });
            return;
          }
          if (contact.current?.id !== e.pointerId) return;
          e.stopPropagation();
          const r = region(e);
          contact.current = null;
          setDraft(null);
          if (r.width < 3 || r.height < 3) return;
          const n = { id: uid(), text: '', region: r };
          onChange({ ...page, reviews: [...notes, n] });
          setSelected(n.id);
          context?.onReviewCreated?.();
        }}
        onPointerCancel={() => {
          adjusting.current = null;
          setAdjusted(null);
          contact.current = null;
          setDraft(null);
        }}
      >
        {notes.map((original, i) => {
          const n =
            adjusted?.id === original.id ? { ...original, region: adjusted.region } : original;
          return (
            <button
              key={n.id}
              className={`review-anchor ${selected === n.id || hover === n.id ? 'highlighted' : ''} ${canManipulate && selected === n.id ? 'editing' : ''}`}
              aria-label={t('便签 {0}', i + 1)}
              aria-pressed={selected === n.id}
              style={{
                left: n.region.x,
                top: n.region.y,
                width: n.region.width,
                height: n.region.height,
                borderWidth: 0,
                borderRadius: 5 / zoom,
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (!canManipulate || e.button !== 0 || adjusting.current) return;
                e.preventDefault();
                save();
                setSelected(n.id);
                if (selected !== n.id && tool !== 'object') return;
                suppressClick.current = false;
                adjusting.current = {
                  pointer: e.pointerId,
                  id: n.id,
                  ...point(e),
                  region: n.region,
                  moved: false,
                  corner: (e.target as HTMLElement).closest<HTMLElement>('[data-review-corner]')
                    ?.dataset.reviewCorner,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onLostPointerCapture={() => {
                adjusting.current = null;
                setAdjusted(null);
              }}
              onMouseEnter={() => hoverNote(n.id)}
              onMouseLeave={() => hoverNote(null)}
              onFocus={() => setHover(n.id)}
              onBlur={() => setHover(null)}
              onClick={(e) => {
                e.stopPropagation();
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                save();
                setClosed((old) => {
                  const next = new Set(old);
                  next.delete(n.id);
                  return next;
                });
                setSelected(n.id);
              }}
            >
              <svg
                className="review-region-frame"
                viewBox={`0 0 ${n.region.width} ${n.region.height}`}
                aria-hidden="true"
              >
                <rect
                  width={n.region.width}
                  height={n.region.height}
                  rx={5 / zoom}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={canManipulate && selected === n.id ? 1.5 : 0.75}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <StickyNote style={{ width: 16 / zoom, height: 16 / zoom }} />
              {canManipulate &&
                selected === n.id &&
                (['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                  <span
                    key={corner}
                    data-review-corner={corner}
                    className={`review-resize-handle ${corner}`}
                    style={{ width: 12 / zoom, height: 12 / zoom, borderWidth: 1.5 / zoom }}
                  />
                ))}
            </button>
          );
        })}
        {draft && (
          <div
            className="review-draft"
            style={{
              left: draft.x,
              top: draft.y,
              width: draft.width,
              height: draft.height,
              borderWidth: 0,
              borderRadius: 5 / zoom,
            }}
          >
            <svg
              className="review-region-frame"
              viewBox={`0 0 ${Math.max(1, draft.width)} ${Math.max(1, draft.height)}`}
              aria-hidden="true"
            >
              <rect
                width={draft.width}
                height={draft.height}
                rx={5 / zoom}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </div>
        )}
      </div>
      {bounds &&
        canvas &&
        canvasHost &&
        createPortal(
          <div className="review-side-overlay" onPointerDown={(e) => e.stopPropagation()}>
            {visibleNotes.map((original, i) => {
              const n =
                adjusted?.id === original.id ? { ...original, region: adjusted.region } : original;
              const sx = bounds.width / page.width,
                sy = bounds.height / page.height;
              const region = {
                x: bounds.left - canvas.left + n.region.x * sx,
                y: bounds.top - canvas.top + n.region.y * sy,
                width: n.region.width * sx,
                height: n.region.height * sy,
              };
              const baseY = scratch
                ? region.y + region.height / 2 - 40
                : Math.max(region.y + region.height / 2 - 40, lastBottom + 8);
              lastBottom = baseY + 108;
              const offset =
                cardPreview?.id === n.id ? cardPreview.offset : (n.cardOffset ?? { x: 0, y: 0 });
              const x =
                  (scratch ? region.x + region.width : bounds.right - canvas.left) + 14 + offset.x,
                y = baseY + offset.y;
              if (
                scratch &&
                n.id !== selected &&
                (region.x + region.width < -width ||
                  region.x > canvas.width + width ||
                  region.y + region.height < -160 ||
                  region.y > canvas.height + 160) &&
                (x + width < 0 || x > canvas.width || y + 160 < 0 || y > canvas.height)
              )
                return null;
              const connector = reviewConnector(region, { x, y, width });
              const editing = canManipulate && selected === n.id;
              return (
                <div
                  key={n.id}
                  className="review-side-entry"
                  onMouseEnter={() => hoverNote(n.id)}
                  onMouseLeave={() => hoverNote(null)}
                >
                  <svg className="review-connector" aria-hidden="true">
                    <line
                      {...connector}
                      className={selected === n.id || hover === n.id ? 'highlighted' : ''}
                    />
                  </svg>
                  <article
                    className={`review-card ${selected === n.id || hover === n.id ? 'highlighted' : ''} ${editing ? 'editing' : ''}`}
                    style={{ left: x, top: y, width }}
                    onClick={() => {
                      if (selected !== n.id) {
                        save();
                        setSelected(n.id);
                      }
                    }}
                  >
                    <header
                      onPointerDown={(e) => {
                        if (
                          !editing ||
                          e.button !== 0 ||
                          (e.target as HTMLElement).closest('button')
                        )
                          return;
                        e.preventDefault();
                        e.stopPropagation();
                        save();
                        cardContact.current = {
                          pointer: e.pointerId,
                          id: n.id,
                          x: e.clientX,
                          y: e.clientY,
                          offset,
                          moved: false,
                        };
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        const c = cardContact.current;
                        if (c?.pointer !== e.pointerId) return;
                        e.stopPropagation();
                        const dx = e.clientX - c.x,
                          dy = e.clientY - c.y;
                        if (Math.hypot(dx, dy) > 3) c.moved = true;
                        setCardPreview({
                          id: c.id,
                          offset: { x: c.offset.x + dx, y: c.offset.y + dy },
                        });
                      }}
                      onPointerUp={(e) => {
                        const c = cardContact.current;
                        if (c?.pointer !== e.pointerId) return;
                        e.stopPropagation();
                        cardContact.current = null;
                        setCardPreview(null);
                        if (c.moved)
                          onChange({
                            ...page,
                            reviews: notes.map((item) =>
                              item.id === c.id
                                ? {
                                    ...item,
                                    cardOffset: {
                                      x: c.offset.x + e.clientX - c.x,
                                      y: c.offset.y + e.clientY - c.y,
                                    },
                                  }
                                : item,
                            ),
                          });
                      }}
                      onPointerCancel={() => {
                        cardContact.current = null;
                        setCardPreview(null);
                      }}
                      onLostPointerCapture={() => {
                        cardContact.current = null;
                        setCardPreview(null);
                      }}
                    >
                      <StickyNote size={14} />
                      <span>{t('便签 {0}', notes.indexOf(original) + 1)}</span>
                      {editing && (
                        <button
                          aria-label={t('删除便签')}
                          onClick={(e) => {
                            e.stopPropagation();
                            onChange({ ...page, reviews: notes.filter((a) => a.id !== n.id) });
                            setSelected(null);
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                      <button
                        aria-label={t('关闭便签')}
                        onClick={(e) => {
                          e.stopPropagation();
                          save();
                          setClosed((old) => new Set(old).add(n.id));
                          setSelected((old) => (old === n.id ? null : old));
                          if (hover === n.id) setHover(null);
                        }}
                      >
                        <X size={14} />
                      </button>
                    </header>
                    {editing && tool === 'hand' ? (
                      <textarea
                        aria-label={t('便签内容')}
                        inputMode={nativeKeyboard ? 'text' : 'none'}
                        maxLength={10000}
                        value={text}
                        onChange={(e) => {
                          draftText.current = { id: n.id, text: e.target.value };
                          setText(e.target.value);
                        }}
                        onBlur={save}
                        autoFocus
                      />
                    ) : (
                      <p>{n.text || t(tool === 'hand' ? '点击编辑便签' : '空白便签')}</p>
                    )}
                  </article>
                </div>
              );
            })}
          </div>,
          canvasHost,
        )}
    </>
  );
}
