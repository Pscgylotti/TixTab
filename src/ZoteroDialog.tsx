import { useEffect, useRef, useState } from 'react';
import {
  BookMarked,
  Search,
  X,
  ExternalLink,
  Copy,
  FileText,
  RefreshCw,
  PanelLeft,
  Paperclip,
  ChevronRight,
} from 'lucide-react';
import { t, useLocale } from './i18n';
import {
  zoteroRequest,
  type ZoteroItem,
  type ZoteroCollection,
  type ZoteroSource,
  type ZoteroRequest,
} from './zotero';
import ZoteroTree, { type CollectionPage } from './ZoteroTree';
import './zotero.css';
type Rows<T> = { rows: T[]; more: boolean };
export type ZoteroPdf = { bytes: Uint8Array; filename: string; source: ZoteroSource };
export default function ZoteroDialog({
  current,
  onOpen,
  onClose,
}: {
  current?: ZoteroSource;
  onOpen: (pdf: ZoteroPdf) => Promise<void>;
  onClose: () => void;
}) {
  useLocale();
  const [libraries, setLibraries] = useState<{ id: string; name: string }[]>([]),
    [library, setLibrary] = useState('users/0'),
    [serverId, setServerId] = useState('');
  const [collectionCache, setCollectionCache] = useState<Record<string, CollectionPage>>({}),
    [collection, setCollection] = useState(''),
    [sidebar, setSidebar] = useState(true);
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [items, setItems] = useState<ZoteroItem[]>([]),
    [more, setMore] = useState(false);
  const [selected, setSelected] = useState<ZoteroItem | null>(null),
    [attachments, setAttachments] = useState<ZoteroItem[]>([]),
    [children, setChildren] = useState(0),
    [childrenMore, setChildrenMore] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [connected, setConnected] = useState(false);
  const mounted = useRef(true),
    running = useRef(false),
    itemOffset = useRef(0);
  const bridge = window.surfaceDesktop?.zotero;
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (e) {
      if (mounted.current) setMessage(e instanceof Error ? e.message : t('操作失败，请重试'));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const request = <T,>(r: ZoteroRequest) => zoteroRequest<T>({ library, serverId, ...r });
  async function loadItems(lib: string, id: string, col: string, q: string, start = 0) {
    const r = await zoteroRequest<Rows<ZoteroItem>>({
      action: 'items',
      library: lib,
      serverId: id,
      collection: col || undefined,
      query: q,
      start,
    });
    if (!mounted.current) return;
    itemOffset.current = start + r.data.rows.length;
    setItems((old) => (start ? [...old, ...r.data.rows] : r.data.rows));
    setMore(r.data.more);
    setSearch(q);
    setCollection(col);
    if (!start) {
      setSelected(null);
      setAttachments([]);
      setChildrenMore(false);
    }
  }
  async function loadCollections(lib: string, id: string, start = 0) {
    const c = await zoteroRequest<Rows<ZoteroCollection>>({
      action: 'collections',
      library: lib,
      serverId: id,
      start,
    });
    if (mounted.current)
      setCollectionCache((old) => ({
        ...old,
        [lib]: {
          rows: start ? [...(old[lib]?.rows || []), ...c.data.rows] : c.data.rows,
          more: c.data.more,
        },
      }));
  }
  async function loadLibrary(lib: string, id: string, col = '') {
    setLibrary(lib);
    setItems([]);
    setSelected(null);
    setAttachments([]);
    setMore(false);
    setCollection('');
    setQuery('');
    setSearch('');
    setConnected(false);
    if (!collectionCache[lib]) await loadCollections(lib, id);
    if (!mounted.current) return;
    await loadItems(lib, id, col, '');
    if (mounted.current) setConnected(true);
  }
  async function connect() {
    setConnected(false);
    setLibraries([]);
    setCollectionCache({});
    setItems([]);
    setSelected(null);
    setAttachments([]);
    const r = await zoteroRequest<{ id: string; name: string }[]>({ action: 'libraries' });
    if (!mounted.current) return;
    setLibraries(r.data);
    setServerId(r.serverId);
    const lib = r.data.some((l) => l.id === library) ? library : 'users/0';
    await loadCollections(lib, r.serverId);
    await loadItems(lib, r.serverId, '', '');
    if (mounted.current) {
      setLibrary(lib);
      setConnected(true);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (bridge) void run(connect);
    return () => {
      mounted.current = false;
      void bridge?.cancel();
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  async function choose(item: ZoteroItem, start = 0) {
    if (!start) {
      setSelected(item);
      setAttachments([]);
      setChildrenMore(false);
    }
    if (item.pdf) {
      setAttachments([item]);
      return;
    }
    const r = await request<Rows<ZoteroItem>>({ action: 'children', key: item.key, start });
    if (!mounted.current) return;
    setChildren(start + r.data.rows.length);
    setChildrenMore(r.data.more);
    setAttachments((old) =>
      start ? [...old, ...r.data.rows.filter((i) => i.pdf)] : r.data.rows.filter((i) => i.pdf),
    );
  }
  const action = (source: ZoteroSource, kind: 'reveal' | 'bibtex') =>
    void run(async () => {
      await zoteroRequest({
        action: kind,
        library: source.library,
        serverId: source.serverId,
        key: source.parentKey || source.key,
      });
      if (mounted.current && kind === 'bibtex') setMessage(t('BibTeX 已复制'));
    });
  const libraryName = libraries.find((l) => l.id === library)?.name || t('我的资料库'),
    collectionName = collectionCache[library]?.rows.find((c) => c.key === collection)?.name;
  return (
    <div className="modal-scrim">
      <section
        className="modal zotero-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('Zotero 资料库')}
        aria-busy={busy}
      >
        <header>
          <h2>
            <BookMarked size={20} /> {t('Zotero 资料库')}
          </h2>
          <div className="row">
            <button
              disabled={!bridge || busy}
              aria-label={t('重新连接 Zotero')}
              onClick={() => void run(connect)}
            >
              <RefreshCw size={16} />
            </button>
            <button className="icon-button" aria-label={t('关闭 Zotero')} onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        </header>
        {(!connected || !bridge) && (
          <p className="zotero-hint zotero-connection-hint">
            {bridge
              ? t('启动 Zotero，并在设置 → 高级中允许本机应用与 Zotero 通信。')
              : t('Zotero 联动请使用桌面应用。')}
          </p>
        )}
        {current && (
          <div className="zotero-current">
            <span>{t('当前文档关联：{0}', current.title)}</span>
            <button disabled={busy || !bridge} onClick={() => action(current, 'reveal')}>
              <ExternalLink size={15} />
              {t('返回 Zotero')}
            </button>
            <button disabled={busy || !bridge} onClick={() => action(current, 'bibtex')}>
              <Copy size={15} />
              {t('复制 BibTeX')}
            </button>
          </div>
        )}
        <div className="zotero-toolbar">
          <button
            className="zotero-sidebar-toggle"
            aria-label={t(sidebar ? '收起文件夹栏' : '展开文件夹栏')}
            aria-expanded={sidebar}
            onClick={() => setSidebar((v) => !v)}
          >
            <PanelLeft size={18} />
          </button>
          <div
            className="zotero-location"
            title={[libraryName, collectionName || t('全部文献')].join(' / ')}
          >
            <span>{libraryName}</span>
            <ChevronRight size={13} />
            <strong>{collectionName || t('全部文献')}</strong>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => loadItems(library, serverId, collection, query));
            }}
          >
            <input
              type="search"
              aria-label={t('搜索 Zotero 文献')}
              placeholder={t('标题或作者')}
              maxLength={300}
              value={query}
              disabled={busy || !connected}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button disabled={busy || !connected}>
              <Search size={16} />
              <span>{t('搜索')}</span>
            </button>
          </form>
        </div>
        <div
          className={`zotero-body ${sidebar ? '' : 'folders-collapsed'} ${selected ? 'has-selection' : ''}`}
        >
          <ZoteroTree
            libraries={libraries.length ? libraries : [{ id: 'users/0', name: '' }]}
            cache={collectionCache}
            library={library}
            collection={collection}
            busy={busy}
            connected={connected}
            onSelect={(lib, col) =>
              void run(() =>
                lib === library
                  ? loadItems(lib, serverId, col, query)
                  : loadLibrary(lib, serverId, col),
              )
            }
            onLoad={(lib, more) =>
              run(() =>
                loadCollections(lib, serverId, more ? collectionCache[lib]?.rows.length || 0 : 0),
              )
            }
          />
          <div className="zotero-results" aria-label={t('文献列表')}>
            <div className="zotero-list-header">
              <span>{t('标题')}</span>
              <span>{t('作者')}</span>
              <span title={t('PDF 附件')}>
                <Paperclip size={16} />
              </span>
            </div>
            <div className="zotero-item-scroll">
              {items.map((item) => (
                <button
                  key={item.key}
                  disabled={busy}
                  aria-pressed={selected?.key === item.key}
                  className={`zotero-item ${selected?.key === item.key ? 'active' : ''}`}
                  title={item.title}
                  onClick={() => void run(() => choose(item))}
                >
                  <span className="zotero-item-title">
                    <ChevronRight size={13} />
                    <FileText size={18} />
                    <strong>{item.title || t('未命名文献')}</strong>
                  </span>
                  <span className="zotero-item-author" title={item.author}>
                    {item.author || '—'}
                  </span>
                  <span className="zotero-item-file">
                    {(item.pdf || item.children > 0) && <Paperclip size={15} />}
                  </span>
                </button>
              ))}
              {connected && !items.length && !busy && (
                <p className="zotero-empty">{t('未找到文献')}</p>
              )}
              {more && (
                <button
                  className="zotero-load-more"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      loadItems(library, serverId, collection, search, itemOffset.current),
                    )
                  }
                >
                  {t('加载更多文献')}
                </button>
              )}
            </div>
          </div>
          <div className="zotero-detail">
            {selected ? (
              <>
                <h3>{selected.title || t('未命名文献')}</h3>
                <p>{[selected.author, selected.date].filter(Boolean).join(' · ')}</p>
                <div className="row">
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(
                        { library, key: selected.key, serverId, title: selected.title },
                        'reveal',
                      )
                    }
                  >
                    <ExternalLink size={15} />
                    {t('返回 Zotero')}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(
                        { library, key: selected.key, serverId, title: selected.title },
                        'bibtex',
                      )
                    }
                  >
                    <Copy size={15} />
                    {t('复制 BibTeX')}
                  </button>
                </div>
                <h4>{t('PDF 附件')}</h4>
                {attachments.map((a) => (
                  <button
                    className="zotero-attachment"
                    key={a.key}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const r = await request<ZoteroPdf>({
                          action: 'pdf',
                          key: a.key,
                          parentKey: selected.pdf ? undefined : selected.key,
                        });
                        if (!mounted.current) return;
                        await onOpen(r.data);
                        if (mounted.current) onClose();
                      })
                    }
                  >
                    <FileText size={20} />
                    <span>
                      {a.title || a.filename}
                      <small>{t('在新标签打开')}</small>
                    </span>
                  </button>
                ))}
                {!attachments.length && !busy && (
                  <p>{t('没有本地 PDF 附件。请先在 Zotero 添加或下载 PDF。')}</p>
                )}
                {childrenMore && (
                  <button
                    disabled={busy}
                    onClick={() => void run(() => choose(selected, children))}
                  >
                    {t('更多附件')}
                  </button>
                )}
              </>
            ) : (
              <p>{t('选择文献以查看附件')}</p>
            )}
          </div>
        </div>
        <footer className="zotero-footer">
          <div className="zotero-message" role="status">
            {busy ? t('正在读取 Zotero…') : message}
          </div>
          <span>{t('标注保存在 SurfaceTab，不自动回写 Zotero。')}</span>
        </footer>
      </section>
    </div>
  );
}
