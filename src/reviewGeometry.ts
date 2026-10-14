type Rect = { x: number; y: number; width: number; height: number };
export function reviewConnector(region: Rect, card: { x: number; y: number; width: number }) {
  const left = card.x + card.width / 2 < region.x + region.width / 2;
  return {
    x1: left ? region.x : region.x + region.width,
    y1: region.y + region.height / 2,
    x2: left ? card.x + card.width : card.x,
    y2: card.y + 25,
  };
}
