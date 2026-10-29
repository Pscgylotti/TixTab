import MusicTempoControl from './MusicTempoControl';
import { musicInstruments, savedMusicInstrument, saveMusicInstrument } from './musicInstruments';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, Pause, X, Music, Mic, ChevronDown, RefreshCw } from 'lucide-react';
import type { Notebook, Page } from './model';
import type { MusicPlayerState } from './musicPlayerState';
import { correctScoreNote, midiName } from './musicScore';
import { scoreTimeline, scoreAt, timelineNotes, setScoreCursor } from './musicTransport';
import type { FollowResult } from './musicFollow';
import { MusicAudio } from './musicAudio';
import { MatchmakerFollow } from './matchmakerFollow';
import { installRuntime } from './runtimeInstall';
import {
  savedMusicOutput,
  saveMusicOutput,
  resolveMusicOutput,
  type MusicOutputDevice,
} from './musicOutput';
import { scoreMidi } from './musicMidi';
import { download } from './storage';
import { t } from './i18n';
import './musicPlayer.css';
export default function MusicPlayer({
  notebook,
  onApply,
  onNavigate,
  onClose,
  presentation = false,
  onStateChange,
}: {
  notebook: Notebook;
  onApply: (pages: Page[]) => void;
  onNavigate: (index: number) => void;
  onClose: () => void;
  presentation?: boolean;
  onStateChange: (change: Partial<MusicPlayerState>) => void;
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
  const saved = notebook.musicPlayer;
  const [beat, setBeat] = useState(() => {
      const item = timeline.find((p) => p.pageId === saved?.cursor?.pageId);
      return item ? item.start + Math.min(saved!.cursor!.beat, item.score.duration) : 0;
    }),
    [playing, setPlaying] = useState(false),
    [tempo, setTempo] = useState(saved?.tempo ?? timeline[0]?.score.tempo ?? 120),
    [volume, setVolume] = useState(saved?.volume ?? 0.6),
    [instrument, setInstrument] = useState(() => saved?.instrument ?? savedMusicInstrument()),
    [output, setOutput] = useState(() => saved?.output ?? savedMusicOutput()),
    [devices, setDevices] = useState<MusicOutputDevice[]>([]),
    [outputLoading, setOutputLoading] = useState(!!window.surfaceDesktop?.musicOutput),
    [starting, setStarting] = useState(false),
    [collapsed, setCollapsed] = useState(saved?.collapsed ?? false),
    [editing, setEditing] = useState(false),
    [selected, setSelected] = useState(''),
    [following, setFollowing] = useState(false),
    [micLevel, setMicLevel] = useState(0),
    [followEngine, setFollowEngine] = useState<'global' | 'matchmaker' | 'cqt'>(() =>
      window.surfaceDesktop?.musicFollow ? (saved?.followEngine ?? 'global') : 'cqt',
    ),
    [preparingFollow, setPreparingFollow] = useState(false),
    [status, setStatus] = useState('');
  const [position, setPosition] = useState(
    saved?.position ?? {
      x: Math.max(12, window.innerWidth - 350),
      y: Math.max(12, window.innerHeight - 260),
    },
  );
  const preferences = useRef({ onStateChange, presentation });
  preferences.current = { onStateChange, presentation };
  useEffect(() => {
    preferences.current.onStateChange({
      tempo,
      volume,
      instrument,
      output,
      collapsed,
      followEngine,
      position,
    });
  }, [tempo, volume, instrument, output, collapsed, followEngine, position]);
  const audio = useRef<MusicAudio | null>(null),
    alive = useRef(true),
    playToken = useRef(0),
    outputToken = useRef(0),
    beatRef = useRef(beat),
    micTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined),
    followToken = useRef(0),
    followWorker = useRef<Worker | null>(null),
    nativeFollow = useRef<MatchmakerFollow | null>(null),
    prepareAbort = useRef<AbortController | null>(null),
    followEpoch = useRef(0),
    followPending = useRef(false),
    tempoRef = useRef(tempo),
    lastPage = useRef(''),
    root = useRef<HTMLElement>(null);
  beatRef.current = beat;
  tempoRef.current = tempo;
  const current = scoreAt(timeline, beat),
    page = current && notebook.pages[current.index],
    localBeat = current ? beat - current.start : 0;
  const saveCursor = () => {
    if (current)
      preferences.current.onStateChange({ cursor: { pageId: current.pageId, beat: localBeat } });
  };
  useEffect(() => {
    // Persist deliberate seeks, pauses and completed playback, never every audio frame.
    if (!playing && !following && !starting) saveCursor();
  }, [playing, following, starting, beat, current?.pageId]);
  const stop = () => {
    playToken.current++;
    audio.current?.stop();
    setPlaying(false);
    setStarting(false);
  };
  const refreshOutputs = async () => {
    const bridge = window.surfaceDesktop?.musicOutput;
    if (!bridge) return;
    const token = ++outputToken.current;
    setOutputLoading(true);
    try {
      const result = await bridge.run({ action: 'list' });
      if (!alive.current || token !== outputToken.current) return;
      setDevices(result.ok ? result.devices || [] : []);
      if (!result.ok) setStatus(t('无法读取 MIDI 音源，请刷新或使用内置合成器。'));
    } catch {
      if (alive.current && token === outputToken.current)
        setStatus(t('无法读取 MIDI 音源，请刷新或使用内置合成器。'));
    } finally {
      if (alive.current && token === outputToken.current) setOutputLoading(false);
    }
  };
  const stopFollowing = () => {
    followToken.current++;
    clearInterval(micTimer.current);
    micTimer.current = undefined;
    audio.current?.stopMic();
    nativeFollow.current?.stop();
    nativeFollow.current = null;
    followWorker.current?.terminate();
    followWorker.current = null;
    followPending.current = false;
    setFollowing(false);
    setMicLevel(0);
    setStatus('');
  };
  const resetFollowing = (beat: number) => {
    nativeFollow.current?.seek(beat);
    followEpoch.current++;
    followWorker.current?.postMessage({
      type: 'seek',
      beat,
      tempo: tempoRef.current,
      epoch: followEpoch.current,
    });
  };
  const seek = useCallback(
    (id: string, local: number, noteId: string) => {
      stop();
      const item = timeline.find((p) => p.pageId === id);
      if (!item) return;
      setSelected(noteId);
      beatRef.current = item.start + local;
      setBeat(beatRef.current);
      resetFollowing(beatRef.current);
    },
    [timeline],
  );
  useEffect(() => {
    alive.current = true;
    audio.current = new MusicAudio();
    void refreshOutputs();
    return () => {
      alive.current = false;
      playToken.current++;
      outputToken.current++;
      followToken.current++;
      clearInterval(micTimer.current);
      followWorker.current?.terminate();
      nativeFollow.current?.stop();
      nativeFollow.current = null;
      if (prepareAbort.current) {
        prepareAbort.current.abort();
        void window.surfaceDesktop?.runtimes?.run({ id: 'matchmaker', action: 'cancel' });
        void window.surfaceDesktop?.models?.cancel();
      }
      followWorker.current = null;
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
    const fitPlayer = () => {
      if (preferences.current.presentation) return;
      const box = root.current?.getBoundingClientRect();
      if (!box) return;
      setPosition((old) => {
        const x = Math.max(12, Math.min(old.x, window.innerWidth - box.width - 12));
        // Leave the bottom page/presentation controls accessible when the panel grows.
        const y = Math.max(12, Math.min(old.y, window.innerHeight - box.height - 100));
        return x === old.x && y === old.y ? old : { x, y };
      });
    };
    const observer = new ResizeObserver(fitPlayer);
    if (root.current) observer.observe(root.current);
    window.addEventListener('resize', fitPlayer);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fitPlayer);
    };
  }, [presentation]);
  useEffect(() => {
    stop();
    stopFollowing();
  }, [timeline]);
  useEffect(() => {
    if (nativeFollow.current) stopFollowing();
    else resetFollowing(beatRef.current);
  }, [tempo]);
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
    if (nativeFollow.current) stopFollowing();
    audio.current?.setInstrument(instrument);
    saveMusicInstrument(instrument);
  }, [instrument]);
  const resolvedOutput = resolveMusicOutput(output, devices);
  useEffect(() => {
    stop();
    audio.current?.setOutput(resolvedOutput);
  }, [resolvedOutput]);
  const audioFailed = () => {
    if (!alive.current) return;
    stop();
    setStatus(t('音源无法播放或已断开，请刷新设备或切换到内置合成器。'));
  };
  const play = async () => {
    if (playing) {
      setBeat(audio.current?.currentBeat() ?? beatRef.current);
      stop();
      return;
    }
    stopFollowing();
    setStatus('');
    const token = ++playToken.current;
    setStarting(true);
    const start = beatRef.current >= duration ? 0 : beatRef.current;
    try {
      const started = await audio.current?.play(
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
        audioFailed,
      );
      if (alive.current && token === playToken.current) setPlaying(!!started);
    } catch {
      if (alive.current && token === playToken.current) audioFailed();
    } finally {
      if (alive.current && token === playToken.current) setStarting(false);
    }
  };
  const follow = async () => {
    if (following || followPending.current) {
      stopFollowing();
      return;
    }
    stop();
    const token = ++followToken.current;
    followPending.current = true;
    setFollowing(true);
    setStatus(t('正在请求麦克风…'));
    try {
      if (followEngine !== 'cqt') {
        const follower = new MatchmakerFollow(
          (data) => {
            if (!alive.current || token !== followToken.current) return;
            setMicLevel(Math.min(1, (data.level || 0) * 8));
            if (data.state === 'matched' && data.beat !== undefined) {
              beatRef.current = data.beat;
              setBeat(data.beat);
              setStatus(t('正在跟随演奏，自动定位与翻页。'));
            } else
              setStatus(
                t(
                  data.state === 'uncertain'
                    ? '正在全谱定位，请继续演奏；位置未确认时保持谱面。'
                    : '等待演奏，保持当前谱面位置。',
                ),
              );
          },
          () => {
            if (alive.current && token === followToken.current) {
              stopFollowing();
              setStatus(t('跟谱分析失败，请重新开启声音跟随。'));
            }
          },
        );
        nativeFollow.current = follower;
        setStatus(t('正在准备跟谱参考…'));
        const started = await follower.start(
          notes,
          tempo,
          beatRef.current,
          instrument,
          (p) => {
            if (alive.current && token === followToken.current)
              setStatus(t('正在准备跟谱参考… {0}%', Math.round(p * 100)));
          },
          followEngine === 'global' ? 'global' : 'oltw',
        );
        if (!started || !alive.current || token !== followToken.current) return;
        await audio.current!.streamMicrophone((samples, time) => follower.audio(samples, time));
        if (!alive.current || token !== followToken.current) return;
        followPending.current = false;
        setStatus(t('等待演奏，保持当前谱面位置。'));
        return;
      }
      const input = await audio.current!.microphone();
      if (!alive.current || token !== followToken.current) {
        return;
      }
      followPending.current = false;
      setStatus(t('正在聆听演奏…至少需要 5 秒音频。'));
      const worker = new Worker(new URL('./musicFollow.worker.ts', import.meta.url), {
        type: 'module',
      });
      followWorker.current = worker;
      worker.postMessage({
        type: 'init',
        notes: notes.map(({ midi, beat, duration }) => ({ midi, beat, duration })),
        tempo,
        beat: beatRef.current,
      });
      let pending = false;
      const failed = () => {
        if (!alive.current || token !== followToken.current) return;
        stopFollowing();
        setStatus(t('跟谱分析失败，请重新开启声音跟随。'));
      };
      worker.onerror = failed;
      worker.onmessage = (
        event: MessageEvent<{ type: string; epoch: number; level: number; result?: FollowResult }>,
      ) => {
        pending = false;
        if (!alive.current || token !== followToken.current) return;
        if (event.data.type === 'error') {
          failed();
          return;
        }
        if (event.data.epoch !== followEpoch.current) return;
        const { result, level } = event.data;
        setMicLevel(Math.min(1, level * 8));
        if (!result) return;
        if (result.state === 'matched' && result.beat !== undefined) {
          beatRef.current = result.beat;
          setBeat(result.beat);
          setStatus(t('正在跟随演奏，自动定位与翻页。'));
        } else
          setStatus(
            t(
              result.state === 'listening'
                ? '正在聆听演奏…至少需要 5 秒音频。'
                : '等待清晰的旋律，保持当前谱面位置。',
            ),
          );
      };
      micTimer.current = setInterval(() => {
        if (pending) return; // At most one PCM frame in flight; never accumulate a work queue.
        const buffer = new Float32Array(input.analyser.fftSize);
        input.analyser.getFloatTimeDomainData(buffer);
        pending = true;
        worker.postMessage(
          {
            type: 'audio',
            samples: buffer,
            sampleRate: input.sampleRate,
            time: performance.now() / 1000,
            epoch: followEpoch.current,
          },
          [buffer.buffer],
        );
      }, 100);
    } catch (e) {
      if (alive.current && token === followToken.current) {
        stopFollowing();
        setStatus(
          t(
            followEngine !== 'cqt' &&
              ['runtime-missing', 'missing-model', 'follow-failed'].includes((e as Error).message)
              ? '请先准备 Matchmaker 组件；若仍失败，请重新安装跟谱运行组件。'
              : (e as Error).message === 'score-limit'
                ? '跟谱乐谱过长，请分段识别或提高参考速度。'
                : (e as Error).message === 'empty-score'
                  ? '没有可跟随的音符，请检查音符是否全部静音。'
                  : (e as Error).message === 'timeout'
                    ? '跟谱组件响应超时，请重新开启声音跟随。'
                    : '无法使用麦克风，请检查系统与应用权限。',
          ),
        );
      }
    }
  };
  const prepareFollow = async () => {
    if (prepareAbort.current) return;
    const a = new AbortController();
    prepareAbort.current = a;
    setPreparingFollow(true);
    const off = window.surfaceDesktop?.models?.onProgress((p) => {
      if (p.id === 'matchmaker' && !a.signal.aborted)
        setStatus(t('正在准备跟谱组件… {0}%', Math.round(p.total ? (p.done / p.total) * 100 : 0)));
    });
    try {
      const b = window.surfaceDesktop;
      if (!b?.runtimes || !b.models) throw Error('runtime-missing');
      setStatus(t('正在准备跟谱组件…'));
      const state = await b.runtimes.run({ id: 'matchmaker', action: 'status' });
      a.signal.throwIfAborted();
      if (!state.data?.installed) {
        const r = await installRuntime('matchmaker');
        if (!r.ok) throw Error('runtime-missing');
      }
      a.signal.throwIfAborted();
      if (!(await b.models.list()).some((m) => m.id === 'matchmaker' && m.source !== 'missing')) {
        const r = await b.models.run('matchmaker', 'install');
        if (!r.ok) throw Error('missing-model');
      }
      a.signal.throwIfAborted();
      setStatus(t('Matchmaker 已就绪，可开启声音跟随。'));
    } catch {
      if (alive.current && !a.signal.aborted)
        setStatus(t('跟谱组件准备失败，请检查运行组件与模型下载。'));
    } finally {
      off?.();
      prepareAbort.current = null;
      if (alive.current) setPreparingFollow(false);
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
  const playButton = (
    <button
      aria-label={t(playing ? '暂停乐谱' : '播放乐谱')}
      title={t(playing ? '暂停乐谱' : '播放乐谱')}
      aria-pressed={playing}
      disabled={!duration || outputLoading || starting}
      onClick={() => void play()}
    >
      {playing ? <Pause size={18} /> : <Play size={18} />}
    </button>
  );
  const followButton = (
    <button
      aria-label={t('声音跟随翻页')}
      title={status || t('声音跟随翻页')}
      aria-pressed={following}
      className={following ? 'music-follow-active' : undefined}
      disabled={!duration || preparingFollow}
      onClick={() => void follow()}
    >
      <Mic size={18} />
    </button>
  );
  return createPortal(
    <section
      className={`music-player${presentation ? ' music-player-presentation' : ''}${collapsed ? ' music-player-collapsed' : ''}`}
      aria-label={t('五线谱播放器')}
      ref={root}
      style={presentation ? undefined : { left: position.x, top: position.y }}
      data-page-index={current?.index}
      data-playing={playing}
      data-following={following}
    >
      {presentation ? (
        <div className="music-player-shortcuts">
          {playButton}
          {followButton}
        </div>
      ) : (
        <header
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            const element = e.currentTarget;
            element.setPointerCapture(e.pointerId);
            const startX = e.clientX,
              startY = e.clientY;
            const onMove = (ev: PointerEvent) =>
              setPosition({
                x: Math.max(
                  0,
                  Math.min(
                    window.innerWidth - (root.current?.offsetWidth || 100),
                    position.x + ev.clientX - startX,
                  ),
                ),
                y: Math.max(
                  0,
                  Math.min(
                    window.innerHeight - (root.current?.offsetHeight || 40),
                    position.y + ev.clientY - startY,
                  ),
                ),
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
          {collapsed && (
            <>
              {playButton}
              {followButton}
            </>
          )}
          <button
            aria-label={t('收起播放器')}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            <ChevronDown size={16} />
          </button>
          <button
            aria-label={t('关闭播放器')}
            onClick={() => {
              saveCursor();
              onClose();
            }}
          >
            <X size={16} />
          </button>
        </header>
      )}
      {!collapsed && !presentation && (
        <>
          <div className="music-player-controls">
            {playButton}
            <select
              aria-label={t('乐谱页面')}
              value={current?.pageId ?? ''}
              onChange={(e) => {
                const item = timeline.find((p) => p.pageId === e.target.value);
                if (item) seek(item.pageId, 0, '');
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
            {t('音源')}
            <select
              aria-label={t('播放音源')}
              value={output}
              onChange={(e) => {
                stop();
                setOutput(e.target.value);
                saveMusicOutput(e.target.value);
              }}
            >
              <option value="auto">{t('自动（优先系统音源）')}</option>
              <option value="internal">{t('内置合成器')}</option>
              {devices.map((d) => (
                <option value={d.id} key={d.id}>
                  {d.name}
                </option>
              ))}
              {!['auto', 'internal'].includes(output) && !devices.some((d) => d.id === output) && (
                <option value={output}>{t('已选音源未连接')}</option>
              )}
            </select>
            <button
              type="button"
              aria-label={t('刷新 MIDI 音源')}
              title={t('刷新 MIDI 音源')}
              disabled={outputLoading || !window.surfaceDesktop?.musicOutput}
              onClick={() => void refreshOutputs()}
            >
              <RefreshCw size={14} />
            </button>
          </label>
          {output === 'auto' && resolvedOutput && (
            <small className="music-output-name">
              {devices.find((d) => d.id === resolvedOutput)?.name}
            </small>
          )}
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
              beatRef.current = Number(e.target.value);
              setBeat(beatRef.current);
              resetFollowing(beatRef.current);
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
            {followButton}
            {following && (
              <meter
                className="music-mic-level"
                aria-label={t('麦克风输入电平')}
                min={0}
                max={1}
                value={micLevel}
              />
            )}
            <button aria-pressed={editing} onClick={() => setEditing(!editing)}>
              {t('修正音符')}
            </button>
          </div>
          <label className="music-instrument-control">
            {t('跟谱后端')}
            <select
              aria-label={t('跟谱后端')}
              value={followEngine}
              disabled={preparingFollow}
              onChange={(e) => {
                stopFollowing();
                setFollowEngine(e.target.value as typeof followEngine);
              }}
            >
              <option value="global" disabled={!window.surfaceDesktop?.musicFollow}>
                {t('Matchmaker · 全谱定位（HMM）')}
              </option>
              <option value="matchmaker" disabled={!window.surfaceDesktop?.musicFollow}>
                Matchmaker · OLTW
              </option>
              <option value="cqt">{t('内置 CQT（兼容）')}</option>
            </select>
          </label>
          {followEngine === 'global' && (
            <small>{t('支持从中途开始、跳段和停奏后继续。重复乐句需等待不同音符确认位置。')}</small>
          )}
          {followEngine !== 'cqt' && (
            <button
              disabled={following}
              onClick={() => {
                if (preparingFollow) {
                  prepareAbort.current?.abort();
                  void window.surfaceDesktop?.runtimes?.run({ id: 'matchmaker', action: 'cancel' });
                  void window.surfaceDesktop?.models?.cancel();
                } else void prepareFollow();
              }}
            >
              {t(preparingFollow ? '取消准备' : '准备 Matchmaker 组件')}
            </button>
          )}
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
