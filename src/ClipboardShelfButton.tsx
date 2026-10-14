import { useCallback, useEffect, useState } from 'react';
import {
  ClipboardList,
  ClipboardPaste,
  FileText,
  Image,
  PenLine,
  Shapes,
  Pause,
  Play,
  Trash2,
  X,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import AnchoredPopover from './AnchoredPopover';
import {
  browserShelf,
  pasteClipboardEntry,
  readCurrentClipboard,
  type ClipboardSnapshot,
} from './clipboardShelf';
import { t as tr } from './i18n';
import './clipboardShelf.css';
export default function ClipboardShelfButton({
  compact,
  disabled,
  onError,
}: {
  compact: boolean;
  disabled: boolean;
  onError: (text: string) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const [snapshot, setSnapshot] = useState<ClipboardSnapshot>({
    entries: [],
    bytes: 0,
    total: 0,
    limit: 128 * 1024 * 1024,
    offset: 0,
    paused: false,
  });
  const [pasting, setPasting] = useState(false);
  const [offset, setOffset] = useState(0);
  const bridge = window.surfaceDesktop?.clipboardShelf || browserShelf;
  useEffect(() => {
    if (!anchor) {
      setSnapshot((value) => ({ ...value, entries: [] }));
      return;
    }
    let alive = true;
    const refresh = () => {
      void bridge
        .run('list', offset)
        .then((value) => {
          if (alive && value) setSnapshot(value);
        })
        .catch(() => {});
    };
    refresh();
    const unsubscribe = bridge.onChanged(refresh);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [anchor, bridge, offset]);
  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);
  return (
    <>
      <button
        className="icon-button clipboard-shelf-toggle"
        title={tr('剪贴板历史')}
        aria-label={tr('剪贴板历史')}
        aria-expanded={!!anchor}
        disabled={disabled}
        onClick={(event) => {
          if (anchor) close();
          else {
            setAnchor(event.currentTarget.getBoundingClientRect());
            setOffset(0);
            void readCurrentClipboard();
          }
        }}
      >
        <ClipboardList size={compact ? 16 : 19} />
      </button>
      {anchor && (
        <AnchoredPopover
          anchor={anchor}
          label={tr('剪贴板历史')}
          onClose={close}
          width={350}
          className="clipboard-shelf"
        >
          <header>
            <strong>
              <ClipboardList size={17} />
              {tr('剪贴板历史')}
            </strong>
            <div className="row">
              <button
                className="icon-button"
                aria-label={snapshot.paused ? tr('继续记录') : tr('暂停记录')}
                title={snapshot.paused ? tr('继续记录') : tr('暂停记录')}
                onClick={async () => {
                  await bridge.run('pause', !snapshot.paused);
                }}
              >
                {snapshot.paused ? <Play size={16} /> : <Pause size={16} />}
              </button>
              <button
                className="icon-button"
                aria-label={tr('清空剪贴板历史')}
                title={tr('清空剪贴板历史')}
                disabled={!snapshot.total}
                onClick={async () => {
                  await bridge.run('clear');
                  setOffset(0);
                }}
              >
                <Trash2 size={16} />
              </button>
              <button className="icon-button" aria-label={tr('关闭')} onClick={close}>
                <X size={17} />
              </button>
            </div>
          </header>
          <div className="clipboard-shelf-list" aria-label={tr('剪贴板条目')}>
            {!snapshot.entries.length && (
              <p className="clipboard-shelf-empty">
                {tr('暂无记录，复制文本、图片或对象后会显示在这里。')}
              </p>
            )}
            {snapshot.entries.map((entry) => {
              const Icon =
                entry.kind === 'objects'
                  ? Shapes
                  : entry.kind === 'ink'
                    ? PenLine
                    : entry.kind === 'image'
                      ? Image
                      : FileText;
              const label =
                entry.kind === 'objects'
                  ? tr('{0} 个对象', entry.count)
                  : entry.kind === 'ink'
                    ? tr('{0} 条笔迹', entry.count)
                    : entry.kind === 'image'
                      ? tr('图片')
                      : tr('文本');
              return (
                <div className="clipboard-shelf-row" key={entry.id}>
                  <button
                    className="clipboard-shelf-item"
                    title={entry.text || label}
                    aria-label={tr(
                      '粘贴：{0}',
                      entry.kind === 'text' ? entry.text.slice(0, 80) : label,
                    )}
                    disabled={pasting}
                    onClick={async () => {
                      setPasting(true);
                      try {
                        const payload = await bridge.run('get', entry.id);
                        if (!payload) throw Error('expired');
                        await pasteClipboardEntry(payload);
                        close();
                      } catch {
                        onError(tr('无法粘贴此条目，请重新复制。'));
                      } finally {
                        setPasting(false);
                      }
                    }}
                  >
                    <span
                      className={`clipboard-shelf-preview ${entry.kind === 'text' ? 'text-preview' : ''}`}
                    >
                      {entry.preview ? (
                        <img src={entry.preview} alt="" loading="lazy" decoding="async" />
                      ) : entry.kind === 'text' ? (
                        <span>{entry.text.slice(0, 110)}</span>
                      ) : (
                        <Icon size={24} />
                      )}
                    </span>
                    <span className="clipboard-shelf-description">
                      <small>
                        <Icon size={13} />
                        {label}
                        {entry.width ? ` · ${entry.width} × ${entry.height}` : ''}
                      </small>
                      <span>
                        {entry.kind === 'ink'
                          ? tr('可编辑笔迹')
                          : entry.text || tr('点击粘贴到当前页')}
                      </span>
                    </span>
                    <ClipboardPaste className="clipboard-shelf-paste" size={15} />
                  </button>
                  <button
                    className="clipboard-shelf-remove icon-button"
                    title={tr('移除此记录')}
                    aria-label={tr('移除此记录')}
                    disabled={pasting}
                    onClick={async () => {
                      await bridge.run('remove', entry.id);
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>
          {snapshot.total > 40 && (
            <div className="clipboard-shelf-pages">
              <button
                aria-label={tr('上一组剪贴板')}
                disabled={!snapshot.offset}
                onClick={() => setOffset(Math.max(0, snapshot.offset - 40))}
              >
                <ChevronLeft size={15} />
              </button>
              <span>
                {snapshot.offset + 1}–{Math.min(snapshot.offset + 40, snapshot.total)} /{' '}
                {snapshot.total}
              </span>
              <button
                aria-label={tr('下一组剪贴板')}
                disabled={snapshot.offset + 40 >= snapshot.total}
                onClick={() => setOffset(snapshot.offset + 40)}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          )}
          <footer>
            <span>
              {snapshot.paused ? tr('已暂停记录') : tr('仅记录运行期间 · 退出后清空')}
              <small>
                {tr('{0} 条记录', snapshot.total)} · {(snapshot.bytes / 1024 / 1024).toFixed(1)} /{' '}
                {snapshot.limit / 1024 / 1024} MB
              </small>
            </span>
            {window.surfaceDesktop?.openClipboardHistory && (
              <button
                title={tr('剪贴板历史（Win+V）')}
                onClick={() => {
                  close();
                  void window.surfaceDesktop?.openClipboardHistory?.();
                }}
              >
                Win+V
              </button>
            )}
          </footer>
        </AnchoredPopover>
      )}
    </>
  );
}
