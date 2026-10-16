import { expect, it } from 'vitest';
import { newNotebook, type PlacedImage } from './model';
import { mergeBackgroundPages } from './backgroundPageResults';
it('applies a correction without overwriting concurrent moves, new objects or handwriting', () => {
  const notebook = newNotebook();
  const image: PlacedImage = {
    id: 'image',
    kind: 'image',
    data: 'old',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  };
  const base = { ...notebook.pages[0], images: [image] };
  const result = {
    ...base,
    images: [{ ...image, data: 'corrected', correction: { model: 'UVDoc' } }],
  };
  const pasted = { ...image, id: 'new' };
  const page = {
    ...base,
    images: [{ ...image, x: 200, width: 80 }, pasted],
    strokes: [
      {
        id: 'ink',
        tool: 'pen' as const,
        size: 1,
        color: '#000000',
        points: [[0, 0, 0.5] as [number, number, number]],
      },
    ],
  };
  const next = mergeBackgroundPages({ ...notebook, pages: [page] }, [result], false, [base]);
  expect(next.pages[0].images).toEqual([{ ...result.images[0], x: 200, width: 80 }, pasted]);
  expect(next.pages[0].strokes).toBe(page.strokes);
});
it('does not resurrect a deleted image or overwrite newly edited image pixels', () => {
  const notebook = newNotebook();
  const image: PlacedImage = {
    id: 'image',
    kind: 'image',
    data: 'old',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  };
  const base = { ...notebook.pages[0], images: [image] };
  const result = { ...base, images: [{ ...image, data: 'corrected' }] };
  const edited = { ...base, images: [{ ...image, data: 'user-edited' }] };
  expect(
    mergeBackgroundPages({ ...notebook, pages: [edited] }, [result], false, [base]).pages[0]
      .images[0].data,
  ).toBe('user-edited');
  expect(
    mergeBackgroundPages({ ...notebook, pages: [{ ...base, images: [] }] }, [result], false, [base])
      .pages[0].images,
  ).toEqual([]);
});
