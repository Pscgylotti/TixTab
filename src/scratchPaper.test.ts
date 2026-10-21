import { describe, it, expect } from 'vitest';
import { newNotebook, blankPage, validNotebook, type Stroke } from './model';
import {
  newScratchPaper,
  scratchPaperName,
  replaceEditablePage,
  splitScratchStroke,
  type ScratchPaper,
} from './scratchPaper';
import { decodeObjects, encodeObjects } from './objectClipboard';
import { encodeProject, decodeProject } from './storage';
import { setLocale } from './i18n';
const rect = (x: number, y: number, w: number, h: number) =>
  ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }) as DOMRect;
describe('independent scratch sheets', () => {
  it('localizes generated draft labels, preserves custom names and avoids name collisions', () => {
    const generated = newScratchPaper([]);
    try {
      setLocale('en');
      expect(scratchPaperName(generated)).toBe('Draft 1');
      expect(generated.name).toBe('草稿纸1');
      expect(scratchPaperName({ ...generated, name: '草稿纸2' })).toBe('Draft 2');
      const custom = { ...generated, customName: true };
      expect(scratchPaperName(custom)).toBe('草稿纸1');
      expect(scratchPaperName({ name: '我的计算' })).toBe('我的计算');
      expect(newScratchPaper([{ ...generated, name: 'Draft 1', customName: true }]).name).toBe(
        '草稿纸2',
      );
      const notebook = { ...newNotebook(), scratchPapers: [custom] };
      expect(decodeProject(encodeProject(notebook))).toEqual(notebook);
      expect(
        validNotebook({ ...notebook, scratchPapers: [{ ...custom, customName: 'bad' }] }),
      ).toBe(false);
    } finally {
      setLocale('zh-CN');
    }
    expect(scratchPaperName(generated)).toBe('草稿纸1');
  });
  it('limits to ten, chooses a free name, validates and preserves project data', () => {
    const papers: ScratchPaper[] = [];
    for (let i = 0; i < 10; i++) papers.push(newScratchPaper(papers));
    expect(papers.map((p) => p.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `草稿纸${i + 1}`),
    );
    expect(() => newScratchPaper(papers)).toThrow();
    const n = { ...newNotebook(), scratchPapers: papers, activeScratchId: papers[0].id };
    expect(validNotebook(n)).toBe(true);
    expect(decodeProject(encodeProject(n))).toEqual(n);
    expect(validNotebook({ ...n, scratchPapers: [null] })).toBe(false);
    expect(validNotebook({ ...n, activeScratchId: 'missing' })).toBe(false);
    expect(
      validNotebook({ ...n, scratchPapers: [{ ...papers[0], view: { x: NaN, y: 0, zoom: 1 } }] }),
    ).toBe(false);
    expect(
      validNotebook({
        ...n,
        scratchPapers: [{ ...papers[0], page: { ...papers[0].page, sourceIndex: 0 } }],
      }),
    ).toBe(false);
  });
  it('updates scratch without inserting it into exported PDF pages', () => {
    const n = newNotebook(),
      scratch = newScratchPaper([]),
      base = { ...n, scratchPapers: [scratch] };
    const p = { ...scratch.page, paperColor: '#123456' };
    const next = replaceEditablePage(base, p);
    expect(next.pages).toBe(base.pages);
    expect(next.scratchPapers![0].page).toBe(p);
    const changed = replaceEditablePage(next, { ...n.pages[0], paper: 'lines' });
    expect(changed.scratchPapers).toBe(next.scratchPapers);
    expect(changed.pages[0].paper).toBe('lines');
  });
  it('routes crossing strokes to PDF first, splits background runs, retains pressure and display width', () => {
    const pdf = blankPage(100, 100),
      scratch = blankPage(1000, 1000);
    const stroke: Stroke = {
      id: 's',
      tool: 'pen',
      color: '#112233',
      size: 2,
      points: [
        [0, 50, 0.2],
        [1000, 50, 0.8],
      ],
    };
    const parts = splitScratchStroke(scratch, stroke, rect(0, 0, 1000, 1000), [
      { page: pdf, rect: rect(400, 0, 200, 200) },
      { page: scratch, rect: rect(0, 0, 1000, 1000) },
    ]);
    expect(parts.get(scratch.id)).toHaveLength(2);
    expect(parts.get(pdf.id)).toHaveLength(1);
    expect(parts.get(pdf.id)![0].points[0].slice(0, 2)).toEqual([0, 25]);
    expect(parts.get(pdf.id)![0].points[0][2]).toBeCloseTo(0.44);
    expect(parts.get(pdf.id)![0].points.at(-1)![0]).toBe(100);
    expect(parts.get(pdf.id)![0].size).toBe(1);
    expect(parts.get(scratch.id)![1].points[0][0]).toBe(600);
  });
  it('blocks detached PDF objects, including groups, while ordinary objects remain portable', () => {
    const p = blankPage(),
      image = {
        id: 'a',
        kind: 'image' as const,
        data: 'data:image/png;base64,AA==',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      };
    p.images = [image];
    expect(decodeObjects(encodeObjects(p, ['a']))?.objects).toHaveLength(1);
    p.images = [{ ...image, scratchPage: true }];
    expect(() => encodeObjects(p, ['a'])).toThrow(/不能复制/);
    const forged = JSON.stringify({
      type: 'tixtab-objects',
      version: 1,
      pageId: p.id,
      objects: p.images,
    });
    expect(decodeObjects(forged)).toBeNull();
    p.images = [
      {
        ...image,
        group: {
          width: 100,
          height: 100,
          objects: [
            { ...image, scratchPage: true },
            { ...image, id: 'b' },
          ],
        },
      },
    ];
    expect(() => encodeObjects(p, ['a'])).toThrow();
  });
});
