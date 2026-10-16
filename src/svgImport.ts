import type { TextBox } from './model';
const namespace = 'http://www.w3.org/2000/svg';
const elements = new Set(
  'svg g defs path rect circle ellipse line polyline polygon text tspan textPath linearGradient radialGradient stop clipPath mask marker pattern use title desc'.split(
    ' ',
  ),
);
const attributes = new Set(
  'id x y x1 y1 x2 y2 cx cy r rx ry dx dy d points width height viewBox preserveAspectRatio transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-miterlimit opacity font-family font-size font-weight font-style text-decoration text-anchor dominant-baseline alignment-baseline letter-spacing word-spacing textLength lengthAdjust offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr clip-path clip-rule mask maskUnits maskContentUnits marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient patternUnits patternContentUnits patternTransform color vector-effect'.split(
    ' ',
  ),
);
const styleProperties = new Set(
  'fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray opacity font-family font-size font-weight font-style text-decoration text-anchor dominant-baseline letter-spacing color white-space'.split(
    ' ',
  ),
);
export interface ImportedImage {
  data: string;
  displayData?: string;
  width: number;
  height: number;
  textBox?: TextBox;
}
export interface SafeSvg {
  dataURL: string;
  width: number;
  height: number;
}

export function svgCandidates(text: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi)) {
    if (match[0].length <= 400_000) values.push(match[0]);
    if (values.length === 3) break;
  }
  return values;
}
function safeValue(value: string) {
  if (
    value.length > 40_000 ||
    /[\\@<>]|(?:https?:|data:|javascript:|expression\s*\(|\/\/)/i.test(value)
  )
    return false;
  const stripped = value.replace(/url\(\s*['"]?#[\w.-]+['"]?\s*\)/gi, '');
  return !/url\s*\(/i.test(stripped);
}
/** Rebuild an inert SVG with presentation attributes and internal references only. */
export function sanitizeSvg(input: string): SafeSvg {
  if (input.length > 400_000 || /<!DOCTYPE|<!ENTITY/i.test(input)) throw Error('svg-invalid');
  const parsed = new DOMParser().parseFromString(input, 'image/svg+xml');
  const source = parsed.documentElement;
  if (
    source.localName !== 'svg' ||
    parsed.querySelector('parsererror') ||
    parsed.querySelectorAll('*').length > 4000
  )
    throw Error('svg-invalid');
  const output = document.implementation.createDocument(namespace, 'svg', null);
  const clean = (from: Element, to: Element) => {
    for (const attribute of Array.from(from.attributes)) {
      const key = attribute.name;
      const value = attribute.value;
      if (key === 'style') {
        const style = value
          .split(';')
          .flatMap((entry) => {
            const at = entry.indexOf(':');
            const name = entry.slice(0, at).trim().toLowerCase(),
              v = entry.slice(at + 1).trim();
            return at > 0 && styleProperties.has(name) && safeValue(v) ? [`${name}:${v}`] : [];
          })
          .join(';');
        if (style) to.setAttribute('style', style);
      } else if ((key === 'href' || key === 'xlink:href') && /^#[\w.-]{1,128}$/.test(value))
        to.setAttribute('href', value);
      else if (attributes.has(key) && safeValue(value)) to.setAttribute(key, value);
    }
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === 3) to.append(output.createTextNode(child.textContent || ''));
      else if (child.nodeType === 1) {
        const element = child as Element;
        if (
          !elements.has(element.localName) ||
          (element.namespaceURI && element.namespaceURI !== namespace)
        )
          continue;
        const next = output.createElementNS(namespace, element.localName);
        clean(element, next);
        to.append(next);
      }
    }
  };
  const root = output.documentElement;
  clean(source, root);
  const view = (root.getAttribute('viewBox') || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const validView =
    view.length === 4 &&
    view.every(Number.isFinite) &&
    view[2] > 0 &&
    view[3] > 0 &&
    view.every((n) => Math.abs(n) <= 100_000);
  const dimension = (name: string, fallback: number) => {
    const value = root.getAttribute(name) || '';
    const number = /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? parseFloat(value) : fallback;
    return Math.max(1, Math.min(8192, number));
  };
  const width = dimension('width', validView ? view[2] : 800),
    height = dimension('height', validView ? view[3] : 500);
  if (!validView) root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  const serialized = new XMLSerializer().serializeToString(root);
  const encoded = btoa(
    Array.from(new TextEncoder().encode(serialized), (b) => String.fromCharCode(b)).join(''),
  );
  return { dataURL: `data:image/svg+xml;base64,${encoded}`, width, height };
}
async function decode(url: string) {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw Error('image-invalid');
  return image;
}
async function png(image: HTMLImageElement, width: number, height: number, density: number) {
  const scale = Math.min(
    density,
    4096 / Math.max(width, height),
    Math.sqrt(6_000_000 / (width * height)),
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  try {
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(Error('image-invalid'))),
        'image/png',
      ),
    );
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(Error('image-invalid'));
      reader.readAsDataURL(blob);
    });
  } finally {
    canvas.width = canvas.height = 1;
  }
}
export async function svgImage(svg: SafeSvg): Promise<ImportedImage> {
  return {
    data: await png(await decode(svg.dataURL), svg.width, svg.height, 2),
    displayData: svg.dataURL,
    width: svg.width,
    height: svg.height,
  };
}
export function isImageFile(file: { name: string }) {
  return /\.(?:png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(file.name);
}
export async function imageFile(file: File): Promise<ImportedImage> {
  if (!isImageFile(file) || file.size > 32_000_000) throw Error('image-invalid');
  if (/\.svg$/i.test(file.name)) return svgImage(sanitizeSvg(await file.text()));
  const url = URL.createObjectURL(file);
  try {
    const image = await decode(url);
    return {
      data: await png(image, image.naturalWidth, image.naturalHeight, 1),
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
