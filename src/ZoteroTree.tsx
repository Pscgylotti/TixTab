import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { BookMarked, Library, Users, Folder, FolderOpen, ChevronRight, Search } from 'lucide-react';
import { collectionRows } from './zoteroCollectionTree';
import type { ZoteroCollection } from './zotero';
import { t } from './i18n';
export type CollectionPage = { rows: ZoteroCollection[]; more: boolean };
type Props = {
  libraries: { id: string; name: string }[];
  cache: Record<string, CollectionPage>;
  library: string;
  collection: string;
  busy: boolean;
  connected: boolean;
  onSelect: (library: string, collection: string) => void;
  onLoad: (library: string, more?: boolean) => Promise<void>;
};
export default function ZoteroTree({
  libraries,
  cache,
  library,
  collection,
  busy,
  connected,
  onSelect,
  onLoad,
}: Props) {
  const [openLibraries, setOpenLibraries] = useState(() => new Set(['users/0'])),
    [openFolders, setOpenFolders] = useState<Set<string>>(new Set()),
    [filter, setFilter] = useState(''),
    [focused, setFocused] = useState('users/0');
  const root = useRef<HTMLDivElement>(null);
  const visible = useMemo(
    () =>
      Object.fromEntries(
        libraries.map((l) => [
          l.id,
          collectionRows(
            cache[l.id]?.rows || [],
            new Set(
              [...openFolders]
                .filter((k) => k.startsWith(l.id + ':'))
                .map((k) => k.slice(l.id.length + 1)),
            ),
            filter,
          ),
        ]),
      ),
    [libraries, cache, openFolders, filter],
  );
  useEffect(() => {
    if (
      !Array.from(root.current?.querySelectorAll<HTMLElement>('[role=treeitem]') || []).some(
        (el) => el.dataset.treeId === focused,
      )
    )
      setFocused(library);
  }, [visible, openLibraries, library, focused]);
  function toggleLibrary(id: string) {
    const next = new Set(openLibraries);
    if (next.has(id)) {
      next.delete(id);
      setFocused(id);
    } else {
      next.add(id);
      if (!cache[id]) void onLoad(id);
    }
    setOpenLibraries(next);
  }
  function toggleFolder(id: string) {
    setFocused(id);
    setOpenFolders((old) => {
      const next = new Set(old);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function keyboard(
    e: KeyboardEvent<HTMLDivElement>,
    id: string,
    parent: string | undefined,
    expandable: boolean,
    open: boolean,
    toggle: () => void,
    select: () => void,
  ) {
    const rows = Array.from(root.current?.querySelectorAll<HTMLElement>('[role=treeitem]') || []),
      at = rows.indexOf(e.currentTarget);
    let target: HTMLElement | undefined;
    if (e.key === 'ArrowDown') target = rows[Math.min(at + 1, rows.length - 1)];
    else if (e.key === 'ArrowUp') target = rows[Math.max(at - 1, 0)];
    else if (e.key === 'Home') target = rows[0];
    else if (e.key === 'End') target = rows.at(-1);
    else if (e.key === 'ArrowRight') {
      if (expandable && !open) toggle();
      else if (
        open &&
        Number(rows[at + 1]?.getAttribute('aria-level')) >
          Number(e.currentTarget.getAttribute('aria-level'))
      )
        target = rows[at + 1];
    } else if (e.key === 'ArrowLeft') {
      if (expandable && open) toggle();
      else target = rows.find((el) => el.dataset.treeId === parent);
    } else if (e.key === 'Enter' || e.key === ' ') select();
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (target) {
      setFocused(target.dataset.treeId || id);
      target.focus();
    }
  }
  const personal = libraries.filter((l) => l.id === 'users/0'),
    groups = libraries.filter((l) => l.id !== 'users/0');
  function renderLibrary(l: { id: string; name: string }) {
    const name = l.name || t('我的资料库'),
      isOpen = openLibraries.has(l.id) || !!filter.trim(),
      selected = library === l.id && !collection;
    return (
      <div key={l.id} className="zotero-tree-library">
        <div
          role="treeitem"
          data-tree-id={l.id}
          aria-level={1}
          aria-expanded={isOpen}
          aria-selected={selected}
          aria-label={name}
          aria-disabled={busy || !connected}
          tabIndex={focused === l.id ? 0 : -1}
          className={`zotero-tree-row library-row ${selected ? 'selected' : ''}`}
          title={name}
          onFocus={() => setFocused(l.id)}
          onClick={() => {
            if (!busy && connected) {
              setOpenLibraries((old) => new Set([...old, l.id]));
              onSelect(l.id, '');
            }
          }}
          onKeyDown={(e) => {
            if (!busy && connected)
              keyboard(
                e,
                l.id,
                undefined,
                true,
                isOpen,
                () => toggleLibrary(l.id),
                () => onSelect(l.id, ''),
              );
          }}
        >
          <button
            className={`tree-disclosure ${isOpen ? 'open' : ''}`}
            tabIndex={-1}
            disabled={busy || !connected}
            aria-label={t(isOpen ? '收起 {0}' : '展开 {0}', name)}
            onClick={(e) => {
              e.stopPropagation();
              toggleLibrary(l.id);
            }}
          >
            <ChevronRight size={15} />
          </button>
          <Library size={18} />
          <span>{name}</span>
        </div>
        {isOpen && (
          <>
            {(visible[l.id] || []).map((row) => {
              const c = row.collection,
                id = l.id + ':' + c.key,
                selected = library === l.id && collection === c.key;
              return (
                <div
                  role="treeitem"
                  key={c.key}
                  data-tree-id={id}
                  aria-level={row.depth + 2}
                  aria-expanded={row.expandable ? row.open : undefined}
                  aria-selected={selected}
                  aria-label={c.name}
                  aria-disabled={busy || !connected}
                  tabIndex={focused === id ? 0 : -1}
                  className={`zotero-tree-row folder-row ${selected ? 'selected' : ''}`}
                  style={{ paddingLeft: 12 + Math.min(row.depth + 1, 10) * 18 }}
                  title={c.name}
                  onFocus={() => setFocused(id)}
                  onClick={() => {
                    if (!busy && connected) onSelect(l.id, c.key);
                  }}
                  onKeyDown={(e) => {
                    if (!busy && connected)
                      keyboard(
                        e,
                        id,
                        row.parent ? l.id + ':' + row.parent : l.id,
                        row.expandable,
                        row.open,
                        () => toggleFolder(id),
                        () => onSelect(l.id, c.key),
                      );
                  }}
                >
                  {row.expandable ? (
                    <button
                      className={`tree-disclosure ${row.open ? 'open' : ''}`}
                      tabIndex={-1}
                      disabled={busy}
                      aria-label={t(row.open ? '收起 {0}' : '展开 {0}', c.name)}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFolder(id);
                      }}
                    >
                      <ChevronRight size={15} />
                    </button>
                  ) : (
                    <span className="tree-disclosure-placeholder" />
                  )}
                  {row.expandable && row.open ? <FolderOpen size={18} /> : <Folder size={18} />}
                  <span>{c.name}</span>
                </div>
              );
            })}
            {cache[l.id]?.more && (
              <button
                className="zotero-more-folders"
                disabled={busy}
                onClick={() => void onLoad(l.id, true)}
              >
                {t('更多分类')}
              </button>
            )}
          </>
        )}
      </div>
    );
  }
  return (
    <aside className="zotero-sidebar" aria-label={t('资料库与文件夹')}>
      <div className="zotero-tree-heading">
        <BookMarked size={15} />
        {t('资料库与文件夹')}
      </div>
      <div ref={root} className="zotero-tree" role="tree" aria-label={t('Zotero 文件夹树')}>
        {personal.map(renderLibrary)}
        {groups.length > 0 && (
          <div className="zotero-group-heading">
            <Users size={17} />
            {t('群组资料库')}
          </div>
        )}
        {groups.map(renderLibrary)}
      </div>
      <label className="zotero-folder-filter">
        <Search size={15} />
        <input
          aria-label={t('筛选文件夹')}
          type="search"
          maxLength={200}
          placeholder={t('筛选文件夹')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>
    </aside>
  );
}
