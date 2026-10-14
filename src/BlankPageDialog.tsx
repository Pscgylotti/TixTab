import { useState } from 'react';
import { X } from 'lucide-react';
import type { Page } from './model';
import { loadBlankPaper, saveBlankPaper } from './blankPaper';
import { paperAppearance, paperChoices } from './paperAppearance';
import { useAppearance } from './appearance';
import { t, useLocale } from './i18n';
import './pageEditing.css';
import AnchoredPopover from './AnchoredPopover';
export default function BlankPageDialog({
  width,
  height,
  anchor,
  onClose,
  onInsert,
}: {
  width: number;
  height: number;
  anchor: DOMRect;
  onClose: () => void;
  onInsert: (paper: Page['paper'], color: string) => void;
}) {
  useLocale();
  const { pdfNight } = useAppearance();
  const [paper, setPaper] = useState(loadBlankPaper),
    [color, setColor] = useState(() => {
      try {
        const saved = localStorage.getItem('tixtab.blankPaperColor');
        return /^#[0-9a-f]{6}$/i.test(saved ?? '') ? saved! : '#ffffff';
      } catch {
        return '#ffffff';
      }
    });
  return (
    <AnchoredPopover
      anchor={anchor}
      label={t('插入空白页')}
      onClose={onClose}
      className="blank-page-dialog"
      width={310}
    >
      <header>
        <h2>{t('插入空白页')}</h2>
        <button aria-label={t('关闭')} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="editing-fields">
        <div className="paper-choice-grid" role="group" aria-label={t('纸张样式')}>
          {paperChoices.map((choice) => (
            <button
              key={choice.id}
              aria-pressed={paper === choice.id}
              onClick={() => setPaper(choice.id)}
            >
              <span
                className="paper-choice-preview"
                style={paperAppearance(
                  { paper: choice.id, paperColor: color, width: 160, height: 200 },
                  pdfNight,
                )}
              />
              {t(choice.label)}
            </button>
          ))}
        </div>
        <div className="paper-color-row">
          <label>
            {t('纸张颜色')}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <div className="paper-color-presets">
            {['#ffffff', '#fff7e6', '#eaf5ef', '#eaf1fb', '#f4eefa'].map((preset) => (
              <button
                key={preset}
                aria-label={t('纸张颜色 {0}', preset)}
                aria-pressed={color === preset}
                style={{ backgroundColor: preset }}
                onClick={() => setColor(preset)}
              />
            ))}
          </div>
        </div>
      </div>
      <footer>
        <button
          className="primary"
          onClick={() => {
            saveBlankPaper(paper);
            try {
              localStorage.setItem('tixtab.blankPaperColor', color);
            } catch {}
            onInsert(paper, color);
          }}
        >
          {t('插入页面')}
        </button>
      </footer>
    </AnchoredPopover>
  );
}
