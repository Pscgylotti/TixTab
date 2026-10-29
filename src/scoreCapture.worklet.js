/* Timestamped mono 16 kHz PCM, 40 ms packets; no main-thread polling. */
class ScoreCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.packet = new Float32Array(640);
    this.used = 0;
    this.phase = 0;
    this.sum = 0;
    this.weight = 0;
    this.active = true;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.active = false;
    };
  }
  process(inputs) {
    if (!this.active) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const ratio = sampleRate / 16000;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      let remaining = 1;
      while (remaining > 1e-8) {
        const take = Math.min(remaining, ratio - this.phase);
        this.sum += value * take;
        this.weight += take;
        this.phase += take;
        remaining -= take;
        if (this.phase >= ratio - 1e-8) {
          this.packet[this.used++] = this.sum / this.weight;
          this.phase = this.sum = this.weight = 0;
          if (this.used === this.packet.length) {
            const packet = this.packet;
            this.port.postMessage({ samples: packet, time: (currentFrame + i + 1) / sampleRate }, [
              packet.buffer,
            ]);
            this.packet = new Float32Array(640);
            this.used = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('tixtab-score-capture', ScoreCapture);
