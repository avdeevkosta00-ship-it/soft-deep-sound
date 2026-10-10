/**
 * Visual mode: click the visualizer → the interface dissolves and the music becomes a wide
 * field of light waves, with the title, artist and time set quietly in the middle.
 */
import { h, $ } from './ui.js';
import { t as tr } from './i18n.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

export class VisualMode {
  constructor({ engine, getTrack, artistOf, toggle }) {
    Object.assign(this, { engine, getTrack, artistOf, toggle });
    this.el = null; this.open = false;
    this.data = new Uint8Array(engine.viz.frequencyBinCount);
    this.lines = 7; this.N = 64;
    this.v = Array.from({ length: this.lines }, () => new Float32Array(this.N));
  }
  get isOpen() { return this.open; }

  show() {
    if (this.open) return;
    const t = this.getTrack();
    this.open = true;
    const el = this.el = h('div', { class: 'visual', role: 'dialog', 'aria-label': 'Visual' },
      h('canvas', { class: 'vis-cv' }),
      h('div', { class: 'vis-meta' },
        h('div', { class: 'vis-title' }, t ? t.title : 'Soft&Deep Sound'),
        h('div', { class: 'vis-artist' }, t ? this.artistOf(t) : ''),
        h('div', { class: 'vis-time mono' }, h('span', { class: 'vis-cur' }, '00:00'), h('i', {}, '/'), h('span', { class: 'vis-dur' }, '00:00'))),
      h('div', { class: 'vis-hint mono' }, tr('vis.exit')));
    el.addEventListener('click', () => this.close());
    document.body.append(el);
    document.body.classList.add('visual-open');
    this.cv = el.querySelector('canvas'); this.g = this.cv.getContext('2d');
    this.curEl = el.querySelector('.vis-cur'); this.durEl = el.querySelector('.vis-dur'); this.lastSec = -1;
    // theme colours once; the glow follows the current cover colour (set on the cover frame)
    const cs = getComputedStyle(document.documentElement);
    const A = (cs.getPropertyValue('--accent-rgb').trim() || '59 231 224').split(/\s+/).join(',');
    const B = (cs.getPropertyValue('--blue-rgb').trim() || '107 156 255').split(/\s+/).join(',');
    const cf = document.getElementById('coverFrame');
    const P = (cf && getComputedStyle(cf).getPropertyValue('--pulse').trim()) || `rgb(${A})`;
    this.pal = { A, B, P };
    this.resize(); this.ro = () => this.resize(); addEventListener('resize', this.ro);
    if (!reduced()) {
      const src = $('#viz').getBoundingClientRect();
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.22,.9,.26,1)', fill: 'both' });
      this.cv.animate([{ clipPath: `inset(${src.top}px ${innerWidth - src.right}px ${innerHeight - src.bottom}px ${src.left}px round 16px)` }, { clipPath: 'inset(0 0 0 0 round 0px)' }],
        { duration: 700, easing: 'cubic-bezier(.22,.9,.26,1)', fill: 'both' });
      el.querySelector('.vis-meta').animate([{ opacity: 0, transform: 'translateY(14px)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'none' }],
        { duration: 600, delay: 260, easing: 'cubic-bezier(.22,.9,.26,1)', fill: 'both' });
    }
    const loop = () => { if (!this.open) return; this.frame(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  close() {
    if (!this.open || this.closing) return;
    this.closing = true;
    const el = this.el;
    const done = () => { cancelAnimationFrame(this.raf); el.remove(); this.el = null; this.open = false; this.closing = false; removeEventListener('resize', this.ro); };
    document.body.classList.remove('visual-open');
    if (reduced()) return done();
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 280, easing: 'ease-in', fill: 'both' }).finished.then(done);
  }

  update() {
    if (!this.open) return;
    const t = this.getTrack(); if (!t) return;
    const ti = this.el.querySelector('.vis-title'), ar = this.el.querySelector('.vis-artist');
    if (ti.textContent === t.title) return;
    ti.textContent = t.title; ar.textContent = this.artistOf(t);
    this.el.querySelector('.vis-meta').animate([{ opacity: 0, filter: 'blur(6px)' }, { opacity: 1, filter: 'none' }], { duration: 500 });
  }

  resize() {
    const d = devicePixelRatio || 1;
    this.cv.width = innerWidth * d; this.cv.height = innerHeight * d;
    this.W = innerWidth; this.H = innerHeight; this.g.setTransform(d, 0, 0, d, 0, 0);
  }

  frame() {
    const e = this.engine, g = this.g, W = this.W, H = this.H, N = this.N;
    const sec = Math.floor(e.time);
    if (sec !== this.lastSec) { this.lastSec = sec; this.curEl.textContent = fmt(e.time); this.durEl.textContent = fmt(e.duration); }
    const playing = e.playing;
    if (playing) e.viz.getByteFrequencyData(this.data);
    const now = performance.now() / 1000;
    const { A, B, P } = this.pal;
    // target spectrum (log-spaced)
    const target = new Float32Array(N);
    const bins = this.data.length, sr = e.ctx.sampleRate, hz = sr / (bins * 2);
    for (let i = 0; i < N; i++) {
      if (!playing) { target[i] = .04 + .03 * Math.sin(now * 1.2 + i * .3); continue; }
      const f0 = 40 * Math.pow(14000 / 40, i / N), f1 = 40 * Math.pow(14000 / 40, (i + 1) / N);
      let m = 0; for (let k = Math.floor(f0 / hz); k <= Math.ceil(f1 / hz) && k < bins; k++) m = Math.max(m, this.data[k]);
      target[i] = Math.pow(m / 255, 1.5) * (.7 + i / N * .5);
    }
    for (let l = 0; l < this.lines; l++) {
      const v = this.v[l], k = .5 / (1 + l * .9); // back lines follow more slowly
      for (let i = 0; i < N; i++) v[i] += (target[i] - v[i]) * (target[i] > v[i] ? k : k * .35);
    }
    g.clearRect(0, 0, W, H);
    // deep backdrop that follows the cover colour
    const bg = g.createRadialGradient(W / 2, H * .62, 0, W / 2, H * .62, Math.max(W, H) * .8);
    bg.addColorStop(0, 'rgba(30,60,80,.0)'); bg.addColorStop(1, 'rgba(0,0,0,.35)');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const mid = H * .62;
    for (let l = this.lines - 1; l >= 0; l--) {
      const v = this.v[l], amp = H * (.36 - l * .025), off = l * 14;
      const pts = [];
      for (let i = 0; i < N; i++) {
        const x = i / (N - 1) * W, edge = Math.pow(Math.sin(Math.PI * i / (N - 1)), .9);
        const wob = Math.sin(now * (.6 + l * .07) + i * .23 + l) * 6;
        pts.push([x, mid + off - (v[i] * amp + wob) * edge]);
      }
      g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 0; i < N - 1; i++) {
        const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        g.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
      }
      const col = l === 0 ? A : l % 2 ? B : A;
      const al = l === 0 ? .95 : .34 - l * .035;
      if (l === 0) {
        g.save(); g.lineTo(W, H); g.lineTo(0, H); g.closePath();
        const fill = g.createLinearGradient(0, mid - amp, 0, H);
        fill.addColorStop(0, `rgba(${A},.16)`); fill.addColorStop(.5, `rgba(${A},.03)`); fill.addColorStop(1, `rgba(${A},0)`);
        g.fillStyle = fill; g.fill(); g.restore();
        g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 0; i < N - 1; i++) {
          const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
          g.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
        }
        g.shadowColor = P; g.shadowBlur = 18;
      }
      g.strokeStyle = `rgba(${col},${Math.max(.05, al)})`; g.lineWidth = l === 0 ? 2 : 1; g.stroke(); g.shadowBlur = 0;
    }
  }
}
