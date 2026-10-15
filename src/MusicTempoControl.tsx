import { useEffect, useRef } from 'react';
import { t } from './i18n';

export default function MusicTempoControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (bpm: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  useEffect(() => {
    const slider = input.current!;
    const wheel = (event: WheelEvent) => {
      const delta = event.deltaY || event.deltaX;
      if (!delta) return;
      event.preventDefault();
      const { value, onChange } = latest.current;
      onChange(Math.max(20, Math.min(400, value - Math.sign(delta) * (event.shiftKey ? 5 : 1))));
    };
    slider.addEventListener('wheel', wheel, { passive: false });
    return () => slider.removeEventListener('wheel', wheel);
  }, []);
  return (
    <label className="music-tempo-control">
      <span>
        BPM <output>{value}</output>
      </span>
      <input
        ref={input}
        aria-label={t('播放速度')}
        type="range"
        min={20}
        max={400}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
