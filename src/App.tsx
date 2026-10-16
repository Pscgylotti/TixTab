import ScratchLiveInk from './ScratchLiveInk';
import ScratchPanel from './ScratchPanel';
import ScratchSurface from './ScratchSurface';
import { ScratchInkContext } from './ScratchInkContext';
import {
  newScratchPaper,
  editablePages,
  replaceEditablePage,
  scratchInsertionAnchor,
  visiblePaperHits,
  splitScratchStroke,
  type ScratchPaper,
} from './scratchPaper';
import { usePenHaptics } from './usePenHaptics';
import { performanceDelay, trackPerformance } from './performanceLedger';
import {
  useAppearance,
  setNight,
  setPowerMode,
  setMemoryMode,
  type MemoryMode,
  setOriginal,
  setRenderQuality,
  setPreRenderRange,
  preRenderChoices,
  type PreRenderRange,
  type RenderQuality,
  type PowerMode,
} from './appearance';
import { t as tr, useLocale, setLocale, type Locale } from './i18n';
import { formulaDraftKey } from './formulaDraft';
import BlankPageDialog from './BlankPageDialog';
import { penSizeFromSlider, penSizeToSlider } from './penSizeScale';
import AnchoredPopover from './AnchoredPopover';
import ClipboardShelfButton from './ClipboardShelfButton';
import { startClipboardCapture, browserShelf } from './clipboardShelf';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type SetStateAction,
} from 'react';
import { fitPageWithControls, fitWidthZoom, MIN_ZOOM, MAX_ZOOM } from './pageFit';
import {
  MessageSquare,
  Moon,
  Sun,
  Eye,
  BookOpen,
  FileUp,
  Download,
  Undo2,
  Redo2,
  Plus,
  Minus,
  Trash2,
  Eraser,
  Languages,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  ChevronDown,
  Maximize,
  MoveHorizontal,
  Settings2,
  Shapes,
  Sigma,
  PanelLeftClose,
  PanelLeft,
  Save,
  HardDrive,
  CircleHelp,
  X,
  FilePlus2,
  ClipboardCopy,
  ClipboardPaste,
  Check,
  MoveUpRight,
  Columns2,
  GalleryVerticalEnd,
  File,
  ScanText,
  Type,
  FilePenLine,
  StickyNote,
  ListChecks,
} from 'lucide-react';
import type { PDFDocumentProxy } from './pdfTypes';
import PdfSurface from './PdfSurface';
import PdfPrefetch from './PdfPrefetchController';
import { setPdfViewCacheKey } from './pdfRenderCache';
import { PenStatus, PenDiagnosticCard, reportPenDiagnostic } from './penDiagnostic';
import {
  blankPage,
  newNotebook,
  isEmptyStarterNotebook,
  uid,
  type Notebook,
  type Page,
  type Tool,
} from './model';
import {
  destroyPdf,
  exportPdf,
  importPdf,
  loadPdf,
  SignedPdfExportError,
  type PdfExportProgress,
} from './pdf';
import { decodeProject, download, encodeProject } from './storage';
import {
  bootstrapWorkspace,
  captureWorkspaceView,
  defaultView,
  deleteWorkspaceDocument,
  listWorkspace,
  loadWorkspaceDocument,
  saveWorkspaceDocument,
  updateWorkspaceDocument,
  type WorkspaceView,
} from './workspaceStore';
import PageList from './PageList';
import PageJump from './PageJump';
import SidebarResizer from './SidebarResizer';
import { useDocumentNavigation } from './DocumentNavigator';
import { duplicateNotebookPage } from './duplicatePage';
import { copyNotebookPages, pasteNotebookPage } from './pageTransfer';
import {
  storeCopiedPage,
  getCopiedPage,
  pageFromClipboard,
  isPageClipboardToken,
  clearPageClipboard,
  usePageClipboard,
} from './pageClipboard';
import ExtraTools from './ExtraTools';
import UiScaleSettings from './UiScaleSettings';
import PressureCurveSettings from './PressureCurveSettings';
import BatchPanel from './BatchPanel';
import {
  batchRequest,
  withBatch,
  batchOutputName,
  saveBatchManifest,
  loadBatchManifest,
  type BatchManifest,
} from './batchWorkspace';
import { historyTarget, historyViewportIndex } from './historyNavigation';
import { trimSourceHistory } from './sourceHistory';
import { applyNativeDrafts } from './nativePdfDrafts';
import { pdfEditErrors } from './pdfNativeTypes';
import AppContexts from './AppContexts';
import type { PageAction } from './pageOperations';
const PageOperationsDialog = lazy(() => import('./PageOperationsDialog'));
import InkColors, { savedInkColor } from './InkColors';
import { savedInkSize, saveInkSize, sizeTool } from './inkPreferences';
import FullscreenButton from './FullscreenButton';
import TouchKeyboard from './TouchKeyboard';
import RegionCapture from './RegionCapture';
const BitmapOcrDialog = lazy(() => import('./BitmapOcrDialog'));
import { imageFile, isImageFile, type ImportedImage } from './svgImport';
import { objectsFromClipboard, placeClipboardObjects } from './objectClipboard';
import { drawingTool, inkFromClipboard, inkGesture, placeInk, selectInk } from './inkSelection';
import { appendPageImages } from './pageLayers';

import type { PdfDropChoice } from './PdfDropDialog';
const PdfDropDialog = lazy(() => import('./PdfDropDialog'));
const TextBoxDialog = lazy(() => import('./TextBoxDialog'));
import { capturePage, type PageRegion } from './capturePage';
const OcrDialog = lazy(() => import('./OcrDialog'));
const CapturePreview = lazy(() => import('./CapturePreview'));
const ModelManager = lazy(() => import('./ModelManager'));
const CacheManager = lazy(() => import('./CacheManager'));
const TaskCenter = lazy(() => import('./TaskCenter'));
const WorkspaceManager = lazy(() => import('./WorkspaceManager'));
const ChatPanel = lazy(() => import('./ChatPanel'));
const ZoteroDialog = lazy(() => import('./ZoteroDialog'));
import type { ZoteroPdf } from './ZoteroDialog';
import ReadingView from './ReadingView';
import SelectionFlyout, { type SelectionInfo } from './SelectionFlyout';
import { useWritingHand, setWritingHand } from './inputPreferences';
import type { WritingHand } from './selectionPlacement';
import { inkTools as tools } from './inkTools';
import PenToolWheel from './PenToolWheel';
import { usePenInteractionTracking, activatePenTarget, penInteractionPage } from './penInteraction';
const SketchDialog = lazy(() => import('./SketchDialog')),
  FormulaDialog = lazy(() => import('./FormulaDialog'));
type DropAnchor = { pageId: string; x?: number; y?: number };
import DocumentTabs from './DocumentTabs';
import {
  reorderDocumentTab,
  tabsToClose,
  type DocumentTab,
  type CloseTabsMode,
} from './tabOperations';
function savedTabs(): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem('surfacetab.tabs') || '[]');
    return Array.isArray(ids)
      ? [...new Set(ids.filter((id): id is string => typeof id === 'string'))]
      : [];
  } catch {
    return [];
  }
}
function savedChrome(key: string) {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}
export default function App() {
  useEffect(startClipboardCapture, []);
  const hasCopiedPage = usePageClipboard();
  const pageTransferAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pageTransferAbort.current) {
        event.preventDefault();
        event.stopPropagation();
        pageTransferAbort.current.abort();
      }
    };
    window.addEventListener('keydown', cancel, true);
    return () => {
      window.removeEventListener('keydown', cancel, true);
      pageTransferAbort.current?.abort();
      clearPageClipboard();
    };
  }, []);
  const locale = useLocale();
  const writingHand = useWritingHand();
  const appearance = useAppearance();
  useEffect(() => {
    void (window.surfaceDesktop?.clipboardShelf || browserShelf).run(
      'memory',
      appearance.memoryMode === 'minimal',
    );
  }, [appearance.memoryMode]);
  const [blankPageAnchor, setBlankPageAnchor] = useState<DOMRect | null>(null);
  const [pageQuickAnchor, setPageQuickAnchor] = useState<DOMRect | null>(null);
  const [translationPanel, setTranslationPanel] = useState<'open' | 'closed' | null>(null);
  const [translationAnchor] = useState<SelectionInfo>(() => ({
    text: '',
    x: innerWidth / 2,
    y: innerHeight / 2,
  }));
  const [pageDelete, setPageDelete] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const [pageSelectionMode, setPageSelectionMode] = useState(false);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [pageSelectionVersion, setPageSelectionVersion] = useState(0);
  const choosePages = (ids: string[]) => {
    setSelectedPageIds(ids);
    setPageSelectionVersion((version) => version + 1);
  };
  const [batchManifest, setBatchManifest] = useState<BatchManifest | null>(null);
  const batchRef = useRef<BatchManifest | null>(null),
    batchSaves = useRef(Promise.resolve());
  const [batchExport, setBatchExport] = useState<{
    done: number;
    total: number;
    name: string;
  } | null>(null);
  const storeBatch = useCallback((manifest: BatchManifest) => {
    batchRef.current = manifest;
    setBatchManifest(manifest);
    batchSaves.current = batchSaves.current.catch(() => {}).then(() => saveBatchManifest(manifest));
    return batchSaves.current;
  }, []);
  const [notebook, setNotebook] = useState<Notebook>(newNotebook),
    [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [index, setIndex] = useState(0);
  const [workspaceOpen, setWorkspaceOpen] = useState(false),
    [activeId, setActiveId] = useState('');
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const [tabs, setTabs] = useState<DocumentTab[]>([]),
    tabsRef = useRef<DocumentTab[]>([]);
  const operation = useRef(false),
    busyRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [pendingDrop, setPendingDrop] = useState<{
    files: File[];
    pdfs: File[];
    anchor: DropAnchor;
    documentId: string;
  } | null>(null);
  const [zoteroOpen, setZoteroOpen] = useState(false);
  useEffect(() => {
    document
      .querySelector('[role=tab][aria-selected=true]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);
  const setDocumentTabs = (next: DocumentTab[]) => {
    tabsRef.current = next;
    setTabs(next);
    try {
      localStorage.setItem('surfacetab.tabs', JSON.stringify(next.map((t) => t.id)));
    } catch {}
  };
  const ensureTab = (id: string, name: string, hasPdf: boolean) =>
    setDocumentTabs(
      tabsRef.current.some((t) => t.id === id)
        ? tabsRef.current.map((t) => (t.id === id ? { id, name, hasPdf } : t))
        : [...tabsRef.current, { id, name, hasPdf }],
    );
  const [tool, setToolState] = useState<Tool>('pen'),
    [color, setColor] = useState(savedInkColor),
    [size, setSize] = useState(savedInkSize),
    [zoom, setZoomState] = useState(0.78),
    [sidebar, setSidebar] = useState(true);
  const readingObserved = useRef(false);
  const setTool = useCallback((next: Tool) => {
    setToolState(next);
    setSize(savedInkSize(sizeTool(next)));
  }, []);
  useEffect(() => {
    saveInkSize(sizeTool(tool), size);
  }, [size, tool]);
  const [penWheel, setPenWheel] = useState<{ x: number; y: number; text: boolean } | null>(null);
  const lastBarrel = useRef(-Infinity);
  const readingPageChanged = useCallback((next: number) => {
    readingObserved.current = true;
    setIndex(next);
  }, []);
  const fitActive = useRef(false);
  const fitMode = useRef<'page' | 'width'>('page');
  const setZoom = useCallback((value: SetStateAction<number>) => {
    fitActive.current = false;
    setZoomState(value);
  }, []);
  const [viewMode, setViewMode] = useState<'single' | 'continuous' | 'dual'>('single'),
    [resetView, setResetView] = useState(0),
    [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [chatOpen, setChatOpen] = useState(false),
    [chatSelection, setChatSelection] = useState<{
      id: number;
      text: string;
      pageId: string;
      pageNumber: number;
      documentId: string;
    } | null>(null);
  const [scratchMode, setScratchMode] = useState(false),
    [scratchHiddenPdf, setScratchHiddenPdf] = useState(false),
    [scratchFocus, setScratchFocus] = useState(false);
  const scratchLive = useRef<import('react').ComponentRef<typeof ScratchLiveInk>>(null);
  const scratchEnabled = useRef(false);
  scratchEnabled.current = scratchMode;
  const scratchReturn = useRef<WorkspaceView | null>(null);
  const activeScratch =
    notebook.scratchPapers?.find((p) => p.id === notebook.activeScratchId) ??
    notebook.scratchPapers?.[0];
  const [focusObjectId, setFocusObjectId] = useState<string | string[] | null>(null);
  const [capturing, setCapturing] = useState(false),
    [ocrImage, setOcrImage] = useState<string | null>(null);
  const [recognizingCapture, setRecognizingCapture] = useState(false);
  const [bitmapOcrOpen, setBitmapOcrOpen] = useState(false);
  const [pageOperation, setPageOperation] = useState<{ action: PageAction; index: number } | null>(
    null,
  );
  const capture = async (pageId: string | null, region: PageRegion) => {
    setCapturing(false);
    setRecognizingCapture(false);
    setBusy(true);
    try {
      const selected = pageId ? editablePages(notebook).find((p) => p.id === pageId) : page;
      if (selected)
        setOcrImage(
          await capturePage(selected, notebook.pages.includes(selected) ? pdf : null, region),
        );
    } catch (error) {
      notify(
        tr(
          '\u533A\u57DF\u622A\u56FE\u5931\u8D25\uFF1A{0}',
          error instanceof Error ? error.message : error,
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  const [editingId, setEditingId] = useState<string | null>(null);
  const pasteAnchor = useRef<(DropAnchor & { documentId: string }) | null>(null);
  const [bottomCollapsed, setBottomCollapsed] = useState(() =>
    savedChrome('surfacetab.bottomCollapsed'),
  );
  const penHaptics = usePenHaptics(tool);
  useEffect(() => {
    try {
      localStorage.setItem('surfacetab.bottomCollapsed', String(bottomCollapsed));
    } catch {}
  }, [bottomCollapsed]);
  const [headerCollapsed, setHeaderCollapsed] = useState(() =>
      savedChrome('surfacetab.headerCollapsed'),
    ),
    [toolbarCollapsed, setToolbarCollapsed] = useState(() =>
      savedChrome('surfacetab.toolbarCollapsed'),
    );
  const [compactWhenCollapsed, setCompactWhenCollapsed] = useState(() =>
    savedChrome('tixtab.compactWhenCollapsed'),
  );
  useEffect(() => {
    try {
      localStorage.setItem('tixtab.compactWhenCollapsed', String(compactWhenCollapsed));
    } catch {}
  }, [compactWhenCollapsed]);
  useEffect(() => {
    try {
      localStorage.setItem('surfacetab.headerCollapsed', String(headerCollapsed));
      localStorage.setItem('surfacetab.toolbarCollapsed', String(toolbarCollapsed));
    } catch {}
  }, [headerCollapsed, toolbarCollapsed]);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 1000px)');
    const resize = () => {
      if (narrow.matches) setSidebar(false);
    };
    resize();
    narrow.addEventListener('change', resize);
    return () => narrow.removeEventListener('change', resize);
  }, []);
  const [dialog, setDialog] = useState<
      | 'sketch'
      | 'formula'
      | 'text'
      | 'help'
      | 'settings'
      | 'models'
      | 'tasks'
      | 'caches'
      | 'delete'
      | 'signed-export'
      | null
    >(null),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [saveStatus, setSaveStatus] = useState(tr('\u51C6\u5907\u4E2D')),
    [renderStatus, setRenderStatus] = useState(tr('\u5C31\u7EEA')),
    [message, setMessage] = useState('');
  busyRef.current = busy;
  const [exportProgress, setExportProgress] = useState<PdfExportProgress | null>(null),
    exportAbort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      exportAbort.current?.abort();
      exportAbort.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!exportProgress) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        exportAbort.current?.abort();
      }
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [!!exportProgress]);
  const history = useRef<Notebook[]>([]),
    future = useRef<Notebook[]>([]),
    file = useRef<HTMLInputElement>(null),
    current = useRef(notebook),
    pdfRef = useRef(pdf),
    renderedSource = useRef<Uint8Array | null>(null),
    saveQueue = useRef(Promise.resolve());
  useEffect(() => {
    if (appearance.memoryMode === 'minimal') {
      history.current = history.current.slice(-5);
      future.current = future.current.slice(-5);
    }
  }, [appearance.memoryMode]);
  current.current = notebook;
  useEffect(() => {
    const id = notebook.batch?.id;
    if (!id) {
      batchRef.current = null;
      setBatchManifest(null);
      return;
    }
    if (batchRef.current?.id === id) return;
    let alive = true;
    void loadBatchManifest(id)
      .then((manifest) => {
        if (alive && manifest) {
          batchRef.current = manifest;
          setBatchManifest(manifest);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [notebook.batch?.id]);
  pdfRef.current = pdf;
  const page = notebook.pages[Math.min(index, notebook.pages.length - 1)];
  const currentPageId = useRef(page.id);
  currentPageId.current = page.id;
  usePenInteractionTracking(
    currentPageId,
    (event, pageId, signal) => {
      lastBarrel.current = performance.now();
      const documentId = activeRef.current;
      const paper = (event.target as Element).closest<HTMLElement>('.paper,.reading-paper');
      const targetPage = editablePages(current.current).find((p) => p.id === pageId);
      if (paper && targetPage) {
        const rect = paper.getBoundingClientRect();
        pasteAnchor.current = {
          documentId,
          pageId,
          x: ((event.clientX - rect.left) / rect.width) * targetPage.width,
          y: ((event.clientY - rect.top) / rect.height) * targetPage.height,
        };
      }
      void activatePenTarget(pageId, event.clientX, event.clientY, signal).then((activated) => {
        if (signal.aborted || documentId !== activeRef.current) return;
        if (activated) {
          setPenWheel(null);
          return;
        }
        if (document.querySelector('[aria-modal="true"]')) return;
        setSelection(null);
        const selection = window.getSelection();
        const text =
          !!selection?.toString().trim() &&
          !!selection.anchorNode?.parentElement?.closest('.textLayer');
        setPenWheel({ x: event.clientX, y: event.clientY, text });
      });
    },
    {
      enabled: drawingTool(tool),
      handle: (phase, event, pageId) => {
        setPenWheel(null);
        if (phase === 'start') setSelection(null);
        inkGesture(pageId, phase, event.clientX, event.clientY);
      },
    },
  );
  const centerAnchor = scratchMode ? scratchInsertionAnchor(notebook) : null;
  const insertionPage =
    (centerAnchor && editablePages(notebook).find((p) => p.id === centerAnchor.pageId)) ||
    (viewMode === 'dual' &&
    pasteAnchor.current?.documentId === activeId &&
    pasteAnchor.current.pageId === notebook.pages[index + 1]?.id
      ? notebook.pages[index + 1]
      : page);
  const editingPage =
    editablePages(notebook).find((p) => p.images.some((i) => i.id === editingId)) ?? insertionPage;
  const editingImage = editingPage.images.find((i) => i.id === editingId);
  const editObject = useCallback((p: Page, id: string) => {
    setEditingId(id);
    setDialog(
      p.images.find((i) => i.id === id)?.kind === 'text'
        ? 'text'
        : p.images.find((i) => i.id === id)?.kind === 'formula'
          ? 'formula'
          : 'sketch',
    );
  }, []);
  const editReadingPage = useCallback((i: number) => {
    if (
      viewRef.current.mode !== 'dual' ||
      i < viewRef.current.index ||
      i > viewRef.current.index + 1
    )
      setIndex(i);
    setTool('pen');
  }, []);
  const pageStep = viewMode === 'dual' ? 2 : 1;
  const turnPage = (direction: number, step = pageStep) =>
    setIndex((i) => {
      const next = i + direction * step;
      return next < 0 ? 0 : next >= current.current.pages.length ? i : next;
    });
  const notify = (s: string) => setMessage(s);
  useEffect(() => {
    if (message) {
      const t = setTimeout(() => setMessage(''), 5500);
      return () => clearTimeout(t);
    }
  }, [message]);
  const viewRef = useRef<WorkspaceView>({ index, zoom, mode: viewMode });
  const [restoredPosition, setRestoredPosition] = useState<WorkspaceView['position']>();
  viewRef.current = {
    index,
    zoom,
    mode: viewMode,
    scratch: {
      enabled: scratchMode,
      hiddenPdf: scratchHiddenPdf,
      returnView: scratchReturn.current ?? undefined,
    },
  };
  const restoredView = useRef(false);
  useEffect(() => {
    let dead = false;
    void bootstrapWorkspace()
      .then(async ({ meta, notebook: n }) => {
        const entries = (await listWorkspace()).documents;
        const restoredTabs = savedTabs()
          .map((id) => entries.find((d) => d.id === id))
          .filter((d): d is typeof meta => !!d)
          .map((d) => ({ id: d.id, name: d.name, hasPdf: d.hasPdf }));
        if (!restoredTabs.some((t) => t.id === meta.id))
          restoredTabs.push({ id: meta.id, name: n.name, hasPdf: !!n.source });
        const doc = n.source ? await loadPdf(n.source) : null;
        if (dead) {
          void destroyPdf(doc);
          return;
        }
        setDocumentTabs(restoredTabs);
        current.current = n;
        pdfRef.current = doc;
        renderedSource.current = n.source;
        activeRef.current = meta.id;
        restoredView.current = true;
        setNotebook(n);
        setPdf(doc);
        setActiveId(meta.id);
        setIndex(Math.min(meta.view.index, n.pages.length - 1));
        setZoom(meta.view.zoom);
        setViewMode(meta.view.mode);
        setRestoredPosition(meta.view.position);
        setScratchMode(!!meta.view.scratch?.enabled && !!n.scratchPapers?.length);
        setScratchHiddenPdf(!!meta.view.scratch?.hiddenPdf);
        scratchReturn.current = meta.view.scratch?.returnView ?? null;
      })
      .catch(() => {
        setSaveStatus(tr('\u6062\u590D\u5931\u8D25'));
        notify(
          tr(
            '\u5DE5\u4F5C\u7A7A\u95F4\u65E0\u6CD5\u6062\u590D\uFF0C\u8BF7\u5BFC\u5165\u5DF2\u4FDD\u5B58\u7684\u5DE5\u7A0B\u6587\u4EF6',
          ),
        );
      })
      .finally(() => {
        if (!dead) setReady(true);
      });
    return () => {
      dead = true;
    };
  }, []);
  useEffect(() => {
    const source = notebook.source;
    if (source === renderedSource.current) return;
    let dead = false;
    void (source ? loadPdf(source) : Promise.resolve(null))
      .then((document) => {
        if (dead) {
          void destroyPdf(document);
          return;
        }
        const old = pdfRef.current;
        renderedSource.current = source;
        pdfRef.current = document;
        setPdf(document);
        if (old !== document) void destroyPdf(old);
      })
      .catch(() => {
        if (!dead) notify(tr('无法加载 PDF 页面，请重新打开文档。'));
      });
    return () => {
      dead = true;
    };
  }, [notebook.source]);
  const persist = useCallback((n: Notebook, id = activeRef.current, view = viewRef.current) => {
    if (!id)
      return Promise.reject(new Error(tr('\u5DE5\u4F5C\u7A7A\u95F4\u5C1A\u672A\u5C31\u7EEA')));
    const visibleSnapshot = id === activeRef.current && n === current.current;
    if (visibleSnapshot) {
      const el = document.querySelector<HTMLElement>('.scratch-viewport');
      const selected = current.current.activeScratchId ?? current.current.scratchPapers?.[0]?.id;
      if (el && selected) {
        const view = {
          x: Number(el.dataset.scratchX),
          y: Number(el.dataset.scratchY),
          zoom: Number(el.dataset.scratchZoom),
        };
        if (Object.values(view).every(Number.isFinite))
          n = {
            ...n,
            scratchPapers: n.scratchPapers?.map((p) => (p.id === selected ? { ...p, view } : p)),
          };
      }
    }
    const snapshot = visibleSnapshot
      ? captureWorkspaceView(view, n.pages[view.index]?.id ?? '')
      : view;
    const previewPdf = renderedSource.current === n.source ? pdfRef.current : undefined;
    saveQueue.current = trackPerformance('workspace-save-queue', () =>
      saveQueue.current
        .catch(() => {})
        .then(() => saveWorkspaceDocument(id, n, snapshot, undefined, undefined, previewPdf))
        .then(() => {}),
    );
    return saveQueue.current;
  }, []);
  const scheduledNotebook = useRef<Notebook | null>(null),
    unsavedContent = useRef(false);
  useEffect(() => {
    if (!ready || !activeId || busy) return;
    // Turning pages or zooming only moves the saved reading position. Let those
    // settle longer and leave the status alone, so reading does not write to disk
    // and re-render the window on every step. Hiding the window still saves at once.
    if (scheduledNotebook.current !== notebook) {
      scheduledNotebook.current = notebook;
      unsavedContent.current = true;
      setSaveStatus(tr('\u4FDD\u5B58\u4E2D'));
    }
    return performanceDelay(
      'save-debounce',
      () => {
        if (operation.current) return;
        unsavedContent.current = false;
        void persist(notebook, activeId, { ...viewRef.current })
          .then(() => setSaveStatus(tr('\u5DF2\u81EA\u52A8\u4FDD\u5B58')))
          .catch(() =>
            setSaveStatus(
              tr('\u81EA\u52A8\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u4FDD\u5B58\u5DE5\u7A0B'),
            ),
          );
      },
      unsavedContent.current ? 450 : 2000,
    );
  }, [
    notebook,
    ready,
    activeId,
    index,
    zoom,
    viewMode,
    busy,
    persist,
    scratchMode,
    scratchHiddenPdf,
  ]);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden' && ready && !operation.current)
        void persist(current.current).catch(() => {});
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [ready, persist]);
  useEffect(
    () => () => {
      void destroyPdf(pdfRef.current);
    },
    [],
  );
  const commit = useCallback(
    (n: Notebook) => {
      const batch = batchRef.current;
      if (n.batch && batch?.id === n.batch.id) {
        const item = batch.items.find((item) => item.id === n.batch!.itemId);
        if (item && !item.edited)
          void storeBatch({
            ...batch,
            items: batch.items.map((value) =>
              value.id === item.id ? { ...value, edited: true } : value,
            ),
          }).catch(() => notify(tr('连续批注进度保存失败，请保存当前工程。')));
      }
      history.current = trimSourceHistory(
        [...history.current.slice(appearance.memoryMode === 'minimal' ? -4 : -39), current.current],
        n,
        (appearance.memoryMode === 'minimal'
          ? 32
          : appearance.mode === 'eco' || (appearance.mode === 'auto' && appearance.battery)
            ? 120
            : 200) *
          1024 *
          1024,
      );
      future.current = [];
      current.current = n;
      setNotebook(n);
    },
    [appearance.memoryMode, appearance.mode, appearance.battery],
  );
  const selectNavigationPage = useCallback((next: number) => {
    readingObserved.current = false;
    setIndex(next);
    setResetView((v) => v + 1);
  }, []);
  const navigation = useDocumentNavigation({
    notebook,
    pdf,
    index,
    documentId: activeId,
    commit,
    onSelect: selectNavigationPage,
    notify,
  });
  const updatePage = useCallback(
    (p: Page) => commit(replaceEditablePage(current.current, p)),
    [commit],
  );
  const createScratch = () => {
    const n = current.current,
      paper = newScratchPaper(n.scratchPapers ?? []);
    commit({ ...n, scratchPapers: [...(n.scratchPapers ?? []), paper], activeScratchId: paper.id });
  };
  const toggleScratch = () => {
    if (!scratchMode) {
      const { scratch, ...normalView } = captureWorkspaceView(viewRef.current, page.id);
      scratchReturn.current = normalView;
      if (!current.current.scratchPapers?.length) createScratch();
      setScratchMode(true);
      setScratchFocus(false);
    } else {
      setScratchMode(false);
      setScratchHiddenPdf(false);
      setScratchFocus(false);
      const prior = scratchReturn.current;
      if (prior && prior.mode === viewRef.current.mode) {
        setZoomState(prior.zoom);
        setRestoredPosition(prior.position ? { ...prior.position } : undefined);
      } else setRestoredPosition(undefined);
      setResetView((v) => v + 1);
    }
  };
  const updateScratch = (id: string, change: Partial<ScratchPaper>, history = true) => {
    const n = current.current;
    if (!n.scratchPapers?.some((p) => p.id === id)) return;
    const next = {
      ...n,
      scratchPapers: n.scratchPapers?.map((p) => (p.id === id ? { ...p, ...change } : p)),
    };
    if (history) commit(next);
    else {
      current.current = next;
      setNotebook(next);
    }
  };
  const routeScratchInk: NonNullable<
    import('react').ContextType<typeof ScratchInkContext>
  >['commit'] = (origin, stroke, rect) => {
    const n = current.current,
      pieces = splitScratchStroke(origin, stroke, rect, visiblePaperHits(n));
    let next = n;
    for (const [id, strokes] of pieces) {
      const p = editablePages(next).find((p) => p.id === id);
      if (p) next = replaceEditablePage(next, { ...p, strokes: [...p.strokes, ...strokes] });
    }
    if (next !== n) commit(next);
  };
  const dropPageOnScratch = (at: number, x: number, y: number) => {
    const target = document.querySelector<HTMLElement>('.scratch-paper');
    const viewport = document.querySelector('.canvas-container')?.getBoundingClientRect();
    if (
      !scratchEnabled.current ||
      !target ||
      !viewport ||
      x < viewport.left ||
      x > viewport.right ||
      y < viewport.top ||
      y > viewport.bottom
    )
      return false;
    const n = current.current,
      scratch = n.scratchPapers?.find((p) => p.id === target.dataset.scratchId);
    const source = n.pages[at],
      r = target.getBoundingClientRect();
    if (!scratch || !source) return false;
    const documentId = activeRef.current;
    reportOperation(() =>
      documentOperation(async () => {
        const { capturePage } = await import('./capturePage');
        const data = await capturePage(source, pdfRef.current, {
          x: 0,
          y: 0,
          width: source.width,
          height: source.height,
        });
        const nightData = await capturePage(
          source,
          pdfRef.current,
          { x: 0, y: 0, width: source.width, height: source.height },
          { night: true },
        );
        if (documentId !== activeRef.current) return;
        const now = current.current,
          sheet = now.scratchPapers?.find((p) => p.id === scratch.id);
        if (!sheet) return;
        const w = source.width,
          h = source.height;
        const image = {
          id: uid(),
          kind: 'image' as const,
          data,
          width: w,
          height: h,
          x: Math.max(
            0,
            Math.min(sheet.page.width - w, ((x - r.left) * sheet.page.width) / r.width - w / 2),
          ),
          y: Math.max(
            0,
            Math.min(sheet.page.height - h, ((y - r.top) * sheet.page.height) / r.height - h / 2),
          ),
          scratchPage: true,
          nightData,
        };
        // Put copied pages below the single scratch handwriting layer.
        const layer = sheet.page.inkLayer ?? sheet.page.images.length;
        const page = {
          ...sheet.page,
          images: [...sheet.page.images.slice(0, layer), image, ...sheet.page.images.slice(layer)],
          inkLayer: layer + 1,
        };
        commit(replaceEditablePage(now, page));
        setScratchFocus(true);
        setTool('object');
        setFocusObjectId(image.id);
        notify(tr('已将页面复制到草稿纸，可移动、缩放和调整层级。'));
      }),
    );
    return true;
  };
  const undo = () => {
    const activePageId = currentPageId.current;
    const prev = history.current.pop();
    if (prev) {
      const target = historyViewportIndex(
        prev,
        historyTarget(current.current, prev, activePageId),
        activePageId,
        viewRef.current.mode,
      );
      future.current.push(current.current);
      current.current = prev;
      setNotebook(prev);
      readingObserved.current = false;
      setIndex(target);
      if (prev.pages[target].id !== activePageId) setResetView((v) => v + 1);
    }
  };
  const redo = () => {
    const activePageId = currentPageId.current;
    const next = future.current.pop();
    if (next) {
      const target = historyViewportIndex(
        next,
        historyTarget(current.current, next, activePageId),
        activePageId,
        viewRef.current.mode,
      );
      history.current.push(current.current);
      current.current = next;
      setNotebook(next);
      readingObserved.current = false;
      setIndex(target);
      if (next.pages[target].id !== activePageId) setResetView((v) => v + 1);
    }
  };
  const measurePageViewport = useCallback(() => {
    const el = document.querySelector<HTMLElement>('.canvas-container');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const controls = [];
    for (const dock of el.querySelectorAll<HTMLElement>(
      ':scope > .insert-dock,:scope > .zoom-dock,:scope > .page-navigation',
    )) {
      const r = dock.getBoundingClientRect();
      if (r.width && r.height)
        controls.push({
          left: r.left - rect.left,
          right: r.right - rect.left,
          top: r.top - rect.top,
          bottom: r.bottom - rect.top,
        });
    }
    return { el, width: el.clientWidth, height: el.clientHeight, controls };
  }, []);
  const fit = useCallback(
    (mode: 'page' | 'width' = fitMode.current) => {
      const viewport = measurePageViewport();
      if (!viewport) return;
      fitActive.current = true;
      fitMode.current = mode;
      const result =
        mode === 'width'
          ? { zoom: fitWidthZoom(notebook.pages, index, viewMode, viewport.width), inset: 0 }
          : fitPageWithControls(
              notebook.pages,
              index,
              viewMode,
              viewport.width,
              viewport.height,
              viewport.controls,
            );
      viewport.el.style.setProperty('--page-controls-inset', `${result.inset}px`);
      setZoomState(result.zoom);
      setResetView((v) => v + 1);
    },
    [viewMode, notebook.pages, index, measurePageViewport],
  );
  useLayoutEffect(() => {
    if (readingObserved.current) return;
    if (!ready) return;
    if (restoredView.current) {
      restoredView.current = false;
      return;
    }
    fit();
  }, [sidebar, ready, pdf, viewMode, page.width, page.height]);
  const fitRef = useRef(fit);
  useLayoutEffect(() => {
    if (pdf)
      setPdfViewCacheKey(
        pdf,
        `${viewMode}:${zoom.toFixed(5)}:${appearance.mode}:${appearance.quality}:${appearance.battery}:${appearance.memoryMode}`,
      );
  }, [
    pdf,
    zoom,
    viewMode,
    appearance.mode,
    appearance.quality,
    appearance.battery,
    appearance.memoryMode,
  ]);
  fitRef.current = fit;
  useLayoutEffect(() => {
    if (!ready) return;
    const el = document.querySelector('.canvas-container');
    if (!el) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        measurePageViewport();
        if (fitActive.current) fitRef.current();
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [
    ready,
    bottomCollapsed,
    headerCollapsed,
    toolbarCollapsed,
    compactWhenCollapsed,
    chatOpen,
    measurePageViewport,
  ]);
  useLayoutEffect(() => {
    if (readingObserved.current) {
      readingObserved.current = false;
      return;
    }
    if (ready && fitActive.current) fitRef.current();
  }, [index, notebook.pages[index + 1]?.width, notebook.pages[index + 1]?.height]);
  const selectedText = useCallback((x?: number, y?: number) => {
    const notebook = current.current,
      index = viewRef.current.index,
      page = notebook.pages[index];
    const s = window.getSelection(),
      text = s?.toString().trim();
    const node = s?.anchorNode?.parentElement;
    if (!text || !node?.closest('.textLayer') || !s?.rangeCount) {
      setSelection(null);
      return;
    }
    const range = s.getRangeAt(0).cloneRange(),
      rect = range.getBoundingClientRect();
    const readingPage = node.closest<HTMLElement>('[data-page-id]');
    const selectedIndex = readingPage
      ? notebook.pages.findIndex((p) => p.id === readingPage.dataset.pageId)
      : index;
    setSelection({
      text: text.slice(0, 10000),
      x: x ?? rect.left,
      y: y ?? rect.bottom,
      range,
      pageId: notebook.pages[selectedIndex]?.id ?? page.id,
      pageNumber: selectedIndex >= 0 ? selectedIndex + 1 : index + 1,
    });
  }, []);
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    const up = (e: PointerEvent) => {
      if (document.querySelector('.pen-tool-wheel') || performance.now() - lastBarrel.current < 600)
        return;
      if (!(e.target instanceof Element)) return;
      if (!e.target.closest('.textLayer')) {
        if (e.target.closest('.canvas-container') && !window.getSelection()?.toString().trim())
          setSelection(null);
        return;
      }
      clearTimeout(pending);
      pending = setTimeout(() => selectedText(e.clientX, e.clientY), 0);
    };
    const context = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.canvas-container')) {
        e.preventDefault();
        selectedText(e.clientX, e.clientY);
      }
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(null);
    };
    document.addEventListener('pointerup', up);
    document.addEventListener('contextmenu', context);
    document.addEventListener('keydown', escape);
    return () => {
      clearTimeout(pending);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('contextmenu', context);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  useEffect(() => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [index, viewMode, pdf]);
  const saveProject = () => {
    download(encodeProject(current.current), `${current.current.name}.tixtab`, 'application/json');
    notify(
      tr(
        '\u5DE5\u7A0B\u5DF2\u4FDD\u5B58\uFF0C\u5305\u542B\u539F\u59CB PDF \u548C\u53EF\u7F16\u8F91\u7B14\u8FF9',
      ),
    );
  };
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]') ||
        document.querySelector('[aria-modal="true"]') ||
        dialog ||
        ocrImage ||
        bitmapOcrOpen ||
        workspaceOpen ||
        zoteroOpen ||
        pendingDrop ||
        busy
      )
        return;
      if (e.key === 'Escape') setCapturing(false);
      if (e.key.toLowerCase() === 'o' && !e.ctrlKey && !e.metaKey) {
        setSelection(null);
        setCapturing(true);
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'f') {
          e.preventDefault();
          setSidebar(true);
          navigation.setMode('search');
          return;
        }
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          e.shiftKey ? redo() : undo();
        }
        if (e.key.toLowerCase() === 'y') {
          e.preventDefault();
          redo();
        }
        if (e.key.toLowerCase() === 's') {
          e.preventDefault();
          saveProject();
        }
        if (e.key.toLowerCase() === 'o') {
          e.preventDefault();
          file.current?.click();
        }
        return;
      }
      const found = tools.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (found) setTool(found.id);
      if (e.key.toLowerCase() === 'd' && !e.altKey) setTool('pdf-edit');
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        turnPage(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey ? 1 : pageStep);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [dialog, viewMode, ocrImage, bitmapOcrOpen, workspaceOpen, zoteroOpen, pendingDrop, busy]);
  const activate = (
    id: string,
    next: Notebook,
    doc: PDFDocumentProxy | null,
    view = defaultView,
  ) => {
    setScratchMode(!!view.scratch?.enabled && !!next.scratchPapers?.length);
    setScratchHiddenPdf(!!view.scratch?.hiddenPdf);
    scratchReturn.current = view.scratch?.returnView ?? null;
    setScratchFocus(false);
    const old = pdfRef.current;
    ensureTab(id, next.batch?.title || next.name, !!next.source);
    viewRef.current = { ...view };
    history.current = [];
    future.current = [];
    current.current = next;
    pdfRef.current = doc;
    renderedSource.current = next.source;
    activeRef.current = id;
    restoredView.current = true;
    setActiveId(id);
    setNotebook(next);
    setPdf(doc);
    setIndex(Math.min(view.index, next.pages.length - 1));
    setZoom(view.zoom);
    setViewMode(view.mode);
    setRestoredPosition(view.position);
    setSelection(null);
    setFocusObjectId(null);
    setEditingId(null);
    setCapturing(false);
    setOcrImage(null);
    setBitmapOcrOpen(false);
    setDialog(null);
    setResetView((v) => v + 1);
    if (old && old !== doc) void destroyPdf(old);
  };
  const documentOperation = async (action: () => Promise<void>) => {
    if (!ready || operation.current || busyRef.current) return;
    operation.current = true;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      operation.current = false;
      busyRef.current = false;
      setBusy(false);
    }
  };
  const reportOperation = (action: () => Promise<void>) => {
    void action().catch((e) => notify(tr('打开失败：{0}', e instanceof Error ? e.message : e)));
  };
  const startBatch = () =>
    documentOperation(async () => {
      const chosen = await batchRequest({ action: 'choose' });
      if (chosen.cancelled) return;
      const folder = chosen.folder!;
      if (!folder.files.length) throw Error(tr('此文件夹中没有 PDF。'));
      await persist(current.current);
      const id = isEmptyStarterNotebook(current.current) ? activeRef.current : uid();
      const manifest: BatchManifest = {
        id,
        title: folder.name,
        folderId: folder.id,
        items: folder.files.map((file) => ({
          ...file,
          storageId: uid(),
          edited: false,
          cached: false,
        })),
      };
      const first = manifest.items[0],
        loaded = await batchRequest({ action: 'read', folderId: folder.id, fileId: first.id });
      const imported = await importPdf(new Uint8Array(loaded.bytes!), first.name);
      try {
        const next = withBatch(imported.notebook, manifest, first);
        await storeBatch(manifest);
        await persist(next, id, defaultView);
        activate(id, next, imported.pdf);
        setWorkspaceOpen(false);
      } catch (error) {
        void destroyPdf(imported.pdf);
        throw error;
      }
    });
  const jumpBatch = (at: number) =>
    reportOperation(() =>
      documentOperation(async () => {
        const manifest = batchRef.current,
          original = current.current;
        if (
          !manifest ||
          !original.batch ||
          original.batch.id !== manifest.id ||
          !manifest.items[at]
        )
          return;
        const target = manifest.items[at];
        if (target.id === original.batch.itemId) return;
        await persist(original);
        await batchSaves.current;
        const previous = manifest.items.find((item) => item.id === original.batch!.itemId)!;
        const { batch: _reference, ...archive } = original;
        await saveWorkspaceDocument(
          previous.storageId,
          archive,
          viewRef.current,
          undefined,
          manifest.id,
        );
        let next: Notebook,
          document: PDFDocumentProxy | null = null,
          view = { ...defaultView, mode: viewRef.current.mode };
        try {
          if (target.cached) {
            const restored = await loadWorkspaceDocument(target.storageId, false);
            next = restored.notebook;
            view = restored.meta.view;
            document = next.source ? await loadPdf(next.source) : null;
          } else {
            const bytes = await batchRequest({
              action: 'read',
              folderId: manifest.folderId,
              fileId: target.id,
            });
            const imported = await importPdf(new Uint8Array(bytes.bytes!), target.name);
            next = imported.notebook;
            document = imported.pdf;
          }
          const updated = {
            ...manifest,
            items: manifest.items.map((item) =>
              item.id === previous.id ? { ...item, cached: true } : item,
            ),
          };
          const selected = withBatch(next, updated, target);
          await storeBatch(updated);
          await persist(selected, activeRef.current, view);
          activate(activeRef.current, selected, document, view);
        } catch (error) {
          void destroyPdf(document);
          throw error;
        }
      }),
    );
  const exportBatch = () =>
    reportOperation(() =>
      documentOperation(async () => {
        const manifest = batchRef.current,
          currentNotebook = current.current;
        if (!manifest || currentNotebook.batch?.id !== manifest.id) return;
        const edited = manifest.items.filter((item) => item.edited);
        if (!edited.length) return;
        await persist(currentNotebook);
        await batchSaves.current;
        const destination = await batchRequest({ action: 'choose-output' });
        if (destination.cancelled) return;
        const controller = new AbortController();
        exportAbort.current = controller;
        const cancelWrite = () => {
          void batchRequest({ action: 'cancel' }).catch(() => {});
        };
        controller.signal.addEventListener('abort', cancelWrite, { once: true });
        let completed = 0;
        const failures: string[] = [];
        try {
          for (const [index, item] of edited.entries()) {
            controller.signal.throwIfAborted();
            setBatchExport({ done: index, total: edited.length, name: item.name });
            setExportProgress({ stage: 'preparing' });
            try {
              const n =
                item.id === currentNotebook.batch.itemId
                  ? currentNotebook
                  : (await loadWorkspaceDocument(item.storageId, false)).notebook;
              const bytes = await exportPdf(n, {
                signal: controller.signal,
                onProgress: setExportProgress,
              });
              controller.signal.throwIfAborted();
              await batchRequest({
                action: 'write',
                token: destination.token,
                name: batchOutputName(item.name),
                bytes,
              });
              completed++;
            } catch (error) {
              if (controller.signal.aborted) throw error;
              failures.push(item.name);
            }
          }
          notify(
            failures.length
              ? tr(
                  '已导出 {0} 份，失败 {1} 份：{2}',
                  completed,
                  failures.length,
                  failures.slice(0, 8).join('；'),
                )
              : tr('已导出 {0} 份已编辑 PDF。', completed),
          );
        } catch (error) {
          if (controller.signal.aborted) notify(tr('已取消导出，已完成 {0} 份。', completed));
          else throw error;
        } finally {
          controller.signal.removeEventListener('abort', cancelWrite);
          await batchRequest({ action: 'finish' }).catch(() => {});
          if (exportAbort.current === controller) exportAbort.current = null;
          setExportProgress(null);
          setBatchExport(null);
        }
      }),
    );
  const loadDocument = async (id: string) => {
    const { meta, notebook: n } = await loadWorkspaceDocument(id);
    const doc = n.source ? await loadPdf(n.source) : null;
    try {
      await persist(n, id, meta.view);
      activate(id, n, doc, meta.view);
    } catch (e) {
      void destroyPdf(doc);
      throw e;
    }
  };
  const switchDocument = (id: string) =>
    documentOperation(async () => {
      await persist(current.current);
      if (id !== activeRef.current) {
        await loadDocument(id);
      }
      setWorkspaceOpen(false);
    });
  const closeTabs = (id: string, mode: CloseTabsMode) =>
    documentOperation(async () => {
      const ordered = tabsRef.current;
      const closing = new Set(tabsToClose(ordered, id, mode));
      if (!closing.size) return;
      await persist(current.current);
      const remaining = ordered.filter((tab) => !closing.has(tab.id));
      if (closing.has(activeRef.current)) {
        const at = ordered.findIndex((tab) => tab.id === id);
        const next =
          mode === 'current'
            ? remaining[Math.min(at, remaining.length - 1)]
            : remaining.find((tab) => tab.id === id);
        if (next) await loadDocument(next.id);
        else {
          const newId = uid(),
            n = newNotebook();
          await persist(n, newId, defaultView);
          activate(newId, n, null);
          remaining.push({ id: newId, name: n.name });
        }
      }
      setDocumentTabs(remaining);
    });
  const createDocument = (folderId: string | null) =>
    documentOperation(async () => {
      await persist(current.current);
      const id = uid(),
        next = newNotebook();
      await saveWorkspaceDocument(id, next, defaultView, folderId);
      activate(id, next, null);
      setWorkspaceOpen(false);
    });
  const removeDocument = (id: string) =>
    documentOperation(async () => {
      await persist(current.current);
      if (id === activeRef.current) {
        const next = (await listWorkspace()).documents.find((d) => d.id !== id);
        if (next) {
          await loadDocument(next.id);
        } else {
          const newId = uid(),
            n = newNotebook();
          await saveWorkspaceDocument(newId, n);
          activate(newId, n, null);
        }
      }
      await deleteWorkspaceDocument(id);
      setDocumentTabs(tabsRef.current.filter((t) => t.id !== id));
    });
  const renameDocument = async (id: string, name: string) => {
    await updateWorkspaceDocument(id, { name });
    setDocumentTabs(tabsRef.current.map((t) => (t.id === id ? { ...t, name } : t)));
    if (id === activeRef.current) {
      if (current.current.batch) {
        current.current = { ...current.current, batch: { ...current.current.batch, title: name } };
        if (batchRef.current) await storeBatch({ ...batchRef.current, title: name });
      } else current.current = { ...current.current, name };
      setNotebook(current.current);
    }
  };
  const exportDocument = async (id: string) => {
    const n =
      id === activeRef.current
        ? current.current
        : (await loadWorkspaceDocument(id, false)).notebook;
    download(encodeProject(n), `${n.name}.tixtab`, 'application/json');
  };
  const revealDocument = async (id: string) => {
    try {
      // Read only tab metadata: revealing an inactive document must not load
      // its PDF, start a renderer or change the active reading position.
      const meta =
        id === activeRef.current
          ? current.current
          : (await listWorkspace()).documents.find((d) => d.id === id);
      if (!meta) return;
      if (meta.batch) {
        const manifest = await loadBatchManifest(meta.batch.id);
        if (!manifest) throw Error('missing');
        await batchRequest({
          action: 'reveal',
          folderId: manifest.folderId,
          fileId: meta.batch.itemId,
        });
        return;
      }
      const result = await window.surfaceDesktop?.revealPdf?.({ path: meta.sourcePath });
      if (!result || result.cancelled) return;
      if (!result.ok || !result.path) throw Error(result.error || 'reveal');
      if (meta.sourcePath !== result.path) {
        await updateWorkspaceDocument(id, { sourcePath: result.path });
        if (id === activeRef.current) {
          current.current = { ...current.current, sourcePath: result.path };
          setNotebook(current.current);
        }
      }
    } catch {
      notify(tr('无法定位原始 PDF，文件可能已移动或删除。'));
    }
  };
  const openFiles = (files: File[]) =>
    documentOperation(async () => {
      const supported = files.filter((f) => /\.(pdf|tixtab)$/i.test(f.name));
      if (!supported.length) {
        notify(tr('请拖入 PDF 或 TixTab 工程文件'));
        return;
      }
      await persist(current.current);
      const failures: string[] = [];
      let starterId: string | null = isEmptyStarterNotebook(current.current)
        ? activeRef.current
        : null;
      for (const f of supported) {
        let doc: PDFDocumentProxy | null = null;
        try {
          let next: Notebook;
          if (/\.pdf$/i.test(f.name)) {
            const imported = await importPdf(new Uint8Array(await f.arrayBuffer()), f.name);
            next = imported.notebook;
            next.sourcePath = window.surfaceDesktop?.getPdfFilePath?.(f) || undefined;
            doc = imported.pdf;
          } else {
            next = decodeProject(await f.text());
            doc = next.source ? await loadPdf(next.source) : null;
            if (
              doc &&
              next.pages.some((p) => p.sourceIndex !== null && p.sourceIndex >= doc!.numPages)
            )
              throw new Error(tr('工程的页面索引无效'));
          }
          const id = starterId || uid();
          await persist(next, id, defaultView);
          activate(id, next, doc);
          starterId = null;
          doc = null;
        } catch (e) {
          void destroyPdf(doc);
          failures.push(`${f.name}: ${e instanceof Error ? e.message : e}`);
        }
      }
      setWorkspaceOpen(false);
      if (failures.length) notify(tr('部分文件导入失败：{0}', failures.join('；')));
    });
  const openZotero = (attachment: ZoteroPdf) =>
    documentOperation(async () => {
      await persist(current.current);
      const source = attachment.source;
      const existing =
        source.serverId &&
        (await listWorkspace()).documents.find(
          (d) =>
            d.zotero?.serverId === source.serverId &&
            d.zotero.library === source.library &&
            d.zotero.key === source.key,
        );
      if (existing) {
        if (existing.id !== activeRef.current) await loadDocument(existing.id);
        return;
      }
      const imported = await importPdf(new Uint8Array(attachment.bytes), attachment.filename);
      const next = { ...imported.notebook, zotero: source, sourcePath: attachment.path },
        id = isEmptyStarterNotebook(current.current) ? activeRef.current : uid();
      try {
        await persist(next, id, defaultView);
        activate(id, next, imported.pdf);
      } catch (e) {
        void destroyPdf(imported.pdf);
        throw e;
      }
    });
  const addImages = (images: ImportedImage[], anchor: DropAnchor) => {
    const notebook = current.current;
    if (scratchEnabled.current) anchor = scratchInsertionAnchor(notebook) ?? anchor;
    const at = notebook.pages.findIndex((page) => page.id === anchor.pageId);
    const page = editablePages(notebook).find((p) => p.id === anchor.pageId);
    if (!page) throw Error(tr('目标页面已不存在。'));
    const objects = images.map((image, i) => {
      const width = Math.min(
        image.width / 2,
        page.width * 0.8,
        (page.height * 0.65 * image.width) / image.height,
      );
      const height = (image.height * width) / image.width;
      return {
        id: uid(),
        data: image.data,
        displayData: image.displayData,
        kind: image.textBox ? ('text' as const) : ('image' as const),
        textBox: image.textBox,
        width,
        height,
        x: Math.max(
          0,
          Math.min(page.width - width, (anchor.x ?? page.width / 2) - width / 2 + i * 12),
        ),
        y: Math.max(
          0,
          Math.min(page.height - height, (anchor.y ?? page.height / 2) - height / 2 + i * 12),
        ),
      };
    });
    if (!objects.length) return;
    commit(replaceEditablePage(notebook, appendPageImages(page, objects)));
    if (
      !scratchEnabled.current &&
      (viewRef.current.mode !== 'dual' ||
        at < viewRef.current.index ||
        at > viewRef.current.index + 1)
    )
      setIndex(at);
    if (scratchEnabled.current) setScratchFocus(at < 0);
    setTool('object');
    setFocusObjectId(objects.at(-1)!.id);
  };
  const droppedImages = async (files: File[], anchor: DropAnchor) => {
    const supported = files.filter(isImageFile);
    if (!supported.length) return;
    const images: ImportedImage[] = [],
      failures: string[] = [];
    for (const file of supported) {
      try {
        images.push(await imageFile(file));
      } catch {
        failures.push(file.name);
      }
    }
    addImages(images, anchor);
    if (failures.length) notify(tr('图片导入失败：{0}', failures.join('、')));
    else notify(tr('已插入 {0} 个图片对象', images.length));
  };
  const confirmPdfDrop = (choice: PdfDropChoice) => {
    const request = pendingDrop;
    setPendingDrop(null);
    if (!request) return;
    reportOperation(async () => {
      if (choice.mode === 'open') {
        await openFiles(request.files);
        await documentOperation(() =>
          droppedImages(request.files, {
            pageId: current.current.pages[viewRef.current.index]?.id || current.current.pages[0].id,
          }),
        );
        return;
      }
      await documentOperation(async () => {
        if (activeRef.current !== request.documentId)
          throw Error(tr('目标文档已切换，请重新拖入文件。'));
        const notebook = current.current;
        const at = notebook.pages.findIndex((page) => page.id === request.anchor.pageId);
        if (at < 0) throw Error(tr('目标页面已不存在。'));
        const inputs = [];
        for (const [i, file] of request.pdfs.entries())
          inputs.push({ bytes: new Uint8Array(await file.arrayBuffer()), pages: choice.pages[i] });
        const { appendPdfSources } = await import('./pdfInsertion');
        const merged = await appendPdfSources(notebook.source, inputs);
        const document = await loadPdf(merged.source);
        try {
          const inserted: Page[] = [];
          for (const sourceIndex of merged.indices) {
            const view = (await document.getPage(sourceIndex + 1)).getViewport({ scale: 1 });
            inserted.push({
              id: uid(),
              sourceIndex,
              width: view.width,
              height: view.height,
              paper: 'plain',
              strokes: [],
              images: [],
            });
          }
          const old = pdfRef.current;
          renderedSource.current = merged.source;
          pdfRef.current = document;
          setPdf(document);
          commit({
            ...notebook,
            source: merged.source,
            pages: [
              ...notebook.pages.slice(0, at + 1),
              ...inserted,
              ...notebook.pages.slice(at + 1),
            ],
          });
          setIndex(at + 1);
          void destroyPdf(old);
          await droppedImages(request.files, { pageId: inserted[0].id });
          notify(tr('已插入 {0} 页 PDF', inserted.length));
        } catch (error) {
          if (pdfRef.current !== document) void destroyPdf(document);
          throw error;
        }
      });
    });
  };
  const objectPasteSequence = useRef({ key: '', count: 0 });
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.defaultPrevented ||
        !ready ||
        busyRef.current ||
        dialog ||
        pendingDrop ||
        workspaceOpen ||
        zoteroOpen ||
        ocrImage ||
        bitmapOcrOpen ||
        document.querySelector('[aria-modal="true"]') ||
        target?.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]')
      )
        return;
      const copiedPage = event.clipboardData ? pageFromClipboard(event.clipboardData) : null;
      if (copiedPage) {
        event.preventDefault();
        pasteCopiedPage(viewRef.current.index, copiedPage);
        return;
      }
      if (isPageClipboardToken(event.clipboardData?.getData('text/plain') || '')) {
        event.preventDefault();
        notify(tr('页面剪贴板已失效，请在此窗口重新复制页面。'));
        return;
      }
      const files = Array.from(event.clipboardData?.files || []).filter(isImageFile);
      const text = event.clipboardData?.getData('text/plain') || '';
      const objects = event.clipboardData ? objectsFromClipboard(event.clipboardData) : null;
      const ink = event.clipboardData ? inkFromClipboard(event.clipboardData) : null;
      if (!objects && !ink && !files.length && !text.trim()) return;
      event.preventDefault();
      const page = current.current.pages[viewRef.current.index] || current.current.pages[0];
      const anchorVisible =
        viewRef.current.mode === 'continuous' &&
        Array.from(document.querySelectorAll<HTMLElement>('.reading-card')).some((card) => {
          if (card.dataset.pageId !== pasteAnchor.current?.pageId) return false;
          const r = card.getBoundingClientRect(),
            viewport = card.closest('.reading-view')?.getBoundingClientRect();
          return !!viewport && r.bottom > viewport.top && r.top < viewport.bottom;
        });
      const anchor =
        (scratchEnabled.current ? scratchInsertionAnchor(current.current) : null) ??
        (pasteAnchor.current?.documentId === activeRef.current &&
        (pasteAnchor.current.pageId === page.id ||
          anchorVisible ||
          (viewRef.current.mode === 'dual' &&
            pasteAnchor.current.pageId === current.current.pages[viewRef.current.index + 1]?.id))
          ? pasteAnchor.current
          : { pageId: page.id });
      setSelection(null);
      reportOperation(() =>
        documentOperation(async () => {
          if (ink) {
            const notebook = current.current;
            const at = notebook.pages.findIndex((p) => p.id === anchor.pageId);
            const page = editablePages(notebook).find((p) => p.id === anchor.pageId);
            if (!page) throw Error(tr('目标页面已不存在。'));
            const strokes = placeInk(ink, page, anchor);
            if (scratchEnabled.current) setScratchFocus(at < 0);
            commit(
              replaceEditablePage(notebook, { ...page, strokes: [...page.strokes, ...strokes] }),
            );
            if (
              !scratchEnabled.current &&
              (viewRef.current.mode !== 'dual' ||
                at < viewRef.current.index ||
                at > viewRef.current.index + 1)
            )
              setIndex(at);
            if (!drawingTool(tool)) setTool('pen');
            requestAnimationFrame(() =>
              selectInk(
                page.id,
                strokes.map((s) => s.id),
              ),
            );
          } else if (objects) {
            const notebook = current.current;
            const at = notebook.pages.findIndex((p) => p.id === anchor.pageId);
            const page = editablePages(notebook).find((p) => p.id === anchor.pageId);
            if (!page) throw Error(tr('目标页面已不存在。'));
            const key = `${activeRef.current}:${page.id}:${objects.objects.map((i) => i.id).join(',')}:${'x' in anchor ? anchor.x : ''}:${'y' in anchor ? anchor.y : ''}`;
            const count =
              objectPasteSequence.current.key === key ? objectPasteSequence.current.count + 1 : 1;
            objectPasteSequence.current = { key, count };
            const placed = placeClipboardObjects(
              objects,
              page,
              anchor,
              scratchEnabled.current ? 0 : count * 16,
            );
            if (scratchEnabled.current) setScratchFocus(at < 0);
            commit(replaceEditablePage(notebook, appendPageImages(page, placed)));
            if (
              !scratchEnabled.current &&
              (viewRef.current.mode !== 'dual' ||
                at < viewRef.current.index ||
                at > viewRef.current.index + 1)
            )
              setIndex(at);
            setTool('object');
            setFocusObjectId(placed.map((i) => i.id));
            notify(tr('已粘贴 {0} 个对象', placed.length));
          } else if (files.length) await droppedImages(files, anchor);
          else {
            const { textBoxImage, defaultTextBox } = await import('./textBox');
            const image = await textBoxImage({ ...defaultTextBox, content: text });
            addImages([image], anchor);
            notify(tr('已粘贴为文本框，可使用对象工具编辑。'));
          }
        }),
      );
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, [ready, dialog, pendingDrop, workspaceOpen, zoteroOpen, ocrImage, bitmapOcrOpen, tool]);
  useEffect(() => {
    let depth = 0;
    const isFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (isFiles(e)) {
        e.preventDefault();
        depth++;
        if (ready && !busyRef.current) setDragging(true);
      }
    };
    const over = (e: DragEvent) => {
      if (isFiles(e)) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = ready && !busyRef.current ? 'copy' : 'none';
      }
    };
    const leave = (e: DragEvent) => {
      if (isFiles(e) && --depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const reset = () => {
      depth = 0;
      setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      reset();
      if (!ready || busyRef.current || pendingDrop) return;
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) return;
      const element = e.target instanceof Element ? e.target : null;
      const paper = element?.closest<HTMLElement>('.paper,.reading-paper');
      const targetId = element?.closest<HTMLElement>('[data-page-id]')?.dataset.pageId;
      const page =
        current.current.pages.find((p) => p.id === targetId) ||
        current.current.pages[viewRef.current.index] ||
        current.current.pages[0];
      const rect = paper?.getBoundingClientRect();
      const anchor: DropAnchor = {
        pageId: page.id,
        ...(rect
          ? {
              x: ((e.clientX - rect.left) / rect.width) * page.width,
              y: ((e.clientY - rect.top) / rect.height) * page.height,
            }
          : {}),
      };
      const pdfs = files.filter((file) => /\.pdf$/i.test(file.name));
      if (pdfs.length) setPendingDrop({ files, pdfs, anchor, documentId: activeRef.current });
      else if (files.some(isImageFile))
        reportOperation(() => documentOperation(() => droppedImages(files, anchor)));
      else reportOperation(() => openFiles(files));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('blur', reset);
    };
  }, [ready, busy, pendingDrop]);
  useEffect(() => {
    if (activeId)
      setDocumentTabs(
        tabsRef.current.map((t) =>
          t.id === activeId ? { ...t, name: notebook.batch?.title || notebook.name } : t,
        ),
      );
  }, [activeId, notebook.name, notebook.batch?.title]);
  const addPage = (event: { currentTarget: HTMLElement }) =>
    setBlankPageAnchor(event.currentTarget.getBoundingClientRect());
  useEffect(() => setPageQuickAnchor(null), [activeId, index]);
  const insertBlankPage = (paper: Page['paper'], paperColor: string) => {
    const n = current.current,
      p = { ...blankPage(page.width, page.height), paper, paperColor };
    commit({ ...n, pages: [...n.pages.slice(0, index + 1), p, ...n.pages.slice(index + 1)] });
    setIndex(index + 1);
    setBlankPageAnchor(null);
  };
  const movePage = (from: number, to: number) => {
    if (from === to || to < 0 || to >= current.current.pages.length) return;
    const pages = [...current.current.pages],
      activeId = page.id,
      [moving] = pages.splice(from, 1);
    pages.splice(to, 0, moving);
    commit({ ...current.current, pages });
    setIndex(pages.findIndex((p) => p.id === activeId));
  };
  const pageTransferFailure = (error: unknown) => {
    if (error instanceof Error && error.name === 'AbortError') return;
    const code = error instanceof Error ? error.message : '';
    notify(
      tr(
        code === 'pending-pdf-edits'
          ? '请先应用或放弃此页暂存的 PDF 编辑。'
          : code === 'page-clipboard-large'
            ? '页面剪贴板最多保留 64 MiB，请减少本页内容后重试。'
            : '页面复制或粘贴失败，请重试。',
      ),
    );
  };
  const copyPagesToClipboard = (indices: number[]) => {
    if (!indices.length) return;
    void documentOperation(async () => {
      const owner = new AbortController();
      pageTransferAbort.current = owner;
      try {
        const payload = await copyNotebookPages(current.current, indices, owner.signal);
        const system = await storeCopiedPage(payload, owner.signal);
        notify(
          indices.length > 1
            ? tr('已复制 {0} 页，切换文档后可粘贴。', indices.length)
            : tr(system ? '页面已复制，切换文档后可粘贴。' : '页面已复制，请使用“粘贴页面”按钮。'),
        );
      } finally {
        if (pageTransferAbort.current === owner) pageTransferAbort.current = null;
      }
    }).catch(pageTransferFailure);
  };
  const copyPageToClipboard = (at: number) => copyPagesToClipboard([at]);
  const copySelectedPages = () => {
    const chosen = new Set(selectedPageIds);
    copyPagesToClipboard(
      current.current.pages.flatMap((page, at) => (chosen.has(page.id) ? [at] : [])),
    );
  };
  const pasteCopiedPage = (at: number, payload = getCopiedPage()) => {
    if (!payload) return;
    void documentOperation(async () => {
      const owner = new AbortController();
      pageTransferAbort.current = owner;
      try {
        const before = current.current;
        const next = await pasteNotebookPage(before, at, payload, owner.signal);
        if (current.current !== before) throw Error('document-changed');
        commit(next);
        setIndex(at + 1);
        notify(
          payload.pages && payload.pages.length > 1
            ? tr('已粘贴 {0} 页。', payload.pages.length)
            : tr('已粘贴页面。'),
        );
      } finally {
        if (pageTransferAbort.current === owner) pageTransferAbort.current = null;
      }
    }).catch(pageTransferFailure);
  };
  useEffect(() => {
    setPageSelectionMode(false);
    setSelectedPageIds([]);
  }, [activeId, notebook.batch?.itemId]);
  useEffect(() => {
    if (navigation.mode !== 'pages') {
      setPageSelectionMode(false);
      setSelectedPageIds([]);
    }
  }, [navigation.mode]);
  useEffect(() => {
    const valid = new Set(notebook.pages.map((page) => page.id));
    setSelectedPageIds((ids) =>
      ids.every((id) => valid.has(id)) ? ids : ids.filter((id) => valid.has(id)),
    );
  }, [notebook.pages]);
  const duplicatePage = (at: number) =>
    reportOperation(() =>
      documentOperation(async () => {
        const before = current.current;
        const next = await duplicateNotebookPage(before, at);
        if (current.current !== before) throw new Error(tr('文档已改变，请重试复制页面'));
        commit(next);
        setIndex(at + 1);
      }),
    );
  const insertImage = (
    data: string,
    w: number,
    h: number,
    kind: 'sketch' | 'formula',
    latex?: string,
    scene?: Record<string, unknown>,
    displayData?: string,
    macros?: Record<string, string>,
  ) => {
    const width = Math.min(w / 2, editingPage.width * 0.8, (editingPage.height * 0.65 * w) / h),
      height = (h * width) / w;
    const image = editingImage
      ? { ...editingImage, data, displayData, scene, latex, macros }
      : {
          id: uid(),
          data,
          displayData,
          x: Math.max(
            0,
            Math.min(
              editingPage.width - width,
              ((scratchMode ? scratchInsertionAnchor(current.current)?.x : undefined) ??
                editingPage.width / 2) -
                width / 2,
            ),
          ),
          y: Math.max(
            0,
            Math.min(
              editingPage.height - height,
              ((scratchMode ? scratchInsertionAnchor(current.current)?.y : undefined) ??
                editingPage.height / 2) -
                height / 2,
            ),
          ),
          width,
          height,
          kind,
          latex,
          scene,
          macros,
        };
    const p = {
      ...editingPage,
      images: editingImage
        ? editingPage.images.map((i) => (i.id === editingImage.id ? image : i))
        : [...editingPage.images, image],
    };
    commit(
      replaceEditablePage(
        { ...current.current, ...(!editingImage ? { scene: undefined } : {}) },
        p,
      ),
    );
    setDialog(null);
    setEditingId(null);
    if (scratchEnabled.current)
      setScratchFocus(!current.current.pages.some((p) => p.id === editingPage.id));
    setFocusObjectId(image.id);
    setTool('object');
    notify(
      editingImage
        ? tr('\u5DF2\u66F4\u65B0\u539F\u5BF9\u8C61\uFF0C\u53EF\u64A4\u9500')
        : tr(
            '\u5DF2\u63D2\u5165\u5F53\u524D\u9875\uFF0C\u9009\u62E9\u5BF9\u8C61\u53EF\u79FB\u52A8\u3001\u7F29\u653E\u6216\u7F16\u8F91',
          ),
    );
  };
  const exportCurrentPdf = async (allowSignatureInvalidation = false) => {
    if (busy || operation.current || exportAbort.current) return;
    const controller = new AbortController(),
      snapshot = current.current;
    exportAbort.current = controller;
    setBusy(true);
    setDialog(null);
    setExportProgress({ stage: 'preparing' });
    try {
      const bytes = await exportPdf(snapshot, {
        allowSignatureInvalidation,
        signal: controller.signal,
        onProgress: (progress) => {
          if (exportAbort.current === controller && !controller.signal.aborted)
            setExportProgress(progress);
        },
      });
      if (controller.signal.aborted || exportAbort.current !== controller) return;
      download(bytes.buffer, tr('{0}-标注.pdf', snapshot.name), 'application/pdf');
      setDialog(null);
      notify(tr('已导出 PDF，保留源页面与标注'));
    } catch (error) {
      if (exportAbort.current !== controller) return;
      if (error instanceof Error && error.name === 'AbortError') notify(tr('已取消 PDF 导出'));
      else if (error instanceof SignedPdfExportError) setDialog('signed-export');
      else notify(tr('导出失败：{0}', error instanceof Error ? error.message : tr('未知错误')));
    } finally {
      if (exportAbort.current === controller) {
        exportAbort.current = null;
        setExportProgress(null);
        setBusy(false);
      }
    }
  };
  const applyPendingPdf = async () => {
    if (busy || operation.current) return;
    const snapshot = current.current;
    setBusy(true);
    try {
      const next = await applyNativeDrafts(snapshot);
      if (current.current === snapshot) commit(next);
      else notify(tr('PDF 内容已改变，请重新选择元素。'));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'pdf-edit';
      notify(tr(pdfEditErrors[code] || pdfEditErrors['pdf-edit']));
    } finally {
      setBusy(false);
    }
  };
  const bottomControls = (
    <>
      <div className="insert-dock">
        <button
          aria-label={tr('框选 OCR')}
          title={tr('框选 OCR (O)')}
          onClick={() => {
            setSelection(null);
            setCapturing(true);
          }}
        >
          <ScanText size={20} />
          <span>OCR</span>
        </button>
        <div />
        <button
          aria-label={tr('草图')}
          title={tr('草图')}
          onClick={() => {
            setEditingId(null);
            setDialog('sketch');
          }}
        >
          <Shapes size={20} />
          <span>{tr('草图')}</span>
        </button>
        <div />
        <button
          aria-label={tr('公式')}
          title={tr('公式')}
          onClick={() => {
            setEditingId(null);
            setDialog('formula');
          }}
        >
          <Sigma size={21} />
          <span>{tr('公式')}</span>
        </button>
        <div />
        <button
          aria-label={tr('文本框')}
          title={tr('插入文本框')}
          onClick={() => {
            setEditingId(null);
            setDialog('text');
          }}
        >
          <Type size={20} />
          <span>{tr('文本框')}</span>
        </button>
        <div />
        <ScratchPanel
          papers={notebook.scratchPapers ?? []}
          selected={notebook.activeScratchId}
          enabled={scratchMode}
          hiddenPdf={scratchHiddenPdf}
          disabled={busy || !ready}
          onToggle={toggleScratch}
          onCreate={createScratch}
          onSelect={(id) => {
            commit({ ...current.current, activeScratchId: id });
            setScratchFocus(true);
          }}
          onRename={(id, name) => updateScratch(id, { name })}
          onColor={(color) => {
            if (activeScratch)
              updateScratch(activeScratch.id, {
                page: { ...activeScratch.page, paperColor: color },
              });
          }}
          onClear={() => {
            if (activeScratch)
              updateScratch(activeScratch.id, {
                page: { ...activeScratch.page, strokes: [], images: [], inkLayer: 0 },
              });
          }}
          onHide={() => {
            if (!scratchHiddenPdf)
              setRestoredPosition(captureWorkspaceView(viewRef.current, page.id).position);
            setScratchHiddenPdf((v) => !v);
          }}
        />
        <div />
        <button
          aria-label={tr('便签')}
          title={tr('框选区域添加便签')}
          aria-pressed={tool === 'review'}
          className={tool === 'review' ? 'active' : ''}
          onClick={() => {
            setSelection(null);
            setTool('review');
          }}
        >
          <StickyNote size={20} />
          <span>{tr('便签')}</span>
        </button>
      </div>
      <div className="zoom-dock">
        <button
          aria-label={tr('缩小')}
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.15))}
        >
          <Minus size={16} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          aria-label={tr('放大')}
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.15))}
        >
          <Plus size={16} />
        </button>
        <div />
        <button title={tr('适合页面')} aria-label={tr('适合页面')} onClick={() => fit('page')}>
          <Maximize size={16} />
        </button>
        <button title={tr('适合宽度')} aria-label={tr('适合宽度')} onClick={() => fit('width')}>
          <MoveHorizontal size={16} />
        </button>
      </div>
      <div className="page-navigation">
        <button
          aria-label={tr('上一页')}
          title={viewMode === 'dual' ? tr('上两页 · ←') : tr('上一页 · ←')}
          disabled={!index}
          onClick={() => turnPage(-1)}
        >
          {viewMode === 'dual' ? <ChevronsLeft size={17} /> : <ChevronLeft size={17} />}
        </button>
        {viewMode === 'dual' && (
          <button
            aria-label={tr('向前移动一页')}
            title={tr('向前移动一页 · Shift+←')}
            disabled={!index}
            onClick={() => turnPage(-1, 1)}
          >
            <ChevronLeft size={17} />
          </button>
        )}
        <PageJump
          key={activeId}
          index={index}
          total={notebook.pages.length}
          onJump={(at) => navigation.go(notebook.pages[at].id)}
        />
        {viewMode === 'dual' && (
          <button
            aria-label={tr('向后移动一页')}
            title={tr('向后移动一页 · Shift+→')}
            disabled={index + 1 >= notebook.pages.length}
            onClick={() => turnPage(1, 1)}
          >
            <ChevronRight size={17} />
          </button>
        )}
        <button
          aria-label={tr('下一页')}
          title={viewMode === 'dual' ? tr('下两页 · →') : tr('下一页 · →')}
          disabled={index + pageStep >= notebook.pages.length}
          onClick={() => turnPage(1)}
        >
          {viewMode === 'dual' ? <ChevronsRight size={17} /> : <ChevronRight size={17} />}
        </button>
      </div>
    </>
  );
  const renderTools = (compact = false) => (
    <div
      className={`tool-group${compact ? ' compact-tools' : ''}`}
      role="group"
      aria-label={tr('标注工具')}
    >
      {[...tools, { id: 'pdf-edit' as const, label: 'PDF 元素', icon: FilePenLine, key: 'D' }].map(
        ({ id, label, icon: Icon, key }) => (
          <button
            key={id}
            className={`tool-button ${tool === id ? 'active' : ''}`}
            title={`${tr(label)} (${key})`}
            aria-label={tr(label)}
            aria-pressed={tool === id}
            onClick={() => {
              setTool(id);
            }}
          >
            <Icon size={compact ? 16 : 20} />
            {!compact && <span>{tr(label)}</span>}
            {id === 'ballpoint' && <span className="ballpoint-dot" aria-hidden="true" />}
          </button>
        ),
      )}
    </div>
  );
  useEffect(() => {
    setPageDelete(null);
    setBlankPageAnchor(null);
  }, [activeId]);
  const renderInkControls = (compact = false) => (
    <div className={compact ? 'compact-edit-controls' : 'expanded-edit-controls'}>
      <InkColors color={color} onChange={setColor} compact={compact} />
      {!compact && <div className="toolbar-divider" />}
      <label className="size-control">
        <span className="size-preview-slot" aria-hidden="true">
          <i style={{ width: Math.min(12, size + 2), height: Math.min(12, size + 2) }} />
        </span>
        <input
          aria-label={tr(tool === 'eraser' ? '橡皮擦半径' : '笔触粗细')}
          title={`${tr(tool === 'eraser' ? '橡皮擦半径' : '笔触粗细')} ${size.toFixed(1)}`}
          type="range"
          min={tool === 'eraser' ? 0.1 : tool === 'highlighter' ? 0.5 : 0}
          max={tool === 'eraser' ? 64 : tool === 'highlighter' ? 32 : 100}
          step={tool === 'highlighter' || tool === 'eraser' ? 0.1 : 1}
          value={tool === 'highlighter' || tool === 'eraser' ? size : penSizeToSlider(size)}
          aria-valuetext={size.toFixed(2)}
          onChange={(e) =>
            setSize(
              tool === 'highlighter' || tool === 'eraser'
                ? Number(e.target.value)
                : penSizeFromSlider(Number(e.target.value)),
            )
          }
        />
        <output>{size.toFixed(1)}</output>
      </label>
    </div>
  );
  const renderHistoryControls = (compact = false) => (
    <div className="row history-buttons" role="group" aria-label={tr('编辑历史与剪贴板')}>
      <button
        className="icon-button"
        title={tr('撤销 (Ctrl+Z)')}
        aria-label={tr('撤销')}
        disabled={!history.current.length}
        onClick={undo}
      >
        <Undo2 size={compact ? 16 : 19} />
      </button>
      <button
        className="icon-button"
        title={tr('重做 (Ctrl+Y)')}
        aria-label={tr('重做')}
        disabled={!future.current.length}
        onClick={redo}
      >
        <Redo2 size={compact ? 16 : 19} />
      </button>
      <ClipboardShelfButton
        key={activeId}
        compact={compact}
        disabled={busy || !ready}
        onError={notify}
      />
    </div>
  );
  return (
    <AppContexts
      navigation={navigation.value}
      editing={{
        notebook,
        pdf,
        mode: viewMode,
        onReviewCreated: () => setTool('hand'),
        stageNative: (pageId, edit) => {
          const n = current.current,
            total = n.pages.reduce(
              (sum, p) =>
                sum +
                (p.pdfEdits?.filter((d) => p.id !== pageId || d.element.id !== edit.element.id)
                  .length ?? 0),
              0,
            );
          if (total >= 256) {
            notify(tr('最多暂存 256 项 PDF 编辑，请先应用已有修改。'));
            return;
          }
          commit({
            ...current.current,
            pages: current.current.pages.map((p) =>
              p.id === pageId
                ? {
                    ...p,
                    pdfEdits: [
                      ...(p.pdfEdits ?? []).filter((d) => d.element.id !== edit.element.id),
                      edit,
                    ],
                  }
                : p,
            ),
          });
        },
      }}
    >
      {pageQuickAnchor && (
        <AnchoredPopover
          anchor={pageQuickAnchor}
          label={tr('页面快捷操作')}
          onClose={() => setPageQuickAnchor(null)}
          width={230}
          className="page-quick-popover"
        >
          <div className="page-quick-actions">
            <button
              onClick={() => {
                setPageQuickAnchor(null);
                setSelection(null);
                setTranslationPanel('open');
              }}
            >
              <Languages size={17} />
              {tr('翻译')}
            </button>
            <button
              disabled={busy || notebook.pages.length <= 1}
              onClick={() => {
                setPageDelete({ id: page.id, anchor: pageQuickAnchor });
                setPageQuickAnchor(null);
              }}
            >
              <Trash2 size={17} />
              {tr('删除当前页')}
            </button>
            <button
              disabled={
                busy || !(page.strokes.length || page.images.length || page.reviews?.length)
              }
              onClick={() => {
                const n = current.current;
                commit({
                  ...n,
                  pages: n.pages.map((p) =>
                    p.id === page.id
                      ? { ...p, strokes: [], images: [], reviews: [], inkLayer: 0 }
                      : p,
                  ),
                });
                setPageQuickAnchor(null);
              }}
            >
              <Eraser size={17} />
              {tr('删除当前页标注')}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setPageQuickAnchor(null);
                duplicatePage(index);
              }}
            >
              <FilePlus2 size={17} />
              {tr('复制当前页')}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setBlankPageAnchor(pageQuickAnchor);
                setPageQuickAnchor(null);
              }}
            >
              <Plus size={17} />
              {tr('插入空白页')}
            </button>
          </div>
        </AnchoredPopover>
      )}
      {blankPageAnchor && (
        <BlankPageDialog
          width={page.width}
          height={page.height}
          anchor={blankPageAnchor}
          onClose={() => setBlankPageAnchor(null)}
          onInsert={insertBlankPage}
        />
      )}
      {pageDelete && (
        <AnchoredPopover
          anchor={pageDelete.anchor}
          label={tr('删除页面')}
          alert
          onClose={() => setPageDelete(null)}
          width={260}
          className="page-delete-popover"
        >
          <div className="editing-fields">
            <p>
              {tr(
                '删除第 {0} 页及其标注？可通过撤销恢复。',
                notebook.pages.findIndex((p) => p.id === pageDelete.id) + 1,
              )}
            </p>
          </div>
          <footer>
            <button onClick={() => setPageDelete(null)}>{tr('取消')}</button>
            <button
              className="danger"
              onClick={() => {
                const n = current.current,
                  at = n.pages.findIndex((p) => p.id === pageDelete.id);
                if (n.pages.length > 1 && at >= 0) {
                  commit({
                    ...n,
                    pages: n.pages.filter((p) => p.id !== pageDelete.id),
                    bookmarks: n.bookmarks?.filter((b) => b.pageId !== pageDelete.id),
                  });
                  setIndex(Math.max(0, at - 1));
                }
                setPageDelete(null);
              }}
            >
              {tr('确认删除')}
            </button>
          </footer>
        </AnchoredPopover>
      )}
      <div
        className={`app-shell ${compactWhenCollapsed && headerCollapsed && toolbarCollapsed && bottomCollapsed ? 'chrome-minimal' : ''}`}
        onPointerDownCapture={(event) => {
          const element = (event.target as HTMLElement).closest<HTMLElement>(
            '.paper,.reading-paper',
          );
          if (element) {
            if (scratchEnabled.current) setScratchFocus(!!element.closest('.scratch-viewport'));
            const id = element.closest<HTMLElement>('[data-page-id]')?.dataset.pageId;
            const p =
              editablePages(current.current).find((p) => p.id === id) ||
              current.current.pages[viewRef.current.index];
            const rect = element.getBoundingClientRect();
            if (p)
              pasteAnchor.current = {
                documentId: activeRef.current,
                pageId: p.id,
                x: ((event.clientX - rect.left) / rect.width) * p.width,
                y: ((event.clientY - rect.top) / rect.height) * p.height,
              };
          }
        }}
        onContextMenuCapture={(event) => {
          if (
            (penWheel || penInteractionPage() || performance.now() - lastBarrel.current < 1000) &&
            (event.target as HTMLElement).closest('.canvas-container')
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {penWheel && (
          <PenToolWheel
            x={penWheel.x}
            y={penWheel.y}
            tool={tool}
            onClose={() => setPenWheel(null)}
            onSelect={(id) => {
              setTool(id);
              setPenWheel(null);
            }}
            onText={
              penWheel.text
                ? () => {
                    selectedText(penWheel.x, penWheel.y);
                    setPenWheel(null);
                  }
                : undefined
            }
          />
        )}
        <TouchKeyboard chatOpen={chatOpen} onModels={() => setDialog('models')} />
        {pendingDrop && (
          <Suspense fallback={null}>
            <PdfDropDialog
              files={pendingDrop.pdfs}
              onClose={() => setPendingDrop(null)}
              onConfirm={confirmPdfDrop}
            />
          </Suspense>
        )}
        {dialog === 'signed-export' && (
          <div className="modal-scrim">
            <section
              className="modal small-modal signed-export"
              role="dialog"
              aria-modal="true"
              aria-label={tr('导出含签名的修改副本')}
            >
              <header>
                <h2>{tr('导出含签名的修改副本')}</h2>
                <button
                  className="icon-button"
                  aria-label={tr('关闭')}
                  disabled={busy}
                  onClick={() => setDialog(null)}
                >
                  <X size={20} />
                </button>
              </header>
              <div className="small-modal-body">
                <p>
                  {tr(
                    '此 PDF 含数字签名。修改页面或添加标注后重新保存，签名将不再有效。原文件和工程内的源 PDF 保持不变。',
                  )}
                </p>
                <p>{tr('未修改的文档会直接导出原始文件；修改副本需要重新签名。')}</p>
                <div className="row">
                  <button disabled={busy} onClick={() => setDialog(null)}>
                    {tr('取消')}
                  </button>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void exportCurrentPdf(true)}
                  >
                    {tr('导出修改副本')}
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}
        <input
          type="file"
          ref={file}
          hidden
          multiple
          accept=".pdf,.tixtab"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            if (files.length) reportOperation(() => openFiles(files));
          }}
        />
        <header className={`topbar ${headerCollapsed ? 'collapsed' : ''}`}>
          <span className="collapsed-title">{notebook.name}</span>
          <div className="brand">
            <span className="brand-mark">
              <BookOpen size={23} />
            </span>
            <span>
              Tix<span className="brand-light">Tab</span>
            </span>
            <span className="version">PREVIEW</span>
          </div>
          <div className="document-title">
            <span className="document-dot" />
            <input
              aria-label={tr('文档名称')}
              value={notebook.name}
              onChange={(e) =>
                setNotebook((n) => ({ ...n, name: e.target.value || tr('未命名笔记') }))
              }
            />
            <span className="save-state">
              <Check size={12} />
              {tr(saveStatus)}
            </span>
          </div>
          <FullscreenButton className="header-fullscreen" />
          <div className="top-actions">
            <button onClick={() => file.current?.click()} disabled={busy || !ready}>
              <FileUp size={17} />
              {tr('打开')}
            </button>
            <button
              className="icon-button"
              title={tr('保存可编辑工程 (Ctrl+S)')}
              aria-label={tr('保存工程')}
              onClick={saveProject}
            >
              <Save size={18} />
            </button>
            <button
              className="primary"
              disabled={busy || !ready}
              onClick={() => void exportCurrentPdf()}
            >
              <Download size={16} />
              {tr('导出 PDF')}
            </button>
          </div>
          <button
            className="icon-button chrome-toggle"
            aria-label={headerCollapsed ? tr('展开顶部区域') : tr('收起顶部区域')}
            title={headerCollapsed ? tr('展开顶部区域') : tr('收起顶部区域')}
            aria-expanded={!headerCollapsed}
            onClick={() => setHeaderCollapsed((v) => !v)}
          >
            {headerCollapsed ? <ChevronDown size={17} /> : <ChevronUp size={17} />}
          </button>
        </header>
        <DocumentTabs
          tabs={tabs}
          activeId={activeId}
          disabled={busy || !ready}
          onSelect={(id) => reportOperation(() => switchDocument(id))}
          onClose={(id, mode) => reportOperation(() => closeTabs(id, mode))}
          onReveal={window.surfaceDesktop?.revealPdf ? (id) => void revealDocument(id) : undefined}
          onReorder={(id, slot) => {
            if (!ready || operation.current || busyRef.current) return;
            setDocumentTabs(reorderDocumentTab(tabsRef.current, id, slot));
          }}
        >
          <button
            className="new-document-tab"
            disabled={busy || !ready}
            aria-label={tr('打开 Zotero 资料库')}
            title={tr('打开 Zotero 资料库')}
            onClick={() => setZoteroOpen(true)}
          >
            <span className="zotero-mark" aria-hidden="true">
              Z
            </span>
          </button>
          <button
            className="new-document-tab"
            disabled={busy || !ready}
            aria-label={tr('新建文档标签')}
            onClick={() => reportOperation(() => createDocument(null))}
          >
            <Plus size={17} />
          </button>
        </DocumentTabs>
        {dragging && (
          <div className="pdf-drop-overlay">
            <FileUp size={36} />
            <strong>{tr('松开以导入文档')}</strong>
            <span>{tr('PDF 可新开标签或插入页面；图片和 SVG 插入为对象')}</span>
          </div>
        )}
        <div className="workspace">
          {sidebar && (
            <aside className="sidebar">
              <SidebarResizer />
              <div className="sidebar-heading">
                <span>{tr('页面')}</span>
                <span className="count">
                  {pageSelectionMode
                    ? `${selectedPageIds.length} / ${notebook.pages.length}`
                    : notebook.pages.length}
                </span>
                <button
                  className="icon-button page-selection-toggle"
                  aria-label={tr('页面选择模式')}
                  title={tr('页面选择模式')}
                  aria-pressed={pageSelectionMode}
                  disabled={busy || !ready}
                  onClick={() => {
                    navigation.setMode('pages');
                    setPageSelectionMode(!pageSelectionMode);
                    setSelectedPageIds([]);
                  }}
                >
                  <ListChecks size={17} />
                </button>
                <button
                  className="icon-button"
                  aria-label={tr('收起页面栏')}
                  onClick={() => setSidebar(false)}
                >
                  <PanelLeftClose size={17} />
                </button>
              </div>
              {pageSelectionMode ? (
                <div
                  className="sidebar-selection-actions"
                  role="group"
                  aria-label={tr('页面批量选择')}
                >
                  <button onClick={() => choosePages(notebook.pages.map((page) => page.id))}>
                    <ListChecks size={16} />
                    <span>{tr('全选')}</span>
                  </button>
                  <button onClick={() => choosePages([])}>
                    <X size={16} />
                    <span>{tr('全不选')}</span>
                  </button>
                  <button
                    onClick={() => {
                      const chosen = new Set(selectedPageIds);
                      choosePages(
                        notebook.pages
                          .filter((page) => !chosen.has(page.id))
                          .map((page) => page.id),
                      );
                    }}
                  >
                    <Check size={16} />
                    <span>{tr('反选')}</span>
                  </button>
                </div>
              ) : (
                navigation.header
              )}
              {navigation.panel}
              {navigation.mode === 'pages' && (
                <>
                  <PageList
                    selectionMode={pageSelectionMode}
                    selectionVersion={pageSelectionVersion}
                    selectedIds={selectedPageIds}
                    onSelectionChange={setSelectedPageIds}
                    onExitSelection={() => {
                      setPageSelectionMode(false);
                      setSelectedPageIds([]);
                    }}
                    onCopyPages={copyPagesToClipboard}
                    pages={notebook.pages}
                    pdf={pdf}
                    index={index}
                    onSelect={(i) => navigation.go(notebook.pages[i].id)}
                    onMove={movePage}
                    onDropOnScratch={scratchMode ? dropPageOnScratch : undefined}
                    onDuplicate={duplicatePage}
                    onCopyPage={copyPageToClipboard}
                    onPastePage={pasteCopiedPage}
                    hasCopiedPage={hasCopiedPage}
                    onClearClipboard={clearPageClipboard}
                    onEditPages={(action, index) => {
                      selectNavigationPage(index);
                      setPageOperation({ action, index });
                    }}
                    onDelete={(i, anchor) => {
                      setIndex(i);
                      setPageDelete({ id: notebook.pages[i].id, anchor });
                    }}
                  />
                  <div className="sidebar-page-actions" role="group" aria-label={tr('页面操作')}>
                    <button
                      className="add-page"
                      aria-label={tr('插入空白页')}
                      title={tr('插入空白页')}
                      onClick={addPage}
                    >
                      <Plus size={16} />
                    </button>
                    <button
                      className="add-page"
                      aria-label={tr('复制当前页')}
                      title={tr('复制当前页')}
                      onClick={() => duplicatePage(index)}
                      disabled={busy}
                    >
                      <FilePlus2 size={16} />
                    </button>
                    <button
                      className="add-page"
                      aria-label={tr(pageSelectionMode ? '复制所选页面' : '复制页面到剪贴板')}
                      title={
                        pageSelectionMode
                          ? tr('复制所选 {0} 页', selectedPageIds.length)
                          : tr('复制页面到剪贴板')
                      }
                      disabled={busy || (pageSelectionMode && !selectedPageIds.length)}
                      onClick={() =>
                        pageSelectionMode ? copySelectedPages() : copyPageToClipboard(index)
                      }
                    >
                      <ClipboardCopy size={16} />
                    </button>
                    <button
                      className="add-page"
                      aria-label={tr('粘贴页面')}
                      title={tr('粘贴页面')}
                      disabled={busy || !hasCopiedPage}
                      onClick={() => pasteCopiedPage(index)}
                    >
                      <ClipboardPaste size={16} />
                    </button>
                    <button
                      className="add-page"
                      aria-label={tr('删除当前页')}
                      title={tr('删除当前页')}
                      disabled={busy || notebook.pages.length <= 1}
                      onClick={(event) =>
                        setPageDelete({
                          id: page.id,
                          anchor: event.currentTarget.getBoundingClientRect(),
                        })
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </>
              )}
              <div className="sidebar-bottom">
                <HardDrive className="local-workspace-icon" size={14} aria-hidden="true" />
                <span>{tr('本地工作空间')}</span>
              </div>
            </aside>
          )}
          <main className="main-workspace">
            <div className={`workspace-heading${toolbarCollapsed ? ' tools-inline' : ''}`}>
              <div className="row workspace-path">
                {!sidebar && (
                  <button
                    className="icon-button"
                    title={tr('展开页面栏')}
                    aria-label={tr('展开页面栏')}
                    onClick={() => setSidebar(true)}
                  >
                    <PanelLeft size={18} />
                  </button>
                )}
                <button
                  className="breadcrumb workspace-library-button"
                  aria-label={tr('管理工作空间')}
                  disabled={busy || !ready}
                  onClick={() => {
                    void persist(current.current)
                      .then(() => batchSaves.current)
                      .then(() => setWorkspaceOpen(true))
                      .catch(() => notify(tr('保存失败，请先保存工程后再管理工作空间')));
                  }}
                >
                  {toolbarCollapsed && <BookOpen size={16} />}
                  <span>{tr('工作空间')}</span>
                </button>
              </div>
              {toolbarCollapsed && (
                <div className="compact-drawing-strip">
                  {renderHistoryControls(true)}
                  {renderTools(true)}
                  {renderInkControls(true)}
                </div>
              )}
              <div className="row workspace-controls">
                {notebook.pages.some((p) => p.pdfEdits?.length) && (
                  <div className="native-edits-actions">
                    <button
                      disabled={busy}
                      className="primary"
                      onClick={() => void applyPendingPdf()}
                    >
                      {tr('应用 PDF 编辑')}
                    </button>
                    <button
                      disabled={busy}
                      title={tr('放弃全部暂存修改')}
                      aria-label={tr('放弃全部暂存修改')}
                      onClick={() =>
                        commit({
                          ...current.current,
                          pages: current.current.pages.map((p) =>
                            p.pdfEdits?.length ? { ...p, pdfEdits: undefined } : p,
                          ),
                        })
                      }
                    >
                      <X size={16} />
                    </button>
                  </div>
                )}
                <ExtraTools
                  key={activeId}
                  notebook={notebook}
                  pdf={pdf}
                  index={index}
                  disabled={busy || !ready}
                  onApply={(pages) => {
                    const replacements = new Map(pages.map((p) => [p.id, p]));
                    commit({
                      ...current.current,
                      pages: current.current.pages.map((p) => replacements.get(p.id) ?? p),
                    });
                  }}
                  onNavigate={(at) => {
                    if (
                      viewRef.current.mode === 'dual' &&
                      Math.floor(viewRef.current.index / 2) === Math.floor(at / 2)
                    )
                      return;
                    setIndex(at);
                  }}
                />
                <button
                  className="icon-button"
                  aria-label={tr('打开 ChatGPT 聊天')}
                  title={tr('打开 ChatGPT 聊天')}
                  aria-pressed={chatOpen}
                  onClick={() => {
                    setChatSelection(null);
                    setChatOpen((v) => !v);
                  }}
                >
                  <MessageSquare size={18} />
                </button>
                <button
                  className="icon-button toolbar-toggle"
                  aria-label={toolbarCollapsed ? tr('展开工具栏') : tr('收起工具栏')}
                  title={toolbarCollapsed ? tr('展开工具栏') : tr('收起工具栏')}
                  aria-expanded={!toolbarCollapsed}
                  aria-controls="drawing-toolbar"
                  onClick={() => setToolbarCollapsed((v) => !v)}
                >
                  {toolbarCollapsed ? <ChevronDown size={17} /> : <ChevronUp size={17} />}
                </button>
                <div className="view-switch" role="group" aria-label={tr('页面预览方式')}>
                  <button
                    className={viewMode === 'single' ? 'active' : ''}
                    title={tr('单页标注')}
                    aria-label={tr('单页标注')}
                    onClick={() => setViewMode('single')}
                  >
                    <File size={16} />
                  </button>
                  <button
                    className={viewMode === 'continuous' ? 'active' : ''}
                    title={tr('连续页面预览')}
                    aria-label={tr('连续页面预览')}
                    onClick={() => setViewMode('continuous')}
                  >
                    <GalleryVerticalEnd size={16} />
                  </button>
                  <button
                    className={viewMode === 'dual' ? 'active' : ''}
                    title={tr('双页预览')}
                    aria-label={tr('双页预览')}
                    onClick={() => setViewMode('dual')}
                  >
                    <Columns2 size={16} />
                  </button>
                </div>
                {appearance.night && (
                  <button
                    className="night-original-toggle"
                    aria-pressed={appearance.original}
                    aria-label={appearance.original ? tr('恢复夜间颜色') : tr('查看原色')}
                    title={appearance.original ? tr('恢复夜间颜色') : tr('查看原色')}
                    onClick={() => setOriginal(!appearance.original)}
                  >
                    {toolbarCollapsed ? (
                      <Eye size={16} />
                    ) : appearance.original ? (
                      tr('恢复夜间颜色')
                    ) : (
                      tr('查看原色')
                    )}
                  </button>
                )}
                <button
                  className={`icon-button night-toggle ${appearance.night ? 'active' : ''}`}
                  aria-label={tr('实验性夜间模式')}
                  title={tr('实验性夜间模式')}
                  aria-pressed={appearance.night}
                  onClick={() => setNight(!appearance.night)}
                >
                  {appearance.night ? <Sun size={17} /> : <Moon size={17} />}
                </button>
                <button
                  className="icon-button"
                  title={tr('设置与笔诊断')}
                  aria-label={tr('设置')}
                  onClick={() => setDialog('settings')}
                >
                  <Settings2 size={18} />
                </button>
              </div>
            </div>
            <div id="drawing-toolbar" className="toolbar" hidden={toolbarCollapsed}>
              {!toolbarCollapsed && renderHistoryControls()}
              <div className="toolbar-divider" />
              {!toolbarCollapsed && renderTools()}
              <div className="toolbar-divider" />
              {!toolbarCollapsed && renderInkControls()}
            </div>
            <ScratchInkContext.Provider
              value={
                scratchMode
                  ? {
                      commit: routeScratchInk,
                      preview: (p, s, r) => scratchLive.current?.preview(p, s, r),
                    }
                  : null
              }
            >
              <div className={`canvas-container${scratchMode ? ' scratch-mode' : ''}`}>
                {scratchMode && <ScratchLiveInk ref={scratchLive} />}
                {scratchMode && activeScratch && (
                  <ScratchSurface
                    key={activeScratch.id}
                    paper={activeScratch}
                    tool={tool}
                    color={color}
                    size={size}
                    active={scratchFocus}
                    focusObjectId={focusObjectId}
                    onActivate={() => setScratchFocus(true)}
                    onChange={updatePage}
                    onView={(view) => updateScratch(activeScratch.id, { view }, false)}
                    onEditObject={editObject}
                    onDiagnostic={reportPenDiagnostic}
                  />
                )}
                {notebook.batch && batchManifest?.id === notebook.batch.id && (
                  <BatchPanel
                    manifest={batchManifest}
                    currentId={notebook.batch.itemId}
                    busy={busy}
                    onJump={jumpBatch}
                    onExport={exportBatch}
                  />
                )}
                <PdfPrefetch
                  pdf={scratchMode && scratchHiddenPdf ? null : pdf}
                  pages={notebook.pages}
                  index={index}
                  mode={viewMode}
                  zoom={zoom}
                />
                {!(scratchMode && scratchHiddenPdf) &&
                  (viewMode === 'single' ? (
                    <PdfSurface
                      freeView={scratchMode}
                      editableActive={!scratchMode || !scratchFocus}
                      restoredPosition={restoredPosition}
                      page={page}
                      pdf={pdf}
                      tool={tool}
                      color={color}
                      size={size}

                      zoom={zoom}
                      resetView={resetView}
                      fitWidth={fitActive.current && fitMode.current === 'width'}
                      setZoom={setZoom}
                      onChange={updatePage}
                      onDiagnostic={reportPenDiagnostic}
                      onRender={setRenderStatus}
                      onContext={selectedText}
                      focusObjectId={focusObjectId}
                      onEditObject={(id) => editObject(page, id)}
                    />
                  ) : (
                    <ReadingView
                      freeView={scratchMode}
                      editableActive={!scratchMode || !scratchFocus}
                      restoredPosition={restoredPosition}
                      pages={notebook.pages}
                      pdf={pdf}
                      mode={viewMode}
                      index={index}
                      tool={tool}
                      zoom={zoom}
                      setZoom={setZoom}
                      resetView={resetView}

                      color={color}
                      size={size}
                      onChange={updatePage}
                      onDiagnostic={reportPenDiagnostic}
                      onContext={selectedText}
                      onEditObject={editObject}
                      focusObjectId={focusObjectId}
                      onEdit={editReadingPage}
                      onPageChange={readingPageChanged}
                    />
                  ))}
                {capturing && (
                  <RegionCapture
                    onCapture={capture}
                    onClose={() => setCapturing(false)}
                    onBitmapOcr={() => {
                      setCapturing(false);
                      setBitmapOcrOpen(true);
                    }}
                  />
                )}
                {!scratchMode &&
                  viewMode === 'single' &&
                  !notebook.source &&
                  page.strokes.length === 0 &&
                  page.images.length === 0 &&
                  index === 0 && (
                    <div className="welcome-note">
                      <span className="eyebrow">A SPACE FOR YOUR THOUGHTS</span>
                      <h1>{tr('思考，从这一笔开始。')}</h1>
                      <p>
                        {tr('拿起笔，自由书写。')}
                        <br />
                        {tr('或打开一份 PDF，让想法落在纸上。')}
                      </p>
                      <button onClick={() => file.current?.click()}>
                        {tr('打开 PDF')}
                        <MoveUpRight size={15} />
                      </button>
                      <span className="welcome-foot">{tr('灵感无需等待，笔记自动保存。')}</span>
                    </div>
                  )}
                {!bottomCollapsed && bottomControls}
              </div>
            </ScratchInkContext.Provider>
            <footer className={`statusbar ${bottomCollapsed ? 'tools-collapsed' : ''}`}>
              <button
                className="icon-button bottom-tools-toggle"
                aria-label={tr(bottomCollapsed ? '展开底部工具' : '收起底部工具')}
                title={tr(bottomCollapsed ? '展开底部工具' : '收起底部工具')}
                aria-expanded={!bottomCollapsed}
                onClick={() => setBottomCollapsed((v) => !v)}
              >
                {bottomCollapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
              </button>
              {bottomCollapsed && (
                <div className="status-tools" aria-label={tr('底部工具')}>
                  {bottomControls}
                </div>
              )}
              <PenStatus />
              <div className="row">
                <span className="sr-only" aria-live="polite">
                  {tr(renderStatus)}
                </span>
                <span className="status-separator" />
                <button
                  className="delete-button"
                  aria-label={tr('页面快捷操作')}
                  title={tr('页面快捷操作')}
                  aria-expanded={!!pageQuickAnchor}
                  onClick={(event) =>
                    setPageQuickAnchor(event.currentTarget.getBoundingClientRect())
                  }
                >
                  <Trash2 size={13} />
                  {tr('页面操作')}
                </button>
                <button
                  className="icon-button"
                  aria-label={tr('使用帮助')}
                  onClick={() => setDialog('help')}
                >
                  <CircleHelp size={15} />
                </button>
              </div>
            </footer>
          </main>
          {chatOpen && (
            <Suspense fallback={null}>
              <ChatPanel
                viewMode={viewMode}
                onModels={() => setDialog('models')}
                onSvgInsert={(image) => {
                  if (activeRef.current === activeId)
                    addImages([image], {
                      pageId:
                        current.current.pages[viewRef.current.index]?.id ||
                        current.current.pages[0].id,
                    });
                }}
                key={activeId}
                documentId={activeId}
                source={notebook.source}
                name={notebook.name}
                pages={notebook.pages}
                page={page}
                pdf={pdf}
                index={index}
                selection={chatSelection?.documentId === activeId ? chatSelection : null}
                onClose={() => setChatOpen(false)}
                onNavigate={(id) => {
                  const at = notebook.pages.findIndex((p) => p.id === id);
                  if (at >= 0) setIndex(at);
                }}
              />
            </Suspense>
          )}
        </div>
        {message && (
          <div className="toast" role="status">
            {tr(message)}
            <button
              className="icon-button"
              aria-label={tr('关闭提示')}
              onClick={() => setMessage('')}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {translationPanel !== null && (
          <SelectionFlyout
            selection={translationAnchor}
            standalone
            open={translationPanel === 'open'}
            onModels={() => setDialog('models')}
            onClose={() => setTranslationPanel('closed')}
          />
        )}
        {selection && (
          <SelectionFlyout
            selection={selection}
            onModels={() => setDialog('models')}
            onAsk={() => {
              setChatSelection({
                id: Date.now(),
                documentId: activeId,
                text: selection.text,
                pageId: selection.pageId ?? page.id,
                pageNumber: selection.pageNumber ?? index + 1,
              });
              setChatOpen(true);
              setSelection(null);
              window.getSelection()?.removeAllRanges();
            }}
            onClose={() => {
              setSelection(null);
              window.getSelection()?.removeAllRanges();
            }}
          />
        )}
        {(busy || !ready) &&
          (exportProgress ? (
            <div className="busy-overlay pdf-export-overlay">
              <section
                className="modal pdf-export-progress"
                role="dialog"
                aria-modal="true"
                aria-label={tr('PDF 导出进度')}
              >
                <h2>{tr('正在导出 PDF')}</h2>
                {batchExport && (
                  <p>
                    {tr(
                      '文件 {0} / {1}：{2}',
                      batchExport.done + 1,
                      batchExport.total,
                      batchExport.name,
                    )}
                  </p>
                )}
                <div className="row" role="status">
                  <span className="spinner" />
                  <span>
                    {tr(
                      {
                        preparing: '准备导出数据…',
                        loading: '读取源 PDF…',
                        structure: '整理页面与文档结构…',
                        annotations: '写入标注…',
                        saving: '保存 PDF…',
                      }[exportProgress.stage],
                    )}
                  </span>
                </div>
                {exportProgress.stage === 'annotations' && (
                  <>
                    <progress
                      aria-label={tr('标注页面进度')}
                      max={exportProgress.total}
                      value={exportProgress.completed}
                    />
                    <p>
                      {tr('已处理 {0} / {1} 页', exportProgress.completed, exportProgress.total)}
                    </p>
                  </>
                )}
                <button onClick={() => exportAbort.current?.abort()}>{tr('取消导出')}</button>
              </section>
            </div>
          ) : (
            <div className="busy-overlay">
              <span className="spinner" />
              <span>{!ready ? tr('恢复工作空间…') : tr('正在处理文档…')}</span>
            </div>
          ))}
        <Suspense
          fallback={
            <div className="busy-overlay">
              <span className="spinner" />
              {tr('加载工具…')}
            </div>
          }
        >
          {dialog === 'tasks' && <TaskCenter onClose={() => setDialog('settings')} />}
          {dialog === 'models' && <ModelManager onClose={() => setDialog('settings')} />}
          {dialog === 'caches' && <CacheManager onClose={() => setDialog('settings')} />}
          {zoteroOpen && (
            <ZoteroDialog
              current={notebook.zotero}
              onOpen={openZotero}
              onClose={() => setZoteroOpen(false)}
            />
          )}
          {workspaceOpen && (
            <WorkspaceManager
              activeId={activeId}
              onOpen={switchDocument}
              onCreate={createDocument}
              onDelete={removeDocument}
              onRename={renameDocument}
              onExport={exportDocument}
              onImport={() => file.current?.click()}
              onStartBatch={window.surfaceDesktop?.batchPdf ? startBatch : undefined}
              onClose={() => setWorkspaceOpen(false)}
            />
          )}
          {ocrImage && !recognizingCapture && (
            <CapturePreview
              image={ocrImage}
              onClose={() => setOcrImage(null)}
              onOcr={() => setRecognizingCapture(true)}
            />
          )}
          {bitmapOcrOpen && (
            <BitmapOcrDialog
              key={activeId}
              pages={notebook.pages}
              pdf={pdf}
              onClose={() => setBitmapOcrOpen(false)}
              onApply={(pages) => {
                const replacements = new Map(pages.map((p) => [p.id, p]));
                commit({
                  ...current.current,
                  pages: current.current.pages.map((p) => replacements.get(p.id) ?? p),
                });
              }}
            />
          )}
          {ocrImage && recognizingCapture && (
            <OcrDialog
              image={ocrImage}
              onClose={() => setOcrImage(null)}
              onRead={(text) => {
                setOcrImage(null);
                setSelection({ text, x: window.innerWidth / 2 - 200, y: 100 });
              }}
            />
          )}
          {dialog === 'sketch' && (
            <SketchDialog
              scene={editingImage ? editingImage.scene : notebook.scene}
              bitmap={editingImage && !editingImage.scene ? editingImage : undefined}
              editing={!!editingImage}
              onClose={(scene) => {
                if (scene && !editingImage) commit({ ...current.current, scene });
                setDialog(null);
                setEditingId(null);
              }}
              onInsert={(data, w, h, scene, displayData) =>
                insertImage(data, w, h, 'sketch', undefined, scene, displayData)
              }
            />
          )}
          {dialog === 'text' && (
            <TextBoxDialog
              initial={editingImage?.textBox}
              onClose={() => {
                setDialog(null);
                setEditingId(null);
              }}
              onInsert={(image) => {
                if (editingImage) {
                  const width = Math.min(
                      image.width / 2,
                      editingPage.width * 0.8,
                      (editingPage.height * 0.8 * image.width) / image.height,
                    ),
                    height = (width * image.height) / image.width;
                  updatePage({
                    ...editingPage,
                    images: editingPage.images.map((i) =>
                      i.id === editingImage.id
                        ? {
                            ...i,
                            data: image.data,
                            displayData: image.displayData,
                            textBox: image.textBox,
                            width,
                            height,
                            x: Math.max(0, Math.min(editingPage.width - width, i.x)),
                            y: Math.max(0, Math.min(editingPage.height - height, i.y)),
                          }
                        : i,
                    ),
                  });
                } else addImages([image], { pageId: editingPage.id });
                setDialog(null);
                setEditingId(null);
                setTool('object');
              }}
            />
          )}
          {dialog === 'formula' && (
            <FormulaDialog
              key={formulaDraftKey(activeId, editingImage?.id)}
              draftKey={formulaDraftKey(activeId, editingImage?.id)}
              initialLatex={editingImage?.latex}
              initialMacros={editingImage?.macros}
              editing={!!editingImage}
              onClose={() => {
                setDialog(null);
                setEditingId(null);
              }}
              onInsert={(data, w, h, latex, macros) =>
                insertImage(data, w, h, 'formula', latex, undefined, undefined, macros)
              }
            />
          )}
        </Suspense>
        {(dialog === 'help' || dialog === 'settings') && (
          <div className="modal-scrim">
            <section
              className="modal small-modal"
              role="dialog"
              aria-modal="true"
              aria-label={dialog === 'settings' ? tr('设置与笔诊断') : tr('使用帮助')}
            >
              <header>
                <h2>{dialog === 'settings' ? tr('纸张与笔输入') : tr('像在纸上一样自然')}</h2>
                <button
                  className="icon-button"
                  aria-label={tr('关闭')}
                  onClick={() => setDialog(null)}
                >
                  <X size={20} />
                </button>
              </header>
              <div className="small-modal-body">
                {dialog === 'settings' ? (
                  <>
                    <button
                      className="zotero-open"
                      onClick={() => {
                        setDialog(null);
                        setZoteroOpen(true);
                      }}
                    >
                      Zotero
                    </button>
                    <button className="task-center-open" onClick={() => setDialog('tasks')}>
                      {tr('任务与后端')}
                    </button>
                    <button className="model-manager-open" onClick={() => setDialog('models')}>
                      {tr('本地模型管理')}
                    </button>
                    <button className="cache-manager-open" onClick={() => setDialog('caches')}>
                      {tr('磁盘缓存管理')}
                    </button>
                    <p className="appearance-note">
                      TixTab · AGPL-3.0-only ·{' '}
                      <a
                        href="https://github.com/Pscgylotti/TixTab"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {tr('源码与许可')}
                      </a>
                    </p>
                    <label className="language-setting">
                      界面语言 / Interface language
                      <select
                        aria-label="界面语言 / Interface language"
                        value={locale}
                        onChange={(e) => setLocale(e.target.value as Locale)}
                      >
                        <option value="zh-CN">简体中文</option>
                        <option value="en">English</option>
                      </select>
                    </label>
                    <UiScaleSettings />
                    <PressureCurveSettings />
                    <label className="appearance-setting">
                      <span>
                        <input
                          type="checkbox"
                          checked={penHaptics.enabled}
                          disabled={!penHaptics.available}
                          onChange={(e) => penHaptics.setEnabled(e.target.checked)}
                        />{' '}
                        {tr('笔触振动反馈')}
                      </span>
                    </label>
                    <label className="appearance-setting haptic-strength-setting">
                      {tr('振动强度')}
                      <input
                        aria-label={tr('振动强度')}
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        disabled={!penHaptics.available || !penHaptics.enabled}
                        value={Math.round(penHaptics.strength * 100)}
                        onChange={(e) => penHaptics.setStrength(Number(e.target.value) / 100)}
                      />
                      <output>{Math.round(penHaptics.strength * 100)}%</output>
                    </label>
                    <p className="appearance-note">
                      {tr('强度调节仅对提供此能力的笔生效；需在系统中开启笔的触觉信号。')}
                    </p>
                    <p className="appearance-note" role="status">
                      {tr(
                        {
                          waiting: '将支持振动的笔靠近屏幕以检测。',
                          supported: '已检测到笔触振动支持；书写时模拟纸张反馈。',
                          unsupported: '当前笔或设备未提供振动反馈。',
                          unavailable: '当前环境未提供笔触振动接口。',
                        }[penHaptics.status],
                      )}
                    </p>
                    <label className="writing-hand-setting">
                      {tr('书写惯用手')}
                      <select
                        aria-label={tr('书写惯用手')}
                        value={writingHand}
                        onChange={(e) => setWritingHand(e.target.value as WritingHand)}
                      >
                        <option value="right">{tr('右手')}</option>
                        <option value="left">{tr('左手')}</option>
                      </select>
                    </label>
                    <label className="appearance-setting">
                      <span>
                        <input
                          type="checkbox"
                          checked={compactWhenCollapsed}
                          onChange={(e) => setCompactWhenCollapsed(e.target.checked)}
                        />{' '}
                        {tr('工具栏全部收起时使用紧凑布局')}
                      </span>
                    </label>
                    <p className="appearance-note">
                      {tr('划词浮窗优先放在惯用手另一侧；空间不足时移到选区上方或下方。')}
                    </p>
                    <label className="appearance-setting">
                      <span>
                        <input
                          type="checkbox"
                          checked={appearance.night}
                          onChange={(e) => setNight(e.target.checked)}
                        />{' '}
                        {tr('实验性夜间模式')}
                      </span>
                    </label>
                    <p className="appearance-note">
                      {tr(
                        '文字与矢量内容调整为暗底亮色，位图降亮度。移动工具下双击图片查看原图；顶部可查看整页原色。复杂裁剪、透明图和图上文字可能不准确，不影响导出与 OCR。',
                      )}
                    </p>
                    <label className="appearance-setting">
                      {tr('渲染与能耗')}
                      <select
                        aria-label={tr('渲染与能耗')}
                        value={appearance.mode}
                        onChange={(e) => setPowerMode(e.target.value as PowerMode)}
                      >
                        <option value="auto">{tr('自动（电池供电时节能）')}</option>
                        <option value="eco">{tr('节能优先')}</option>
                        <option value="quality">{tr('画质优先')}</option>
                      </select>
                    </label>
                    <label className="appearance-setting">
                      {tr('PDF 渲染清晰度')}
                      <select
                        aria-label={tr('PDF 渲染清晰度')}
                        disabled={appearance.memoryMode === 'minimal'}
                        value={appearance.quality}
                        onChange={(e) => setRenderQuality(e.target.value as RenderQuality)}
                      >
                        <option value="standard">{tr('标准')}</option>
                        <option value="high">{tr('高清（推荐）')}</option>
                        <option value="ultra">{tr('超清')}</option>
                      </select>
                    </label>
                    <p className="appearance-note">
                      {tr('缩小页面时使用更高采样密度，停下后补绘。超清会增加内存与耗电。')}
                    </p>
                    <label className="appearance-setting">
                      {tr('内存占用')}
                      <select
                        aria-label={tr('内存占用')}
                        value={appearance.memoryMode}
                        onChange={(e) => setMemoryMode(e.target.value as MemoryMode)}
                      >
                        <option value="normal">{tr('标准缓存')}</option>
                        <option value="minimal">{tr('极低内存')}</option>
                      </select>
                    </label>
                    {appearance.memoryMode === 'minimal' && (
                      <p className="appearance-note">
                        {tr(
                          '仅保留正在显示的画面，关闭预渲染并降低像素预算；撤销历史保留 5 步，回翻页面会重新渲染。模型闲置卸载时间仍按独立设置执行。',
                        )}
                      </p>
                    )}
                    <label className="appearance-setting">
                      {tr('前后预渲染页数')}
                      <select
                        aria-label={tr('前后预渲染页数')}
                        disabled={appearance.memoryMode === 'minimal'}
                        value={appearance.preRender}
                        onChange={(e) =>
                          setPreRenderRange(Number(e.target.value) as PreRenderRange)
                        }
                      >
                        {preRenderChoices.map((n) => (
                          <option key={n} value={n}>
                            {n === 0
                              ? tr('关闭')
                              : n === 0.5
                                ? tr('0.5（前后半页）')
                                : n === 1
                                  ? tr('1（默认）')
                                  : n}
                          </option>
                        ))}
                      </select>
                    </label>
                    {appearance.memoryMode !== 'minimal' && (
                      <p className="appearance-note">
                        {tr(
                          '保留最近 15 页；额外页面缓存普通模式 200 MiB、节能模式 120 MiB。缩放或切换视图后重建。',
                        )}
                      </p>
                    )}
                    <p className="appearance-note">
                      {tr(
                        '节能档降低补绘并行度与像素预算；交互期间复用已有画面，窗口隐藏时暂停 PDF 绘制。',
                      )}
                      {appearance.battery
                        ? tr('当前使用电池。')
                        : tr('当前连接电源或未报告电池状态。')}
                    </p>
                    <p>{tr('默认用笔书写、手指移动。书写时忽略触摸，减少手掌误触。')}</p>
                    <PenDiagnosticCard />
                    <p className="muted">
                      {tr(
                        '支持标准笔擦信号 button=5 / buttons=32；实际压感与笔擦需由设备驱动上报。',
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      {tr(
                        '笔尖直接书写，翻转手写笔使用背面橡皮擦。橡皮擦滑过新增笔迹和插入对象时先高亮，松手删除；保留原始 PDF 内容。',
                      )}
                    </p>
                    <p>
                      {tr(
                        '单指拖动页面，双指缩放与拖动，按钮左右翻页。鼠标滚轮平移，Ctrl + 滚轮缩放。复杂页面可开启“快速预览”，固定低清背景。',
                      )}
                    </p>
                    <p>{tr('框选多个对象，拖动选中对象统一移动；Shift 可加选或取消。')}</p>
                    <p>
                      {tr(
                        'S 选择对象 · T 选择文字 · Delete 删除选中对象 · Ctrl+Z 撤销 · Ctrl+Y 重做 · Ctrl+S 保存工程 · Ctrl+O 打开',
                      )}
                    </p>
                    <p>
                      {tr(
                        '工程保留可编辑笔迹和便签；导出 PDF 保留绘图与审阅批注。PDF 元素工具可修改原生文本和图片，首次使用需安装本地运行时。',
                      )}
                    </p>
                    <p>
                      {tr(
                        'Texo 公式识别与中英翻译在本机运行。选文后可复制、翻译和朗读；按笔侧键或右键打开工具。',
                      )}
                    </p>
                  </>
                )}
              </div>
            </section>
          </div>
        )}
        {pageOperation && (
          <Suspense fallback={null}>
            <PageOperationsDialog
              notebook={notebook}
              pdf={pdf}
              index={pageOperation.index}
              action={pageOperation.action}
              onClose={() => setPageOperation(null)}
              onApply={(next) => {
                if (current.current !== notebook) {
                  notify(tr('文档已改变，请重新操作。'));
                  return;
                }
                commit(next);
                setPageOperation(null);
                setResetView((v) => v + 1);
              }}
            />
          </Suspense>
        )}
      </div>
    </AppContexts>
  );
}
