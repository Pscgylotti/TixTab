import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { t } from './i18n';
import { DEFAULT_UI_SCALE, setUiScale, uiScaleAvailable, useUiScale } from './uiScale';

export default function UiScaleSettings() {
  const scale = useUiScale(),
    [draft, setDraft] = useState(scale),
    available = uiScaleAvailable();
  useEffect(() => setDraft(scale), [scale]);
  const commit = (value: number) => {
    if (!setUiScale(value)) setDraft(scale);
  };
  return (
    <div className="ui-scale-setting">
      <label htmlFor="ui-scale">{t('界面放大倍率')}</label>
      <div className="ui-scale-controls">
        <input
          id="ui-scale"
          aria-label={t('界面放大倍率')}
          type="range"
          min="0.5"
          max="4"
          step="0.1"
          disabled={!available}
          value={draft}
          onChange={(event) => setDraft(Number(event.target.value))}
          onPointerUp={(event) => commit(Number(event.currentTarget.value))}
          onKeyUp={(event) => commit(Number(event.currentTarget.value))}
          onBlur={(event) => commit(Number(event.currentTarget.value))}
        />
        <output htmlFor="ui-scale">{draft.toFixed(1)}</output>
        <button
          className="icon-button"
          aria-label={t('恢复默认界面倍率')}
          title={t('恢复默认界面倍率')}
          disabled={!available}
          onClick={() => commit(DEFAULT_UI_SCALE)}
        >
          <RotateCcw size={16} />
        </button>
      </div>
      <p className="appearance-note">
        {t(
          available ? '2.0 为当前默认大小；松开滑条后应用。' : '整体界面缩放仅在桌面客户端中可用。',
        )}
      </p>
    </div>
  );
}
