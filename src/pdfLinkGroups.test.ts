import { expect, it } from 'vitest';
import { groupPageLinks } from './pdfLinkGroups';
it('highlights adjacent wrapped fragments as one URL without merging distant repeated links', () => {
  const links = groupPageLinks([
    { url: 'https://example.org/long', rect: { x: 200, y: 100, width: 200, height: 12 } },
    { url: 'https://example.org/long', rect: { x: 40, y: 115, width: 180, height: 12 } },
    { url: 'https://example.org/long', rect: { x: 40, y: 300, width: 180, height: 12 } },
  ]);
  expect(links[0].group).toBe(links[1].group);
  expect(links[2].group).not.toBe(links[0].group);
});
it('keeps explicit quadrilateral fragments and different destinations independent', () => {
  const links = groupPageLinks([
    { dest: 'a', group: 'quad', rect: { x: 0, y: 0, width: 100, height: 12 } },
    { dest: 'a', group: 'quad', rect: { x: 0, y: 40, width: 100, height: 12 } },
    { dest: 'b', rect: { x: 0, y: 55, width: 100, height: 12 } },
  ]);
  expect(links[0].group).toBe('quad');
  expect(links[1].group).toBe('quad');
  expect(links[2].group).not.toBe('quad');
});
