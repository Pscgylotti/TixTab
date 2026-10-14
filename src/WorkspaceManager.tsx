import { t as tr, useLocale } from './i18n';
import { useEffect, useState } from 'react';
import {
  BookOpen,
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
  } | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceDocument | null>(null);
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
        <div className="workspace-library-body">
          <nav aria-label={tr('文档分组')}>
            <button className={folder === 'all' ? 'active' : ''} onClick={() => setFolder('all')}>
              {tr('全部文档')}
              <span>{documents.length}</span>
            </button>
            <button
              className={folder === 'unfiled' ? 'active' : ''}
              onClick={() => setFolder('unfiled')}
            >
              {tr('未分组')}
            </button>
            {folders.map((f) => (
              <div className="workspace-folder" key={f.id}>
                <button className={folder === f.id ? 'active' : ''} onClick={() => setFolder(f.id)}>
                  {f.name}
                </button>
                <button
                  aria-label={tr('重命名分组 {0}', f.name)}
                  disabled={busy}
                  onClick={() => setEditing({ kind: 'folder', id: f.id, name: f.name })}
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
              onClick={() => setEditing({ kind: 'new-folder', id: '', name: '' })}
            >
              <FolderPlus size={15} />
              {tr('新建分组')}
            </button>
          </nav>
          <div className="workspace-library-content">
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
            {editing && (
              <form
                className="workspace-name-editor"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveName();
                }}
              >
                <label>
                  {editing.kind === 'document' ? tr('文档名称') : tr('分组名称')}
                  <input
                    autoFocus
                    aria-label={tr('新的名称')}
                    maxLength={editing.kind === 'document' ? 120 : 80}
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  />
                </label>
                <button className="primary" disabled={busy}>
                  {tr('保存名称')}
                </button>
                <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                  {tr('取消')}
                </button>
              </form>
            )}
            {error && (
              <p className="error" role="alert">
                {tr(error)}
              </p>
            )}
            {deleting && (
              <div className="workspace-delete" role="alertdialog" aria-label={tr('确认删除文档')}>
                <p>
                  {tr('删除「{0}」及其本地标注？此操作无法撤销，导出的文件仍保留。', deleting.name)}
                </p>
                <button disabled={busy} onClick={() => setDeleting(null)}>
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
            )}
            <div className="workspace-document-list">
              {filtered.map((d) => (
                <article
                  key={d.id}
                  className={`workspace-document ${d.id === activeId ? 'active' : ''}`}
                  data-document-id={d.id}
                >
                  <button
                    className="workspace-open"
                    aria-label={tr('打开文档 {0}', d.name)}
                    disabled={busy}
                    onClick={() => void run(() => onOpen(d.id))}
                  >
                    <BookOpen size={22} />
                    <span>
                      <strong>{d.name}</strong>
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
                      onClick={() => setEditing({ kind: 'document', id: d.id, name: d.name })}
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
                      onClick={() => setDeleting(d)}
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
      </section>
    </div>
  );
}
