import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  GripHorizontal,
  Search,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { t as tr } from './i18n';
import type { BatchManifest } from './batchWorkspace';
import './batchPanel.css';
export default function BatchPanel({
  manifest,
  currentId,
  busy,
  onJump,
  onExport,
}: {
  manifest: BatchManifest;
  currentId: string;
  busy: boolean;
  onJump: (index: number) => void;
  onExport: () => void;
}) {
  const index = manifest.items.findIndex((item) => item.id === currentId);
  const [query, setQuery] = useState(''),
    [jump, setJump] = useState(''),
    [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState(() => {
    const bounds = document.querySelector('.canvas-container')?.getBoundingClientRect();
    return {
      x: Math.max(8, Math.min(window.innerWidth - 278, (bounds?.left || 0) + 18)),
      y: Math.max(8, Math.min(window.innerHeight - 130, (bounds?.top || 0) + 70)),
    };
  });
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const matches = useMemo(
    () =>
      manifest.items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        .slice(0, 50),
    [manifest, query],
  );
  const totalEdited = manifest.items.filter((item) => item.edited).length;
  return createPortal(
    <section
      className="batch-panel"
      aria-label={tr('连续批注')}
      style={{ left: position.x, top: position.y }}
    >
      <header
        onPointerDown={(event) => {
          if ((event.target as Element).closest('button')) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: position.x,
            top: position.y,
          };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          const panel = event.currentTarget.parentElement!;
          if (start?.id === event.pointerId)
            setPosition({
              x: Math.max(
                0,
                Math.min(
                  window.innerWidth - panel.offsetWidth,
                  start.left + event.clientX - start.x,
                ),
              ),
              y: Math.max(
                0,
                Math.min(window.innerHeight - 36, start.top + event.clientY - start.y),
              ),
            });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <GripHorizontal size={15} />
        <strong>{tr('连续批注')}</strong>
        <small>
          {index + 1} / {manifest.items.length}
        </small>
        <button
          aria-label={tr('展开文件列表')}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </header>
      <div className="batch-current" title={manifest.items[index]?.name}>
        {manifest.items[index]?.name}
      </div>
      <div className="batch-actions">
        <button
          aria-label={tr('上一份 PDF')}
          title={tr('上一份 PDF')}
          disabled={busy || index <= 0}
          onClick={() => onJump(index - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = Number(jump);
            if (Number.isInteger(value) && value >= 1 && value <= manifest.items.length) {
              onJump(value - 1);
              setJump('');
            }
          }}
        >
          <input
            aria-label={tr('跳转到第几份 PDF')}
            inputMode="numeric"
            type="text"
            pattern="[0-9]*"
            placeholder={String(index + 1)}
            value={jump}
            disabled={busy}
            onChange={(event) => setJump(event.target.value.replace(/\D/g, '').slice(0, 5))}
          />
          <button disabled={busy || !jump}>{tr('跳转')}</button>
        </form>
        <button
          aria-label={tr('下一份 PDF')}
          title={tr('下一份 PDF')}
          disabled={busy || index >= manifest.items.length - 1}
          onClick={() => onJump(index + 1)}
        >
          <ChevronRight size={17} />
        </button>
        <button
          aria-label={tr('导出已编辑 PDF')}
          title={tr('导出已编辑 PDF')}
          disabled={busy || !totalEdited}
          onClick={onExport}
        >
          <Download size={16} />
          <small>{totalEdited}</small>
        </button>
      </div>
      {expanded && (
        <div className="batch-files">
          <label>
            <Search size={14} />
            <input
              aria-label={tr('搜索 PDF 文件名')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr('搜索文件名')}
            />
          </label>
          <div role="list" aria-label={tr('PDF 文件列表')}>
            {matches.map(({ item, index }) => (
              <button
                role="listitem"
                key={item.id}
                aria-current={item.id === currentId ? true : undefined}
                disabled={busy}
                onClick={() => onJump(index)}
              >
                <small>{index + 1}</small>
                <span title={item.name}>{item.name}</span>
                {item.edited && <i aria-label={tr('已编辑')} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>,
    document.body,
  );
}
