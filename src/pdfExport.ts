import {
  PDFDocument,
  PDFPage,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFDict,
  PDFArray,
  PDFStream,
  PDFString,
  PDFHexString,
  PDFContentStream,
  rgb,
  degrees,
  type PDFObject,
} from 'pdf-lib';
import type { Notebook, Page } from './model';
import { finalInkPath } from './ink';
import { pageLayers } from './pageLayers';
import { groupLeaves } from './objectGroup';
import { t } from './i18n';
import { SignedPdfExportError, type PdfExportProgress } from './pdfExportProtocol';
import { paperStep } from './paperAppearance';
export { SignedPdfExportError } from './pdfExportProtocol';

const name = (value: string) => PDFName.of(value);
const text = (value: PDFObject | undefined) =>
  value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : undefined;
const resolve = (doc: PDFDocument, value: PDFObject | undefined) =>
  value ? doc.context.lookup(value) : undefined;

/** Maps our bottom-left drawing space to the original, unrotated PDF space.
 * The reading viewport uses the CropBox/MediaBox intersection, in UserUnit units. */
export function exportPageGeometry(page: PDFPage) {
  const rect = (r: { x: number; y: number; width: number; height: number }) => [
    Math.min(r.x, r.x + r.width),
    Math.min(r.y, r.y + r.height),
    Math.max(r.x, r.x + r.width),
    Math.max(r.y, r.y + r.height),
  ];
  const media = rect(page.getMediaBox()),
    crop = rect(page.getCropBox());
  let [x0, y0, x1, y1] = [
    Math.max(media[0], crop[0]),
    Math.max(media[1], crop[1]),
    Math.min(media[2], crop[2]),
    Math.min(media[3], crop[3]),
  ];
  if (x1 <= x0 || y1 <= y0) [x0, y0, x1, y1] = media;
  const rawUnit = page.node.lookupMaybe(name('UserUnit'), PDFNumber)?.asNumber() ?? 1,
    unit = Number.isFinite(rawUnit) && rawUnit > 0 ? rawUnit : 1,
    s = 1 / unit;
  const rawAngle = ((page.getRotation().angle % 360) + 360) % 360,
    angle = [0, 90, 180, 270].includes(rawAngle) ? rawAngle : 0;
  const matrix: Record<number, number[]> = {
    0: [s, 0, 0, s, x0, y0],
    90: [0, s, -s, 0, x1, y0],
    180: [-s, 0, 0, -s, x1, y1],
    270: [0, -s, s, 0, x0, y1],
  };
  return {
    width: (angle % 180 ? y1 - y0 : x1 - x0) * unit,
    height: (angle % 180 ? x1 - x0 : y1 - y0) * unit,
    rect: [x0, y0, x1, y1],
    matrix: matrix[angle] as [number, number, number, number, number, number],
  };
}

function visitDictionaries(doc: PDFDocument, visit: (dict: PDFDict) => void) {
  const stack: PDFObject[] = doc.context.enumerateIndirectObjects().map(([, value]) => value),
    seen = new Set<PDFObject>();
  while (stack.length) {
    const value = stack.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (value instanceof PDFDict) {
      visit(value);
      stack.push(...value.values());
    } else if (value instanceof PDFArray) stack.push(...value.asArray());
    else if (value instanceof PDFStream) stack.push(value.dict);
  }
}

function pruneFields(doc: PDFDocument, removedPages: Set<string>, removedWidgets: Set<PDFObject>) {
  const form = resolve(doc, doc.catalog.get(name('AcroForm')));
  if (!(form instanceof PDFDict)) return;
  const removed = new Set<PDFObject>(),
    seen = new Set<PDFObject>();
  const prune = (fields: PDFArray) => {
    if (seen.has(fields)) throw new Error(t('PDF 表单结构包含循环，无法安全导出。'));
    seen.add(fields);
    for (let i = fields.size() - 1; i >= 0; i--) {
      const raw = fields.get(i),
        field = resolve(doc, raw);
      if (!(field instanceof PDFDict)) continue;
      const page = field.get(name('P')),
        widget = text(field.get(name('Subtype'))) === 'Widget';
      let drop =
        widget &&
        (removedWidgets.has(field) ||
          (page instanceof PDFRef && removedPages.has(page.toString())));
      const kids = resolve(doc, field.get(name('Kids')));
      if (!drop && kids instanceof PDFArray && kids.size()) {
        prune(kids);
        drop = kids.size() === 0;
      }
      if (drop) {
        fields.remove(i);
        removed.add(field);
      }
    }
  };
  const fields = resolve(doc, form.get(name('Fields')));
  if (fields instanceof PDFArray) prune(fields);
  const order = resolve(doc, form.get(name('CO')));
  if (order instanceof PDFArray)
    for (let i = order.size() - 1; i >= 0; i--)
      if (removed.has(resolve(doc, order.get(i))!)) order.remove(i);
}

function reconcileNavigation(doc: PDFDocument, original: PDFPage[], kept: Set<string>) {
  const pages = new Set(original.map((page) => page.ref.toString())),
    destinations = new Map<string, PDFObject>();
  const names = resolve(doc, doc.catalog.get(name('Names'))),
    tree = names instanceof PDFDict ? resolve(doc, names.get(name('Dests'))) : undefined;
  const oldDests = resolve(doc, doc.catalog.get(name('Dests')));
  if (oldDests instanceof PDFDict)
    for (const [key, value] of oldDests.entries()) destinations.set(key.decodeText(), value);
  const seenTrees = new Set<PDFObject>();
  const collect = (node: PDFObject | undefined) => {
    if (!(node instanceof PDFDict) || seenTrees.has(node)) return;
    seenTrees.add(node);
    const pairs = resolve(doc, node.get(name('Names'))),
      kids = resolve(doc, node.get(name('Kids')));
    if (pairs instanceof PDFArray)
      for (let i = 0; i + 1 < pairs.size(); i += 2) {
        const key = text(resolve(doc, pairs.get(i)));
        if (key !== undefined) destinations.set(key, pairs.get(i + 1));
      }
    if (kids instanceof PDFArray) for (const child of kids.asArray()) collect(resolve(doc, child));
  };
  collect(tree);
  const valid = (raw: PDFObject | undefined, seen = new Set<string>()): boolean => {
    const value = resolve(doc, raw);
    if (value instanceof PDFArray && value.size()) {
      const target = value.get(0);
      if (target instanceof PDFRef)
        return !pages.has(target.toString()) || kept.has(target.toString());
      if (target instanceof PDFNumber) {
        const page = original[target.asNumber()];
        if (page) {
          if (!kept.has(page.ref.toString())) return false;
          value.set(0, page.ref);
        }
      }
      return true;
    }
    if (value instanceof PDFDict) return valid(value.get(name('D')), seen);
    const key = text(value);
    if (key === undefined || !destinations.has(key) || seen.has(key)) return true;
    seen.add(key);
    return valid(destinations.get(key), seen);
  };
  const invalidNames = new Set(
    [...destinations].filter(([, dest]) => !valid(dest)).map(([key]) => key),
  );
  if (oldDests instanceof PDFDict)
    for (const [key] of oldDests.entries())
      if (invalidNames.has(key.decodeText())) oldDests.delete(key);
  seenTrees.clear();
  const pruneTree = (node: PDFObject | undefined): PDFObject[] => {
    if (!(node instanceof PDFDict) || seenTrees.has(node)) return [];
    seenTrees.add(node);
    let limits: PDFObject[] = [];
    const pairs = resolve(doc, node.get(name('Names'))),
      kids = resolve(doc, node.get(name('Kids')));
    if (pairs instanceof PDFArray) {
      for (let i = pairs.size() - 2; i >= 0; i -= 2)
        if (invalidNames.has(text(resolve(doc, pairs.get(i))) ?? '')) {
          pairs.remove(i + 1);
          pairs.remove(i);
        }
      if (pairs.size()) limits = [pairs.get(0), pairs.get(pairs.size() - 2)];
    }
    if (kids instanceof PDFArray) {
      for (let i = kids.size() - 1; i >= 0; i--) {
        const bounds = pruneTree(resolve(doc, kids.get(i)));
        if (!bounds.length) kids.remove(i);
      }
      if (kids.size()) {
        const a = resolve(doc, kids.get(0)),
          b = resolve(doc, kids.get(kids.size() - 1));
        const first = a instanceof PDFDict ? resolve(doc, a.get(name('Limits'))) : null,
          last = b instanceof PDFDict ? resolve(doc, b.get(name('Limits'))) : null;
        if (first instanceof PDFArray && last instanceof PDFArray)
          limits = [first.get(0), last.get(1)];
      }
    }
    if (limits.length) node.set(name('Limits'), doc.context.obj(limits));
    else node.delete(name('Limits'));
    return limits;
  };
  pruneTree(tree);
  const invalidActions = new Set<PDFObject>(),
    removedLinks = new Set<PDFObject>();
  visitDictionaries(doc, (dict) => {
    const dest = dict.get(name('Dest'));
    if (dest && !valid(dest)) {
      dict.delete(name('Dest'));
      if (text(dict.get(name('Subtype'))) === 'Link') removedLinks.add(dict);
    }
    if (
      text(dict.get(name('S'))) === 'GoTo' &&
      dict.has(name('D')) &&
      !valid(dict.get(name('D')))
    ) {
      dict.delete(name('D'));
      invalidActions.add(dict);
    }
  });
  visitDictionaries(doc, (dict) => {
    for (const key of ['A', 'OpenAction']) {
      const action = resolve(doc, dict.get(name(key)));
      if (
        action &&
        (invalidActions.has(action) ||
          (key === 'OpenAction' && action instanceof PDFArray && !valid(action)))
      ) {
        dict.delete(name(key));
        if (text(dict.get(name('Subtype'))) === 'Link') removedLinks.add(dict);
      }
    }
    const actions = resolve(doc, dict.get(name('AA')));
    if (actions instanceof PDFDict)
      for (const [key, value] of actions.entries())
        if (invalidActions.has(resolve(doc, value)!)) actions.delete(key);
  });
  for (const page of doc.getPages()) {
    const annotations = page.node.Annots();
    if (annotations)
      for (let i = annotations.size() - 1; i >= 0; i--)
        if (removedLinks.has(resolve(doc, annotations.get(i))!)) annotations.remove(i);
  }
}

function reconcileLabels(doc: PDFDocument, sourceIndices: (number | null)[]) {
  const root = resolve(doc, doc.catalog.get(name('PageLabels')));
  if (!(root instanceof PDFDict)) return;
  const labels: { index: number; spec: PDFDict }[] = [],
    seen = new Set<PDFObject>(),
    stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    const nums = resolve(doc, node.get(name('Nums'))),
      kids = resolve(doc, node.get(name('Kids')));
    if (nums instanceof PDFArray)
      for (let i = 0; i + 1 < nums.size(); i += 2) {
        const index = resolve(doc, nums.get(i)),
          spec = resolve(doc, nums.get(i + 1));
        if (index instanceof PDFNumber && spec instanceof PDFDict)
          labels.push({ index: index.asNumber(), spec });
      }
    if (kids instanceof PDFArray)
      for (const raw of kids.asArray()) {
        const child = resolve(doc, raw);
        if (child instanceof PDFDict) stack.push(child);
      }
  }
  labels.sort((a, b) => a.index - b.index);
  const nums: PDFObject[] = [];
  sourceIndices.forEach((index, i) => {
    let low = 0,
      high = labels.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (index !== null && labels[mid].index <= index) low = mid + 1;
      else high = mid;
    }
    const label = index !== null ? labels[low - 1] : undefined,
      spec = label ? label.spec.clone(doc.context) : doc.context.obj({ S: 'D', St: i + 1 });
    if (label && spec.has(name('S'))) {
      const start = resolve(doc, spec.get(name('St')));
      spec.set(
        name('St'),
        PDFNumber.of((start instanceof PDFNumber ? start.asNumber() : 1) + index! - label.index),
      );
    }
    nums.push(PDFNumber.of(i), spec);
  });
  doc.catalog.set(name('PageLabels'), doc.context.obj({ Nums: nums }));
}

/** Remove unreachable serialized objects after deletions (including orphaned
 * page streams). Referenced document structures are retained. */
function collectGarbage(doc: PDFDocument) {
  const stack: PDFObject[] = Object.values(doc.context.trailerInfo).filter(
      (v): v is PDFObject => !!v,
    ),
    refs = new Set<string>(),
    seen = new Set<PDFObject>();
  while (stack.length) {
    const value = stack.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (value instanceof PDFRef) {
      refs.add(value.toString());
      const target = resolve(doc, value);
      if (target) stack.push(target);
    } else if (value instanceof PDFDict) stack.push(...value.values());
    else if (value instanceof PDFArray) stack.push(...value.asArray());
    else if (value instanceof PDFStream) stack.push(value.dict);
  }
  for (const [ref] of doc.context.enumerateIndirectObjects())
    if (!refs.has(ref.toString())) doc.context.delete(ref);
}

/** A final annotation appearance follows existing annotations in the PDF array.
 * Some viewers reorder widgets above all other annotations. The appearance resources are private and original page streams stay
 * untouched. One appearance per edited page avoids a PDF object per ink point. */
async function appendOverlay(
  doc: PDFDocument,
  page: PDFPage,
  p: Page,
  geometry: { rect: number[]; matrix: number[] },
) {
  const layer = PDFPage.create(doc);
  layer.setSize(p.width, p.height);
  for (const image of pageLayers(p).flatMap((i) => (i ? groupLeaves(i) : [i]))) {
    if (image) {
      const png = await doc.embedPng(image.data),
        turn = image.rotation ?? 0,
        displayWidth = turn % 180 ? image.height : image.width,
        displayHeight = turn % 180 ? image.width : image.height,
        scale = Math.min(displayWidth / png.width, displayHeight / png.height),
        width = png.width * scale,
        height = png.height * scale;
      layer.drawImage(png, {
        x:
          image.x +
          image.width / 2 -
          (Math.cos((-turn * Math.PI) / 180) * width - Math.sin((-turn * Math.PI) / 180) * height) /
            2,
        y:
          p.height -
          image.y -
          image.height / 2 -
          (Math.sin((-turn * Math.PI) / 180) * width + Math.cos((-turn * Math.PI) / 180) * height) /
            2,
        width,
        height,
        rotate: degrees(-turn),
      });
    } else {
      for (const stroke of p.strokes) {
        const hex = stroke.color.slice(1);
        layer.drawSvgPath(finalInkPath(stroke), {
          x: 0,
          y: p.height,
          color: rgb(
            parseInt(hex.slice(0, 2), 16) / 255,
            parseInt(hex.slice(2, 4), 16) / 255,
            parseInt(hex.slice(4, 6), 16) / 255,
          ),
          opacity: stroke.tool === 'highlighter' ? 0.28 : stroke.tool === 'pencil' ? 0.65 : 1,
        });
      }
    }
  }
  const contents = layer.node.Contents();
  if (!(contents instanceof PDFArray) || contents.size() !== 1)
    throw new Error(t('无法创建 PDF 标注外观。'));
  const ref = contents.get(0),
    appearance = doc.context.lookup(ref);
  if (!(appearance instanceof PDFContentStream)) throw new Error(t('无法创建 PDF 标注外观。'));
  const attributes = doc.context.obj({
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, p.width, p.height],
    Matrix: geometry.matrix,
    Resources: layer.node.Resources()!,
  });
  for (const [key, value] of attributes.entries()) appearance.dict.set(key, value);
  page.node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Stamp',
        Name: 'TixTab',
        Rect: geometry.rect,
        P: page.ref,
        F: 4,
        AP: { N: ref },
        T: PDFString.of('TixTab'),
      }),
    ),
  );
  // The temporary page is not attached to the page tree; only its appearance and
  // resources are retained by the annotation. Never serialize its dummy Parent.
  doc.context.delete(layer.ref);
}

export async function exportPdf(
  notebook: Notebook,
  options: {
    allowSignatureInvalidation?: boolean;
    onProgress?: (progress: PdfExportProgress) => void;
  } = {},
) {
  if (!notebook.pages.length) throw new Error(t('文档至少需要一页。'));
  options.onProgress?.({ stage: 'loading' });
  const output = notebook.source
      ? await PDFDocument.load(notebook.source, { updateMetadata: false })
      : await PDFDocument.create(),
    original = notebook.source ? output.getPages() : [];
  options.onProgress?.({ stage: 'structure' });
  const indices = notebook.pages.flatMap((page) =>
    page.sourceIndex === null ? [] : [page.sourceIndex],
  );
  if (indices.some((i) => !original[i])) throw new Error(t('工程引用了不存在的 PDF 页面。'));
  if (new Set(indices).size !== indices.length)
    throw new Error(t('工程重复引用源 PDF 页面，请分别导入后再导出。'));
  const geometries = notebook.pages.map((page) =>
    page.sourceIndex === null
      ? {
          width: page.width,
          height: page.height,
          rect: [0, 0, page.width, page.height],
          matrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
        }
      : exportPageGeometry(original[page.sourceIndex]),
  );
  if (
    geometries.some(
      (g, i) =>
        Math.abs(g.width - notebook.pages[i].width) > 0.01 ||
        Math.abs(g.height - notebook.pages[i].height) > 0.01,
    )
  )
    throw new Error(t('源 PDF 页面尺寸与工程不一致，无法安全导出。'));
  const reordered =
      notebook.pages.length !== original.length ||
      notebook.pages.some((page, i) => page.sourceIndex !== i),
    painted = notebook.pages.some(
      (page) => page.strokes.length || page.images.length || page.reviews?.length,
    );
  const bookmarked = notebook.bookmarks?.some((b) => notebook.pages.some((p) => p.id === b.pageId));
  if (notebook.source && !reordered && !painted && !bookmarked) return notebook.source.slice();
  let signed = false;
  visitDictionaries(output, (dict) => {
    if (dict.has(name('ByteRange')) && dict.has(name('Contents'))) signed = true;
  });
  if (signed && !options.allowSignatureInvalidation) throw new SignedPdfExportError();
  if (reordered && notebook.source) {
    const kept = new Set(indices.map((i) => original[i].ref.toString())),
      removedPages = new Set(
        original
          .filter((page) => !kept.has(page.ref.toString()))
          .map((page) => page.ref.toString()),
      ),
      removedWidgets = new Set<PDFObject>();
    for (const page of original) {
      if (kept.has(page.ref.toString()))
        for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
          const value = page.node.getInheritableAttribute(name(key));
          if (value) page.node.set(name(key), value);
        }
      else
        for (const value of page.node.Annots()?.asArray() ?? []) {
          const annotation = resolve(output, value);
          if (annotation) removedWidgets.add(annotation);
        }
    }
    for (let i = original.length - 1; i >= 0; i--) output.removePage(i);
    for (const page of notebook.pages)
      output.addPage(
        page.sourceIndex === null ? [page.width, page.height] : original[page.sourceIndex],
      );
    pruneFields(output, removedPages, removedWidgets);
    reconcileNavigation(output, original, kept);
    reconcileLabels(
      output,
      notebook.pages.map((page) => page.sourceIndex),
    );
  } else if (!notebook.source)
    for (const page of notebook.pages) output.addPage([page.width, page.height]);
  if (bookmarked) {
    let rootRef = output.catalog.get(name('Outlines')),
      root = resolve(output, rootRef);
    if (!(root instanceof PDFDict)) {
      root = output.context.obj({ Type: 'Outlines' });
      rootRef = output.context.register(root);
      output.catalog.set(name('Outlines'), rootRef);
    }
    const tree = root as PDFDict;
    let lastRef = tree.get(name('Last')),
      last = resolve(output, lastRef),
      added = 0;
    const pageIds = new Map(notebook.pages.map((p, i) => [p.id, i]));
    for (const bookmark of notebook.bookmarks ?? []) {
      const i = pageIds.get(bookmark.pageId);
      if (i === undefined) continue;
      const item = output.context.obj({
        Title: PDFHexString.fromText(bookmark.title),
        Parent: rootRef,
        Dest: [output.getPage(i).ref, name('Fit')],
      });
      const ref = output.context.register(item);
      if (last instanceof PDFDict && lastRef) {
        last.set(name('Next'), ref);
        item.set(name('Prev'), lastRef);
      } else tree.set(name('First'), ref);
      tree.set(name('Last'), ref);
      last = item;
      lastRef = ref;
      added++;
    }
    const old = resolve(output, tree.get(name('Count')));
    tree.set(
      name('Count'),
      PDFNumber.of(Math.max(0, old instanceof PDFNumber ? old.asNumber() : 0) + added),
    );
  }
  for (let i = 0; i < notebook.pages.length; i++) {
    const p = notebook.pages[i];
    if (p.sourceIndex === null) appendPaper(output, output.getPage(i), p);
    if (p.strokes.length || p.images.length)
      await appendOverlay(output, output.getPage(i), p, geometries[i]);
    for (const note of p.reviews ?? []) {
      const r = note.region,
        m = geometries[i].matrix;
      const points = [
        [r.x, p.height - r.y - r.height],
        [r.x + r.width, p.height - r.y],
      ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const rect = [
        Math.min(points[0][0], points[1][0]),
        Math.min(points[0][1], points[1][1]),
        Math.max(points[0][0], points[1][0]),
        Math.max(points[0][1], points[1][1]),
      ];
      const parent = output.context.register(
        output.context.obj({
          Type: 'Annot',
          Subtype: 'Square',
          Rect: rect,
          P: output.getPage(i).ref,
          F: 4,
          C: [0.75, 0.58, 0.18],
          BS: { W: 1.5, S: 'S' },
          Contents: PDFHexString.fromText(note.text),
          T: PDFString.of('TixTab'),
          NM: PDFString.of(note.id),
        }),
      );
      const w = rect[2] - rect[0],
        h = rect[3] - rect[1],
        inset = 0.75,
        radius = Math.min(5, Math.max(0, w / 2 - inset), Math.max(0, h / 2 - inset)),
        k = radius * 0.5522847498;
      const x = inset,
        y = inset,
        right = w - inset,
        top = h - inset;
      const path = `q 0.75 0.58 0.18 RG 1.5 w ${x + radius} ${y} m ${right - radius} ${y} l ${right - radius + k} ${y} ${right} ${y + radius - k} ${right} ${y + radius} c ${right} ${top - radius} l ${right} ${top - radius + k} ${right - radius + k} ${top} ${right - radius} ${top} c ${x + radius} ${top} l ${x + radius - k} ${top} ${x} ${top - radius + k} ${x} ${top - radius} c ${x} ${y + radius} l ${x} ${y + radius - k} ${x + radius - k} ${y} ${x + radius} ${y} c S Q`;
      const appearance = output.context.register(
        output.context.flateStream(path, {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, w, h],
          Resources: {},
        }),
      );
      output.context.lookup(parent, PDFDict).set(name('AP'), output.context.obj({ N: appearance }));
      const popup = output.context.register(
        output.context.obj({
          Type: 'Annot',
          Subtype: 'Popup',
          Rect: [rect[2] + 8, rect[1], rect[2] + 248, rect[1] + 180],
          Parent: parent,
          Open: false,
        }),
      );
      const annotation = output.context.lookup(parent, PDFDict);
      annotation.set(name('Popup'), popup);
      output.getPage(i).node.addAnnot(parent);
      output.getPage(i).node.addAnnot(popup);
    }
    options.onProgress?.({ stage: 'annotations', completed: i + 1, total: notebook.pages.length });
  }
  // New images must be registered before the reachability walk.
  options.onProgress?.({ stage: 'saving' });
  await output.flush();
  if (reordered && notebook.source) collectGarbage(output);
  return output.save({ updateFieldAppearances: false });
}
/** One tiling cell per page: fine grids/dots do not expand into thousands of paths. */
function appendPaper(doc: PDFDocument, page: PDFPage, p: Page) {
  const background = p.paperColor ?? '#ffffff',
    channels = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16) / 255);
  if (background.toLowerCase() !== '#ffffff')
    page.drawRectangle({
      x: 0,
      y: 0,
      width: p.width,
      height: p.height,
      color: rgb(channels[0], channels[1], channels[2]),
    });
  if (p.paper === 'plain') return;
  const step = paperStep(p.paper),
    line = [174 / 255, 189 / 255, 211 / 255].map((c, i) => c * 0.36 + channels[i] * 0.64).join(' '),
    mid = step / 2,
    r = 0.65,
    k = r * 0.5522847498;
  const path =
    p.paper === 'dots'
      ? `${line} rg ${mid + r} ${mid} m ${mid + r} ${mid + k} ${mid + k} ${mid + r} ${mid} ${mid + r} c ${mid - k} ${mid + r} ${mid - r} ${mid + k} ${mid - r} ${mid} c ${mid - r} ${mid - k} ${mid - k} ${mid - r} ${mid} ${mid - r} c ${mid + k} ${mid - r} ${mid + r} ${mid - k} ${mid + r} ${mid} c f`
      : `${line} RG .6 w 0 0 m ${step} 0 l ${p.paper === 'lines' ? '' : `0 0 m 0 ${step} l`} S`;
  const pattern = doc.context.register(
    doc.context.flateStream(path, {
      Type: 'Pattern',
      PatternType: 1,
      PaintType: 1,
      TilingType: 1,
      BBox: [0, 0, step, step],
      XStep: step,
      YStep: step,
      Matrix: [1, 0, 0, -1, 0, p.height],
      Resources: {},
    }),
  );
  let resources = page.node.Resources();
  if (!resources) {
    resources = doc.context.obj({});
    page.node.set(name('Resources'), resources);
  }
  let patterns = resources.lookupMaybe(name('Pattern'), PDFDict);
  if (!patterns) {
    patterns = doc.context.obj({});
    resources.set(name('Pattern'), patterns);
  }
  patterns.set(name('TixTabPaper'), pattern);
  page.node.addContentStream(
    doc.context.register(
      doc.context.flateStream(`q /Pattern cs /TixTabPaper scn 0 0 ${p.width} ${p.height} re f Q`),
    ),
  );
}
