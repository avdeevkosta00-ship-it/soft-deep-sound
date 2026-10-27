/**
 * "Light wave" visualizer — one thin organic line with a translucent body and a slow echo.
 * Also feeds a bass value to a few elements (set per-element so the whole document is never
 * restyled per frame).
 */
const BANDS = 56;

export class Visualizer {
  constructor(canvas, analyser, isPlaying) {
    this.c = canvas; this.g = canvas.getContext('2d');
    this.an = analyser; this.isPlaying = isPlaying;
    this.data = new Uint8Array(analyser.frequencyBinCount);
    this.v = new Float32Array(BANDS); this.slow = new Float32Array(BANDS);
    this.bassEls = [];
    this.bass = 0;
    this.t = 0;
    this.edges = this.makeEdges(analyser.context.sampleRate, analyser.fftSize);
    this.readTheme();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    // nobody can see it while the window sits in the tray: skip the work (audio is unaffected)
    // a 144–165 Hz screen would draw it 2–3× more often for nothing: 60 fps with music, 30 at rest
    let last = 0;
    const loop = (now) => {
      requestAnimationFrame(loop);
      const b = document.body.classList;
      if (document.documentElement.classList.contains('win-hidden') || document.hidden || b.contains('deep-open') || b.contains('visual-open')) return;
      if (now - last < (this.isPlaying() ? 15.5 : 32)) return;
      this.dt = Math.min(.1, (now - last) / 1000); last = now; this.frame();
    };
    requestAnimationFrame(loop);
  }

  makeEdges(sr, fft) {
    const e = [], fmin = 38, fmax = 15000, hz = sr / fft;
    for (let i = 0; i <= BANDS; i++) e.push(Math.max(1, Math.round(fmin * Math.pow(fmax / fmin, i / BANDS) / hz)));
    return e;
  }

  readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const theme = document.documentElement.dataset.theme;
    const rgb = cs.getPropertyValue('--accent-rgb').trim().split(/\s+/).join(',') || '255,74,28';
    this.col = {
      a: cs.getPropertyValue('--viz-a').trim(),
      b: cs.getPropertyValue('--viz-b').trim(),
      ink: document.documentElement.dataset.tone === 'dark' ? 'rgba(255,255,255,.16)' : 'rgba(40,50,90,.16)',
      rgb, accent: `rgb(${rgb})`,
      blue: (cs.getPropertyValue('--blue-rgb').trim() || '107 156 255').split(/\s+/).join(','),
      dark: document.documentElement.dataset.tone === 'dark',
      w1: (cs.getPropertyValue('--wave-1').trim() || rgb.split(',').join(' ')).split(/\s+/).join(','),
      w2: (cs.getPropertyValue('--wave-2').trim() || rgb.split(',').join(' ')).split(/\s+/).join(',')
    };
  }

  resize() {
    const d = devicePixelRatio || 1, r = { width: this.c.clientWidth, height: this.c.clientHeight };
    this.c.width = Math.max(1, r.width * d); this.c.height = Math.max(1, r.height * d);
    this.W = r.width; this.H = r.height; this.g.setTransform(d, 0, 0, d, 0, 0);
  }

  frame() {
    this.t += this.dt || 1 / 60;
    const playing = this.isPlaying();
    if (playing) this.an.getByteFrequencyData(this.data);
    for (let b = 0; b < BANDS; b++) {
      let target = 0;
      if (playing) {
        let m = 0; const s = this.edges[b], e = Math.max(s + 1, this.edges[b + 1]);
        for (let i = s; i < e; i++) m = Math.max(m, this.data[i]);
        target = Math.pow(m / 255, 1.6) * (0.75 + b / BANDS * .55);
      } else target = .035 + .025 * Math.sin(this.t * 1.4 + b * .35);
      const cur = this.v[b];
      this.v[b] = cur + (target - cur) * (target > cur ? .55 : .14);
      this.slow[b] += (this.v[b] - this.slow[b]) * .08;
    }
    const bass = playing ? (this.v[1] + this.v[2] + this.v[3] + this.v[4]) / 4 : 0;
    this.bass += (bass - this.bass) * .3;
    const bv = Math.min(1, this.bass * 1.3).toFixed(3);
    for (const el of this.bassEls) el.style.setProperty('--bass', bv);
    this.draw();
  }

  /** smooth curve through points (Catmull-Rom → Bézier) */
  smooth(pts) {
    const g = this.g;
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      g.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
  }

  /** Soft&Deep: one thin organic light line with a soft translucent body and a faint echo */
  drawWave() {
    const g = this.g, W = this.W, H = this.H, n = 28;
    const base = H * .78, amp = H * .66, A = this.col.w1, B = this.col.w2;
    const sample = (arr, k) => {
      const pts = [];
      for (let i = 0; i < n; i++) {
        const f = i / (n - 1) * (BANDS - 1), j = Math.floor(f), fr = f - j;
        const v = arr[j] * (1 - fr) + (arr[Math.min(BANDS - 1, j + 1)] || 0) * fr;
        const edge = Math.pow(Math.sin(Math.PI * i / (n - 1)), .8);
        const drift = Math.sin(this.t * .9 + i * .55) * .018 + Math.sin(this.t * .37 + i * .21) * .012;
        pts.push([i / (n - 1) * W, base - (v * k + drift + .02) * amp * edge]);
      }
      return pts;
    };
    const lineGrad = (a) => {
      const gr = g.createLinearGradient(0, 0, W, 0);
      gr.addColorStop(0, `rgba(${A},0)`); gr.addColorStop(.18, `rgba(${A},${a})`); gr.addColorStop(.82, `rgba(${B},${a})`); gr.addColorStop(1, `rgba(${B},0)`);
      return gr;
    };
    const echo = sample(this.slow, 1.15);
    g.beginPath(); this.smooth(echo); g.strokeStyle = lineGrad(this.col.dark ? .3 : .35); g.lineWidth = 1; g.stroke();
    const pts = sample(this.v, 1);
    g.beginPath(); this.smooth(pts); g.lineTo(W, H); g.lineTo(0, H); g.closePath();
    const fill = g.createLinearGradient(0, base - amp, 0, H);
    fill.addColorStop(0, `rgba(${A},${this.col.dark ? .2 : .16})`); fill.addColorStop(.6, `rgba(${B},.04)`); fill.addColorStop(1, `rgba(${B},0)`);
    g.fillStyle = fill; g.fill();
    g.beginPath(); this.smooth(pts);
    g.strokeStyle = lineGrad(.95); g.lineWidth = 1.6; g.shadowColor = `rgba(${A},${this.col.dark ? .8 : .45})`; g.shadowBlur = this.col.dark ? 12 : 6; g.stroke(); g.shadowBlur = 0;
    // square markers on the peaks + ruler ticks on the baseline (the HUD language)
    g.fillStyle = `rgba(${A},.9)`;
    for (let i = 3; i < n - 3; i += 4) { const p = pts[i]; g.fillRect(p[0] - 1.5, p[1] - 9, 3, 3); }
    g.fillStyle = this.col.ink;
    for (let i = 0; i <= 24; i++) g.fillRect(Math.round(i / 24 * (W - 1)), base + 6, 1, i % 6 === 0 ? 5 : 2.5);
  }

  draw() {
    const g = this.g, W = this.W, H = this.H;
    if (!W) return;
    g.clearRect(0, 0, W, H);
    this.drawWave();
  }
}

/** Waveform seek bar (peaks come from the analysis worker). */
export class WaveSeek {
  constructor(canvas, opts = {}) {
    this.onDark = !!opts.onDark;
    this.c = canvas; this.g = canvas.getContext('2d'); this.peaks = null; this.p = 0; this.hover = -1;
    new ResizeObserver(() => { this.resize(); this.draw(); }).observe(canvas);
    this.resize();
  }
  resize() {
    const r = this.c.getBoundingClientRect(), d = devicePixelRatio || 1;
    this.c.width = Math.max(1, r.width * d); this.c.height = Math.max(1, r.height * d);
    this.W = r.width; this.H = r.height; this.g.setTransform(d, 0, 0, d, 0, 0);
  }
  /** new peaks morph from the previous waveform instead of popping in */
  set(peaks) {
    cancelAnimationFrame(this.tw);
    const from = this.peaks;
    if (!from || matchMedia('(prefers-reduced-motion: reduce)').matches) { this.peaks = peaks; this.draw(); return; }
    const N = 240, at = (arr, i) => (arr ? arr[Math.floor(i / N * arr.length)] || 0 : 4);
    const a = Array.from({ length: N }, (_, i) => at(from, i)), b = Array.from({ length: N }, (_, i) => at(peaks, i));
    const t0 = performance.now(), D = 520;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - k, 3);
      this.peaks = a.map((v, i) => v + (b[i] - v) * e);
      this.draw();
      if (k < 1) this.tw = requestAnimationFrame(step); else this.peaks = peaks;
    };
    this.tw = requestAnimationFrame(step);
  }
  progress(p) { if (Math.abs(p - this.p) > .0005) { this.p = p; this.draw(); } }
  draw() {
    const g = this.g, W = this.W, H = this.H;
    g.clearRect(0, 0, W, H);
    if (!this.peaks || !W) return;
    const bw = 2, gap = 1.2, n = Math.floor(W / (bw + gap));
    // colours are read once per theme and accent (Settings → Оформление), not on every frame
    const theme = document.documentElement.dataset.theme + '|' + document.documentElement.style.getPropertyValue('--accent');
    if (!this.pal || this.pal.theme !== theme) {
      const deep = this.onDark || document.documentElement.dataset.tone === 'dark';
      const cs = getComputedStyle(document.documentElement);
      const acc = cs.getPropertyValue('--accent').trim() || '#1f45e8';
      this.pal = { theme, acc, acc2: cs.getPropertyValue('--accent-2').trim() || acc,
        idle: deep ? 'rgba(255,255,255,.22)' : 'rgba(40,50,90,.20)', hov: deep ? 'rgba(255,255,255,.45)' : 'rgba(40,50,90,.38)' };
    }
    const { idle, hov, acc, acc2 } = this.pal;
    for (let i = 0; i < n; i++) {
      const v = this.peaks[Math.floor(i / n * this.peaks.length)] / 100;
      const h = Math.max(2, v * (H - 2));
      const x = i * (bw + gap), fx = x / W;
      g.fillStyle = fx <= this.p ? (fx > this.p - .004 ? acc2 : acc) : (this.hover >= 0 && fx <= this.hover ? hov : idle);
      g.beginPath(); g.roundRect(x, (H - h) / 2, bw, h, 1); g.fill();
    }
  }
}
