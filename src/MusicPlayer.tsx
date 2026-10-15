import MusicTempoControl from './MusicTempoControl';
import { musicInstruments, savedMusicInstrument, saveMusicInstrument } from './musicInstruments';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, Pause, X, Music, Mic, ChevronDown } from 'lucide-react';
import type { Notebook, Page } from './model';
import { correctScoreNote, midiName } from './musicScore';
import {
  scoreTimeline,
  scoreAt,
  timelineNotes,
  setScoreCursor,
  estimateMidi,
  followScore,
} from './musicTransport';
import { MusicAudio } from './musicAudio';
import { scoreMidi } from './musicMidi';
import { download } from './storage';
import { t } from './i18n';
import './musicPlayer.css';
export default function MusicPlayer({
  notebook,
  onApply,
  onNavigate,
  onClose,
}: {
  notebook: Notebook;
  onApply: (pages: Page[]) => void;
  onNavigate: (index: number) => void;
  onClose: () => void;
}) {
  const lastTimeline = useRef<ReturnType<typeof scoreTimeline>>([]);
  const timeline = useMemo(() => {
      const next = scoreTimeline(notebook.pages),
        old = lastTimeline.current;
      if (
        next.length === old.length &&
        next.every(
          (p, i) =>
            p.pageId === old[i].pageId && p.index === old[i].index && p.score === old[i].score,
        )
      )
        return old;
      lastTimeline.current = next;
      return next;
    }, [notebook.pages]),
    notes = useMemo(() => timelineNotes(timeline), [timeline]);
  const duration = timeline.length ? timeline.at(-1)!.start + timeline.at(-1)!.score.duration : 0;
  const [beat, setBeat] = useState(0),
    [playing, setPlaying] = useState(false),
    [tempo, setTempo] = useState(timeline[0]?.score.tempo ?? 120),
    [volume, setVolume] = useState(0.6),
    [instrument, setInstrument] = useState(savedMusicInstrument),
    [collapsed, setCollapsed] = useState(false),
    [editing, setEditing] = useState(false),
    [selected, setSelected] = useState(''),
    [following, setFollowing] = useState(false),
    [status, setStatus] = useState('');
  const [position, setPosition] = useState({
    x: Math.max(12, window.innerWidth - 350),
    y: Math.max(12, window.innerHeight - 260),
  });
  const audio = useRef<MusicAudio | null>(null),
    alive = useRef(true),
    beatRef = useRef(beat),
    micTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined),
    followToken = useRef(0),
    lastPage = useRef(''),
    root = useRef<HTMLElement>(null);
  beatRef.current = beat;
  const current = scoreAt(timeline, beat),
    page = current && notebook.pages[current.index],
    localBeat = current ? beat - current.start : 0;
  const stop = () => {
    audio.current?.stop();
    setPlaying(false);
  };
  const stopFollowing = () => {
    followToken.current++;
    clearInterval(micTimer.current);
    micTimer.current = undefined;
    audio.current?.stopMic();
    setFollowing(false);
  };
  const seek = useCallback(
    (id: string, local: number, noteId: string) => {
      stop();
      const item = timeline.find((p) => p.pageId === id);
      if (!item) return;
      setSelected(noteId);
      beatRef.current = item.start + local;
      setBeat(beatRef.current);
    },
    [timeline],
  );
  useEffect(() => {
    alive.current = true;
    audio.current = new MusicAudio();
    return () => {
      alive.current = false;
      followToken.current++;
      clearInterval(micTimer.current);
      audio.current?.dispose();
      audio.current = null;
      setScoreCursor({ pageId: '', beat: 0, seek: null });
    };
  }, []);
  useEffect(() => {
    setScoreCursor({ pageId: current?.pageId ?? '', beat: localBeat, selectedId: selected, seek });
    if (current && lastPage.current !== current.pageId) {
      lastPage.current = current.pageId;
      onNavigate(current.index);
    }
  }, [beat, current?.pageId, selected, timeline]);
  useEffect(() => {
    stop();
    stopFollowing();
  }, [timeline]);
  useEffect(() => {
    audio.current?.setVolume(volume);
  }, [volume]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) {
        stop();
        stopFollowing();
      }
    };
    document.addEventListener('visibilitychange', hidden);
    const off = window.surfaceDesktop?.onWindowVisibility?.((visible) => {
      if (!visible) {
        stop();
        stopFollowing();
      }
    });
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      off?.();
    };
  }, []);
  useEffect(() => {
    audio.current?.setInstrument(instrument);
    saveMusicInstrument(instrument);
  }, [instrument]);
  const play = async () => {
    if (playing) {
      setBeat(audio.current?.currentBeat() ?? beatRef.current);
      stop();
      return;
    }
    stopFollowing();
    setStatus('');
    const start = beatRef.current >= duration ? 0 : beatRef.current;
    try {
      await audio.current?.play(
        notes,
        start,
        tempo,
        volume,
        duration,
        (b) => {
          if (alive.current) {
            beatRef.current = b;
            setBeat(b);
          }
        },
        () => {
          if (alive.current) setPlaying(false);
        },
      );
      if (alive.current) setPlaying(true);
    } catch {
      if (alive.current) setStatus(t('无法启动本地音频。'));
    }
  };
  const follow = async () => {
    if (following) {
      stopFollowing();
      return;
    }
    stop();
    const token = ++followToken.current;
    setStatus(t('正在请求麦克风…'));
    try {
      const input = await audio.current!.microphone();
      if (!alive.current || token !== followToken.current) {
        audio.current?.stopMic();
        return;
      }
      setFollowing(true);
      setStatus(t('单旋律跟随（实验性）：演奏后自动定位与翻页。'));
      const buffer = new Float32Array(input.analyser.fftSize);
      let previous: number | null = null,
        last = 0;
      micTimer.current = setInterval(() => {
        input.analyser.getFloatTimeDomainData(buffer);
        const midi = estimateMidi(buffer, input.sampleRate),
          now = performance.now();
        if (midi === null) {
          previous = null;
          return;
        }
        if (previous === midi && now - last < 450) return;
        previous = midi;
        last = now;
        const target = followScore(notes, beatRef.current, midi);
        if (target) {
          beatRef.current = target.beat + 0.02;
          setBeat(beatRef.current);
        }
      }, 110);
    } catch {
      if (alive.current) {
        stopFollowing();
        setStatus(t('无法使用麦克风，请检查系统与应用权限。'));
      }
    }
  };
  const note = page?.score?.notes.find((n) => n.id === selected);
  const update = (change: Parameters<typeof correctScoreNote>[2]) => {
    if (!page?.score || !note) return;
    stop();
    stopFollowing();
    try {
      onApply([{ ...page, score: correctScoreNote(page.score, note.id, change) }]);
    } catch {
      setStatus(t('音符数值无效。'));
    }
  };
  return createPortal(
    <section
      className="music-player"
      aria-label={t('五线谱播放器')}
      ref={root}
      style={{ left: position.x, top: position.y }}
    >
      <header
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          const element = e.currentTarget;
          element.setPointerCapture(e.pointerId);
          const startX = e.clientX,
            startY = e.clientY;
          const onMove = (ev: PointerEvent) =>
            setPosition({
              x: Math.max(0, Math.min(window.innerWidth - 100, position.x + ev.clientX - startX)),
              y: Math.max(0, Math.min(window.innerHeight - 40, position.y + ev.clientY - startY)),
            });
          const end = () => {
            element.removeEventListener('pointermove', onMove);
            element.removeEventListener('pointerup', end);
            element.removeEventListener('pointercancel', end);
          };
          element.addEventListener('pointermove', onMove);
          element.addEventListener('pointerup', end, { once: true });
          element.addEventListener('pointercancel', end, { once: true });
        }}
      >
        <Music size={16} />
        <strong>{t('五线谱')}</strong>
        <small>{current ? t('第 {0} 页', current.index + 1) : t('无识别结果')}</small>
        <button
          aria-label={t('收起播放器')}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <ChevronDown size={16} />
        </button>
        <button aria-label={t('关闭播放器')} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {!collapsed && (
        <>
          <div className="music-player-controls">
            <button
              aria-label={t(playing ? '暂停乐谱' : '播放乐谱')}
              disabled={!duration}
              onClick={() => void play()}
            >
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <select
              aria-label={t('乐谱页面')}
              value={current?.pageId ?? ''}
              onChange={(e) => {
                stop();
                const item = timeline.find((p) => p.pageId === e.target.value);
                if (item) setBeat(item.start);
              }}
            >
              {timeline.map((p) => (
                <option key={p.pageId} value={p.pageId}>
                  {t('第 {0} 页', p.index + 1)}
                </option>
              ))}
            </select>
            <MusicTempoControl
              value={tempo}
              onChange={(bpm) => {
                stop();
                setTempo(bpm);
              }}
            />
          </div>
          <label className="music-instrument-control">
            {t('音色')}
            <select
              aria-label={t('MIDI 音色')}
              value={instrument}
              onChange={(e) => setInstrument(Number(e.target.value))}
            >
              {musicInstruments.map(([program, name]) => (
                <option value={program} key={program}>
                  {t(name)}
                </option>
              ))}
            </select>
          </label>
          <input
            aria-label={t('乐谱进度')}
            type="range"
            min={0}
            max={duration || 1}
            step={0.02}
            value={Math.min(beat, duration)}
            onChange={(e) => {
              stop();
              setBeat(Number(e.target.value));
            }}
          />
          <div className="music-player-controls">
            <label>
              {t('音量')}
              <input
                type="range"
                aria-label={t('乐谱音量')}
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
              />
            </label>
            <button
              aria-label={t('声音跟随翻页')}
              aria-pressed={following}
              disabled={!duration}
              onClick={() => void follow()}
            >
              <Mic size={16} />
            </button>
            <button aria-pressed={editing} onClick={() => setEditing(!editing)}>
              {t('修正音符')}
            </button>
          </div>
          <div className="music-player-controls">
            <button
              disabled={!duration}
              onClick={() =>
                download(scoreMidi(notes, tempo, instrument), notebook.name + '.mid', 'audio/midi')
              }
            >
              MIDI ↓
            </button>
            {page?.score && (
              <button
                onClick={() =>
                  download(
                    page.score!.musicxml,
                    notebook.name + '-' + (current.index + 1) + '.musicxml',
                    'application/vnd.recordare.musicxml+xml',
                  )
                }
              >
                {t('原始 MusicXML')} ↓
              </button>
            )}
          </div>
          {editing && page?.score && (
            <div className="music-note-editor">
              <select
                aria-label={t('待修正音符')}
                value={note?.id ?? ''}
                onChange={(e) => {
                  const n = page.score!.notes.find((n) => n.id === e.target.value)!;
                  seek(page.id, n.beat, n.id);
                }}
              >
                <option value="">{t('点击谱面音符或选择…')}</option>
                {page.score.notes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.measure} · {midiName(n.midi)} · {n.beat.toFixed(2)}
                  </option>
                ))}
              </select>
              {note && (
                <>
                  <label>
                    MIDI
                    <input
                      aria-label={t('音符 MIDI 音高')}
                      type="number"
                      min={0}
                      max={127}
                      value={note.midi}
                      onChange={(e) => update({ midi: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    {t('时值')}
                    <input
                      aria-label={t('音符时值')}
                      type="number"
                      min={0.0625}
                      max={1000}
                      step={0.0625}
                      value={note.duration}
                      onChange={(e) => update({ duration: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={t('静音此音符')}
                      checked={!!note.muted}
                      onChange={(e) => update({ muted: e.target.checked })}
                    />
                    {t('静音')}
                  </label>
                </>
              )}
            </div>
          )}
          {current?.score.positioning === 'estimated' && <small>{t('谱面位置为估计值')}</small>}
          {status && <p role="status">{status}</p>}
        </>
      )}
    </section>,
    document.body,
  );
}
