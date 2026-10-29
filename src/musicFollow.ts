import type { ScoreNote } from './musicScore';

// Bounded, microphone-only features. No audio recording is persisted.
const LOW = 36,
  HIGH = 96,
  PITCHES = HIGH - LOW + 1,
  DIMENSIONS = PITCHES + 12;
const normalize = (v: Float32Array, offset: number, count: number) => {
  let norm = 0;
  for (let i = offset; i < offset + count; i++) norm += v[i] ** 2;
  if (norm > 0) for (let i = offset; i < offset + count; i++) v[i] /= Math.sqrt(norm);
};
export function pitchFeature(pitches: number[]) {
  const feature = new Float32Array(DIMENSIONS);
  for (const midi of pitches) {
    if (midi >= LOW && midi <= HIGH) feature[midi - LOW] = 1;
    feature[PITCHES + (((midi % 12) + 12) % 12)] = 1;
  }
  normalize(feature, 0, PITCHES);
  normalize(feature, PITCHES, 12);
  return feature;
}
export function featureDistance(a: Float32Array, b: Float32Array) {
  let pitch = 0,
    chroma = 0,
    aPower = 0,
    bPower = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    if (i < PITCHES) pitch += a[i] * b[i];
    else chroma += a[i] * b[i];
    aPower += a[i];
    bPower += b[i];
  }
  if (!aPower || !bPower) return aPower === bPower ? 0 : 1;
  return Math.max(0, 1 - 0.75 * pitch - 0.25 * chroma);
}

/** Hann-window constant-Q kernels, one semitone per bin, with harmonic suppression. */
export class ScoreCqt {
  private rate = 0;
  private kernels: { real: Float32Array; imaginary: Float32Array; weight: number }[] = [];
  extract(input: Float32Array, sampleRate: number) {
    const stride = Math.max(1, Math.floor(sampleRate / 12000));
    const rate = sampleRate / stride;
    if (rate !== this.rate) {
      this.rate = rate;
      this.kernels = Array.from({ length: PITCHES }, (_, i) => {
        const frequency = 440 * 2 ** ((LOW + i - 69) / 12);
        const size = Math.ceil((17 * rate) / frequency);
        const real = new Float32Array(size),
          imaginary = new Float32Array(size);
        let weight = 0;
        for (let j = 0; j < size; j++) {
          const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (size - 1));
          const angle = (2 * Math.PI * frequency * j) / rate;
          real[j] = window * Math.cos(angle);
          imaginary[j] = window * Math.sin(angle);
          weight += window;
        }
        return { real, imaginary, weight };
      });
    }
    const samples = new Float32Array(Math.ceil(input.length / stride));
    let power = 0;
    for (let i = 0; i < samples.length; i++) {
      // Box low-pass before decimation, instead of dropping all intermediate samples.
      let sum = 0,
        count = 0;
      for (let j = i * stride; j < Math.min(input.length, (i + 1) * stride); j++) {
        sum += input[j];
        count++;
      }
      samples[i] = sum / count;
      power += samples[i] ** 2;
    }
    const level = Math.sqrt(power / samples.length);
    const feature = new Float32Array(DIMENSIONS);
    if (level < 0.003) return { feature, level, voiced: false };
    const magnitudes = new Float32Array(PITCHES);
    for (let i = 0; i < PITCHES; i++) {
      const kernel = this.kernels[i];
      let real = 0,
        imaginary = 0;
      const start = samples.length - kernel.real.length;
      for (let j = Math.max(0, -start); j < kernel.real.length; j++) {
        real += samples[start + j] * kernel.real[j];
        imaginary += samples[start + j] * kernel.imaginary[j];
      }
      magnitudes[i] = (2 * Math.hypot(real, imaginary)) / kernel.weight;
    }
    const peak = Math.max(...magnitudes);
    for (let i = 0; i < PITCHES; i++) {
      // Subtract expected octave/third harmonics, retaining real simultaneous fundamentals.
      const harmonic =
        0.45 *
        ((magnitudes[i - 12] || 0) +
          0.6 * (magnitudes[i - 19] || 0) +
          0.4 * (magnitudes[i - 24] || 0));
      const skirt = 0.85 * Math.max(magnitudes[i - 1] || 0, magnitudes[i + 1] || 0);
      const value = Math.max(0, magnitudes[i] - skirt - harmonic - peak * 0.04);
      feature[i] = Math.sqrt(value);
      feature[PITCHES + ((LOW + i) % 12)] += Math.sqrt(value);
    }
    normalize(feature, 0, PITCHES);
    normalize(feature, PITCHES, 12);
    return { feature, level, voiced: peak > 0.002 };
  }
}

export type FollowResult = {
  state: 'listening' | 'uncertain' | 'matched';
  seconds: number;
  beat?: number;
  confidence?: number;
};
type Frame = { time: number; feature: Float32Array; voiced: boolean };
export class ScoreFollower {
  private reference: Float32Array[];
  private step: number;
  private frames: Frame[] = [];
  private lastMatchTime = -Infinity;
  private lastBeat: number;
  private matched = false;
  private started = 0;
  constructor(
    notes: Pick<ScoreNote, 'midi' | 'beat' | 'duration' | 'muted'>[],
    private tempo: number,
    beat = 0,
  ) {
    if (notes.length > 200000) throw Error('score-limit');
    const duration = notes.reduce((end, n) => Math.max(end, n.beat + n.duration), 1);
    this.step = Math.max(0.25, duration / 30000);
    // Sweep note on/off events so long documents do not require notes × frames work.
    const events = notes
      .filter((n) => !n.muted)
      .flatMap((n) => [
        { time: n.beat, midi: n.midi, change: 1 },
        { time: n.beat + n.duration, midi: n.midi, change: -1 },
      ])
      .sort((a, b) => a.time - b.time);
    const active = new Map<number, number>();
    let at = 0;
    this.reference = Array.from({ length: Math.ceil(duration / this.step) }, (_, i) => {
      const time = (i + 0.5) * this.step;
      while (at < events.length && events[at].time <= time) {
        const e = events[at++],
          count = (active.get(e.midi) || 0) + e.change;
        if (count > 0) active.set(e.midi, count);
        else active.delete(e.midi);
      }
      return pitchFeature([...active.keys()]);
    });
    this.lastBeat = beat;
  }
  reset(beat: number, tempo = this.tempo) {
    this.frames = [];
    this.lastBeat = beat;
    this.matched = false;
    this.lastMatchTime = -Infinity;
    this.tempo = tempo;
  }
  get bufferedFrames() {
    return this.frames.length;
  }
  push(feature: Float32Array, time: number, voiced: boolean): FollowResult | null {
    if (!Number.isFinite(time) || feature.length !== DIMENSIONS) return null;
    if (!this.frames.length) this.started = time;
    this.frames.push({ time, feature, voiced });
    while (this.frames.length > 80 || time - this.frames[0].time > 8) this.frames.shift();
    const seconds = Math.min(8, time - this.started);
    if (time - this.lastMatchTime < 0.45) return null;
    const dt = Number.isFinite(this.lastMatchTime) ? time - this.lastMatchTime : seconds;
    this.lastMatchTime = time;
    if (seconds < 5 || this.frames.filter((f) => f.voiced).length < 20)
      return { state: 'listening', seconds };
    // Silence never moves the cursor, even when the score contains a matching rest.
    if (!voiced) return { state: 'uncertain', seconds };
    let changes = 0;
    for (let i = 1; i < this.frames.length; i++)
      if (featureDistance(this.frames[i].feature, this.frames[i - 1].feature) > 0.15) changes++;
    if (changes < 3) return { state: 'uncertain', seconds };
    const expected = this.lastBeat + ((this.matched ? dt : seconds) * this.tempo) / 60;
    const candidates: { index: number; cost: number }[] = [];
    const reach = Math.max(8, ((dt * this.tempo) / 60) * 3);
    // Global acquisition from >=5 seconds of evidence; after locking, stay near the score position.
    for (let i = 0; i < this.reference.length; i++) {
      const beat = i * this.step;
      if (this.matched && (beat < this.lastBeat - 2 || beat > this.lastBeat + reach)) continue;
      const cost = featureDistance(feature, this.reference[i]);
      if (cost < 0.7)
        candidates.push({
          index: i,
          cost: cost + Math.min(0.12, Math.abs(beat - expected) * 0.002),
        });
    }
    candidates.sort((a, b) => a.cost - b.cost);
    const endpoints: number[] = [];
    for (const c of candidates) {
      if (endpoints.every((i) => Math.abs(i - c.index) * this.step >= 0.75))
        endpoints.push(c.index);
      if (endpoints.length === 24) break;
    }
    const span = Math.ceil(
      ((((this.frames.at(-1)!.time - this.frames[0].time) * this.tempo) / 60) * 2.5) / this.step,
    );
    const ranked = endpoints
      .map((end) => {
        const start = Math.max(0, end - span);
        let previous = new Float32Array(end - start + 2); // Free subsequence start, fixed endpoint.
        for (const f of this.frames) {
          const next = new Float32Array(previous.length);
          next[0] = Infinity;
          for (let j = 1; j < next.length; j++)
            next[j] =
              featureDistance(f.feature, this.reference[start + j - 1]) +
              Math.min(previous[j] + 0.04, previous[j - 1], next[j - 1] + 0.08);
          previous = next;
        }
        const beat = (end + 0.5) * this.step;
        const raw = previous.at(-1)! / this.frames.length;
        return { beat, raw, cost: raw + Math.min(0.12, Math.abs(beat - expected) * 0.002) };
      })
      .sort((a, b) => a.cost - b.cost);
    const best = ranked[0],
      other = ranked.find((r) => best && Math.abs(r.beat - best.beat) > 3);
    if (!best || best.raw > 0.48 || (other && other.cost - best.cost < 0.025))
      return { state: 'uncertain', seconds };
    if (this.matched && best.beat < this.lastBeat - 0.5) return { state: 'uncertain', seconds };
    this.lastBeat = this.matched ? Math.max(this.lastBeat, best.beat) : best.beat;
    this.matched = true;
    return { state: 'matched', seconds, beat: this.lastBeat, confidence: 1 - best.raw };
  }
}
