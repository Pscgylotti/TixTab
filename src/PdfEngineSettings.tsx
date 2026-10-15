import { useAppearance, setPdfRenderBackend, type PdfRenderBackend } from './appearance';
import { t as tr } from './i18n';
export default function PdfEngineSettings() {
  const { pdfRenderBackend } = useAppearance();
  return (
    <>
      <label className="appearance-setting">
        {tr('PDF 渲染引擎')}
        <select
          aria-label={tr('PDF 渲染引擎')}
          value={pdfRenderBackend}
          onChange={(event) => setPdfRenderBackend(event.target.value as PdfRenderBackend)}
        >
          <option value="pdfjs">PDF.js</option>
          <option value="pdfium">{tr('PDFium WASM（实验）')}</option>
        </select>
      </label>
      <p className="appearance-note">
        {tr('切换后重新渲染页面。实验引擎尚未保证更低的内存占用。')}
      </p>
    </>
  );
}
