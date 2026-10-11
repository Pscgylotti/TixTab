import { memo, useMemo, useState } from 'react';
import { sanitizeSvg, svgCandidates, svgImage, type ImportedImage } from './svgImport';
import { t, useLocale } from './i18n';

export default memo(function ChatSvgPreview({
  text,
  onInsert,
  onStatus,
}: {
  text: string;
  onInsert: (image: ImportedImage) => void;
  onStatus: (text: string) => void;
}) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const previews = useMemo(
    () =>
      svgCandidates(text).flatMap((value) => {
        try {
          return [sanitizeSvg(value)];
        } catch {
          return [];
        }
      }),
    [text],
  );
  return previews.map((svg, index) => (
    <div className="chat-svg-preview" key={index}>
      <img src={svg.dataURL} alt={t('生成的 SVG 预览')} />
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            onInsert(await svgImage(svg));
            onStatus(t('SVG 已插入当前页'));
          } catch {
            onStatus(t('SVG 无法导入，请重新生成简化的矢量图。'));
          } finally {
            setBusy(false);
          }
        }}
      >
        {t(busy ? '正在插入…' : '插入 SVG 到当前页')}
      </button>
    </div>
  ));
});
