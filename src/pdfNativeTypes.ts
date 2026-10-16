export interface NativePdfElement {
  id: string;
  kind: 'text' | 'image';
  rect: [number, number, number, number];
  text?: string;
  font?: string;
  fontSize?: number;
  color?: string;
  blocked?: string;
}
export interface NativePdfEdit {
  element: NativePdfElement;
  rect: [number, number, number, number];
  text?: string;
  fontSize?: number;
  color?: string;
  replacement?: string;
  delete?: boolean;
}
export function validNativeEdits(value: unknown): value is NativePdfEdit[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every(
      (e) =>
        e &&
        e.element &&
        typeof e.element.id === 'string' &&
        ['text', 'image'].includes(e.element.kind) &&
        Array.isArray(e.rect) &&
        e.rect.length === 4 &&
        e.rect.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) &&
        (e.text === undefined || (typeof e.text === 'string' && e.text.length <= 10000)) &&
        (e.fontSize === undefined ||
          (Number.isFinite(e.fontSize) && e.fontSize >= 1 && e.fontSize <= 300)) &&
        (e.color === undefined || /^#[0-9a-f]{6}$/i.test(e.color)) &&
        (e.replacement === undefined ||
          (typeof e.replacement === 'string' &&
            e.replacement.startsWith('data:image/png;base64,') &&
            e.replacement.length <= 48 * 1024 * 1024)) &&
        (e.delete === undefined || typeof e.delete === 'boolean'),
    )
  );
}
export type NativePdfRequest =
  | {
      id: string;
      action: 'inspect' | 'edit';
      source: Uint8Array;
      page: number;
      elementId?: string;
      rect?: number[];
      text?: string;
      fontSize?: number;
      color?: string;
      delete?: boolean;
      replacement?: string;
      overflow?: boolean;
    }
  | {
      id: string;
      action: 'batch' | 'preview';
      source: Uint8Array;
      page: number;
      scale?: number;
      maxPixels?: number;
      edits: {
        page: number;
        elementId: string;
        rect: number[];
        text?: string;
        fontSize?: number;
        color?: string;
        replacement?: string;
        delete?: boolean;
        overflow?: boolean;
      }[];
    }
  | { id: string; action: 'cancel' };
export type NativePdfReply = {
  ok: boolean;
  error?: string;
  data?: {
    elements?: NativePdfElement[];
    source?: Uint8Array;
    warning?: string;
    width?: number;
    height?: number;
    preview?: string;
    polygons?: number[][];
  };
};
export type PdfEditorBridge = { run: (request: NativePdfRequest) => Promise<NativePdfReply> };
export const pdfEditErrors: Record<string, string> = {
  'pending-pdf-edits': '请先应用或放弃暂存的 PDF 元素编辑，再旋转或裁剪页面。',
  'runtime-missing': '请先安装 PDF 编辑运行时。',
  'pdf-edit': '无法编辑此 PDF，请重试或选择其它元素。',
  'pdf-permissions': '此 PDF 已加密或禁止修改，请使用允许编辑的副本。',
  'signed-edit': '此 PDF 含数字签名，请先创建明确移除签名的副本再编辑。',
  'overlapping-elements': '此元素与其它同类元素重叠，暂时无法单独安全编辑。',
  'pending-redactions': '此页含未应用的涂黑批注，请先在原编辑器处理后再编辑。',
  'complex-image': '此图片包含旋转、裁剪或复杂变换，暂时无法安全编辑。',
  'rotated-text': '暂不支持编辑斜向或竖排文本。',
  'element-stale': 'PDF 内容已改变，请重新选择元素。',
  'text-does-not-fit': '文本超出所选框，请增大宽高或减小字号。',
  'unsupported-glyph': '替换字体不支持部分字符，请调整文本。',
  'invalid-rect': '编辑区域必须完整位于页面内。',
  'invalid-text': '请输入有效文本。',
  'invalid-font': '请输入 1–300 的字号。',
  'invalid-color': '请选择有效颜色。',
  'invalid-image': '请使用有效的 PNG 图片。',
  'image-size': '图片超过 3200 万像素，请先缩小。',
  'element-limit': '此页元素过多，暂时无法编辑。',
  'pdf-size': '编辑后的 PDF 超出 512 MB 限制。',
  busy: '上一项 PDF 编辑尚未结束，请稍后重试。',
  cancelled: '已取消',
  'crop-range': '裁剪后至少需要保留每个方向 5% 的页面。',
  'shared-page': '源页面被重复引用，请先使用复制页面创建独立副本。',
  'page-range': '请输入有效的页码范围。',
  'invalid-transform': '此变换会使对象消失，请调整后重试。',
  'invalid-stroke': '线宽必须在 0–1000 之间。',
  'pdf-object-memory': '此页对象过大，暂时无法编辑。',
};
