// Opening sequence: a point of light, the wordmark condenses, the app reveals.
import { $, $$ } from './ui.js';

function splitLetters() {
  let i = 0;
  for (const el of $$('#splash [data-split]')) {
    const txt = el.textContent;
    el.textContent = '';
    for (const ch of txt) {
      const s = document.createElement('span');
      s.className = 'ch';
      s.textContent = ch;
      s.style.setProperty('--i', el.classList.contains('wm-sound') ? i++ - 8 : i++);
      el.append(s);
    }
  }
}

function chime(ctx) {
  // soft Cmaj9 bloom with an airy delay tail — quiet, ~2.5 s
  const t = ctx.currentTime + .35;
  const out = ctx.createGain(); out.gain.value = .07;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(700, t); lp.frequency.exponentialRampToValueAtTime(4200, t + 1.4);
  const dl = ctx.createDelay(); dl.delayTime.value = .26;
  const fb = ctx.createGain(); fb.gain.value = .33;
  const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 2600;
  lp.connect(out); lp.connect(dl); dl.connect(dlp).connect(fb).connect(dl); dlp.connect(out);
  out.connect(ctx.destination);
  [261.63, 329.63, 392.0, 493.88, 587.33, 783.99].forEach((f, i) => {
    for (const [type, det, lvl] of [['sine', 0, 1], ['triangle', 6, .35]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det;
      const g = ctx.createGain(); const st = t + i * .085;
      g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(lvl * (1 - i * .09), st + .06);
      g.gain.exponentialRampToValueAtTime(.0008, st + 2.6);
      o.connect(g).connect(lp); o.start(st); o.stop(st + 2.8);
    }
  });
}

export function runSplash({ ctx, sound }) {
  splitLetters();
  if (sound) { try { ctx.resume().then(() => chime(ctx)); } catch {} }
  const sp = $('#splash');
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      sp.classList.add('out');
      setTimeout(() => document.body.classList.add('ready'), 60);
      setTimeout(() => { sp.remove(); resolve(); }, 520);
    };
    // short by design: ~1.2 s from the first light to a usable interface
    setTimeout(finish, matchMedia('(prefers-reduced-motion: reduce)').matches ? 300 : 1150);
    sp.addEventListener('click', finish);
    addEventListener('keydown', finish, { once: true });
  });
}
