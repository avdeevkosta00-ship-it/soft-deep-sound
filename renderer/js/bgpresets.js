/**
 * Built-in animated backgrounds (Settings → Оформление → Свой фон): drawn here, no image files.
 * Colours come from the current theme and accent, so every one fits every theme:
 *   aurora — soft light blobs drifting into each other;
 *   waves  — layered slow waves rising from the bottom;
 *   drift  — a constellation: slow points joined by faint lines when close;
 *   silk   — glowing ribbons flowing across.
 * Half resolution, ~30 fps, resting while the window is hidden or a full-screen view covers it;
 * with reduced motion only one still frame is drawn. The beat nudges them, gently.
 */
export const PRESET_IDS = ['aurora', 'waves', 'drift', 'silk'];

function palette() {
  const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
  const rgb = (n, d) => (v(n) || d).split(/[\s,]+/).map(Number);             // «31 69 232»
  const hex = (x) => [0, 2, 4].map((i) => parseInt(x.replace('#', '').slice(i, i + 2), 16)); // «#1f45e8»
  return {
    dark: document.documentElement.dataset.tone === 'dark',
    a: rgb('--accent-rgb', '120 110 255'), b: hex(v('--accent-2') || '#ff7ad9'), c: rgb('--n3-rgb', '80 180 255'),
    bg1: hex(v('--bg-1') || '#0b0b10'), bg3: hex(v('--bg-3') || '#000000')
  };
}
const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

/* ------------------------------ the four scenes ------------------------------ */
function base(g, W, H, p) {
  const gr = g.createLinearGradient(0, 0, W * .4, H);
  gr.addColorStop(0, rgba(p.bg1, 1)); gr.addColorStop(1, rgba(p.bg3, 1));
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
}

function aurora(g, W, H, t, p, e) {
  base(g, W, H, p);
  g.globalCompositeOperation = p.dark ? 'lighter' : 'source-over';
  const blobs = [[p.a, .31, .37, .55, .23], [p.b, .69, .58, .5, .17], [p.c, .5, .2, .45, .29], [p.a, .2, .78, .4, .13]];
  blobs.forEach(([c, x, y, r, sp], i) => {
    const X = W * (x + Math.sin(t * sp + i * 1.7) * .16), Y = H * (y + Math.cos(t * sp * .8 + i) * .14);
    const R = Math.max(W, H) * r * (1 + e * .12);
    const gr = g.createRadialGradient(X, Y, 0, X, Y, R);
    gr.addColorStop(0, rgba(c, p.dark ? .42 : .36)); gr.addColorStop(.55, rgba(c, p.dark ? .12 : .1)); gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  });
  g.globalCompositeOperation = 'source-over';
}

function waves(g, W, H, t, p, e) {
  base(g, W, H, p);
  const layers = 5;
  for (let i = 0; i < layers; i++) {
    const k = i / (layers - 1), c = [p.c, p.a, p.b, p.a, p.c][i];
    const y0 = H * (.48 + k * .1), amp = H * (.045 + k * .02) * (1 + e * .3), len = W * (.9 - k * .25), sp = .25 + k * .18;
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W + 8; x += 8) g.lineTo(x, y0 + Math.sin(x / len * Math.PI * 2 + t * sp + i * 1.3) * amp + Math.sin(x / (len * .43) + t * sp * 1.7) * amp * .35);
    g.lineTo(W, H); g.closePath();
    const gr = g.createLinearGradient(0, y0 - amp, 0, H);
    gr.addColorStop(0, rgba(c, p.dark ? .2 + k * .08 : .16 + k * .07)); gr.addColorStop(1, rgba(c, p.dark ? .02 : .04));
    g.fillStyle = gr; g.fill();
  }
}

function drift(g, W, H, t, p, e, st) {
  base(g, W, H, p);
  if (!st.pts || st.W !== W || st.H !== H) {
    const n = Math.round(Math.min(120, Math.max(26, W * H / 6000)));
    st.pts = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * 9, vy: (Math.random() - .5) * 9, r: 1 + Math.random() * 1.8, c: Math.random() }));
    st.W = W; st.H = H; st.last = t;
  }
  const dt = Math.min(.1, Math.max(0, t - st.last)); st.last = t;
  const lim = Math.min(W, H) * .16, pts = st.pts;
  for (const q of pts) {
    q.x += q.vx * dt * (1 + e); q.y += q.vy * dt * (1 + e);
    if (q.x < -10) q.x = W + 10; if (q.x > W + 10) q.x = -10; if (q.y < -10) q.y = H + 10; if (q.y > H + 10) q.y = -10;
  }
  g.lineWidth = 1;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d = Math.hypot(dx, dy);
    if (d < lim) { g.strokeStyle = rgba(p.a, (1 - d / lim) * (p.dark ? .5 : .38)); g.beginPath(); g.moveTo(pts[i].x, pts[i].y); g.lineTo(pts[j].x, pts[j].y); g.stroke(); }
  }
  for (const q of pts) {
    const c = q.c < .5 ? p.a : q.c < .8 ? p.b : p.c;
    g.fillStyle = rgba(c, p.dark ? .85 : .7); g.beginPath(); g.arc(q.x, q.y, q.r * (1 + e * .5), 0, Math.PI * 2); g.fill();
  }
}

function silk(g, W, H, t, p, e) {
  base(g, W, H, p);
  g.globalCompositeOperation = p.dark ? 'lighter' : 'source-over';
  const n = 7;
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1), c = [p.a, p.b, p.c][i % 3];
    const yc = H * (.3 + k * .4), amp = H * (.14 + .05 * Math.sin(t * .2 + i)) * (1 + e * .2);
    g.beginPath();
    for (let x = -20; x <= W + 20; x += 10) {
      const y = yc + Math.sin(x / W * Math.PI * 2 * (1.1 + k * .4) + t * (.18 + k * .07) + i) * amp * .6 + Math.sin(x / W * Math.PI * 5 + t * .31 + i * 2) * amp * .18;
      x === -20 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.strokeStyle = rgba(c, p.dark ? .34 : .28); g.lineWidth = 1.2 + k * 1.6;
    g.shadowColor = rgba(c, .8); g.shadowBlur = p.dark ? 14 : 6;
    g.stroke();
  }
  g.shadowBlur = 0;
  g.globalCompositeOperation = 'source-over';
}

const SCENES = { aurora, waves, drift, silk };

/** a still frame for the gallery tile */
export function drawPresetThumb(canvas, id) {
  const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height, p = palette();
  (SCENES[id] || aurora)(g, W, H, 7.3, p, 0, {});
  // full screen the scenes are calm on purpose; a tile that small needs them louder to be told apart
  if (p.dark) { g.globalCompositeOperation = 'lighter'; g.globalAlpha = .7; g.drawImage(canvas, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; }
}

/** the running background behind the interface */
export function createPresetBg({ energy = () => 0 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'ubg-canvas';
  const g = canvas.getContext('2d');
  let id = null, raf = 0, last = 0, t = Math.random() * 40, pal = palette(), st = {}, drewStill = false;
  const K = .5;
  const size = () => { canvas.width = Math.ceil(innerWidth * K); canvas.height = Math.ceil(innerHeight * K); st = {}; drewStill = false; };
  const resting = () => document.hidden || document.documentElement.classList.contains('win-hidden') ||
    document.body.classList.contains('deep-open') || document.body.classList.contains('visual-open');
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    if (!id || resting()) { last = now; return; }
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still && drewStill) return;
    if (now - last < 33) return;
    const dt = Math.min(.1, (now - last) / 1000); last = now;
    if (!still) t += dt;
    SCENES[id](g, canvas.width, canvas.height, t, pal, still ? 0 : Math.min(1, energy() || 0), st);
    drewStill = true;
  };
  addEventListener('resize', size);
  size();
  return {
    canvas,
    start(next) { id = SCENES[next] ? next : 'aurora'; st = {}; drewStill = false; if (!raf) raf = requestAnimationFrame(loop); },
    stop() { id = null; cancelAnimationFrame(raf); raf = 0; },
    /** theme or accent changed */
    recolor() { pal = palette(); drewStill = false; }
  };
}
