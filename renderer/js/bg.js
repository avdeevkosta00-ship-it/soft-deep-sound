/**
 * Living background: slow, quiet motion that breathes a little with the music.
 * Rendered at half resolution, ~30 fps; time flows faster while music plays and
 * almost stops when paused, so the backdrop never competes with the UI.
 */
export class BackgroundFX {
  constructor(canvas, { isPlaying, energy }) {
    this.c = canvas; this.g = canvas.getContext('2d');
    this.isPlaying = isPlaying; this.energy = energy;
    this.t = Math.random() * 100; this.e = 0; this.speed = .2; this.last = 0;
    this.grain = null;
    this.readTheme();
    addEventListener('resize', () => this.resize());
    this.resize();
    // Settings → Оформление → «Живой фон»: live, calm (slower, barely reacts to the beat), still (one frame), off
    const loop = (now) => {
      requestAnimationFrame(loop);
      const fx = document.documentElement.dataset.fx || 'live';
      if (fx === 'off' || (fx === 'still' && this.drawn) || document.documentElement.classList.contains('win-hidden') || document.hidden || document.body.classList.contains('deep-open') || document.body.classList.contains('visual-open')) { this.last = now; return; }
      if (now - this.last < 32) return;
      this.pace = fx === 'calm' ? .35 : fx === 'still' ? 0 : 1;
      this.frame(Math.min(.1, (now - this.last) / 1000) * (this.pace || 0));
      this.drawn = true; this.last = now;
    };
    requestAnimationFrame(loop);
  }
  resize() {
    this.k = this.gl ? .5 : .75; // with WebGL shapes the backdrop itself can stay soft // the sphere wants a crisper canvas
    this.W = innerWidth; this.H = innerHeight;
    this.c.width = Math.ceil(this.W * this.k); this.c.height = Math.ceil(this.H * this.k);
    this.g.setTransform(this.k, 0, 0, this.k, 0, 0);
    this.grain = null; this.cloudLayer = null; this.bub = null; this.drawn = false;
  }
  setPulse(rgb) { this.pulseTarget = rgb; }
  readTheme() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    const prev = this.theme;
    this.theme = document.documentElement.dataset.theme;
    if (prev && prev !== this.theme) this.resize();
    this.col = { line: v('--line'), faint: v('--line-faint'), orb: v('--orb'), acc: v('--accent'), acc2: v('--accent-2'), rgb: v('--accent-rgb').split(/\s+/).join(',') };
    this.grain = null; this.drawn = false; // a still background repaints once in the new colours
  }
  frame(dt) {
    const playing = this.isPlaying();
    this.speed += ((playing ? 1 : .12) - this.speed) * .03;
    this.t += dt * this.speed;
    this.e += ((playing ? this.energy() * (this.pace === 1 ? 1 : .3) : 0) - this.e) * .08;
    // glide the glow colour towards the current cover colour
    const tgt = this.pulseTarget || this.col.rgb.split(',').map(Number);
    this.pulse = this.pulse ? this.pulse.map((v, i) => v + (tgt[i] - v) * .04) : [...tgt];
    this.prgb = this.pulse.map((v) => Math.round(v)).join(',');
    const g = this.g;
    g.clearRect(0, 0, this.W, this.H);
    const fn = { soft: this.sky, pearl: this.pearl, deep: this.noir, obsidian: this.obsidian }[this.theme] || this.sky;
    fn.call(this, g, this.W, this.H, this.t, this.e);
  }

  orb(g, x, y, r, color, alpha) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, color); gr.addColorStop(1, clear(g, color));
    g.globalAlpha = alpha; g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); g.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------------------
     Soft & Deep (v1.6): one glass sphere that breathes — slowly when it's quiet,
     with the bass when music plays — plus a few smaller bubbles drifting around it.
     SOFT = a clear soap-glass bubble in a bright sky (Soft Club);
     DEEP = a dark glass sphere on black with a neon light ribbon passing through it.
     --------------------------------------------------------------------------- */
  sphereLayout(W, H) {
    const m = Math.min(W, H);
    if (this.gl) return { x: W * .62, y: H * .56, r: m * .2 * 1.15 }; // matches shapes.js heroLayout (+ perspective)
    return { x: W * .6, y: H * .57, r: m * .26 };
  }
  breath(e) {
    const now = performance.now() / 1000;
    const idle = Math.sin(now * 1.15) * .014 + Math.sin(now * .43) * .008; // calm breathing
    this.kick = Math.max((this.kick || 0) * .9, e); // fast attack, soft release
    return 1 + idle + this.kick * .085;
  }
  bubbles(W, H) {
    if (this.bub && this.bub.W === W && this.bub.H === H) return this.bub.list;
    const R = (a, b) => a + Math.random() * (b - a);
    const list = [
      [.30, .90, .055], [.86, .22, .035], [.44, .80, .03], [.93, .74, .07], [.70, .12, .022], [.15, .66, .028], [.52, .93, .02]
    ].map(([x, y, r], i) => ({ x, y, r, ph: R(0, 6.28), sp: R(.04, .09), dx: R(-1, 1), focus: i % 3 !== 1 }));
    this.bub = { W, H, list };
    return list;
  }
  clouds(W, H) {
    if (this.cloudLayer && this.cloudLayer.width === Math.ceil(W * this.k)) return this.cloudLayer;
    const o = document.createElement('canvas'); o.width = Math.ceil(W * this.k); o.height = Math.ceil(H * this.k);
    const q = o.getContext('2d'); q.scale(this.k, this.k);
    const puff = (x, y, r, a) => { const gr = q.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(.55, `rgba(255,255,255,${a * .45})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); q.fillStyle = gr; q.fillRect(x - r, y - r, r * 2, r * 2); };
    const bank = (cx, cy, w, n, size) => { for (let i = 0; i < n; i++) puff(cx + (Math.random() - .5) * w, cy + (Math.random() - .5) * size * .9, size * (.5 + Math.random() * .7), .5 + Math.random() * .35); };
    bank(W * .12, H * .92, W * .45, 26, H * .22);
    bank(W * .82, H * .98, W * .5, 22, H * .2);
    bank(W * .05, H * .35, W * .18, 12, H * .16);
    bank(W * .62, H * .06, W * .4, 14, H * .12);
    bank(W * .98, H * .45, W * .14, 9, H * .14);
    this.cloudLayer = o;
    return o;
  }
  star(g, x, y, s, a, rot = 0) { // a four-point lens-flare star
    g.save(); g.translate(x, y); g.rotate(rot); g.globalAlpha = a;
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, s * .5); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(-s * .5, -s * .5, s, s);
    g.fillStyle = '#fff';
    for (let i = 0; i < 2; i++) { g.beginPath(); g.moveTo(-s, 0); g.quadraticCurveTo(0, -s * .045, s, 0); g.quadraticCurveTo(0, s * .045, -s, 0); g.fill(); g.rotate(Math.PI / 2); }
    g.restore(); g.globalAlpha = 1;
  }
  softBubble(g, x, y, r, a = 1) { // a clear soap-glass bubble for bright skies
    let gr = g.createRadialGradient(x, y, r * .2, x, y, r);
    gr.addColorStop(0, `rgba(255,255,255,${.04 * a})`); gr.addColorStop(.72, `rgba(120,160,255,${.08 * a})`);
    gr.addColorStop(.9, `rgba(255,255,255,${.75 * a})`); gr.addColorStop(.975, `rgba(255,255,255,${.95 * a})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.29); g.fill();
    if (g.createConicGradient) { // thin iridescent rim
      const cg = g.createConicGradient(this.t * .2, x, y);
      [[0, '120,170,255'], [.25, '255,170,240'], [.5, '140,240,255'], [.75, '40,80,240'], [1, '120,170,255']].forEach(([o, c]) => cg.addColorStop(o, `rgba(${c},${.55 * a})`));
      g.strokeStyle = cg; g.lineWidth = Math.max(.8, r * .018); g.beginPath(); g.arc(x, y, r * .985, 0, 6.29); g.stroke();
    }
    g.save(); g.translate(x - r * .38, y - r * .42); g.rotate(-.65);
    gr = g.createRadialGradient(0, 0, 0, 0, 0, r * .3); gr.addColorStop(0, `rgba(255,255,255,${.9 * a})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.scale(1, .5); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r * .3, 0, 6.29); g.fill(); g.restore();
  }
  darkBubble(g, x, y, r, a = 1, blur = 0) { // glass on black: only the rim and reflections catch light
    if (blur) { // out-of-focus bokeh
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(200,205,230,${.05 * a})`); gr.addColorStop(.8, `rgba(200,205,230,${.09 * a})`); gr.addColorStop(1, 'rgba(200,205,230,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.29); g.fill(); return;
    }
    let gr = g.createRadialGradient(x - r * .2, y - r * .25, r * .1, x, y, r);
    gr.addColorStop(0, `rgba(255,255,255,${.015 * a})`); gr.addColorStop(.8, `rgba(170,180,220,${.035 * a})`);
    gr.addColorStop(.965, `rgba(235,238,255,${.32 * a})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.29); g.fill();
    g.strokeStyle = `rgba(255,255,255,${.5 * a})`; g.lineWidth = Math.max(.8, r * .02);
    g.beginPath(); g.arc(x, y, r * .9, Math.PI * .15, Math.PI * .55); g.stroke();
    g.beginPath(); g.arc(x, y, r * .93, Math.PI * 1.15, Math.PI * 1.4); g.stroke();
    g.save(); g.translate(x - r * .42, y - r * .45); g.rotate(-.7);
    gr = g.createRadialGradient(0, 0, 0, 0, 0, r * .22); gr.addColorStop(0, `rgba(255,255,255,${.75 * a})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.scale(1, .45); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r * .22, 0, 6.29); g.fill(); g.restore();
  }

  sky(g, W, H, t, e) {
    const now = performance.now() / 1000;
    // sky
    let gr = g.createLinearGradient(0, 0, W * .35, H);
    gr.addColorStop(0, '#9fc6f2'); gr.addColorStop(.45, '#d6e7f9'); gr.addColorStop(1, '#f6f9fe');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    this.orb(g, W * .78, H * .18, Math.max(W, H) * .45, 'rgba(255,255,255,1)', .55);
    // drifting clouds (pre-rendered, slowly sliding)
    const cl = this.clouds(W, H), off = (t * 6) % W;
    g.globalAlpha = .9; g.drawImage(cl, -off, 0, W, H); g.drawImage(cl, W - off, 0, W, H); g.globalAlpha = 1;
    // HUD: dashed orbit, crosshair ticks, a dotted meridian
    const { x, y, r } = this.sphereLayout(W, H), k = this.breath(e), R = r * k;
    g.save(); g.strokeStyle = `rgba(${this.col.rgb},.28)`; g.lineWidth = 1;
    g.setLineDash([3, 6]); g.lineDashOffset = -t * 6;
    g.beginPath(); g.arc(x, y, r * 1.32, 0, 6.29); g.stroke();
    g.setLineDash([]);
    g.beginPath(); g.moveTo(x - r * 1.55, y); g.lineTo(x - r * 1.38, y); g.moveTo(x + r * 1.38, y); g.lineTo(x + r * 1.55, y);
    g.moveTo(x, y - r * 1.55); g.lineTo(x, y - r * 1.38); g.moveTo(x, y + r * 1.38); g.lineTo(x, y + r * 1.55); g.stroke();
    g.fillStyle = `rgba(${this.col.rgb},.55)`; g.beginPath(); g.arc(x + Math.cos(t * .12) * r * 1.32, y + Math.sin(t * .12) * r * 1.32, 2.5, 0, 6.29); g.fill();
    g.restore();
    if (this.gl) { this.flare(g, x, y, R, now); return; }
    // satellites (2D fallback when WebGL is unavailable)
    for (const b of this.bubbles(W, H)) {
      const bx = (b.x + Math.sin(now * b.sp + b.ph) * .015 + b.dx * Math.sin(t * .02 + b.ph) * .01) * W;
      const by = (b.y + Math.cos(now * b.sp * 1.3 + b.ph) * .02) * H;
      const br = b.r * Math.min(W, H) * (1 + (k - 1) * .6);
      this.softBubble(g, bx, by, br, b.focus ? .9 : .5);
    }
    // the sphere: refraction of the sky + a cobalt core that swells with the bass
    gr = g.createRadialGradient(x - R * .25, y + R * .35, 0, x, y, R);
    gr.addColorStop(0, `rgba(31,69,232,${.3 + this.kick * .25})`); gr.addColorStop(.55, 'rgba(80,130,255,.12)'); gr.addColorStop(1, 'rgba(80,130,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, R, 0, 6.29); g.fill();
    this.softBubble(g, x, y, R, 1);
    g.strokeStyle = 'rgba(31,69,232,.22)'; g.lineWidth = 1; g.beginPath(); g.arc(x, y, R * 1.004, 0, 6.29); g.stroke();
    this.flare(g, x, y, R, now);
  }
  /** a bright four-point lens flare on the rim, like sun on a CD */
  flare(g, x, y, R, now) {
    const fa = .75 + Math.sin(now * 1.7) * .15 + this.kick * .3, fx = x + R * .7, fy = y - R * .72;
    this.orb(g, fx, fy, R * .42, `rgba(${this.col.rgb},1)`, .2 + this.kick * .15);
    this.star(g, fx, fy, R * .75, Math.min(1, fa), .05);
    this.star(g, fx, fy, R * .2, .9, Math.PI / 4);
    this.orb(g, fx, fy, R * .5, 'rgba(255,255,255,1)', .35);
  }

  noir(g, W, H, t, e) {
    const now = performance.now() / 1000;
    g.fillStyle = '#040406'; g.fillRect(0, 0, W, H);
    const { x, y, r } = this.sphereLayout(W, H), k = this.breath(e), R = r * k;
    if (this.gl) { // shapes are drawn by WebGL; here only the light around them
      this.orb(g, x, y, R * 2.1, `rgba(${this.prgb},1)`, .05 + this.kick * .1);
      this.orb(g, x - R * .4, y - R * .5, R * 1.2, `rgba(${this.col.rgb},1)`, .05);
      this.vignette(g, W, H); return;
    }
    // far bokeh
    for (const b of this.bubbles(W, H)) {
      const bx = (b.x + Math.sin(now * b.sp + b.ph) * .015) * W, by = (b.y + Math.cos(now * b.sp * 1.3 + b.ph) * .02) * H;
      const br = b.r * Math.min(W, H) * (b.focus ? 1 : 2.2) * (1 + (k - 1) * .6);
      this.darkBubble(g, bx, by, br, b.focus ? .9 : .8, !b.focus);
    }
    // soft halo behind the sphere tinted by the cover colour
    this.orb(g, x, y, R * 1.9, `rgba(${this.prgb},1)`, .06 + this.kick * .12);
    // the neon ribbon: outside the sphere it is faint, inside it is bright (refracted)
    const ribbon = (inside) => {
      g.save();
      if (inside) { g.beginPath(); g.arc(x, y, R * .97, 0, 6.29); g.clip(); }
      g.globalCompositeOperation = 'lighter';
      const lg = g.createLinearGradient(x - R * 2.2, 0, x + R * 2.2, 0);
      lg.addColorStop(0, 'rgba(255,95,210,0)'); lg.addColorStop(.3, 'rgba(255,95,210,1)'); lg.addColorStop(.55, 'rgba(143,123,255,1)'); lg.addColorStop(.8, 'rgba(79,139,255,1)'); lg.addColorStop(1, 'rgba(79,139,255,0)');
      for (const [ph, amp, w, al] of [[0, .32, 2.2, 1], [1.7, .22, 1.2, .6], [3.1, .4, .8, .4]]) {
        g.beginPath();
        for (let i = 0; i <= 64; i++) {
          const u = i / 64, px = x - R * 2.2 + u * R * 4.4;
          const py = y + Math.sin(u * 5.2 + now * .55 + ph) * R * amp * (1 + this.kick * .6) * (inside ? 1.15 : 1) + Math.sin(u * 2.1 - now * .3) * R * .12;
          i ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.strokeStyle = lg; g.globalAlpha = (inside ? .75 : .22) * al;
        g.lineWidth = w * (inside ? 1.6 : 1) * (1 + this.kick * .8);
        g.shadowColor = 'rgba(160,120,255,1)'; g.shadowBlur = inside ? 16 : 8;
        g.stroke();
      }
      g.restore(); g.globalAlpha = 1;
    };
    ribbon(false);
    this.darkBubble(g, x, y, R, 1);
    ribbon(true);
    // the rim catches a little of the neon
    if (g.createConicGradient) {
      const cg = g.createConicGradient(now * .1, x, y);
      [[0, '255,95,210'], [.33, '143,123,255'], [.66, '79,139,255'], [1, '255,95,210']].forEach(([o, c]) => cg.addColorStop(o, `rgba(${c},${.18 + this.kick * .25})`));
      g.strokeStyle = cg; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, R * .995, 0, 6.29); g.stroke();
    }
    this.vignette(g, W, H);
  }
  vignette(g, W, H) {
    const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .35, W / 2, H / 2, Math.max(W, H) * .8);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)');
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
  }

  /* Pearl: milky light with slow iridescent haze, the same HUD orbit as Soft */
  pearl(g, W, H, t, e) {
    const now = performance.now() / 1000;
    let gr = g.createLinearGradient(0, 0, W * .4, H);
    gr.addColorStop(0, '#e6dcf6'); gr.addColorStop(.5, '#f6f2fb'); gr.addColorStop(1, '#e4f1f7');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    const haze = [[.18, .2, '255,170,215'], [.82, .15, '170,150,255'], [.75, .85, '140,225,235'], [.25, .8, '255,215,170']];
    haze.forEach(([hx, hy, c], i) => this.orb(g, (hx + Math.sin(now * .05 + i) * .05) * W, (hy + Math.cos(now * .04 + i) * .05) * H, Math.max(W, H) * .4, `rgba(${c},1)`, .35));
    const { x, y, r } = this.sphereLayout(W, H), k = this.breath(e), R = r * k;
    g.save(); g.strokeStyle = `rgba(${this.col.rgb},.26)`; g.lineWidth = 1;
    g.setLineDash([2, 7]); g.lineDashOffset = -t * 6;
    g.beginPath(); g.arc(x, y, r * 1.34, 0, 6.29); g.stroke(); g.setLineDash([]);
    g.beginPath(); g.ellipse(x, y, r * 1.6, r * .42, -.35, 0, 6.29); g.stroke();
    g.restore();
    this.orb(g, x, y, R * 1.3, 'rgba(255,255,255,1)', .5);
    if (this.gl) { this.flare(g, x, y, R, now); return; }
    this.softBubble(g, x, y, R, 1); this.flare(g, x, y, R, now);
  }

  /* Obsidian: black, a cold spotlight from the upper left, nothing else to look at */
  obsidian(g, W, H, t, e) {
    g.fillStyle = '#050505'; g.fillRect(0, 0, W, H);
    const { x, y, r } = this.sphereLayout(W, H), k = this.breath(e), R = r * k;
    this.orb(g, x - R * .9, y - R * 1.1, R * 2.4, 'rgba(120,124,135,1)', .16);
    this.orb(g, x, y, R * 1.6, `rgba(${this.prgb},1)`, .03 + this.kick * .08);
    if (!this.gl) this.darkBubble(g, x, y, R, 1);
    this.vignette(g, W, H);
  }

}

/** same colour with alpha 0 — avoids grey fringes when a gradient fades out */
function clear(g, color) {
  g.fillStyle = color; const c = g.fillStyle;
  if (c.startsWith('#')) { const n = parseInt(c.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},0)`; }
  return c.replace(/rgba?\(([^,]+),([^,]+),([^,)]+).*$/, 'rgba($1,$2,$3,0)');
}
