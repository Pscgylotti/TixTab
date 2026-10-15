import { instrumentVoice } from './musicInstruments';
import type { ScoreNote } from './musicScore';
/** Bounded oscillator voices and a short scheduling horizon; no soundfont/model heap. */
export class MusicAudio {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private voices = new Map<OscillatorNode, GainNode>();
  private startTime = 0;
  private startBeat = 0;
  private tempo = 120;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private disposed = false;
  private micGeneration = 0;
  private generation = 0;
  private instrument = 0;
  private waves = new Map<number, PeriodicWave>();
  setInstrument(program: number) {
    if (Number.isInteger(program) && program >= 0 && program <= 127) this.instrument = program;
  }
  async ready() {
    if (this.disposed) throw Error('cancelled');
    this.context ??= new AudioContext();
    await this.context.resume();
    if (this.disposed) throw Error('cancelled');
    if (!this.gain) {
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
    }
    return this.context;
  }
  setVolume(value: number) {
    if (this.gain)
      this.gain.gain.setValueAtTime(
        Math.max(0, Math.min(1, value)) * 0.22,
        this.context!.currentTime,
      );
  }
  currentBeat() {
    return (
      this.startBeat +
      (this.context
        ? (Math.max(0, this.context.currentTime - this.startTime) * this.tempo) / 60
        : 0)
    );
  }
  stop() {
    this.generation++;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const [voice, envelope] of this.voices) {
      try {
        voice.stop();
      } catch {}
      voice.disconnect();
      envelope.disconnect();
      voice.onended = null;
    }
    this.voices.clear();
  }
  async play(
    notes: ScoreNote[],
    beat: number,
    tempo: number,
    volume: number,
    duration: number,
    tick: (beat: number) => void,
    done: () => void,
  ) {
    this.stop();
    const generation = this.generation;
    const ctx = await this.ready();
    if (this.generation !== generation) return;
    this.setVolume(volume);
    this.startTime = ctx.currentTime + 0.03;
    this.startBeat = beat;
    this.tempo = tempo;
    let at = notes.findIndex((n) => n.beat + n.duration > beat);
    if (at < 0) at = notes.length;
    const pump = () => {
      const b = this.currentBeat();
      tick(Math.min(duration, b));
      if (b >= duration) {
        this.stop();
        done();
        return;
      }
      while (at < notes.length && notes[at].beat < b + (0.18 * tempo) / 60) {
        const n = notes[at++];
        if (n.muted || n.beat + n.duration <= b || this.voices.size >= 64) continue;
        const start = Math.max(ctx.currentTime, this.startTime + ((n.beat - beat) * 60) / tempo),
          end = Math.max(
            start + 0.025,
            this.startTime + ((n.beat + n.duration - beat) * 60) / tempo,
          );
        const oscillator = ctx.createOscillator(),
          envelope = ctx.createGain();
        const voice = instrumentVoice(this.instrument);
        if (voice.harmonics) {
          let wave = this.waves.get(this.instrument);
          if (!wave) {
            const imaginary = Float32Array.from([0, ...voice.harmonics]);
            wave = ctx.createPeriodicWave(new Float32Array(imaginary.length), imaginary);
            this.waves.set(this.instrument, wave);
          }
          oscillator.setPeriodicWave(wave);
        } else oscillator.type = voice.type;

        oscillator.frequency.value = 440 * 2 ** ((n.midi - 69) / 12);
        envelope.gain.setValueAtTime(0, start);
        const attack = Math.min(voice.attack, (end - start) * 0.3);
        envelope.gain.linearRampToValueAtTime(0.7, start + attack);
        envelope.gain.exponentialRampToValueAtTime(
          voice.sustain,
          Math.max(start + attack + 0.001, end - 0.02),
        );
        envelope.gain.linearRampToValueAtTime(0, end);
        oscillator.connect(envelope);
        envelope.connect(this.gain!);
        this.voices.set(oscillator, envelope);
        oscillator.onended = () => {
          this.voices.delete(oscillator);
          oscillator.disconnect();
          envelope.disconnect();
        };
        oscillator.start(start);
        oscillator.stop(end + 0.01);
      }
    };
    pump();
    this.timer = setInterval(pump, 40);
  }
  async microphone() {
    this.stopMic();
    const generation = this.micGeneration;
    const ctx = await this.ready();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (this.disposed || generation !== this.micGeneration) {
      stream.getTracks().forEach((t) => t.stop());
      throw Error('cancelled');
    }
    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);
    return { analyser: this.analyser, sampleRate: ctx.sampleRate };
  }
  stopMic() {
    this.micGeneration++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source?.disconnect();
    this.source = null;
    this.analyser?.disconnect();
    this.analyser = null;
  }
  dispose() {
    this.disposed = true;
    this.stop();
    this.stopMic();
    this.gain?.disconnect();
    this.gain = null;
    void this.context?.close();
    this.context = null;
    this.waves.clear();
  }
}
