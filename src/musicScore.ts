export interface ScoreRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type ScoreLocations = Record<
  string,
  { system: number; region: ScoreRect; detected?: boolean }
>;
export interface ScoreLayout {
  systems: ScoreRect[];
  noteLocations: ScoreLocations;
}
export interface ScoreNote {
  id: string;
  sourceId: string;
  midi: number;
  beat: number;
  duration: number;
  measure: string;
  part: string;
  system: number;
  region: ScoreRect;
  muted?: boolean;
  continuations?: { beat: number; duration: number; system: number; region: ScoreRect }[];
}
export interface MusicScore {
  version: 1;
  engine: 'audiveris' | 'homr' | 'copista' | 'import';
  musicxml: string;
  notes: ScoreNote[];
  systems: ScoreRect[];
  duration: number;
  tempo: number;
  positioning: 'layout' | 'estimated';
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const rectValid = (r: any) =>
  r &&
  [r.x, r.y, r.width, r.height].every(finite) &&
  r.x >= 0 &&
  r.y >= 0 &&
  r.width > 0 &&
  r.height > 0 &&
  r.x + r.width <= 1.000001 &&
  r.y + r.height <= 1.000001;
export function validMusicScore(value: unknown): value is MusicScore {
  if (!value || typeof value !== 'object') return false;
  const s = value as MusicScore;
  return (
    s.version === 1 &&
    ['audiveris', 'homr', 'copista', 'import'].includes(s.engine) &&
    typeof s.musicxml === 'string' &&
    s.musicxml.length <= 4 * 1024 * 1024 &&
    finite(s.duration) &&
    s.duration > 0 &&
    s.duration <= 100000 &&
    finite(s.tempo) &&
    s.tempo >= 20 &&
    s.tempo <= 400 &&
    ['layout', 'estimated'].includes(s.positioning) &&
    Array.isArray(s.systems) &&
    s.systems.length > 0 &&
    s.systems.length <= 256 &&
    s.systems.every(rectValid) &&
    Array.isArray(s.notes) &&
    s.notes.length > 0 &&
    s.notes.length <= 20000 &&
    s.notes.reduce((total, n) => total + (n?.continuations?.length ?? 0), 0) <= 40000 &&
    s.notes.every(
      (n) =>
        n &&
        typeof n.id === 'string' &&
        n.id.length <= 120 &&
        typeof n.sourceId === 'string' &&
        n.sourceId.length <= 120 &&
        Number.isInteger(n.midi) &&
        n.midi >= 0 &&
        n.midi <= 127 &&
        finite(n.beat) &&
        n.beat >= 0 &&
        finite(n.duration) &&
        n.duration > 0 &&
        n.duration <= 1000 &&
        n.beat + n.duration <= s.duration + 0.001 &&
        typeof n.measure === 'string' &&
        n.measure.length <= 50 &&
        typeof n.part === 'string' &&
        n.part.length <= 100 &&
        Number.isInteger(n.system) &&
        n.system >= 0 &&
        n.system < s.systems.length &&
        rectValid(n.region) &&
        (n.muted === undefined || typeof n.muted === 'boolean') &&
        (n.continuations === undefined ||
          (Array.isArray(n.continuations) &&
            n.continuations.length <= 5000 &&
            n.continuations.every(
              (c) =>
                c &&
                finite(c.beat) &&
                c.beat >= n.beat &&
                finite(c.duration) &&
                c.duration > 0 &&
                c.beat + c.duration <= n.beat + n.duration + 0.001 &&
                Number.isInteger(c.system) &&
                c.system >= 0 &&
                c.system < s.systems.length &&
                rectValid(c.region),
            ))),
    )
  );
}
const children = (e: Element | undefined, tag: string): Element[] =>
  e ? Array.from(e.children).filter((c) => c.localName === tag) : [];
const child = (e: Element | undefined, tag: string) => children(e, tag)[0];
const text = (e: Element | undefined, tag: string, fallback = '') =>
  child(e, tag)?.textContent?.trim() || fallback;
const number = (e: Element | undefined, tag: string, fallback: number) => {
  const value = text(e, tag);
  const n = Number(value);
  return value && Number.isFinite(n) ? n : fallback;
};
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const region = (x: number, y: number, w: number, h: number): ScoreRect => {
  x = clamp(x, 0, 0.999);
  y = clamp(y, 0, 0.999);
  return { x, y, width: clamp(w, 0.001, 1 - x), height: clamp(h, 0.001, 1 - y) };
};
const steps: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const semitones: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** MusicXML timing keeps chord onsets and backup/forward voices separate.
 * Layout coordinates, when present, stay normalized to the captured page. */
export function parseMusicScore(
  xml: string,
  engine: MusicScore['engine'],
  detected?: ScoreLayout,
): MusicScore {
  if (
    detected &&
    (!Array.isArray(detected.systems) ||
      !detected.systems.length ||
      detected.systems.length > 256 ||
      !detected.systems.every(rectValid) ||
      !detected.noteLocations ||
      Object.keys(detected.noteLocations).length > 20000)
  )
    throw Error('score-format');
  if (xml.length > 4 * 1024 * 1024 || /<!ENTITY/i.test(xml)) throw Error('score-format');
  const doc = new DOMParser().parseFromString(
    xml.replace(/<!DOCTYPE[^>]*>/gi, ''),
    'application/xml',
  );
  if (
    doc.getElementsByTagName('parsererror').length ||
    doc.documentElement.localName !== 'score-partwise'
  )
    throw Error('score-format');
  const root = doc.documentElement,
    defaults = child(root, 'defaults'),
    layout = child(defaults, 'page-layout'),
    margins = child(layout, 'page-margins');
  const pw = number(layout, 'page-width', 1000),
    ph = number(layout, 'page-height', 1400),
    left = number(margins, 'left-margin', 60),
    top = number(margins, 'top-margin', 60);
  if (pw <= 0 || ph <= 0) throw Error('score-format');
  type LocalNote = Omit<ScoreNote, 'beat' | 'id'> & {
    localBeat: number;
    tieStart: boolean;
    tieStop: boolean;
    voice: string;
  };
  type Measure = {
    notes: LocalNote[];
    duration: number;
    repeatStart: boolean;
    repeatEnd: boolean;
    number: string;
  };
  const parts = children(root, 'part'),
    all: Measure[][] = [],
    systems: ScoreRect[] = [];
  if (!parts.length || parts.length > 64) throw Error('score-format');
  let tempo = 120,
    positioned = false,
    noteCount = 0,
    mappedCount = 0;
  for (const [pi, part] of parts.entries()) {
    let divisions = 1,
      beats = 4,
      beatType = 4,
      system = 0,
      systemTop = top,
      measureX = left,
      systemLeft = left,
      staffCount = 1,
      gap = 65;
    let priorHeight = 40;
    const clefs = new Map<number, { sign: string; line: number }>([[1, { sign: 'G', line: 2 }]]),
      measures: Measure[] = [];
    for (const [mi, measure] of children(part, 'measure').entries()) {
      if (mi > 5000) throw Error('score-limit');
      const print = child(measure, 'print'),
        sl = child(print, 'system-layout'),
        sm = child(sl, 'system-margins');
      const attr = child(measure, 'attributes');
      divisions = number(attr, 'divisions', divisions);
      staffCount = number(attr, 'staves', staffCount);
      const time = child(attr, 'time');
      beats = number(time, 'beats', beats);
      beatType = number(time, 'beat-type', beatType);
      if (divisions <= 0 || staffCount < 1 || staffCount > 32 || beats <= 0 || beatType <= 0)
        throw Error('score-format');
      for (const c of children(attr, 'clef'))
        clefs.set(Number(c.getAttribute('number') || 1), {
          sign: text(c, 'sign', 'G'),
          line: number(c, 'line', 2),
        });
      if (
        mi === 0 ||
        print?.getAttribute('new-system') === 'yes' ||
        print?.getAttribute('new-page') === 'yes'
      ) {
        if (mi > 0) system++;
        systemLeft = left + number(sm, 'left-margin', 0);
        measureX = systemLeft;
        systemTop =
          mi === 0 || print?.getAttribute('new-page') === 'yes'
            ? top + number(sl, 'top-system-distance', 0)
            : systemTop + priorHeight + number(sl, 'system-distance', 80);
        const staffLayout = children(print, 'staff-layout').find(
          (s) => s.getAttribute('number') === '2',
        );
        gap = number(staffLayout, 'staff-distance', gap);
        priorHeight = 40 * staffCount + gap * (staffCount - 1);
        if (pi === 0)
          systems[system] = region(
            systemLeft / pw,
            Math.max(0, systemTop - 20) / ph,
            (pw - systemLeft - 60) / pw,
            (priorHeight + 50) / ph,
          );
      }
      const width = Number(measure.getAttribute('width')) || (pw - left - 60) / 4;
      let cursor = 0,
        lastOnset = 0,
        duration = 0;
      const notes: LocalNote[] = [];
      const label = (measure.getAttribute('number') || String(mi + 1)).slice(0, 50);
      for (const node of Array.from(measure.children)) {
        if (node.localName === 'direction') {
          const sound = child(node, 'sound'),
            bpm = Number(sound?.getAttribute('tempo'));
          if (mi === 0 && bpm >= 20 && bpm <= 400) tempo = bpm;
        } else if (node.localName === 'backup')
          cursor = Math.max(0, cursor - number(node, 'duration', 0) / divisions);
        else if (node.localName === 'forward') {
          cursor += number(node, 'duration', 0) / divisions;
          duration = Math.max(duration, cursor);
        } else if (node.localName === 'note') {
          const isChord = !!child(node, 'chord'),
            isGrace = !!child(node, 'grace'),
            length = number(node, 'duration', 0) / divisions;
          const onset = isChord ? lastOnset : cursor;
          if (!isChord) lastOnset = onset;
          if (!isChord && !isGrace) cursor += length;
          duration = Math.max(duration, cursor, onset + length);
          const pitch = child(node, 'pitch');
          if (!pitch || child(node, 'rest')) continue;
          if (++noteCount > 20000) throw Error('score-limit');
          const step = text(pitch, 'step'),
            octave = number(pitch, 'octave', 4),
            alter = number(pitch, 'alter', 0);
          if (!(step in semitones)) continue;
          const staff = number(node, 'staff', 1),
            clef = clefs.get(staff) || clefs.get(1)!;
          const clefRef =
            clef.sign === 'F'
              ? 3 * 7 + steps.F
              : clef.sign === 'C'
                ? 4 * 7 + steps.C
                : 4 * 7 + steps.G;
          const diatonicTop = clefRef + 2 * (5 - clef.line);
          const defaultY = node.getAttribute('default-y'),
            y =
              defaultY === null
                ? (diatonicTop - (octave * 7 + steps[step])) * 5
                : -Number(defaultY);
          const defaultX = node.getAttribute('default-x');
          if (defaultX !== null) positioned = true;
          const x =
            measureX +
            (defaultX === null
              ? width * (0.1 + (0.8 * onset) / Math.max((beats * 4) / beatType, duration, 1))
              : Number(defaultX));
          const located = detected?.noteLocations[node.getAttribute('id') ?? ''];
          if (
            located &&
            (!rectValid(located.region) ||
              !Number.isInteger(located.system) ||
              located.system < 0 ||
              located.system >= detected!.systems.length)
          )
            throw Error('score-format');
          if (located && located.detected !== false) mappedCount++;
          notes.push({
            sourceId: `${pi}:${mi}:${notes.length}`,
            midi: clamp(Math.round((octave + 1) * 12 + semitones[step] + alter), 0, 127),
            localBeat: onset,
            duration: Math.max(isGrace ? 0.125 : 1 / 64, length),
            measure: label,
            part: (
              text(
                child(
                  children(child(root, 'part-list'), 'score-part').find(
                    (p) => p.getAttribute('id') === part.getAttribute('id'),
                  ),
                  'score-instrument',
                ),
                'instrument-name',
              ) ||
              part.getAttribute('id') ||
              `Part ${pi + 1}`
            ).slice(0, 100),
            system: located?.system ?? system,
            region:
              located?.region ??
              region(
                (x - 5) / pw,
                (systemTop + (staff - 1) * (40 + gap) + y - 6) / ph,
                10 / pw,
                12 / ph,
              ),
            tieStart: children(node, 'tie').some((t) => t.getAttribute('type') === 'start'),
            tieStop: children(node, 'tie').some((t) => t.getAttribute('type') === 'stop'),
            voice: text(node, 'voice', '1'),
          });
        }
      }
      measures.push({
        notes,
        duration: Math.max(
          duration,
          ((beats * 4) / beatType) * (measure.getAttribute('implicit') === 'yes' ? 0 : 1),
        ),
        repeatStart: children(measure, 'barline').some(
          (b) => child(b, 'repeat')?.getAttribute('direction') === 'forward',
        ),
        repeatEnd: children(measure, 'barline').some(
          (b) => child(b, 'repeat')?.getAttribute('direction') === 'backward',
        ),
        number: label,
      });
      measureX += width;
    }
    all.push(measures);
  }
  if (detected) systems.splice(0, systems.length, ...detected.systems);
  const count = Math.max(...all.map((p) => p.length)),
    order: number[] = [];
  let repeatStart = 0;
  for (let i = 0; i < count; i++) {
    if (all.some((p) => p[i]?.repeatStart)) repeatStart = i;
    order.push(i);
    if (all.some((p) => p[i]?.repeatEnd)) for (let j = repeatStart; j <= i; j++) order.push(j);
  }
  const notes: ScoreNote[] = [],
    ties = new Map<string, ScoreNote>();
  let beat = 0;
  for (const [iteration, mi] of order.entries()) {
    const length = Math.max(0, ...all.map((p) => p[mi]?.duration || 0));
    for (const [pi, part] of all.entries())
      for (const n of part[mi]?.notes || []) {
        const key = `${pi}:${n.voice}:${n.midi}`,
          previous = ties.get(key),
          start = beat + n.localBeat;
        if (n.tieStop && previous && Math.abs(previous.beat + previous.duration - start) < 0.01) {
          previous.duration += n.duration;
          (previous.continuations ??= []).push({
            beat: start,
            duration: n.duration,
            system: Math.min(n.system, systems.length - 1),
            region: n.region,
          });
          if (!n.tieStart) ties.delete(key);
          continue;
        }
        const { localBeat, tieStart, tieStop, voice, ...base } = n;
        const event: ScoreNote = {
          ...base,
          system: Math.min(n.system, systems.length - 1),
          id: `${iteration}:${base.sourceId}`,
          beat: start,
        };
        notes.push(event);
        if (tieStart) ties.set(key, event);
        else ties.delete(key);
      }
    beat += length;
  }
  if (!systems.length) systems.push(region(0.06, 0.06, 0.88, 0.88));
  notes.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  const score: MusicScore = {
    version: 1,
    engine,
    musicxml: xml,
    notes,
    systems,
    duration: Math.max(beat, ...notes.map((n) => n.beat + n.duration)),
    tempo,
    positioning: detected
      ? mappedCount === noteCount
        ? 'layout'
        : 'estimated'
      : positioned
        ? 'layout'
        : 'estimated',
  };
  if (!validMusicScore(score)) throw Error('no-score');
  return score;
}
export const midiName = (value: number) =>
  ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][value % 12] +
  (Math.floor(value / 12) - 1);
/** Correct all repeat occurrences of the same recognized note together. */
export function correctScoreNote(
  score: MusicScore,
  id: string,
  change: Partial<Pick<ScoreNote, 'midi' | 'duration' | 'muted'>>,
) {
  const source = score.notes.find((n) => n.id === id)?.sourceId;
  if (!source) return score;
  const notes = score.notes.map((n) => {
    if (n.sourceId !== source) return n;
    const next = { ...n, ...change };
    if (change.duration !== undefined && n.continuations)
      next.continuations = n.continuations
        .filter((c) => c.beat < n.beat + change.duration!)
        .map((c) => ({ ...c, duration: Math.min(c.duration, n.beat + change.duration! - c.beat) }));
    return next;
  });
  const next = {
    ...score,
    notes,
    duration: Math.max(score.duration, ...notes.map((n) => n.beat + n.duration)),
  };
  if (!validMusicScore(next)) throw Error('score-note');
  return next;
}

/** homr supplies staff-row geometry separately from symbolic MusicXML. */
export function remapScoreSystems(score: MusicScore, detected: ScoreRect[]): MusicScore {
  if (!detected.length || detected.length > 256 || !detected.every(rectValid)) return score;
  const ordered = [...new Set(score.notes.map((n) => n.system))].sort((a, b) => a - b);
  const measures = [
    ...new Set(score.notes.map((n) => n.sourceId.split(':').slice(0, 2).join(':'))),
  ];
  const measureIndex = new Map(measures.map((m, i) => [m, i])),
    systemIndex = new Map(ordered.map((s, i) => [s, i]));
  const row = (n: ScoreNote) =>
    ordered.length === 1 && detected.length > 1
      ? Math.min(
          detected.length - 1,
          Math.floor(
            ((measureIndex.get(n.sourceId.split(':').slice(0, 2).join(':')) ?? 0) *
              detected.length) /
              Math.max(1, measures.length),
          ),
        )
      : Math.min(
          detected.length - 1,
          Math.floor(((systemIndex.get(n.system) ?? 0) * detected.length) / ordered.length),
        );
  const originals = new Map<string, ScoreNote>(),
    groups = detected.map(() => [] as ScoreNote[]);
  score.notes.forEach((n) => {
    if (!originals.has(n.sourceId)) {
      originals.set(n.sourceId, n);
      groups[row(n)].push(n);
    }
  });
  const ranges = groups.map((ns) => ({
    start: Math.min(...ns.map((n) => n.beat)),
    end: Math.max(...ns.map((n) => n.beat + n.duration)),
    low: Math.min(...ns.map((n) => n.midi)) - 3,
    high: Math.max(...ns.map((n) => n.midi)) + 3,
  }));
  const notes = score.notes.map((n) => {
    const system = row(n),
      target = detected[system],
      source = originals.get(n.sourceId)!,
      range = ranges[system];
    const x = 0.04 + (0.9 * (source.beat - range.start)) / Math.max(0.01, range.end - range.start),
      y = 0.1 + (0.8 * (range.high - n.midi)) / Math.max(1, range.high - range.low);
    return {
      ...n,
      system,
      region: region(
        target.x + x * target.width,
        target.y + y * target.height,
        Math.min(0.02, target.width * 0.02),
        Math.min(0.025, target.height * 0.15),
      ),
    };
  });
  const next = { ...score, systems: detected, notes, positioning: 'estimated' as const };
  return validMusicScore(next) ? next : score;
}
