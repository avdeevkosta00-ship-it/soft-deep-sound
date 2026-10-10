/**
 * Deep View — full-screen "Now Playing".
 * Opens with a shared-element transition: the artwork flies from the Now Playing panel
 * into place while the backdrop (the cover itself, blurred) fades in and the details
 * rise in a short stagger. Closing is the same motion in reverse, a bit faster.
 */
import { $, h, esc, fmt, clamp } from './ui.js';
import { t as tr, tn } from './i18n.js';
import { ICON } from './icons.js';
import { WaveSeek } from './visualizer.js';
import { findSimilar, analyzed, quality } from './smart.js';

const ENTER = 'cubic-bezier(.16,.84,.24,1)', EXIT = 'cubic-bezier(.5,0,.75,.3)';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class DeepView {
  constructor(api) {
    this.api = api; // { engine, getTrack, tracks, art, artistOf, playIds, playNext, next, prev, toggle, ensureAnalysis, ensureFormat, onSimilar }
    this.el = null; this.open = false; this.busy = false;
  }
  get isOpen() { return this.open; }
  toggle() { this.open ? this.close() : this.show(); }

  show() {
    const t = this.api.getTrack();
    if (!t || this.open || this.busy) return;
    this.open = true; this.busy = true;
    const el = this.el = this.build(t);
    document.body.append(el);
    document.body.classList.add('deep-open');
    const src = $('#coverFrame').getBoundingClientRect();
    const cover = el.querySelector('.dv-cover');
    const dst = cover.getBoundingClientRect();
    const items = [...el.querySelectorAll('.dv-in')];
    const done = () => { if (this.closing) return; this.busy = false; el.querySelector('.dv-close').focus({ preventScroll: true }); };
    if (reduced()) { el.classList.add('shown'); done(); }
    else {
      $('#coverFrame').style.visibility = 'hidden';
      el.querySelector('.dv-bg').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease-out', fill: 'both' });
      const dx = src.left - dst.left, dy = src.top - dst.top, s = src.width / dst.width;
      cover.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${s})`, borderRadius: `${24 / s}px` }, { transform: 'none', borderRadius: '30px' }],
        { duration: 640, easing: ENTER, fill: 'both' }).finished.catch(() => {}).then(() => { if (!this.closing) $('#coverFrame').style.visibility = ''; done(); });
      items.forEach((n, i) => n.animate([{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }],
        { duration: 520, delay: 140 + i * 45, easing: ENTER, fill: 'both' }));
      el.classList.add('shown');
    }
    this.bindLoop();
    this.api.ensureFormat(t).then(() => this.refreshMeta());
    this.api.ensureAnalysis(t);
  }

  close() {
    if (!this.open || this.closing) return;
    const el = this.el;
    // interrupt a still-running opening animation so Esc always works
    if (this.busy) el.getAnimations({ subtree: true }).forEach((a) => { if (a instanceof CSSAnimation) return; try { a.finish(); } catch {} });
    this.busy = true; this.closing = true;
    const finish = () => { if (this.el !== el) return; el.remove(); this.el = null; this.open = false; this.busy = false; this.closing = false; document.body.classList.remove('deep-open'); cancelAnimationFrame(this.raf); $('#coverFrame').style.visibility = ''; };
    if (reduced()) return finish();
    const cover = el.querySelector('.dv-cover'), dst = $('#coverFrame').getBoundingClientRect(), src = cover.getBoundingClientRect();
    const dx = dst.left - src.left, dy = dst.top - src.top, s = dst.width / src.width;
    [...el.querySelectorAll('.dv-in')].forEach((n) => n.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(10px)' }], { duration: 180, easing: EXIT, fill: 'both' }));
    el.querySelector('.dv-bg').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, delay: 80, easing: 'ease-in', fill: 'both' });
    $('#coverFrame').style.visibility = 'hidden';
    cover.animate([{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${s})`, borderRadius: `${24 / s}px` }],
      { duration: 440, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'both' }).finished.catch(() => {}).then(finish);
    // never leave the overlay stuck if the animation is interrupted (e.g. the cover was rebuilt mid-close)
    setTimeout(() => { if (this.closing && this.el === el) finish(); }, 1200);
  }

  /** called when the playing track changes or its analysis finishes */
  update() {
    if (!this.open || !this.el || this.closing) return;
    const t = this.api.getTrack();
    if (!t) return this.close();
    if (t.id !== this.el.dataset.id) {
      const fresh = this.build(t); fresh.classList.add('shown');
      fresh.querySelector('.dv-bg').style.opacity = 1;
      this.el.replaceWith(fresh); this.el = fresh;
      fresh.querySelectorAll('.dv-in, .dv-cover').forEach((n, i) => n.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: i * 30, easing: ENTER }));
      this.bindLoop();
      this.api.ensureFormat(t).then(() => this.refreshMeta());
      this.api.ensureAnalysis(t);
    } else { this.refreshMeta(); this.refreshAnalysis(); }
  }

  build(t) {
    const a = this.api;
    const close = h('button', { class: 'dv-close', title: tr('dv.close'), 'aria-label': tr('dv.close'), html: ICON.collapse2 });
    close.onclick = () => this.close();
    const play = h('button', { class: 'play-btn dv-play', title: tr('tr.play'), 'aria-label': tr('tr.play') }, h('span', { class: 'play-bezel' }));
    play.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24"><path class="pp a"/><path class="pp b"/></svg>');
    play.onclick = () => a.toggle();
    const prev = h('button', { class: 'tbtn', title: tr('tr.prev'), 'aria-label': tr('tr.prev'), html: '<svg viewBox="0 0 24 24"><path class="fill" d="M18 6v12l-8.5-6zM6 6h2.2v12H6z"/></svg>' });
    const next = h('button', { class: 'tbtn', title: tr('tr.next'), 'aria-label': tr('tr.next'), html: '<svg viewBox="0 0 24 24"><path class="fill" d="M6 6v12l8.5-6zM15.8 6H18v12h-2.2z"/></svg>' });
    prev.onclick = () => a.prev(); next.onclick = () => a.next();
    const seek = h('div', { class: 'dv-seek' }, h('canvas'));
    const cur = h('span', { class: 'time dv-cur' }, '0:00'), dur = h('span', { class: 'time' }, fmt(t.duration));

    const el = h('div', { class: 'deep', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('dv.kicker'), dataset: { id: t.id } },
      h('div', { class: 'dv-bg' }, h('div', { class: 'dv-bg-art', style: { background: a.art(t) } }), h('div', { class: 'dv-bg-tint' })),
      h('div', { class: 'dv-top dv-in' }, h('div', { class: 'v-kicker' }, tr('dv.kicker')), h('span', { class: 'dv-hint' }, tr('dv.hint')), close),
      h('div', { class: 'dv-main' },
        h('div', { class: 'dv-left' },
          h('div', { class: 'dv-cover', style: { background: a.art(t) } }, h('div', { class: 'cover-gloss' })),
          h('div', { class: 'dv-transport dv-in' },
            h('div', { class: 'dv-timeline' }, cur, seek, dur),
            h('div', { class: 'dv-buttons' }, prev, play, next))),
        h('div', { class: 'dv-info' },
          h('div', { class: 'dv-in' },
            h('h1', { class: 'dv-title' }, t.title),
            h('div', { class: 'dv-artist' }, a.artistOf(t), t.album ? h('span', {}, ' — ' + t.album) : null, t.year ? h('span', { class: 'dv-year' }, ' · ' + t.year) : null),
            h('div', { class: 'dv-chips' })),
          h('section', { class: 'dv-sec dv-in' }, h('div', { class: 'sec-title' }, tr('dv.analysis')), h('div', { class: 'dv-stats' })),
          h('section', { class: 'dv-sec dv-in' }, h('div', { class: 'sec-title' }, tr('dv.character')), h('div', { class: 'dv-bars' })),
          h('section', { class: 'dv-sec dv-in' },
            h('div', { class: 'sec-title' }, h('span', {}, tr('dv.similar')), h('button', { class: 'text-btn dv-simall', onClick: () => a.onSimilar(this.api.getTrack()) }, tr('dv.simAll'))),
            h('div', { class: 'dv-sim' })))));
    el.addEventListener('dblclick', (e) => { if (e.target.closest('.dv-cover, .dv-bg, .dv-top')) this.close(); });
    this.wave = new WaveSeek(seek.querySelector('canvas'), { onDark: true });
    this.wave.set(t.peaks || null);
    seek.addEventListener('pointerdown', (e) => {
      const r = seek.getBoundingClientRect();
      a.engine.seek(clamp((e.clientX - r.left) / r.width, 0, 1) * a.engine.duration);
    });
    this.ui = { cur, dur };
    this.refreshMeta(el); this.refreshAnalysis(el);
    return el;
  }

  bindLoop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.open || !this.el) return;
      const e = this.api.engine, d = e.duration;
      this.wave.progress(d ? e.time / d : 0);
      this.ui.cur.textContent = fmt(e.time);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  refreshMeta(root = this.el) {
    if (!root) return;
    const t = this.api.getTrack(); if (!t) return;
    const chips = root.querySelector('.dv-chips'); chips.innerHTML = '';
    const q = quality(t);
    const fmtChip = [(t.codec || t.format || '').toUpperCase().replace('MPEG 1 LAYER 3', 'MP3'), t.bitrate && !t.lossless ? `${t.bitrate} kbps` : null].filter(Boolean).join(' · ');
    if (fmtChip) chips.append(h('span', { class: 'badge' + (q === 'lossless' ? ' lic' : '') }, q === 'lossless' ? tr('q.lossless') + ' · ' + fmtChip : fmtChip));
    if (t.sampleRate) chips.append(h('span', { class: 'badge' }, `${(t.sampleRate / 1000).toFixed(1).replace('.0', '')} kHz${t.bitDepth ? ' · ' + t.bitDepth + ' bit' : ''}`));
    if (t.genre) chips.append(h('span', { class: 'badge' }, t.genre));
    if (t.plays) chips.append(h('span', { class: 'badge acc' }, tn('dv.plays', t.plays)));
  }

  refreshAnalysis(root = this.el) {
    if (!root) return;
    const t = this.api.getTrack(); if (!t) return;
    const stats = root.querySelector('.dv-stats'), bars = root.querySelector('.dv-bars'), sim = root.querySelector('.dv-sim');
    const ok = analyzed(t);
    const tile = (label, value, sub, cls = '') => h('div', { class: 'dv-stat ' + cls }, h('div', { class: 'lbl' }, label), h('div', { class: 'val', html: value }), sub ? h('div', { class: 'sub' }, sub) : null);
    stats.innerHTML = '';
    stats.append(
      tile(tr('dv.bpm'), t.bpm ? String(Math.round(t.bpm)) : '—', t.bpm && t.bpmConf != null ? tr('dv.conf', { n: Math.round((t.bpmConf || 0) * 100) }) : ''),
      tile(tr('dv.key'), ok ? esc(t.key) : '—', ok ? `Camelot ${t.camelot}` : ''),
      tile(tr('dv.duration'), fmt(t.duration), t.size ? (t.size / 1048576).toFixed(1) + ' ' + tr('mb') : ''),
      tile(tr('dv.loudness'), ok ? `${t.lufs}<small> LUFS</small>` : '—', ok ? tr('dv.peak', { n: t.peakDb }) : ''),
      tile(tr('dv.dynamics'), ok ? `${t.plr}<small> dB</small>` : '—', ok ? (t.plr >= 12 ? tr('dv.dynWide') : t.plr >= 8 ? tr('dv.dynMid') : tr('dv.dynTight')) : ''));
    if (!ok) stats.append(h('div', { class: 'dv-pending' }, h('span', { class: 'spin' }), tr('dv.analyzing')));
    bars.innerHTML = '';
    for (const k of ['energy', 'bass', 'vocal', 'bright']) {
      const v = ok ? t[k] : 0;
      const fill = h('i');
      bars.append(h('div', { class: 'dv-bar' }, h('span', {}, tr('dv.' + k)), h('div', { class: 'track' }, fill), h('b', {}, ok ? Math.round(v * 100) : '—')));
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (v * 100).toFixed(0) + '%'; }));
    }
    sim.innerHTML = '';
    const list = ok ? findSimilar(t, this.api.tracks(), 6) : [];
    if (!ok) sim.append(h('div', { class: 'sp-empty' }, tr('dv.simWait')));
    else if (!list.length) sim.append(h('div', { class: 'sp-empty' }, tr('dv.simNone')));
    list.forEach(({ t: s, score, reasons }, i) => {
      const pct = Math.round(score * 100);
      const row = h('div', { class: 'dv-simrow', tabindex: 0, style: { '--i': i } },
        h('div', { class: 'thumb', style: { background: this.api.art(s) } }),
        h('div', { class: 'dv-simmeta' }, h('div', { class: 't' }, s.title), h('div', { class: 'why' }, reasons.slice(0, 3).join(' · ') || this.api.artistOf(s))),
        h('div', { class: 'dv-match', style: { '--p': pct } }, h('span', {}, pct + '%')),
        h('button', { class: 'icon-btn', title: tr('m.next'), 'aria-label': tr('m.next'), html: ICON.next, onClick: (e) => { e.stopPropagation(); this.api.playNext([s.id]); } }));
      row.addEventListener('dblclick', (e) => { e.stopPropagation(); this.api.playIds([s.id]); });
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.api.playIds([s.id]); });
      sim.append(row);
    });
    if (t.peaks) this.wave && this.wave.set(t.peaks);
  }
}
