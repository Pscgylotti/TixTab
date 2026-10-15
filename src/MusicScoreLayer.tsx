import { useMemo } from 'react';
import type { Page } from './model';
import { cursorNote, useScoreCursor } from './musicTransport';
import { t } from './i18n';
export default function MusicScoreLayer({ page }: { page: Page }) {
  const cursor = useScoreCursor(page.id),
    score = page.score;
  const rows = useMemo(() => {
    const seen = new Set<string>(),
      groups = (score?.systems ?? []).map(() => [] as NonNullable<typeof score>['notes']);
    for (const n of score?.notes ?? [])
      if (!seen.has(n.sourceId)) {
        seen.add(n.sourceId);
        groups[n.system]?.push(n);
      }
    return groups;
  }, [score]);
  if (!score || !cursor.seek) return null;
  const note = cursor.pageId === page.id ? cursorNote(score, cursor.beat) : undefined,
    system = note && score.systems[note.system],
    selected = cursor.pageId === page.id && score.notes.find((n) => n.id === cursor.selectedId);
  const next = note && score.notes.find((n) => n.system === note.system && n.beat > note.beat),
    f = next ? Math.max(0, Math.min(1, (cursor.beat - note!.beat) / (next.beat - note!.beat))) : 0;
  const x = note
    ? ((note.region.x + note.region.width / 2) * (1 - f) +
        (next ? next.region.x + next.region.width / 2 : 0) * f) *
      page.width
    : 0;
  return (
    <svg
      className="music-score-layer"
      viewBox={`0 0 ${page.width} ${page.height}`}
      aria-label={t('谱面定位')}
    >
      {score.systems.map((r, i) => (
        <rect
          key={i}
          x={r.x * page.width}
          y={r.y * page.height}
          width={r.width * page.width}
          height={r.height * page.height}
          fill="transparent"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const b = e.currentTarget.ownerSVGElement!.getBoundingClientRect(),
              x = (e.clientX - b.left) / b.width,
              y = (e.clientY - b.top) / b.height;
            const nearest = rows[i].reduce<typeof note>((best, n) => {
              const distance = (n.region.x - x) ** 2 + (n.region.y - y) ** 2 * 0.2;
              const old = best
                ? (best.region.x - x) ** 2 + (best.region.y - y) ** 2 * 0.2
                : Infinity;
              return distance < old ? n : best;
            }, undefined);
            if (nearest) cursor.seek!(page.id, nearest.beat, nearest.id);
          }}
          onPointerUp={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
        />
      ))}
      {selected && (
        <rect
          className="music-selected-note"
          x={selected.region.x * page.width}
          y={selected.region.y * page.height}
          width={selected.region.width * page.width}
          height={selected.region.height * page.height}
          fill="#4775db55"
          style={{ pointerEvents: 'none' }}
        />
      )}
      {system && (
        <line
          x1={x}
          x2={x}
          y1={system.y * page.height}
          y2={(system.y + system.height) * page.height}
          stroke="#e46d65"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
