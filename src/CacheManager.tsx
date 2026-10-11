import { useEffect, useRef, useState } from 'react';
import { X, Trash2, HardDrive, RefreshCw } from 'lucide-react';
import catalog from '../electron/cache-catalog.json';
import { t, useLocale } from './i18n';
import {
  listBrowserCaches,
  clearBrowserCache,
  type BrowserCacheId,
  type CacheRow,
} from './browserCaches';
import { maintainLocalCaches } from './providers';
import './cacheManager.css';
const labels: Record<string, string> = {
  ...Object.fromEntries(catalog.items.map((item) => [item.id, item.label])),
  'browser-transformers': '浏览器公式与翻译缓存',
  'browser-tesseract': '浏览器 OCR 缓存',
  'browser-piper': '旧浏览器语音副本',
};
const errors: Record<string, string> = {
  busy: '缓存正在使用，请先结束任务或释放其它窗口的模型后重试。',
  'legacy-service': '旧原生服务不支持缓存保护，请先关闭或更新该服务。',
  unavailable: '缓存服务不可用，请稍后重试。',
  unsafe: '目录包含链接或路径异常，已停止清理。',
  limited: '缓存目录条目过多，请手动检查。',
  changed: '缓存已变化，请重新统计并确认。',
  partial: '部分文件仍被占用，已保留未删除文件。',
  cancelled: '已取消，可能已清理部分缓存；请重新统计。',
  failed: '缓存操作失败，请重新统计后重试。',
  invalid: '缓存类型无效。',
};
const size = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
export default function CacheManager({ onClose }: { onClose: () => void }) {
  useLocale();
  const bridge = window.surfaceDesktop?.caches;
  const [rows, setRows] = useState<CacheRow[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [pending, setPending] = useState<CacheRow | null>(null);
  const controller = useRef<AbortController | null>(null),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      void bridge?.cancel();
    };
  }, [bridge]);
  function cancel() {
    controller.current?.abort();
    void bridge?.cancel();
  }
  async function run(clear?: CacheRow) {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setPending(null);
    setMessage(t(clear ? '等待本地任务完成后清理缓存…' : '正在按需统计缓存…'));
    try {
      if (clear) {
        const result = await maintainLocalCaches(async () => {
          if (clear.id.startsWith('browser-')) {
            await clearBrowserCache(clear.id as BrowserCacheId, current.signal);
            return { ok: true, error: undefined };
          }
          if (!bridge) return { ok: false, error: 'unavailable' };
          return bridge.clear(clear.id, clear.token ?? '');
        }, current.signal);
        current.signal.throwIfAborted();
        if (mounted.current) {
          setRows([]);
          setMessage(
            t(
              result.ok
                ? '缓存已清理；再次使用时按需重新生成。'
                : (errors[result.error ?? 'failed'] ?? errors.failed),
            ),
          );
        }
      } else {
        const browser = await listBrowserCaches(current.signal),
          native = bridge ? await bridge.list() : null;
        current.signal.throwIfAborted();
        if (mounted.current) {
          setRows([...(native?.ok ? (native.rows ?? []) : []), ...browser]);
          setMessage(
            native && !native.ok ? t(errors[native.error ?? 'failed'] ?? errors.failed) : '',
          );
        }
      }
    } catch {
      if (mounted.current) {
        setRows([]);
        setMessage(t(current.signal.aborted ? errors.cancelled : errors.failed));
      }
    } finally {
      if (controller.current === current) controller.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="modal-scrim">
      <section
        className="modal cache-manager"
        role="dialog"
        aria-modal="true"
        aria-label={t('磁盘缓存管理')}
      >
        <header>
          <div>
            <h2>{t('磁盘缓存管理')}</h2>
            <p>{t('按需统计，不在后台扫描权重')}</p>
          </div>
          <button className="icon-button" aria-label={t('关闭缓存管理')} onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="cache-manager-body">
          <p>
            {t(
              '仅管理应用自有缓存；文档、下载模型、内置权重和运行时文件不在清理范围。自定义缓存路径不在这里清理。',
            )}
          </p>
          {!bridge && <p>{t('浏览器预览只管理当前来源的浏览器副本；原生缓存请使用桌面应用。')}</p>}
          <div className="cache-manager-actions">
            <button disabled={busy} onClick={() => void run()}>
              <RefreshCw size={16} />
              {t('统计缓存')}
            </button>
            {busy && <button onClick={cancel}>{t('取消任务')}</button>}
          </div>
          {message && <p role="status">{message}</p>}
          {pending && (
            <div className="cache-confirm" role="alertdialog" aria-label={t('确认清理缓存')}>
              <strong>{t(labels[pending.id])}</strong>
              <p>
                {t(
                  '清理此类缓存？首次使用可能需要重新解包或编译。请先关闭旧版程序和手动启动的旧原生服务。',
                )}
              </p>
              <p>
                {t(
                  '更新后的原生进程和窗口会协同保护正在使用的缓存；其它进程仍在使用时会拒绝清理。',
                )}
              </p>
              <div className="row">
                <button className="danger" onClick={() => void run(pending)}>
                  {t('确认清理缓存')}
                </button>
                <button onClick={() => setPending(null)}>{t('取消')}</button>
              </div>
            </div>
          )}
          <div className="cache-list">
            {rows.map((row) => (
              <article className="cache-card" key={row.id} data-cache-id={row.id}>
                <div>
                  <h3>
                    <HardDrive size={16} />
                    {t(labels[row.id] ?? row.id)}
                  </h3>
                  <p>
                    {row.error ? (
                      t(errors[row.error] ?? errors.failed)
                    ) : (
                      <>
                        {t('{0} 个文件', row.files)} ·{' '}
                        {row.unknownBytes
                          ? t('至少 {0}，{1} 项大小未统计', size(row.bytes), row.unknownBytes)
                          : size(row.bytes)}
                      </>
                    )}
                  </p>
                  {!!row.preserved && <small>{t('保留 {0} 项其它数据', row.preserved)}</small>}
                  {!!row.links && <small>{t('目录包含链接或路径异常，已停止清理。')}</small>}
                </div>
                <button
                  disabled={busy || !!row.error || !!row.links || row.files === 0}
                  aria-label={t('清理 {0}', t(labels[row.id] ?? row.id))}
                  onClick={() => setPending(row)}
                >
                  <Trash2 size={16} />
                  {t('清理缓存')}
                </button>
              </article>
            ))}
          </div>
          <p>
            {t(
              '浏览器 OCR 仅删除识别语言文件，保留旧笔记；语音仅删除本应用两种声音副本。未知文件保留。',
            )}
          </p>
          <p>
            {t('统计只读取目录、文件大小及响应头，不读取模型权重内容；无法获得的大小会单独标记。')}
          </p>
        </div>
      </section>
    </div>
  );
}
