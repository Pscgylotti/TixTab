import { describe, it, expect } from 'vitest';
import { placeSelectionFlyout, type ViewRect } from './selectionPlacement';
const view = { left: 0, top: 0, width: 1440, height: 960 };
const text = { left: 650, top: 400, width: 120, height: 24 };
const intersects = (a: ViewRect, b: ViewRect) =>
  a.left < b.left + b.width &&
  a.left + a.width > b.left &&
  a.top < b.top + b.height &&
  a.top + a.height > b.top;
describe('selection flyout placement', () => {
  it('prefers the roomier vertical side, aligns away from the hand and clears text and tip', () => {
    const positions = [];
    for (const hand of ['right', 'left'] as const) {
      const result = placeSelectionFlyout(
        view,
        { width: 340, height: 54 },
        text,
        { x: 710, y: 412 },
        hand,
        false,
      );
      expect(result.side).toBe('below');
      positions.push(result.left);
      expect(intersects(result, text)).toBe(false);
      expect(intersects(result, { left: 678, top: 380, width: 64, height: 64 })).toBe(false);
    }
    expect(positions[0]).toBeLessThan(positions[1]);
  });
  it('uses the larger vertical region even when both regions can fit the complete panel', () => {
    for (const height of [54, 260]) {
      for (const y of [280, 620]) {
        const paragraph = { left: 60, top: y, width: 1300, height: 24 };
        const result = placeSelectionFlyout(
          view,
          { width: 408, height },
          paragraph,
          { x: 710, y: y + 12 },
          'right',
          height > 54,
        );
        expect(result.side).toBe(y < 400 ? 'below' : 'above');
        expect(result.height).toBe(height);
        expect(intersects(result, paragraph)).toBe(false);
      }
    }
  });
  it('compares unobstructed height rather than raw viewport space when a keyboard is present', () => {
    const anchor = { left: 200, top: 330, width: 1050, height: 24 };
    const keyboard = { left: 0, top: 520, width: 1440, height: 400 };
    const result = placeSelectionFlyout(
      view,
      { width: 408, height: 54 },
      anchor,
      { x: 700, y: 342 },
      'right',
      false,
      [keyboard],
    );
    expect(result.side).toBe('above');
    expect(intersects(result, keyboard)).toBe(false);
  });
  it('uses free space above/below a wide paragraph and limits a tall panel', () => {
    const paragraph = { left: 150, top: 620, width: 1150, height: 90 };
    const result = placeSelectionFlyout(
      view,
      { width: 408, height: 1400 },
      paragraph,
      { x: 400, y: 700 },
      'right',
      true,
    );
    expect(result.side).toBe('above');
    expect(result.maxHeight).toBeLessThan(600);
    expect(intersects(result, paragraph)).toBe(false);
  });
  it('keeps panels within portrait, zoomed and very short viewports', () => {
    for (const viewport of [
      { left: 0, top: 0, width: 560, height: 600 },
      { left: 170, top: 280, width: 320, height: 240 },
      { left: 0, top: 0, width: 70, height: 30 },
    ]) {
      for (const anchor of [text, { left: -100, top: -300, width: 1500, height: 2000 }]) {
        const result = placeSelectionFlyout(
          viewport,
          { width: 408, height: 1200 },
          anchor,
          { x: anchor.left, y: anchor.top },
          'left',
          true,
        );
        expect(result.left).toBeGreaterThanOrEqual(viewport.left);
        expect(result.top).toBeGreaterThanOrEqual(viewport.top);
        expect(result.left + result.width).toBeLessThanOrEqual(viewport.left + viewport.width);
        expect(result.top + result.height).toBeLessThanOrEqual(viewport.top + viewport.height);
      }
    }
  });
  it('keeps a scrollable panel clear of text when docks leave only a narrow vertical slot', () => {
    const viewport = { left: 16, top: 233, width: 736, height: 333 };
    const anchor = { left: 369, top: 322, width: 26, height: 7 };
    const result = placeSelectionFlyout(
      viewport,
      { width: 408, height: 900 },
      anchor,
      { x: 380, y: 325 },
      'right',
      true,
      [
        { left: 28, top: 480, width: 284, height: 60 },
        { left: 319, top: 438, width: 130, height: 40 },
      ],
    );
    expect(result.side).toBe('below');
    expect(result.height).toBeLessThan(100);
    expect(intersects(result, anchor)).toBe(false);
  });
  it('moves away from a floating keyboard when non-overlapping space exists', () => {
    const keyboard = { left: 20, top: 580, width: 480, height: 300 };
    const result = placeSelectionFlyout(
      view,
      { width: 408, height: 700 },
      text,
      { x: 710, y: 420 },
      'right',
      true,
      [keyboard],
    );
    expect(intersects(result, keyboard)).toBe(false);
    expect(intersects(result, text)).toBe(false);
  });
});
