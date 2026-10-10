/**
 * Ambient Generator v2 — calm procedural soundscapes + Smart Duck.
 *
 * Each layer is rendered once in an OfflineAudioContext with real biquad filters,
 * convolution and smooth envelopes (no raw clicks), then folded into a seamless loop:
 * the tail is cross-faded into the head, so the loop point is literally a continuation.
 * Levels are RMS-matched, so switching layers never jumps in loudness.
 */
export const LAYERS = [
  { key: 'rain', name: 'am.rain' },
  { key: 'ocean', name: 'am.ocean' },
  { key: 'fire', name: 'am.fire' },
  { key: 'train', name: 'am.train' },
  { key: 'vinyl', name: 'am.vinyl' }
];

const R = Math.random;
const rr = (a, b) => a + R() * (b - a);

/* ------------------------------ building blocks ------------------------------ */
function noise(oc, seconds, color = 'pink') {
  const n = Math.ceil(seconds * oc.sampleRate);
  const b = oc.createBuffer(2, n, oc.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = R() * 2 - 1;
      if (color === 'white') d[i] = w * .5;
      else if (color === 'brown') { last = (last + .02 * w) / 1.02; d[i] = last * 3.5; }
      else {
        b0 = .99886 * b0 + w * .0555179; b1 = .99332 * b1 + w * .0750759; b2 = .969 * b2 + w * .153852;
        b3 = .8665 * b3 + w * .3104856; b4 = .55 * b4 + w * .5329522; b5 = -.7616 * b5 - w * .016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * .5362) * .11; b6 = w * .115926;
      }
    }
  }
  return b;
}
const play = (oc, buf, dest, when = 0) => { const s = oc.createBufferSource(); s.buffer = buf; s.connect(dest); s.start(when); return s; };
function filt(oc, type, freq, Q = .707, dest) { const f = oc.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = Q; if (dest) f.connect(dest); return f; }
function gain(oc, v, dest) { const g = oc.createGain(); g.gain.value = v; if (dest) g.connect(dest); return g; }
/** smooth random curve in [lo, hi] — sum of slow sines */
function drift(seconds, lo, hi, speed = 1) {
  const n = Math.max(2, Math.ceil(seconds * 50)), out = new Float32Array(n);
  const parts = [0, 1, 2].map(() => ({ f: rr(.03, .12) * speed, p: R() * 6.28, a: R() }));
  const sum = parts.reduce((s, p) => s + p.a, 0);
  for (let i = 0; i < n; i++) {
    const t = i / 50;
    let v = 0; for (const p of parts) v += p.a * Math.sin(6.283 * p.f * t + p.p);
    out[i] = lo + (hi - lo) * (.5 + .5 * v / sum);
  }
  return out;
}
/** a short, softly-enveloped noise grain (attack avoids clicks) */
function grain(oc, ms, attackMs = .6) {
  const sr = oc.sampleRate, n = Math.ceil(ms / 1000 * sr * 5), a = attackMs / 1000 * sr, tau = ms / 1000 * sr;
  const b = oc.createBuffer(1, n, sr), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (R() * 2 - 1) * Math.min(1, i / a) * Math.exp(-i / tau);
  return b;
}
function impulse(oc, seconds, decay = 3) {
  const n = Math.ceil(seconds * oc.sampleRate), b = oc.createBuffer(2, n, oc.sampleRate);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (R() * 2 - 1) * Math.pow(1 - i / n, decay); }
  return b;
}
/** RBJ biquad applied in-place (bandpass / lowpass / highpass) — used to pre-shape grains */
function biquad(x, sr, type, f, Q) {
  const w = 2 * Math.PI * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * Q);
  let b0, b1, b2;
  if (type === 'lowpass') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
  else if (type === 'highpass') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
  else { b0 = al; b1 = 0; b2 = -al; }
  const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
  }
  return x;
}
/** Scatter many short filtered grains into ONE stereo buffer (fast: no per-grain audio nodes). */
function sprinkle(oc, dest, { count, span, ms, f: [f1, f2], Q, amp: [a1, a2], pan = .7, type = 'bandpass', cluster = 0 }) {
  const sr = oc.sampleRate, n = Math.ceil(span * sr);
  const out = oc.createBuffer(2, n, sr), L = out.getChannelData(0), Rc = out.getChannelData(1);
  const pool = Array.from({ length: 14 }, () => {
    const g = grain(oc, rr(ms[0], ms[1])).getChannelData(0);
    biquad(g, sr, type, rr(f1, f2), Q);
    let m = 0; for (const v of g) m = Math.max(m, Math.abs(v));
    for (let i = 0; i < g.length; i++) g[i] /= (m || 1);
    return g;
  });
  for (let i = 0; i < count; i++) {
    const t0 = R() * span, reps = cluster ? 1 + ((R() * cluster) | 0) : 1, p = (R() * 2 - 1) * pan;
    for (let k = 0; k < reps; k++) {
      const g = pool[(R() * pool.length) | 0];
      const a = a1 + Math.pow(R(), 2.2) * (a2 - a1);
      const pp = Math.max(-1, Math.min(1, p + rr(-.1, .1)));
      const gl = a * Math.cos((pp + 1) * Math.PI / 4), gr = a * Math.sin((pp + 1) * Math.PI / 4);
      const s0 = Math.floor((t0 + (cluster ? R() * .14 : 0)) * sr);
      for (let j = 0; j < g.length && s0 + j < n; j++) { L[s0 + j] += g[j] * gl; Rc[s0 + j] += g[j] * gr; }
    }
  }
  play(oc, out, dest);
}

/** render `build(oc, out, span)`, then fold tail into head and RMS-normalise */
async function renderLoop(ctx, seconds, xfSec, build) {
  const sr = ctx.sampleRate, span = seconds + xfSec;
  const oc = new OfflineAudioContext(2, Math.ceil(span * sr), sr);
  const out = gain(oc, 1, oc.destination);
  build(oc, out, span);
  const r = await oc.startRendering();
  const len = Math.round(seconds * sr), xf = Math.round(xfSec * sr);
  const buf = ctx.createBuffer(2, len, sr);
  let sq = 0, peak = 0;
  for (let c = 0; c < 2; c++) {
    const src = r.getChannelData(c), dst = buf.getChannelData(c);
    dst.set(src.subarray(0, len));
    for (let i = 0; i < xf; i++) {
      const t = i / xf;
      dst[i] = src[i] * Math.sin(t * Math.PI / 2) + src[len + i] * Math.cos(t * Math.PI / 2);
    }
    for (let i = 0; i < len; i++) { sq += dst[i] * dst[i]; peak = Math.max(peak, Math.abs(dst[i])); }
  }
  const rms = Math.sqrt(sq / (len * 2)) || 1e-9;
  const k = Math.min(.11 / rms, .85 / (peak || 1));
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] *= k; }
  return buf;
}

/* -------------------------------- generators -------------------------------- */
// Soft rain on a window: a warm filtered bed, a distant wash and gentle, filtered droplets.
const rain = (ctx) => renderLoop(ctx, 18, 2, (oc, out, span) => {
  const warm = filt(oc, 'lowpass', 5200, .5, out);
  const bedG = gain(oc, .55, warm);
  bedG.gain.setValueCurveAtTime(drift(span, .42, .62), 0, span);
  play(oc, noise(oc, span), filt(oc, 'highpass', 280, .5, filt(oc, 'lowpass', 3800, .4, bedG)));
  play(oc, noise(oc, span, 'brown'), filt(oc, 'lowpass', 220, .5, gain(oc, .35, warm)));
  sprinkle(oc, warm, { count: span * 26, span, ms: [2, 6], f: [2200, 4800], Q: 1.6, amp: [.015, .06] });
  sprinkle(oc, warm, { count: span * 5, span, ms: [8, 16], f: [900, 1700], Q: 3, amp: [.03, .08], pan: .5 });
});

// Ocean: slow swells — each wave opens a filter, then washes back as foam.
const ocean = (ctx) => renderLoop(ctx, 26, 3, (oc, out, span) => {
  const warm = filt(oc, 'lowpass', 6000, .5, out);
  for (const side of [-.55, .55]) {
    const pan = oc.createStereoPanner(); pan.pan.value = side; pan.connect(warm);
    const N = Math.ceil(span * 50), g = new Float32Array(N), fq = new Float32Array(N), foam = new Float32Array(N);
    g.fill(.12); fq.fill(260); foam.fill(0);
    let t = side < 0 ? rr(0, 1.5) : rr(2.5, 4.5);
    while (t < span) {
      const per = rr(7.5, 10), rise = per * rr(.3, .4), peakG = rr(.75, 1);
      for (let i = Math.floor(t * 50); i < Math.min(N, Math.ceil((t + per * 1.6) * 50)); i++) {
        const x = i / 50 - t;
        const env = x < rise ? Math.pow(Math.sin(x / rise * Math.PI / 2), 2) : Math.exp(-(x - rise) / (per * .35));
        g[i] = Math.max(g[i], .12 + env * peakG);
        fq[i] = Math.max(fq[i], 260 + env * 1500);
        const fx = x - rise * .8;
        if (fx > 0) foam[i] = Math.max(foam[i], Math.exp(-fx / (per * .3)) * Math.min(1, fx * 3));
      }
      t += per;
    }
    const body = gain(oc, 0, pan); body.gain.setValueCurveAtTime(g, 0, span);
    const lp = filt(oc, 'lowpass', 300, .6, body); lp.frequency.setValueCurveAtTime(fq, 0, span);
    play(oc, noise(oc, span), lp);
    const fg = gain(oc, 0, pan); fg.gain.setValueCurveAtTime(foam.map((v) => v * .1), 0, span);
    play(oc, noise(oc, span), filt(oc, 'highpass', 1800, .5, filt(oc, 'lowpass', 5500, .5, fg)));
    const sg = gain(oc, 0, pan); sg.gain.setValueCurveAtTime(g.map((v) => v * .35), 0, span);
    play(oc, noise(oc, span, 'brown'), filt(oc, 'lowpass', 140, .5, sg));
  }
});

// Fireplace: a soft breathing roar, warm flame body, sparse and muffled crackles.
const fire = (ctx) => renderLoop(ctx, 18, 2, (oc, out, span) => {
  const warm = filt(oc, 'lowpass', 4200, .5, out);
  const room = oc.createConvolver(); room.buffer = impulse(oc, .9, 4); room.connect(gain(oc, .18, warm));
  const roarG = gain(oc, .8, warm); roarG.gain.setValueCurveAtTime(drift(span, .55, .95, 1.6), 0, span);
  play(oc, noise(oc, span, 'brown'), filt(oc, 'lowpass', 240, .4, roarG));
  const bodyG = gain(oc, .06, warm); bodyG.gain.setValueCurveAtTime(drift(span, .02, .07, 2.5), 0, span);
  play(oc, noise(oc, span), filt(oc, 'bandpass', 650, .6, bodyG));
  const crack = gain(oc, 1, warm); crack.connect(room);
  sprinkle(oc, crack, { count: span * 1.8, span, ms: [2, 5], f: [1400, 2800], Q: 1.1, amp: [.03, .14], cluster: 6, pan: .6 });
  sprinkle(oc, crack, { count: span * .3, span, ms: [14, 26], f: [420, 760], Q: 1.8, amp: [.08, .16], pan: .4 });
});

// Night train, heard from inside the carriage: deep rumble, muffled "ta-dam … ta-dam".
const train = (ctx) => {
  const car = 2.5;
  return renderLoop(ctx, car * 7, car * .6, (oc, out, span) => {
    const cabin = filt(oc, 'lowpass', 2600, .5, out);
    const sway = gain(oc, 1, cabin); sway.gain.setValueCurveAtTime(drift(span, .8, 1, .7), 0, span);
    play(oc, noise(oc, span, 'brown'), filt(oc, 'lowpass', 110, .5, gain(oc, 1, sway)));
    play(oc, noise(oc, span), filt(oc, 'bandpass', 240, 1.1, gain(oc, .1, sway)));
    play(oc, noise(oc, span), filt(oc, 'bandpass', 900, .7, gain(oc, .022, sway)));
    const clack = filt(oc, 'lowpass', 700, .6);
    const room = oc.createConvolver(); room.buffer = impulse(oc, 1.1, 3.5);
    clack.connect(gain(oc, .8, cabin)); clack.connect(room); room.connect(gain(oc, .22, cabin));
    for (let c = 0; c * car < span; c++) {
      [0, .21, .78, .99].forEach((off, j) => {
        const t = c * car + off + .1; if (t > span - .3) return;
        const amp = (j % 2 ? .3 : .42) * rr(.85, 1.1);
        const o = oc.createOscillator(); o.frequency.setValueAtTime(82, t); o.frequency.exponentialRampToValueAtTime(52, t + .18);
        const g = gain(oc, 0, clack); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + .006); g.gain.exponentialRampToValueAtTime(.0005, t + .32);
        o.connect(g); o.start(t); o.stop(t + .35);
        const s = oc.createBufferSource(); s.buffer = grain(oc, 22, 2);
        s.connect(filt(oc, 'lowpass', 420, .8, gain(oc, amp * .6, clack))); s.start(t);
      });
    }
  });
};

// Vinyl: warm hiss, faint rumble, soft crackle, a quiet once-per-revolution tick.
const vinyl = (ctx) => {
  const rev = 1.8;
  return renderLoop(ctx, rev * 8, rev, (oc, out, span) => {
    const warm = filt(oc, 'lowpass', 5500, .5, out);
    play(oc, noise(oc, span), filt(oc, 'highpass', 2200, .5, filt(oc, 'lowpass', 7000, .5, gain(oc, .07, warm))));
    play(oc, noise(oc, span, 'brown'), filt(oc, 'lowpass', 55, .6, gain(oc, .5, warm)));
    sprinkle(oc, warm, { count: span * 11, span, ms: [.4, 1.4], f: [1800, 4200], Q: .8, amp: [.03, .2], pan: .2, attackMs: .1 });
    for (let t = .37; t < span; t += rev) {
      const s = oc.createBufferSource(); s.buffer = grain(oc, 3, .3);
      s.connect(filt(oc, 'bandpass', 900, 1.5, gain(oc, .12, warm))); s.start(t);
    }
  });
};

const GEN = { rain, ocean, fire, train, vinyl };

export class Ambient {
  constructor(engine) {
    this.engine = engine;
    const c = this.ctx = engine.ctx;
    this.bus = c.createGain();
    this.tone = c.createBiquadFilter(); this.tone.type = 'lowpass'; this.tone.frequency.value = 9000; this.tone.Q.value = .5;
    this.duck = c.createGain();
    this.bus.connect(this.tone).connect(this.duck).connect(engine.ambientIn);
    this.layers = {};
    for (const { key } of LAYERS) {
      const g = c.createGain(); g.gain.value = 0; g.connect(this.bus);
      this.layers[key] = { gain: g, src: null, buffer: null, pending: null, on: false, level: .5, stopTimer: null };
    }
    this.depth = .7; this.sensitivity = .5; this.master = .8;
    this.bus.gain.value = this.master;
    this.env = 0; this.reduction = 0; this.voiceLevel = 0;
    this.fbuf = new Float32Array(engine.voice.frequencyBinCount);
    this.avgDb = -60;
    setInterval(() => this.tick(), 40);
  }

  get anyOn() { return Object.values(this.layers).some((l) => l.on); }

  async setLayer(key, on) {
    const l = this.layers[key];
    if (!l) return;
    l.on = on;
    const t = this.ctx.currentTime;
    if (on) {
      if (!l.buffer) { l.pending = l.pending || GEN[key](this.ctx); l.buffer = await l.pending; }
      if (!l.on) return; // switched off while rendering
      if (l.stopTimer) { clearTimeout(l.stopTimer); l.stopTimer = null; }
      if (!l.src) {
        l.src = this.ctx.createBufferSource();
        l.src.buffer = l.buffer; l.src.loop = true;
        l.src.connect(l.gain);
        l.src.start(this.ctx.currentTime, Math.random() * l.buffer.duration);
      }
      if (this.ctx.state !== 'running') this.ctx.resume();
      l.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      l.gain.gain.setTargetAtTime(l.level, this.ctx.currentTime, .6); // slow, gentle fade-in
    } else {
      l.gain.gain.cancelScheduledValues(t);
      l.gain.gain.setTargetAtTime(0, t, .4);
      if (l.src && !l.stopTimer) {
        l.stopTimer = setTimeout(() => {
          l.stopTimer = null;
          if (l.on || !l.src) return;
          try { l.src.stop(); l.src.disconnect(); } catch {}
          l.src = null;
        }, 2600);
      }
    }
  }
  setLevel(key, v) { const l = this.layers[key]; if (!l) return; l.level = v; if (l.on) l.gain.gain.setTargetAtTime(v, this.ctx.currentTime, .08); }
  setMaster(v) { this.master = v; this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, .08); }

  /** Smart Duck: vocal-band presence → gain reduction with fast attack / slow release */
  tick() {
    const an = this.engine.voice;
    let presence = 0;
    if (this.engine.playing && this.anyOn) {
      an.getFloatFrequencyData(this.fbuf);
      const hz = this.ctx.sampleRate / an.fftSize;
      let voice = 0, total = 1e-12;
      for (let i = 1; i < this.fbuf.length; i++) {
        const f = i * hz; if (f < 40 || f > 16000) continue;
        const p = Math.pow(10, this.fbuf[i] / 10);
        total += p;
        if (f >= 300 && f <= 3400) voice += p;
      }
      const db = 10 * Math.log10(voice + 1e-12);
      this.avgDb = this.avgDb * .992 + db * .008;
      const ratio = voice / total;
      const thr = this.avgDb + 4 - this.sensitivity * 10;
      const loud = Math.min(1, Math.max(0, (db - thr) / 8));
      const vocalish = Math.min(1, Math.max(0, (ratio - .18) / .32));
      presence = loud * vocalish;
      this.voiceLevel = Math.min(1, Math.max(0, (db + 70) / 60));
    } else this.voiceLevel *= .8;
    this.env += (presence - this.env) * (presence > this.env ? .45 : .045);
    const target = 1 - this.depth * this.env;
    this.reduction = 1 - target;
    this.duck.gain.setTargetAtTime(target, this.ctx.currentTime, presence > this.env ? .05 : .4);
  }
}
