import { useMemo } from 'react';
import type { Page } from './model';
import { cursorNote, scoreAnchors, scoreNoteAt, useScoreCursor } from './musicTransport';
import { t } from './i18n';
export default function MusicScoreLayer({ page }: { page: Page }) {
  const cursor = useScoreCursor(page.id),
    score = page.score;
  const anchors = useMemo(() => (score ? scoreAnchors(score) : []), [score]);
  if (!score || !cursor.seek) return null;
  const note = cursor.pageId === page.id ? cursorNote(score, cursor.beat, anchors) : undefined,
    system = note && score.systems[note.system],
    selected = cursor.pageId === page.id && score.notes.find((n) => n.id === cursor.selectedId);
  // Printed spacing is not proportional to duration. Hold at the current onset.
  const x = note ? (note.region.x + note.region.width / 2) * page.width : 0;
  return (
    <svg
      className="music-score-layer"
      data-score-page-id={page.id}
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
            const nearest = scoreNoteAt(score, x, y, anchors);
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
