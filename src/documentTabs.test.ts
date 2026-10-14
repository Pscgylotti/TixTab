import { describe, it, expect } from 'vitest';
import { reorderDocumentTab, tabsToClose } from './tabOperations';
const tabs = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id }));
describe('document tab operations', () => {
  it('inserts at a gap in both directions without mutating the original', () => {
    expect(reorderDocumentTab(tabs, 'a', 3).map((t) => t.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderDocumentTab(tabs, 'd', 1).map((t) => t.id)).toEqual(['a', 'd', 'b', 'c']);
    expect(tabs.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(reorderDocumentTab(tabs, 'a', 99).at(-1)?.id).toBe('a');
  });
  it('ignores adjacent gaps, missing ids and invalid slots', () => {
    for (const slot of [1, 2, NaN]) expect(reorderDocumentTab(tabs, 'b', slot)).toBe(tabs);
    expect(reorderDocumentTab(tabs, 'missing', 0)).toBe(tabs);
  });
  it('closes relative to current order and leaves workspace contents alone', () => {
    expect(tabsToClose(tabs, 'b', 'current')).toEqual(['b']);
    expect(tabsToClose(tabs, 'b', 'others')).toEqual(['a', 'c', 'd']);
    expect(tabsToClose(tabs, 'b', 'right')).toEqual(['c', 'd']);
    expect(tabsToClose(tabs, 'd', 'right')).toEqual([]);
    expect(tabsToClose(tabs, 'missing', 'others')).toEqual([]);
  });
});
