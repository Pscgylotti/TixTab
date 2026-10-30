import { t as tr, useLocale } from './i18n';
import {
  useCallback,
  useEffect,
  useState,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  FolderPlus,
  Pin,
  Plus,
  Search,
  Trash2,
  X,
  Pencil,
  FileUp,
  Download,
  FolderOpen,
} from 'lucide-react';
import {
  createWorkspaceFolder,
  deleteWorkspaceFolder,
  listWorkspace,
  renameWorkspaceFolder,
  updateWorkspaceDocument,
  type WorkspaceDocument,
  type WorkspaceFolder,
} from './workspaceStore';
import './workspace.css';
import './pageEditing.css';
import AnchoredPopover from './AnchoredPopover';
interface Props {
  activeId: string;
  onOpen: (id: string) => Promise<void>;
  onCreate: (folderId: string | null) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onExport: (id: string) => Promise<void>;
  onImport: () => void;
  onStartBatch?: () => Promise<void>;
  onClose: () => void;
}
export default function WorkspaceManager({
  activeId,
  onOpen,
  onCreate,
  onDelete,
  onRename,
  onExport,
  onImport,
  onStartBatch,
  onClose,
}: Props) {
  const locale = useLocale();
  const [documents, setDocuments] = useState<WorkspaceDocument[]>([]),
    [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  const [folder, setFolder] = useState('all'),
    [search, setSearch] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [editing, setEditing] = useState<{
    kind: 'document' | 'folder' | 'new-folder';
    id: string;
    name: string;
    originalName: string;
    anchor: HTMLElement;
  } | null>(null);
  const manager = useRef<HTMLElement>(null),
    actionPanel = useRef<HTMLDivElement>(null);
  const contact = useRef<{
    pointerId: number;
    id: string;
    x: number;
    y: number;
    held: boolean;
    dragging: boolean;
    element: HTMLElement;
    timer?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const suppressed = useRef(0);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; target?: string } | null>(
    null,
  );
  const cancelDrag = () => {
    const c = contact.current;
    contact.current = null;
    clearTimeout(c?.timer);
    if (c?.element.hasPointerCapture(c.pointerId)) c.element.releasePointerCapture(c.pointerId);
    setDrag(null);
  };
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDrag();
    };
    window.addEventListener('blur', cancelDrag);
    window.addEventListener('keydown', escape);
    return () => {
      const c = contact.current;
      contact.current = null;
      clearTimeout(c?.timer);
      window.removeEventListener('blur', cancelDrag);
      window.removeEventListener('keydown', escape);
    };
  }, []);
  const dragDown = (e: ReactPointerEvent<HTMLElement>, id: string) => {
    if (busy || e.button !== 0) return;
    cancelDrag();
    const c = {
      pointerId: e.pointerId,
      id,
      x: e.clientX,
      y: e.clientY,
      held: e.pointerType === 'mouse',
      dragging: false,
      element: e.currentTarget,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    contact.current = c;
    if (!c.held)
      c.timer = setTimeout(() => {
        c.held = true;
        c.element.setPointerCapture(c.pointerId);
      }, 450);
  };
  const dragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const c = contact.current;
    if (!c || c.pointerId !== e.pointerId) return;
    if (Math.hypot(e.clientX - c.x, e.clientY - c.y) < 7 && !c.dragging) return;
    if (!c.held) {
      cancelDrag();
      return;
    }
    c.dragging = true;
    c.element.setPointerCapture(c.pointerId);
    e.preventDefault();
    suppressed.current = performance.now() + 800;
    const target = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest<HTMLElement>('[data-workspace-group]')?.dataset.workspaceGroup;
    setDrag({ id: c.id, x: e.clientX, y: e.clientY, target });
  };
  const dragEnd = (e: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const c = contact.current;
    if (!c || c.pointerId !== e.pointerId) return;
    const target = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest<HTMLElement>('[data-workspace-group]')?.dataset.workspaceGroup;
    if (c.dragging) {
      suppressed.current = performance.now() + 800;
      e.preventDefault();
      if (!cancelled && target && (target === 'unfiled' || folders.some((f) => f.id === target)))
        void run(() =>
          updateWorkspaceDocument(c.id, { folderId: target === 'unfiled' ? null : target }),
        );
    }
    cancelDrag();
  };
  const [deleting, setDeleting] = useState<(WorkspaceDocument & { anchor: HTMLElement }) | null>(
    null,
  );
  const closeActions = useCallback(() => {
    if (busy) return;
    setEditing(null);
    setDeleting(null);
    setError('');
  }, [busy]);
  const editName = (
    kind: 'document' | 'folder' | 'new-folder',
    id: string,
    name: string,
    anchor: HTMLElement,
  ) => {
    setDeleting(null);
    setError('');
    setEditing({ kind, id, name, originalName: name, anchor });
  };
  useEffect(() => {
    const anchor = editing?.anchor ?? deleting?.anchor,
      panel = actionPanel.current;
    if (!anchor || !panel) return;
    const input = panel.querySelector('input');
    if (input) {
      input.focus({ preventScroll: true });
      input.select();
    } else panel.querySelector<HTMLButtonElement>('[data-cancel]')?.focus({ preventScroll: true });
    return () => {
      if (panel.contains(document.activeElement) || document.activeElement === document.body) {
        const target = anchor.isConnected
          ? anchor
          : manager.current?.querySelector<HTMLInputElement>('.workspace-search input');
        target?.focus({ preventScroll: true });
      }
    };
  }, [editing?.anchor, deleting?.anchor]);
  const refresh = async () => {
    const data = await listWorkspace();
    setDocuments(data.documents);
    setFolders(data.folders);
  };
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : tr('\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5'),
      );
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run(refresh);
  }, []);
  const filtered = documents.filter(
    (d) =>
      (folder === 'all' || (folder === 'unfiled' && !d.folderId) || d.folderId === folder) &&
      d.name.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()),
  );
  const saveName = () =>
    void run(async () => {
      if (!editing?.name.trim()) throw new Error(tr('\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A'));
      if (editing.kind === 'document')
        await onRename(editing.id, editing.name.trim().slice(0, 120));
      else if (editing.kind === 'new-folder') {
        const f = await createWorkspaceFolder(editing.name);
        setFolder(f.id);
      } else await renameWorkspaceFolder(editing.id, editing.name);
      setEditing(null);
    });
  return (
    <div className="modal-scrim">
      <section
        ref={manager}
        className="modal workspace-manager"
        role="dialog"
        aria-modal="true"
        aria-label={tr('工作空间管理')}
        aria-busy={busy}
      >
        <header>
          <div>
            <h2>{tr('工作空间')}</h2>
            <p>{tr('{0} 份本地文档', documents.length)}</p>
          </div>
          <div className="row">
            {onStartBatch && (
              <button disabled={busy} onClick={() => void run(onStartBatch)}>
                <FolderOpen size={16} />
                {tr('连续批注')}
              </button>
            )}
            <button disabled={busy} onClick={onImport}>
              <FileUp size={16} />
              {tr('导入')}
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(() => onCreate(folder === 'all' || folder === 'unfiled' ? null : folder))
              }
            >
              <Plus size={16} />
              {tr('新建笔记')}
            </button>
            <button
              className="icon-button"
              aria-label={tr('关闭工作空间')}
              disabled={busy}
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
        </header>
        {drag && (
          <div
            className="workspace-drag-preview"
            style={{ left: drag.x + 14, top: drag.y + 12 }}
            aria-hidden="true"
          >
            {documents.find((d) => d.id === drag.id)?.name}
          </div>
        )}
        <div className="workspace-library-body">
          <nav
            aria-label={tr('文档分组')}
            onScroll={() => {
              if (editing || deleting) closeActions();
            }}
          >
            <button className={folder === 'all' ? 'active' : ''} onClick={() => setFolder('all')}>
              {tr('全部文档')}
              <span>{documents.length}</span>
            </button>
            <button
              className={`${folder === 'unfiled' ? 'active' : ''} ${drag?.target === 'unfiled' ? 'drop-target' : ''}`}
              data-workspace-group="unfiled"
              onClick={() => setFolder('unfiled')}
            >
              {tr('未分组')}
            </button>
            {folders.map((f) => (
              <div
                className={`workspace-folder ${drag?.target === f.id ? 'drop-target' : ''}`}
                data-workspace-group={f.id}
                key={f.id}
              >
                <button className={folder === f.id ? 'active' : ''} onClick={() => setFolder(f.id)}>
                  {f.name}
                </button>
                <button
                  aria-label={tr('重命名分组 {0}', f.name)}
                  disabled={busy}
                  onClick={(e) => editName('folder', f.id, f.name, e.currentTarget)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  aria-label={tr('移除分组 {0}', f.name)}
                  title={tr('仅移除分组，保留文档')}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await deleteWorkspaceFolder(f.id);
                      setFolder('all');
                    })
                  }
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <button
              disabled={busy}
              onClick={(e) => editName('new-folder', '', '', e.currentTarget)}
            >
              <FolderPlus size={15} />
              {tr('新建分组')}
            </button>
          </nav>
          <div
            className="workspace-library-content"
            onScroll={() => {
              if (editing || deleting) closeActions();
            }}
          >
            <label className="workspace-search">
              <Search size={17} />
              <input
                aria-label={tr('搜索文档')}
                type="search"
                placeholder={tr('搜索文档名称')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            {error && !editing && !deleting && (
              <p className="error" role="alert">
                {tr(error)}
              </p>
            )}
            <div className="workspace-document-list">
              {filtered.map((d) => (
                <article
                  key={d.id}
                  className={`workspace-document ${d.id === activeId ? 'active' : ''} ${drag?.id === d.id ? 'dragging' : ''}`}
                  data-document-id={d.id}
                >
                  <button
                    className="workspace-open"
                    aria-label={tr('打开文档 {0}', d.name)}
                    disabled={busy}
                    onClick={() => {
                      if (performance.now() > suppressed.current) void run(() => onOpen(d.id));
                    }}
                    onPointerDown={(e) => dragDown(e, d.id)}
                    onPointerMove={dragMove}
                    onPointerUp={(e) => dragEnd(e)}
                    onPointerCancel={(e) => dragEnd(e, true)}
                    onLostPointerCapture={(e) => dragEnd(e, true)}
                    onContextMenu={(e) => {
                      if (contact.current?.held) e.preventDefault();
                    }}
                  >
                    <span className="workspace-preview" aria-hidden="true">
                      {d.preview && (
                        <img
                          src={d.preview}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          draggable={false}
                        />
                      )}
                    </span>
                    <span>
                      <strong>{d.name}</strong>
                      {d.batch && (
                        <span className="workspace-batch-badge">
                          {tr('连续批注组')}
                          {d.batchInfo ? ` · ${tr('{0} 份文档', d.batchInfo.total)}` : ''}
                        </span>
                      )}
                      {d.batchInfo && (
                        <small>
                          {tr(
                            '当前 {0}/{1} · 已编辑 {2} 份',
                            d.batchInfo.current,
                            d.batchInfo.total,
                            d.batchInfo.edited,
                          )}
                        </small>
                      )}
                      <small>
                        {tr(
                          '{0} 页 · {1}',
                          d.pageIds.length,
                          new Date(d.updatedAt).toLocaleDateString(locale),
                        )}{' '}
                        {d.id === activeId ? tr('· 当前文档') : ''}
                      </small>
                    </span>
                  </button>
                  <div className="workspace-document-actions">
                    <select
                      aria-label={tr('文档分组 {0}', d.name)}
                      value={d.folderId ?? ''}
                      disabled={busy}
                      onChange={(e) =>
                        void run(() =>
                          updateWorkspaceDocument(d.id, { folderId: e.target.value || null }),
                        )
                      }
                    >
                      <option value="">{tr('未分组')}</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                    <button
                      aria-label={tr('{0} {1}', d.pinned ? tr('取消置顶') : tr('置顶'), d.name)}
                      aria-pressed={d.pinned}
                      disabled={busy}
                      onClick={() =>
                        void run(() => updateWorkspaceDocument(d.id, { pinned: !d.pinned }))
                      }
                    >
                      <Pin size={15} />
                    </button>
                    <button
                      aria-label={tr('重命名文档 {0}', d.name)}
                      disabled={busy}
                      onClick={(e) => editName('document', d.id, d.name, e.currentTarget)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      aria-label={tr('导出工程 {0}', d.name)}
                      disabled={busy}
                      onClick={() => void run(() => onExport(d.id))}
                    >
                      <Download size={15} />
                    </button>
                    <button
                      aria-label={tr('删除文档 {0}', d.name)}
                      disabled={busy}
                      onClick={(e) => {
                        setEditing(null);
                        setError('');
                        setDeleting({ ...d, anchor: e.currentTarget });
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {!busy && filtered.length === 0 && (
              <p className="workspace-empty">
                {search ? tr('没有匹配的文档') : tr('这个分组还没有文档')}
              </p>
            )}
          </div>
        </div>
        {(editing || deleting) && (
          <AnchoredPopover
            anchor={(editing ?? deleting)!.anchor}
            label={
              deleting
                ? tr('确认删除文档')
                : editing!.kind === 'new-folder'
                  ? tr('新建分组')
                  : editing!.kind === 'document'
                    ? tr('重命名文档 {0}', editing!.originalName)
                    : tr('重命名分组 {0}', editing!.originalName)
            }
            alert={!!deleting}
            onClose={closeActions}
            className="workspace-action-popover"
            width={340}
          >
            <div ref={actionPanel} aria-busy={busy}>
              <header>
                <h2>
                  {deleting
                    ? tr('确认删除文档')
                    : editing!.kind === 'new-folder'
                      ? tr('新建分组')
                      : editing!.kind === 'document'
                        ? tr('文档名称')
                        : tr('分组名称')}
                </h2>
                <button
                  className="icon-button"
                  aria-label={tr('关闭')}
                  disabled={busy}
                  onClick={closeActions}
                >
                  <X size={18} />
                </button>
              </header>
              {editing ? (
                <form
                  className="workspace-name-editor"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveName();
                  }}
                >
                  {editing.originalName && (
                    <p className="workspace-action-target">{editing.originalName}</p>
                  )}
                  <input
                    aria-label={tr('新的名称')}
                    maxLength={editing.kind === 'document' ? 120 : 80}
                    value={editing.name}
                    disabled={busy}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  />
                  {error && (
                    <p className="error" role="alert">
                      {tr(error)}
                    </p>
                  )}
                  <div className="workspace-action-buttons">
                    <button type="button" data-cancel disabled={busy} onClick={closeActions}>
                      {tr('取消')}
                    </button>
                    <button className="primary" disabled={busy}>
                      {tr('保存名称')}
                    </button>
                  </div>
                </form>
              ) : (
                deleting && (
                  <div className="workspace-delete">
                    <p>
                      {tr(
                        '删除「{0}」及其本地标注？此操作无法撤销，导出的文件仍保留。',
                        deleting.name,
                      )}
                    </p>
                    {error && (
                      <p className="error" role="alert">
                        {tr(error)}
                      </p>
                    )}
                    <div className="workspace-action-buttons">
                      <button data-cancel disabled={busy} onClick={closeActions}>
                        {tr('取消')}
                      </button>
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await onDelete(deleting.id);
                            setDeleting(null);
                          })
                        }
                      >
                        {tr('确认删除文档')}
                      </button>
                    </div>
                  </div>
                )
              )}
            </div>
          </AnchoredPopover>
        )}
      </section>
    </div>
  );
}
