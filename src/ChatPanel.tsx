import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useChatWindow } from './useChatWindow';
import TouchKeyboard from './TouchKeyboard';
import ChatSvgPreview from './ChatSvgPreview';
import type { ImportedImage } from './svgImport';
import { get, set, del } from 'idb-keyval';
import {
  X,
  Send,
  Square,
  Plus,
  FileText,
  Image,
  Trash2,
  Copy,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Sparkles,
  ArrowUpRight,
  BookOpen,
  ExternalLink,
  PanelRight,
  Shapes,
} from 'lucide-react';
import type { PDFDocumentProxy } from './pdfTypes';
import type { Page } from './model';
import { t, useLocale } from './i18n';
import { copyText } from './clipboard';
import {
  chatRequest,
  chatError,
  conversationInput,
  type ChatMessage,
  type ChatStatus,
  type ChatModel,
} from './chatgpt';
import { pageChatContext, clearChatImages, type ChatContext } from './chatContext';
import {
  attachmentPages,
  chatImage,
  checkChatImages,
  type ChatImageAttachment,
} from './chatAttachments';
import { originalPdfFile, originalPdfText } from './chatFile';
import ChatApiSettings from './ChatApiSettings';
import { useProviderConfig } from './providerSettings';
import { apiChat, chatApiError, chatApiIdentity } from './chatApi';
import { endpoint, ProviderInputError } from './remoteProvider';
import DictationButton from './DictationButton';
import ChatMarkdown from './ChatMarkdown';
import { compactChatMessage, summaryPrompt, svgPrompt } from './chatPrompts';
import './chat.css';
export default function ChatPanel({
  documentId,
  source,
  name,
  pages,
  page,
  pdf,
  index,
  viewMode,
  selection,
  onClose,
  onNavigate,
  onModels,
  onSvgInsert,
  voiceRequest = 0,
}: {
  documentId: string;
  source: Uint8Array | null;
  name: string;
  pages: Page[];
  page: Page;
  pdf: PDFDocumentProxy | null;
  index: number;
  viewMode: 'single' | 'continuous' | 'dual';
  selection: { id: number; text: string; pageId: string; pageNumber: number } | null;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onModels?: () => void;
  onSvgInsert: (image: ImportedImage) => void;
  voiceRequest?: number;
}) {
  useLocale();
  const floating = useChatWindow();
  const api = useProviderConfig('chat', 'llm');
  const [mode, setMode] = useState<'chatgpt' | 'api'>(() => {
    try {
      return localStorage.getItem('surfacetab.chat.mode') === 'api' ? 'api' : 'chatgpt';
    } catch {
      return 'chatgpt';
    }
  });
  const apiMode = mode === 'api';
  useEffect(() => {
    try {
      localStorage.setItem('surfacetab.chat.mode', mode);
    } catch {}
  }, [mode]);
  const [accountCollapsed, setAccountCollapsed] = useState(() => {
    try {
      return localStorage.getItem('surfacetab.chat.accountCollapsed') === 'true';
    } catch {
      return false;
    }
  });
  const [diagnostic, setDiagnostic] = useState('');
  const [pageNumber, setPageNumber] = useState(String(index + 1));
  useEffect(() => {
    setPageNumber(String(index + 1));
  }, [index]);
  useEffect(() => {
    try {
      localStorage.setItem('surfacetab.chat.accountCollapsed', String(accountCollapsed));
    } catch {}
  }, [accountCollapsed]);
  const [account, setAccount] = useState<ChatStatus | null>(null),
    [models, setModels] = useState<ChatModel[]>([]),
    [model, setModel] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]),
    [prompt, setPrompt] = useState(''),
    [contexts, setContexts] = useState<ChatContext[]>([]),
    [images, setImages] = useState<ChatImageAttachment[]>([]),
    [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false),
    [loginBusy, setLoginBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [confirmClear, setConfirmClear] = useState(false);
  const [voiceSendPending, setVoiceSendPending] = useState(false);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const mounted = useRef(true),
    abort = useRef<AbortController | null>(null),
    history = useRef(messages),
    job = useRef(false),
    messageList = useRef<HTMLDivElement>(null),
    transcript = useRef<HTMLDivElement>(null),
    stickToBottom = useRef(true),
    queue = useRef(Promise.resolve()),
    loadGeneration = useRef(0);
  const imageInput = useRef<HTMLInputElement>(null);
  history.current = messages;
  const active = account?.accounts.find((a) => a.id === account.active);
  const selectedModel = apiMode ? api.provider.model.trim() : model;
  let apiConfigured = false;
  try {
    endpoint(api.provider, 'chat');
    apiConfigured = !!selectedModel;
  } catch {}
  const canChat = apiMode
    ? api.ready && apiConfigured
    : !!active?.signedIn && !!active.enabled && !!model;
  const key = apiMode
    ? `surfacetab.chat.api.v1:${documentId}:${chatApiIdentity(api.provider)}`
    : `surfacetab.chat.v1:${documentId}:${account?.active || ''}`;
  const showError = (e: unknown) => {
    if (mounted.current)
      setStatus(apiMode ? chatApiError(e) : chatError(e instanceof Error ? e.message : 'network'));
  };
  const update = (value: ChatMessage[]) => {
    history.current = value;
    setMessages(value);
  };
  const persist = (value: ChatMessage[]) => {
    // Binary attachments stay in memory. Persist only bounded document-specific text history.
    const safe = value.slice(-32).map(({ image, images, file, ...m }) => m);
    queue.current = queue.current
      .then(() => set(key, safe))
      .catch(() => {
        if (mounted.current) setStatus(t('对话保存失败，关闭窗口前请复制需要的内容。'));
      });
  };
  const refreshModels = async () => {
    const generation = loadGeneration.current;
    try {
      const next = await chatRequest<ChatModel[]>({ action: 'models' });
      if (!mounted.current || generation !== loadGeneration.current) return;
      setModels(next);
      setModel((current) => (next.some((m) => m.id === current) ? current : next[0]?.id || ''));
    } catch (e) {
      if (generation === loadGeneration.current) showError(e);
    }
  };
  useEffect(() => {
    mounted.current = true;
    let dead = false;
    if (!apiMode)
      void chatRequest<ChatStatus>({ action: 'status' })
        .then((s) => {
          if (mounted.current && !dead) setAccount(s);
        })
        .catch((e) => {
          if (!dead) showError(e);
        });
    return () => {
      dead = true;
      mounted.current = false;
      abort.current?.abort();
      if (!apiMode) void chatRequest({ action: 'cancel' }).catch(() => {});
      clearChatImages();
    };
  }, [apiMode]);
  useEffect(() => {
    if (floating.target)
      floating.target.ownerDocument.title = `TixTab · ${apiMode ? 'LLM API' : 'ChatGPT'}`;
  }, [apiMode, floating.target]);
  useEffect(() => {
    const generation = ++loadGeneration.current;
    setModels([]);
    setModel('');
    update([]);
    setLoading(true);
    setContexts([]);
    setImages([]);
    setStatus('');
    if (!apiMode && !account?.active) {
      setLoading(false);
      return;
    }
    void get<ChatMessage[]>(key)
      .then((saved) => {
        if (!mounted.current || generation !== loadGeneration.current) return;
        if (Array.isArray(saved))
          update(
            saved
              .filter(
                (m) =>
                  m &&
                  typeof m.text === 'string' &&
                  m.text.length <= 100000 &&
                  typeof m.id === 'string' &&
                  ['user', 'assistant'].includes(m.role),
              )
              .slice(-32)
              .map(compactChatMessage),
          );
      })
      .catch(() => {
        if (mounted.current && generation === loadGeneration.current)
          setStatus(t('无法读取本地对话。'));
      })
      .finally(() => {
        if (mounted.current && generation === loadGeneration.current) setLoading(false);
      });
    if (!apiMode && active?.signedIn && active.enabled) void refreshModels();
  }, [key, active?.signedIn]);
  useEffect(() => {
    if (selection) {
      setContexts((current) =>
        current.length >= 3 && !current.some((c) => c.pageId === selection.pageId)
          ? current
          : [
              ...current.filter((c) => c.pageId !== selection.pageId),
              {
                label: t('选中文字 · 第 {0} 页', selection.pageNumber),
                text: `[Selected text, PDF page ${selection.pageNumber}]\n${selection.text.slice(0, 16000)}`,
                pageId: selection.pageId,
                pageNumber: selection.pageNumber,
              },
            ],
      );
    }
  }, [selection?.id, key]);
  useEffect(() => {
    const el = messageList.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);
  useEffect(() => {
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = messageList.current;
        if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
      });
    });
    if (transcript.current) observer.observe(transcript.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  const login = async (id?: string, enable = false) => {
    if (job.current) return;
    job.current = true;
    setLoginBusy(true);
    setStatus(t('请在浏览器中完成 ChatGPT 授权，然后返回此窗口。'));
    try {
      const next = await chatRequest<ChatStatus>({
        action: 'login',
        enable,
        ...(id ? { id } : {}),
      });
      if (mounted.current) {
        setAccount(next);
        setStatus(
          next.accounts.find((a) => a.id === next.active)?.enabled ? '' : chatError('permission'),
        );
      }
    } catch (e) {
      showError(e);
    } finally {
      job.current = false;
      if (mounted.current) setLoginBusy(false);
    }
  };
  const stop = () => {
    abort.current?.abort();
    if (!apiMode) void chatRequest({ action: 'cancel' }).catch(showError);
  };
  const choosePage = () => {
    const next = Number(pageNumber);
    if (Number.isInteger(next) && next >= 1 && next <= pages.length) onNavigate(pages[next - 1].id);
  };
  const attach = async (kind: 'text' | 'image') => {
    if (job.current) return;
    job.current = true;
    const controller = new AbortController();
    const generation = loadGeneration.current;
    abort.current = controller;
    setBusy(true);
    setStatus(t('正在准备页面…'));
    try {
      const selected = attachmentPages(pageNumber, pages.length);
      const ids = new Set(selected.map((n) => pages[n].id));
      const kept = contexts.filter((c) => !ids.has(c.pageId));
      if (kept.length + selected.length > 3)
        throw new ProviderInputError(t('每次最多附加三页，请先移除其它页面。'));
      // Render sequentially to bound memory and avoid competing with the reading surface.
      const next: ChatContext[] = [...kept];
      for (const n of selected)
        next.push({ ...(await pageChatContext(pages[n], pdf, n, kind, controller.signal)), kind });
      checkChatImages([
        ...next.flatMap((c) => (c.image ? [c.image] : [])),
        ...images.map((i) => i.image),
      ]);
      if (mounted.current && !controller.signal.aborted && generation === loadGeneration.current) {
        setContexts(next);
        setStatus('');
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'page-no-text')
        setStatus(t('当前页没有可提取的文字，请使用“附加页面图片”。'));
      else setStatus(e instanceof Error ? e.message : t('准备附件失败，请重试。'));
    } finally {
      job.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const attachImages = async (files: File[]) => {
    if (job.current || !files.length) return;
    job.current = true;
    setBusy(true);
    const generation = loadGeneration.current;
    try {
      checkChatImages([
        ...contexts.flatMap((c) => (c.image ? [c.image] : [])),
        ...images.map((i) => i.image),
        ...files.map(() => ''),
      ]);
      const next = [...images];
      for (const file of files) {
        next.push(await chatImage(file));
        checkChatImages([
          ...contexts.flatMap((c) => (c.image ? [c.image] : [])),
          ...next.map((i) => i.image),
        ]);
      }
      if (mounted.current && generation === loadGeneration.current) {
        setImages(next);
        setStatus('');
      }
    } catch (e) {
      if (mounted.current && generation === loadGeneration.current)
        setStatus(
          e instanceof Error && e.message !== 'image-invalid'
            ? e.message
            : t('无法读取图片，请选择 PNG、JPEG、WebP 或 SVG 图片。'),
        );
    } finally {
      job.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const send = async (original = false, generateSvg = false, voicePrompt?: string) => {
    const inputPrompt = voicePrompt ?? prompt;
    if (
      job.current ||
      (!original && !inputPrompt.trim() && !contexts.length && !images.length) ||
      !canChat ||
      loading
    )
      return;
    setDiagnostic('');
    job.current = true;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setStatus(t(original ? '正在准备原 PDF…' : '正在回答…'));
    setConfirmClear(false);
    let output = history.current,
      turns = history.current,
      assistant: ChatMessage | undefined,
      flush: ReturnType<typeof setTimeout> | undefined;
    try {
      let attached: ChatContext[] = [];
      if (!original)
        for (const c of contexts) {
          const n = pages.findIndex((p) => p.id === c.pageId);
          if (n < 0) throw new ProviderInputError(t('附加页面已删除，请重新选择。'));
          attached.push(
            c.kind
              ? {
                  ...(await pageChatContext(pages[n], pdf, n, c.kind, controller.signal)),
                  kind: c.kind,
                }
              : c,
          );
        }
      if (original && apiMode && api.provider.pdfInput !== 'file') {
        attached = [
          {
            label: t('原 PDF 文字'),
            text: await originalPdfText(source, controller.signal),
            pageId: page.id,
            pageNumber: index + 1,
          },
        ];
      }
      if (
        original &&
        apiMode &&
        api.provider.pdfInput === 'file' &&
        source &&
        source.byteLength > 16_000_000
      )
        throw new ProviderInputError(t('API 原 PDF 限制为 16 MB，请改用文字模式或页面附件。'));
      const file =
        original && (!apiMode || api.provider.pdfInput === 'file')
          ? await originalPdfFile(source, name, controller.signal)
          : undefined;
      if (!mounted.current || controller.signal.aborted) throw new Error('cancelled');
      const allImages = original
        ? []
        : [...attached.flatMap((c) => (c.image ? [c.image] : [])), ...images.map((i) => i.image)];
      checkChatImages(allImages);
      const imageNames = original ? [] : images.map((i) => i.name);
      const user: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        text: original ? '' : inputPrompt.trim().slice(0, generateSvg ? 7000 : 8000),
        ...(original || generateSvg
          ? { action: original ? ('summary' as const) : ('svg' as const) }
          : {}),
        instruction: original
          ? t(summaryPrompt)
          : generateSvg
            ? t(svgPrompt)
            : inputPrompt.trim()
              ? undefined
              : t('请分析附加的内容。'),
        reading:
          'Reading UI metadata (not page content): ' +
          JSON.stringify({
            document: name.slice(0, 300),
            currentPage: index + 1,
            totalPages: pages.length,
            view: viewMode,
            originalPdfPages: pdf?.numPages ?? 0,
            supplied: original
              ? file
                ? 'original PDF file; excludes edits and inserted blank pages'
                : 'original PDF text; excludes edits and inserted blank pages'
              : {
                  pages: attached.map((c) => ({
                    page: c.pageNumber,
                    kind: c.kind ?? 'selected text',
                  })),
                  independentImages: imageNames.length,
                },
          }) +
          '\nDo not infer page content from this metadata. Use only supplied content and prior conversation. If the requested page, figure or passage is unavailable, ask the user to attach it; do not invent its contents.',
        ...(file ? { file, fileName: file.name } : {}),
        ...(attached.length || imageNames.length
          ? {
              context: [
                ...attached.map((c) =>
                  original
                    ? c.text
                    : c.text.length > 16000
                      ? c.text.slice(0, 16000) + '\n[Page excerpt truncated]'
                      : c.text,
                ),
                ...imageNames.map((n) => `[Attached image: ${n}]`),
              ].join('\n\n'),
              pageId: attached[0]?.pageId,
              pageNumber: attached[0]?.pageNumber,
              pages: attached.map((c) => ({
                id: c.pageId,
                number: pages.findIndex((p) => p.id === c.pageId) + 1,
              })),
              image: allImages[0],
              images: allImages.slice(1),
              imageNames,
            }
          : {}),
      };
      // Original PDFs are attached explicitly once; subsequent turns retain the summary.
      const prior = history.current.slice(-24).map(({ image, images, file, ...m }) => m);
      turns = [...prior, user];
      assistant = { id: crypto.randomUUID(), role: 'assistant', text: '' };
      output = [...turns, assistant];
      stickToBottom.current = true;
      update(output);
      persist(turns);
      if (!original) {
        setPrompt('');
        setContexts([]);
        setImages([]);
      }
      setStatus(t('正在回答…'));
      if (apiMode) {
        await apiChat(api.provider, conversationInput(turns), controller.signal, (text) => {
          assistant!.text = text;
          if (!flush)
            flush = setTimeout(() => {
              flush = undefined;
              if (mounted.current && !controller.signal.aborted) update([...output]);
            }, 100);
        });
      } else {
        const started = await chatRequest<{ id: string }>({
          action: 'start',
          model: selectedModel,
          messages: conversationInput(turns),
        });
        if (controller.signal.aborted) {
          void chatRequest({ action: 'cancel' });
          throw new Error('cancelled');
        }
        for (;;) {
          const next = await chatRequest<{
            delta: string;
            done: boolean;
            error: string;
            diagnostic?: unknown;
          }>({ action: 'read', id: started.id });
          if (controller.signal.aborted) throw new Error('cancelled');
          assistant.text += next.delta;
          if (!flush)
            flush = setTimeout(() => {
              flush = undefined;
              if (mounted.current && !controller.signal.aborted) update([...output]);
            }, 100);
          if (next.done) {
            if (next.error) {
              setDiagnostic(JSON.stringify(next.diagnostic || {}, null, 2));
              throw new Error(next.error);
            }
            break;
          }
        }
      }
      if (mounted.current) setStatus('');
    } catch (e) {
      if (assistant) {
        assistant.failed = true;
        if (!assistant.text) output = turns;
      }
      showError(e);
    } finally {
      clearTimeout(flush);
      job.current = false;
      if (mounted.current) {
        output = output.map(({ file, image, images, ...m }) => m);
        update([...output]);
        persist(output);
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    if (!voiceSendPending || loading || busy || loginBusy) return;
    setVoiceSendPending(false);
    if (canChat) void send(false, false, promptRef.current);
    else setStatus(t('请先配置聊天后端，语音文字已保留在输入框。'));
  }, [voiceSendPending, loading, busy, loginBusy, canChat]);
  const clear = async () => {
    await queue.current;
    await del(key);
    update([]);
    setConfirmClear(false);
    setStatus('');
  };
  const content = (
    <aside
      className="chat-panel"
      role="complementary"
      aria-label={t(apiMode ? 'AI 阅读助手' : 'ChatGPT 阅读助手')}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files).filter((file) =>
          file.type.startsWith('image/'),
        );
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        void attachImages(files);
      }}
    >
      <header className="chat-heading">
        <span className="chat-heading-mark">
          <Sparkles size={17} />
        </span>
        <strong>{t(apiMode ? 'AI 阅读助手' : 'ChatGPT 阅读助手')}</strong>
        <span>{t('实验性')}</span>
        <button
          className="icon-button"
          aria-label={t(floating.target ? '停靠到侧栏' : '在独立悬浮窗中打开')}
          title={t(floating.target ? '停靠到侧栏' : '在独立悬浮窗中打开')}
          onClick={() => {
            if (floating.target) floating.dock();
            else if (!floating.detach()) setStatus(t('无法打开悬浮窗，请允许应用弹出窗口。'));
          }}
        >
          {floating.target ? <PanelRight size={16} /> : <ExternalLink size={16} />}
        </button>
        <button className="icon-button" aria-label={t('收起聊天')} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="chat-account">
        <button
          className="chat-account-toggle"
          aria-expanded={!accountCollapsed}
          aria-controls="chat-account-details"
          onClick={() => setAccountCollapsed((v) => !v)}
          title={apiMode ? t('LLM API（OpenAI 兼容）') : active?.email || t('ChatGPT 账号')}
        >
          <span>
            {t('账号与模型')}
            {accountCollapsed
              ? apiMode
                ? ` · API · ${api.provider.model}`
                : active?.signedIn
                  ? ` · ${active.email || active.name}`
                  : ''
              : ''}
          </span>
          {accountCollapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
        <div id="chat-account-details" hidden={accountCollapsed}>
          <label>
            {t('聊天接入方式')}
            <select
              aria-label={t('聊天接入方式')}
              value={mode}
              disabled={busy || loginBusy}
              onChange={(e) => setMode(e.target.value as 'chatgpt' | 'api')}
            >
              <option value="chatgpt">{t('ChatGPT 账号')}</option>
              <option value="api">{t('LLM API（OpenAI 兼容）')}</option>
            </select>
          </label>
          {apiMode ? (
            <ChatApiSettings {...api} disabled={busy || loginBusy} />
          ) : (
            <>
              {account?.accounts.length ? (
                <>
                  <label>
                    {t('ChatGPT 账号')}
                    <select
                      aria-label={t('ChatGPT 账号')}
                      disabled={busy || loginBusy}
                      value={account.active}
                      onChange={(e) => {
                        setStatus('');
                        void chatRequest<ChatStatus>({ action: 'select', id: e.target.value })
                          .then(setAccount)
                          .catch(showError);
                      }}
                    >
                      {account.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.email || a.name || t('ChatGPT 账号')} · {a.id.slice(-6)}
                          {!a.signedIn ? ` · ${t('已退出')}` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="chat-account-actions">
                    <button disabled={busy || loginBusy} onClick={() => void login()}>
                      <Plus size={14} />
                      {t('添加账号')}
                    </button>
                    {active?.signedIn ? (
                      <button
                        disabled={busy || loginBusy}
                        onClick={() => {
                          setLoginBusy(true);
                          void chatRequest<ChatStatus>({ action: 'logout', id: account.active })
                            .then((s) => {
                              setAccount(s);
                              if (!s.revoked)
                                setStatus(
                                  t('已在本机退出，未确认远程撤销，请在 ChatGPT 设置中断开连接。'),
                                );
                            })
                            .catch(showError)
                            .finally(() => setLoginBusy(false));
                        }}
                      >
                        {t('退出登录')}
                      </button>
                    ) : (
                      <button
                        disabled={busy || loginBusy}
                        onClick={() => void login(account.active)}
                      >
                        Continue with ChatGPT
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <button
                  className="chat-signin"
                  disabled={loginBusy || !window.surfaceDesktop?.chatgpt}
                  onClick={() => void login()}
                >
                  Continue with ChatGPT
                </button>
              )}
              {!active?.signedIn && (
                <p>{t('登录现有 ChatGPT 账号，授权后使用可用的订阅额度。无需 API Key。')}</p>
              )}
              {loginBusy && <button onClick={stop}>{t('取消登录')}</button>}
              {account?.storage === 'session' && (
                <small>{t('系统安全存储不可用，本次登录仅保留到退出应用。')}</small>
              )}
              {active?.signedIn && !active.enabled && (
                <button disabled={busy || loginBusy} onClick={() => void login(active.id, true)}>
                  {t('启用 ChatGPT 订阅额度')}
                </button>
              )}
              {active?.signedIn && active.enabled && (
                <div className="chat-model">
                  <label>
                    {t('聊天模型')}
                    <select
                      aria-label={t('聊天模型')}
                      disabled={busy || !models.length}
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                    >
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="icon-button"
                    aria-label={t('刷新聊天模型')}
                    disabled={busy || loginBusy}
                    onClick={() => void refreshModels()}
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>
              )}
              <div className="chat-plan">
                <span>
                  {active?.signedIn && active.enabled
                    ? t('使用 ChatGPT 订阅额度')
                    : t('登录后开始聊天')}
                </span>
                <button
                  className="chat-usage"
                  onClick={() => void chatRequest({ action: 'usage' }).catch(showError)}
                >
                  {t('管理 ChatGPT 用量')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {!apiMode && account?.welcome && (
        <div className="chat-welcome" role="dialog" aria-label={t('正在使用 ChatGPT 订阅额度')}>
          <strong>{t('正在使用 ChatGPT 订阅额度')}</strong>
          <p>{t('此处符合条件的请求使用你的 ChatGPT 额度，可在 ChatGPT 设置中管理用量。')}</p>
          <button
            onClick={() =>
              void chatRequest<ChatStatus>({ action: 'welcome' }).then(setAccount).catch(showError)
            }
          >
            {t('知道了')}
          </button>
        </div>
      )}
      <div
        className="chat-messages"
        ref={messageList}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        aria-label={t('聊天记录')}
        aria-busy={busy}
      >
        <div className="chat-transcript" ref={transcript}>
          {!messages.length && (
            <div className="chat-empty">
              <div className="chat-empty-mark">
                <BookOpen size={26} />
              </div>
              <strong>{t('一起读懂这份文档')}</strong>
              <p>{t('选中段落或附加当前页，开始分析。')}</p>
              <div className="chat-suggestions">
                {['概括当前页的要点', '逐步解释这一页的公式', '找出值得深入讨论的问题'].map(
                  (text) => (
                    <button
                      key={text}
                      disabled={busy || loginBusy || !canChat}
                      onClick={() => {
                        setPrompt(t(text));
                        void attach('text');
                      }}
                    >
                      {t(text)}
                      <ArrowUpRight size={14} />
                    </button>
                  ),
                )}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <article key={m.id} className={`chat-message ${m.role}`}>
              <div className="chat-message-meta">
                {m.role === 'assistant' && <Sparkles size={13} />}
                <b>
                  {m.role === 'user' ? t('你') : apiMode ? api.provider.model || 'LLM' : 'ChatGPT'}
                </b>
                {(m.pages || (m.pageId ? [{ id: m.pageId, number: m.pageNumber }] : [])).map(
                  (p) => (
                    <button key={p.id} onClick={() => onNavigate(p.id)}>
                      {t('第 {0} 页', p.number)}
                    </button>
                  ),
                )}
                {m.text && (
                  <button
                    className="icon-button"
                    aria-label={t('复制消息')}
                    onClick={() =>
                      void copyText(m.text)
                        .then(() => setStatus(t('已复制')))
                        .catch(() => setStatus(t('复制失败')))
                    }
                  >
                    <Copy size={13} />
                  </button>
                )}
              </div>
              {m.fileName && <small className="chat-file-name">PDF · {m.fileName}</small>}
              {!!m.imageNames?.length && (
                <small className="chat-file-name">{m.imageNames.join(' · ')}</small>
              )}
              {m.action === 'summary' && (
                <span
                  className="chat-action-label"
                  aria-label={t('总结全文')}
                  title={t('总结全文')}
                >
                  <BookOpen size={16} aria-hidden="true" />
                  {t('总结全文')}
                </span>
              )}
              <>
                {m.role === 'assistant' ? (
                  m.text ? (
                    <ChatMarkdown text={m.text} />
                  ) : (
                    <div className="chat-thinking" role="status">
                      <i />
                      <i />
                      <i />
                      <span>{t('正在回答…')}</span>
                    </div>
                  )
                ) : m.text ? (
                  <p className="chat-user-text">{m.text}</p>
                ) : null}
              </>
              {m.role === 'assistant' && m.text && !busy && !m.failed && (
                <ChatSvgPreview text={m.text} onInsert={onSvgInsert} onStatus={setStatus} />
              )}
              {m.failed && <small className="chat-incomplete">{t('回答未完成')}</small>}
            </article>
          ))}
        </div>
      </div>
      <div className="chat-compose">
        <div className="chat-context-actions">
          <input
            className="chat-page-number"
            type="text"
            inputMode="text"
            aria-label={t('聊天附件页码')}
            title={t('输入页码或范围，例如 1, 3-4；最多附加三页。')}
            value={pageNumber}
            disabled={busy}
            onChange={(e) => setPageNumber(e.target.value)}
            onBlur={choosePage}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <button
            disabled={busy || loginBusy}
            aria-label={t('附加页面文字')}
            title={t('附加页面文字')}
            onClick={() => void attach('text')}
          >
            <FileText size={15} />
            {t('文字')}
          </button>
          <button
            disabled={busy || loginBusy}
            aria-label={t('附加页面图片')}
            title={t('附加页面图片')}
            onClick={() => void attach('image')}
          >
            <Image size={15} />
            {t('图片')}
          </button>
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,image/svg+xml"
            multiple
            hidden
            aria-label={t('聊天独立图片附件')}
            onChange={(e) => {
              void attachImages(Array.from(e.target.files || []));
              e.target.value = '';
            }}
          />
          <button
            className="icon-button"
            aria-label={t('附加独立图片')}
            title={t('附加独立图片（也可粘贴图片）')}
            disabled={busy || loginBusy}
            onClick={() => imageInput.current?.click()}
          >
            <Plus size={15} />
          </button>
          <button
            aria-label={t('根据描述生成 SVG')}
            title={t('根据输入框中的描述生成 SVG 矢量图')}
            disabled={busy || loading || loginBusy || !prompt.trim() || !canChat}
            onClick={() => void send(false, true)}
          >
            <Shapes size={15} />
            {t('生成 SVG')}
          </button>
          <button
            className="chat-original"
            aria-label={t('发送原 PDF 并总结')}
            title={t('发送导入的原 PDF，先进行总结；不包含后续标注。')}
            disabled={busy || loading || loginBusy || !source || !canChat}
            onClick={() => void send(true)}
          >
            <Send size={13} />
            {t('总结 PDF')}
          </button>
          <button
            className="icon-button"
            aria-label={t('清空当前对话')}
            disabled={busy || loading || !messages.length}
            onClick={() => setConfirmClear((v) => !v)}
          >
            <Trash2 size={15} />
          </button>
        </div>
        {confirmClear && (
          <div className="chat-clear">
            <span>
              {t(apiMode ? '删除此文档当前 API 的本地对话？' : '删除此文档当前账号的本地对话？')}
            </span>
            <button onClick={() => void clear().catch(showError)}>{t('删除')}</button>
            <button onClick={() => setConfirmClear(false)}>{t('取消')}</button>
          </div>
        )}
        {(contexts.length > 0 || images.length > 0) && (
          <div className="chat-attachments" aria-label={t('待发送附件')}>
            {contexts.map((context) => (
              <div className="chat-context" key={context.pageId}>
                <span>
                  {context.label}
                  {context.kind === 'image' || context.image ? ` · ${t('图片')}` : ''}
                </span>
                <button
                  className="icon-button"
                  disabled={busy}
                  aria-label={t('移除附加内容')}
                  onClick={() =>
                    setContexts((current) => current.filter((c) => c.pageId !== context.pageId))
                  }
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            {images.map((image) => (
              <div className="chat-context chat-image-attachment" key={image.id}>
                <img src={image.image} alt={image.name} />
                <span title={image.name}>{image.name}</span>
                <button
                  className="icon-button"
                  disabled={busy}
                  aria-label={t('移除图片 {0}', image.name)}
                  onClick={() => setImages((current) => current.filter((i) => i.id !== image.id))}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="chat-input">
          <textarea
            aria-label={t(apiMode ? '向 LLM 提问' : '向 ChatGPT 提问')}
            placeholder={t('解释这一段，或检查公式推导…')}
            rows={2}
            maxLength={8000}
            disabled={busy || loginBusy}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="chat-send-row">
            <span className="chat-keyboard-slot" />
            <DictationButton
              toggleRequest={voiceRequest}
              onShortcutFinished={() => setVoiceSendPending(true)}
              hostDocument={floating.target?.ownerDocument}
              onModels={
                onModels
                  ? () => {
                      window.focus();
                      onModels();
                    }
                  : undefined
              }
              disabled={busy || loginBusy}
              onText={(text) => {
                promptRef.current = (
                  promptRef.current +
                  (promptRef.current ? '\n' : '') +
                  text
                ).slice(0, 8000);
                setPrompt(promptRef.current);
              }}
              onStatus={setStatus}
            />
            <span className="chat-send-hint">{t('Enter 发送 · Shift+Enter 换行')}</span>
            {busy ? (
              <button onClick={stop}>
                <Square size={14} />
                {t('停止')}
              </button>
            ) : (
              <button
                className="primary"
                disabled={
                  (!prompt.trim() && !contexts.length && !images.length) ||
                  !canChat ||
                  loading ||
                  loginBusy
                }
                onClick={() => void send()}
              >
                <Send size={15} />
                {t('发送')}
              </button>
            )}
          </div>
        </div>
        <p className="chat-status" role="status">
          {status}
        </p>
        {diagnostic && (
          <details className="chat-diagnostic">
            <summary>{t('连接诊断')}</summary>
            <button
              onClick={() =>
                void copyText(diagnostic)
                  .then(() => setStatus(t('已复制')))
                  .catch(() => setStatus(t('复制失败')))
              }
            >
              <Copy size={12} />
              {t('复制诊断')}
            </button>
            <pre>{diagnostic}</pre>
          </details>
        )}
      </div>
    </aside>
  );
  return floating.target
    ? createPortal(
        <>
          {content}
          <TouchKeyboard
            chatOpen
            hostDocument={floating.target.ownerDocument}
            onModels={
              onModels
                ? () => {
                    window.focus();
                    onModels();
                  }
                : undefined
            }
          />
        </>,
        floating.target,
      )
    : content;
}
