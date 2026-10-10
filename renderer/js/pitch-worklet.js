/**
 * Real-time pitch shifter (AudioWorklet).
 * Dual-tap rotating delay line (granular "Doppler" shifter): two read heads sweep through a
 * circular buffer at speed = ratio, crossfaded with complementary sin² windows so the sum is
 * always unity. Tempo is untouched — only key changes. Bypass is crossfaded (no clicks) and
 * keeps the same latency, so toggling never shifts the timeline.
 */
class SoftDeepPitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor(options) {
    super();
    const init = options && options.processorOptions && options.processorOptions.ratio;
    this.size = 1 << 17;
    this.mask = this.size - 1;
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
    this.w = 0;
    this.phase = 0;
    this.win = Math.round(sampleRate * 0.065); // grain length ~65 ms
    this.minDelay = 4;
    this.dryDelay = this.win / 2 + this.minDelay; // align dry path with the mean wet delay
    // offline export starts already at the target ratio (no glide in the first milliseconds)
    this.ratio = init || 1;
    this.mix = init && Math.abs(init - 1) > 1e-4 ? 1 : 0;
  }

  read(b, pos) {
    pos = ((pos % this.size) + this.size) % this.size;
    const i = pos | 0;
    const f = pos - i;
    const a = b[i & this.mask];
    const c = b[(i + 1) & this.mask];
    return a + (c - a) * f;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const n = output[0].length;
    const target = params.ratio[0];
    const W = this.win;
    const targetMix = Math.abs(target - 1) < 1e-4 ? 0 : 1;
    const PI = Math.PI;

    for (let i = 0; i < n; i++) {
      // smooth parameter + bypass crossfade per-sample
      this.ratio += (target - this.ratio) * 0.0015;
      this.mix += (targetMix - this.mix) * 0.0015;
      this.phase += (1 - this.ratio) / W;
      if (this.phase >= 1) this.phase -= 1; else if (this.phase < 0) this.phase += 1;
      const p1 = this.phase;
      let p2 = p1 + 0.5; if (p2 >= 1) p2 -= 1;
      const s1 = Math.sin(PI * p1), s2 = Math.sin(PI * p2);
      const g1 = s1 * s1, g2 = s2 * s2;
      const d1 = p1 * W + this.minDelay, d2 = p2 * W + this.minDelay;

      for (let ch = 0; ch < output.length; ch++) {
        const b = this.buf[ch & 1];
        const src = input && input.length ? (input[ch] || input[0]) : null;
        b[this.w] = src ? src[i] : 0;
        const dry = this.read(b, this.w - this.dryDelay);
        let out = dry;
        if (this.mix > 1e-4) {
          const wet = this.read(b, this.w - d1) * g1 + this.read(b, this.w - d2) * g2;
          out = dry + (wet - dry) * this.mix;
        }
        output[ch][i] = out;
      }
      this.w = (this.w + 1) & this.mask;
    }
    return true;
  }
}

registerProcessor('sds-pitch-shifter', SoftDeepPitchShifter);
