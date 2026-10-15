import { t } from './i18n';
import { nativeCppVariant } from './nativeCppOcr';
import { useEffect, useState } from 'react';
export default function NativeCppOcrSettings({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [npu, setNpu] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.surfaceDesktop?.nativeOcr
      ?.run({ action: 'status' })
      .then((value) => {
        if (alive) setNpu(!!value.npuAvailable);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div>
      <label>
        {t('模型')}
        <select
          aria-label={t('原生 Tesseract 模型')}
          value={nativeCppVariant(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="mixed-fast">{t('简体中文 + English · Fast')}</option>
          <option value="fast">English · Fast</option>
          <option value="best">English · Best</option>
          <option value="mixed-best">{t('简体中文 + English · Best')}</option>
          {(npu || value.startsWith('npu-')) && (
            <>
              <option value="npu-fast" disabled={!npu}>
                English · Fast · NPU · {t('实验性')}
              </option>
              <option value="npu-best" disabled={!npu}>
                English · Best · NPU · {t('实验性')}
              </option>
            </>
          )}
        </select>
      </label>
      {value.startsWith('npu-') && (
        <p className="muted">
          {t(
            '实验性原生 NPU：仅英文、单行推理、无 CPU 识别回退；使用近似预处理与贪心解码，可能漏字或漏空格。',
          )}
        </p>
      )}
    </div>
  );
}
