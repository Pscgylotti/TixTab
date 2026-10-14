export type DocumentTab = { id: string; name: string };
export type CloseTabsMode = 'current' | 'others' | 'right';
export function tabsToClose(tabs: readonly DocumentTab[], id: string, mode: CloseTabsMode) {
  const at = tabs.findIndex((tab) => tab.id === id);
  if (at < 0) return [];
  return tabs
    .filter((tab, i) =>
      mode === 'current' ? tab.id === id : mode === 'others' ? tab.id !== id : i > at,
    )
    .map((tab) => tab.id);
}
/** The drop slot is a gap before/after a tab, not a tab to swap with. */
export function reorderDocumentTab(tabs: DocumentTab[], id: string, slot: number) {
  const from = tabs.findIndex((tab) => tab.id === id);
  if (from < 0 || !Number.isFinite(slot)) return tabs;
  const gap = Math.max(0, Math.min(tabs.length, Math.floor(slot))),
    to = gap > from ? gap - 1 : gap;
  if (from === to) return tabs;
  const next = [...tabs],
    [tab] = next.splice(from, 1);
  next.splice(to, 0, tab);
  return next;
}
