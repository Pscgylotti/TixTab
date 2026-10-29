import type { PDFDocumentProxy } from './pdfTypes';
import { workspacePreview } from './workspacePreview';
import { pdfFingerprint, samePdfPath } from './pdfAssociation';
import { editablePages } from './scratchPaper';
import {
  isEmptyStarterNotebook,
  newNotebook,
  uid,
  validNotebook,
  type Notebook,
  type Page,
} from './model';
import { restore } from './storage';
import { deleteFormulaDrafts } from './formulaDraft';
import { performanceLedger, trackPerformance } from './performanceLedger';

export interface WorkspaceView {
  index: number;
  zoom: number;
  mode: 'single' | 'continuous' | 'dual';
  position?: WorkspacePosition;
  scratch?: { enabled: boolean; hiddenPdf: boolean; returnView?: Omit<WorkspaceView, 'scratch'> };
}
export interface WorkspacePosition {
  pageId: string;
  mode: WorkspaceView['mode'];
  x: number;
  y: number;
  freeX?: number;
  freeY?: number;
}
/** Read only when saving, rather than re-rendering the shell on every pan. */
export function captureWorkspaceView(view: WorkspaceView, pageId: string): WorkspaceView {
  const root = document.querySelector<HTMLElement>(
    view.mode === 'single' ? '.surface' : '.reading-view',
  );
  if (!root) return view;
  const zoom = Number(root.dataset.viewZoom);
  if (!Number.isFinite(zoom) || zoom <= 0) return view;
  const x = view.mode === 'single' ? Number(root.dataset.panX) : root.scrollLeft;
  const y = view.mode === 'single' ? Number(root.dataset.panY) : root.scrollTop;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return view;
  return {
    ...view,
    zoom,
    position: {
      pageId,
      mode: view.mode,
      x: x / zoom,
      y: y / zoom,
      ...(view.scratch?.enabled && view.mode !== 'single'
        ? { freeX: Number(root.dataset.freeX) || 0, freeY: Number(root.dataset.freeY) || 0 }
        : {}),
    },
  };
}
export interface WorkspaceDocument {
  id: string;
  name: string;
  folderId: string | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  pageIds: string[];
  /** Small first-page raster generated during saving. Older workspaces omit it. */
  preview?: string;
  scratchPapers?: {
    id: string;
    name: string;
    pageId: string;
    view: NonNullable<Notebook['scratchPapers']>[number]['view'];
  }[];
  activeScratchId?: string;
  view: WorkspaceView;
  scene?: Record<string, unknown>;
  zotero?: Notebook['zotero'];
  bookmarks?: Notebook['bookmarks'];
  musicPlayer?: Notebook['musicPlayer'];
  batch?: Notebook['batch'];
  batchInfo?: { total: number; current: number; edited: number };
  documentName?: string;
  sourcePath?: string;
  sourceFingerprint?: string;
  hasPdf?: boolean;
  archiveFor?: string;
}
export interface WorkspaceFolder {
  id: string;
  name: string;
}
export const defaultView: WorkspaceView = { index: 0, zoom: 0.78, mode: 'single' };
let connection: Promise<IDBDatabase> | undefined;
// Only keep the active document's immutable references. Sources are stored once,
// and unchanged pages never go through structured cloning on a pen autosave.
let saved: { id: string; notebook: Notebook } | undefined;
// Untouched tabs exist only in this session. Keep their chosen group/view until
// the first edit, without persisting pages, sources or preview bitmaps.
const drafts = new Map<string, { meta: WorkspaceDocument; notebook: Notebook }>();
let activeDraft: string | undefined;
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
function finished(tx: IDBTransaction) {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('保存事务已取消'));
    tx.onerror = () => {};
  });
  void done.catch(() => {});
  return done;
}
function database() {
  return (connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('surfacetab-workspaces', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('documents', { keyPath: 'id' });
      db.createObjectStore('sources', { keyPath: 'documentId' });
      db.createObjectStore('pages', { keyPath: ['documentId', 'pageId'] }).createIndex(
        'documentId',
        'documentId',
      );
      db.createObjectStore('folders', { keyPath: 'id' });
      db.createObjectStore('preferences');
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => {
        db.close();
        connection = undefined;
      };
      resolve(db);
    };
    r.onerror = () => {
      connection = undefined;
      reject(r.error);
    };
  }));
}
export async function listWorkspace() {
  const db = await database(),
    tx = db.transaction(['documents', 'folders'], 'readonly');
  const [documents, folders] = await Promise.all([
    request<WorkspaceDocument[]>(tx.objectStore('documents').getAll()),
    request<WorkspaceFolder[]>(tx.objectStore('folders').getAll()),
  ]);
  const visible = documents.filter((document) => !document.archiveFor);
  // The small persisted manifest already owns group counts; never open its PDFs here.
  if (visible.some((d) => d.batch)) {
    const { loadBatchManifest } = await import('./batchWorkspace');
    await Promise.all(
      visible
        .filter((d) => d.batch)
        .map(async (d) => {
          const manifest = await loadBatchManifest(d.batch!.id);
          if (manifest)
            d.batchInfo = {
              total: manifest.items.length,
              current: Math.max(0, manifest.items.findIndex((i) => i.id === d.batch!.itemId) + 1),
              edited: manifest.items.filter((i) => i.edited).length,
            };
        }),
    );
  }
  visible.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  return { documents: visible, folders };
}
export function saveWorkspaceDocument(
  id: string,
  notebook: Notebook,
  view = defaultView,
  folderId?: string | null,
  archiveFor?: string,
  pdf?: PDFDocumentProxy | null,
  activate = true,
) {
  return trackPerformance('workspace-transaction', () =>
    saveWorkspaceDocumentImpl(id, notebook, view, folderId, archiveFor, pdf, activate),
  );
}
async function saveWorkspaceDocumentImpl(
  id: string,
  notebook: Notebook,
  view = defaultView,
  folderId?: string | null,
  archiveFor?: string,
  pdf?: PDFDocumentProxy | null,
  activate = true,
) {
  if (!archiveFor && isEmptyStarterNotebook(notebook)) {
    const draft = drafts.get(id);
    const existing = draft
      ? undefined
      : await request<WorkspaceDocument | undefined>(
          (await database()).transaction('documents').objectStore('documents').get(id),
        );
    // A previously saved document stays saved even after undo/clear returns it
    // to a blank page. Never hide or remove existing user records.
    if (!existing) {
      const now = Date.now();
      drafts.set(id, {
        notebook,
        meta: {
          id,
          name: notebook.name,
          folderId: folderId === undefined ? (draft?.meta.folderId ?? null) : folderId,
          pinned: false,
          createdAt: draft?.meta.createdAt ?? now,
          updatedAt: now,
          pageIds: notebook.pages.map((p) => p.id),
          view: { ...view },
          hasPdf: false,
        },
      });
      activeDraft = id;
      return { pageWrites: 0, sourceWrites: 0 };
    }
  }
  // Raster work must finish before opening the IndexedDB transaction.
  const preview = await workspacePreview(notebook.pages[0], pdf);
  const db = await database(),
    tx = db.transaction(['documents', 'pages', 'sources', 'preferences'], 'readwrite'),
    done = finished(tx);
  try {
    const store = tx.objectStore('documents'),
      old = await request<WorkspaceDocument | undefined>(store.get(id));
    const previous = saved?.id === id ? saved.notebook : undefined,
      oldPages = new Map(previous ? editablePages(previous).map((p) => [p.id, p]) : []);
    const pageIds = notebook.pages.map((p) => p.id),
      present = new Set(editablePages(notebook).map((p) => p.id));
    let pageWrites = 0;
    for (const page of editablePages(notebook))
      if (oldPages.get(page.id) !== page) {
        tx.objectStore('pages').put({ documentId: id, pageId: page.id, page });
        pageWrites++;
      }
    for (const pageId of [
      ...(old?.pageIds ?? []),
      ...(old?.scratchPapers ?? []).map((p) => p.pageId),
    ])
      if (!present.has(pageId)) tx.objectStore('pages').delete([id, pageId]);
    const sourceWrites = !old || !previous || previous.source !== notebook.source ? 1 : 0;
    if (sourceWrites) tx.objectStore('sources').put({ documentId: id, source: notebook.source });
    const now = Date.now();
    const record: WorkspaceDocument = {
      id,
      name: notebook.batch?.title || notebook.name,
      documentName: notebook.batch ? notebook.name : undefined,
      batch: notebook.batch,
      sourcePath: notebook.sourcePath,
      sourceFingerprint: notebook.sourceFingerprint ?? old?.sourceFingerprint,
      hasPdf: !!notebook.source,
      archiveFor: archiveFor ?? old?.archiveFor,
      createdAt: old?.createdAt ?? now,
      updatedAt: previous === notebook ? (old?.updatedAt ?? now) : now,
      folderId:
        folderId === undefined
          ? (old?.folderId ?? drafts.get(id)?.meta.folderId ?? null)
          : folderId,
      pinned: old?.pinned ?? false,
      pageIds,
      preview: preview ?? (old?.pageIds[0] === pageIds[0] ? old.preview : undefined),
      scratchPapers: notebook.scratchPapers?.map(({ page, ...p }) => ({ ...p, pageId: page.id })),
      activeScratchId: notebook.activeScratchId,
      view: { ...view },
      scene: notebook.scene,
      zotero: notebook.zotero,
      bookmarks: notebook.bookmarks,
      musicPlayer: notebook.musicPlayer,
    };
    store.put(record);
    if (activate && !archiveFor && !old?.archiveFor)
      tx.objectStore('preferences').put(id, 'activeDocument');
    await done;
    performanceLedger?.count('workspacePageWrites', pageWrites);
    performanceLedger?.count('workspaceSourceWrites', sourceWrites);
    if (activate && !archiveFor && !old?.archiveFor) {
      saved = { id, notebook };
      drafts.delete(id);
      activeDraft = undefined;
    }
    return { pageWrites, sourceWrites };
  } catch (error) {
    try {
      tx.abort();
    } catch {}
    await done.catch(() => {});
    throw error;
  }
}
export async function loadWorkspaceDocument(id: string, track = true) {
  const draft = drafts.get(id);
  if (draft) {
    if (track) activeDraft = id;
    return draft;
  }
  const db = await database(),
    tx = db.transaction(['documents', 'pages', 'sources'], 'readonly');
  const metaPromise = request<WorkspaceDocument | undefined>(tx.objectStore('documents').get(id));
  const pagesPromise = request<{ page: Page }[]>(
    tx.objectStore('pages').index('documentId').getAll(id),
  );
  const sourcePromise = request<{ source: Uint8Array | null } | undefined>(
    tx.objectStore('sources').get(id),
  );
  const [meta, records, source] = await Promise.all([metaPromise, pagesPromise, sourcePromise]);
  if (!meta || !source) throw new Error('文档不存在或数据不完整');
  const pages = new Map(records.map((r) => [r.page.id, r.page]));
  const notebook: Notebook = {
    version: 1,
    name: meta.documentName || meta.name,
    batch: meta.batch,
    sourcePath: meta.sourcePath,
    sourceFingerprint: meta.sourceFingerprint,
    source: source.source,
    pages: meta.pageIds.map((id) => pages.get(id)!),
    scratchPapers: meta.scratchPapers?.map(({ pageId, ...p }) => ({
      ...p,
      page: pages.get(pageId)!,
    })),
    activeScratchId: meta.activeScratchId,
    scene: meta.scene,
    zotero: meta.zotero,
    bookmarks: meta.bookmarks,
    musicPlayer: meta.musicPlayer,
  };
  if (
    !validNotebook(notebook) ||
    (notebook.pages.some((p) => p.sourceIndex !== null) && !(notebook.source instanceof Uint8Array))
  )
    throw new Error('文档数据无法恢复');
  if (track) {
    saved = { id, notebook };
    activeDraft = undefined;
  }
  return { meta, notebook };
}
let bootstrapping: ReturnType<typeof bootstrapWorkspaceImpl> | undefined;
/** Index legacy sources one at a time; never retain all PDFs or load their page objects. */
export async function findWorkspacePdfProjects(path: string, fingerprint: string) {
  const { documents } = await listWorkspace();
  const db = await database();
  const matches: WorkspaceDocument[] = [];
  for (const meta of documents) {
    if (!meta.sourceFingerprint && meta.hasPdf !== false) {
      const source = await request<{ source: Uint8Array | null } | undefined>(
        db.transaction('sources').objectStore('sources').get(meta.id),
      );
      if (source?.source?.length) {
        meta.sourceFingerprint = await pdfFingerprint(source.source);
        const tx = db.transaction('documents', 'readwrite'),
          done = finished(tx);
        const store = tx.objectStore('documents');
        const latest = await request<WorkspaceDocument | undefined>(store.get(meta.id));
        if (latest)
          store.put({
            ...latest,
            sourceFingerprint: latest.sourceFingerprint ?? meta.sourceFingerprint,
          });
        await done;
        if (saved?.id === meta.id && !saved.notebook.sourceFingerprint)
          saved.notebook = { ...saved.notebook, sourceFingerprint: meta.sourceFingerprint };
      }
    }
    if (samePdfPath(meta.sourcePath, path) || meta.sourceFingerprint === fingerprint)
      matches.push(meta);
  }
  return matches.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function bootstrapWorkspace() {
  return (bootstrapping ??= bootstrapWorkspaceImpl().finally(() => {
    bootstrapping = undefined;
  }));
}
async function bootstrapWorkspaceImpl() {
  if (activeDraft && drafts.has(activeDraft)) return loadWorkspaceDocument(activeDraft);
  const db = await database(),
    active = await request<string | undefined>(
      db.transaction('preferences').objectStore('preferences').get('activeDocument'),
    );
  const { documents } = await listWorkspace();
  if (documents.length)
    return loadWorkspaceDocument(documents.find((d) => d.id === active)?.id ?? documents[0].id);
  const legacy = await restore(),
    id = uid();
  await saveWorkspaceDocument(id, legacy ?? newNotebook());
  return loadWorkspaceDocument(id);
}
export async function updateWorkspaceDocument(
  id: string,
  change: Partial<Pick<WorkspaceDocument, 'name' | 'folderId' | 'pinned' | 'sourcePath'>>,
) {
  const db = await database(),
    tx = db.transaction('documents', 'readwrite'),
    done = finished(tx),
    store = tx.objectStore('documents');
  const meta = await request<WorkspaceDocument | undefined>(store.get(id));
  if (!meta) throw new Error('文档已被删除');
  store.put({
    ...meta,
    ...change,
    batch: meta.batch && change.name ? { ...meta.batch, title: change.name } : meta.batch,
  });
  await done;
  if (meta.batch && change.name) {
    const { loadBatchManifest, saveBatchManifest } = await import('./batchWorkspace');
    const manifest = await loadBatchManifest(meta.batch.id);
    if (manifest) await saveBatchManifest({ ...manifest, title: change.name });
  }
}
export async function createWorkspaceFolder(name: string) {
  const db = await database(),
    tx = db.transaction('folders', 'readwrite'),
    done = finished(tx);
  const folder = { id: uid(), name: name.trim().slice(0, 80) };
  if (!folder.name) throw new Error('请输入分组名称');
  tx.objectStore('folders').put(folder);
  await done;
  return folder;
}
export async function renameWorkspaceFolder(id: string, name: string) {
  if (!name.trim()) throw new Error('请输入分组名称');
  const db = await database(),
    tx = db.transaction('folders', 'readwrite'),
    done = finished(tx);
  tx.objectStore('folders').put({ id, name: name.trim().slice(0, 80) });
  await done;
}
export async function deleteWorkspaceFolder(id: string) {
  const db = await database(),
    tx = db.transaction(['documents', 'folders'], 'readwrite'),
    done = finished(tx);
  const documents = await request<WorkspaceDocument[]>(tx.objectStore('documents').getAll());
  for (const doc of documents)
    if (doc.folderId === id) tx.objectStore('documents').put({ ...doc, folderId: null });
  tx.objectStore('folders').delete(id);
  await done;
  for (const draft of drafts.values())
    if (draft.meta.folderId === id) draft.meta = { ...draft.meta, folderId: null };
}
export async function deleteWorkspaceDocument(id: string) {
  drafts.delete(id);
  if (activeDraft === id) activeDraft = undefined;
  const db = await database(),
    tx = db.transaction(['documents', 'pages', 'sources'], 'readwrite'),
    done = finished(tx);
  const documents = await request<WorkspaceDocument[]>(tx.objectStore('documents').getAll());
  const removing = [
    id,
    ...documents.filter((document) => document.archiveFor === id).map((document) => document.id),
  ];
  for (const documentId of removing) {
    const keys = await request<IDBValidKey[]>(
      tx.objectStore('pages').index('documentId').getAllKeys(documentId),
    );
    for (const key of keys) tx.objectStore('pages').delete(key);
    tx.objectStore('documents').delete(documentId);
    tx.objectStore('sources').delete(documentId);
  }
  await done;
  if (saved?.id === id) saved = undefined;
  for (const documentId of removing) await deleteFormulaDrafts(documentId);
  await (await import('./batchWorkspace')).deleteBatchManifest(id);
}
export async function discardWorkspaceDraft(id: string) {
  if (!drafts.delete(id)) return;
  if (activeDraft === id) activeDraft = undefined;
  await deleteFormulaDrafts(id);
}
