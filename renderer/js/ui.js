// Small DOM + UI helpers shared by all modules.
import { t } from './i18n.js';
import { swipeToClose, slideAway } from './gestures.js';
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
export function fmtLong(sec) {
  const hrs = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return hrs ? t('dur.h', { h: hrs, m }) : t('dur.m', { m });
}
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
export function debounce(fn, ms) {
  let t, pending = null;
  const d = (...a) => { pending = a; clearTimeout(t); t = setTimeout(() => { pending = null; fn(...a); }, ms); };
  d.flush = () => { clearTimeout(t); if (pending) { const a = pending; pending = null; fn(...a); } else fn(); };
  return d;
}
export function hash(str) { let x = 2166136261; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** Generated aero-style cover for tracks without artwork. */
export function genArt(seed) {
  const x = hash(seed || 'x');
  const hue = 200 + (x % 46);
  const ang = 100 + (x >> 8) % 60;
  const cut = 48 + (x >> 4) % 30;
  return `linear-gradient(${ang}deg, transparent ${cut}%, rgb(var(--accent-rgb) / .85) ${cut + .4}%, transparent ${cut + 1}%),` +
    `radial-gradient(circle at ${20 + (x >> 3) % 40}% ${15 + (x >> 5) % 30}%, hsla(${hue},70%,97%,.95), transparent 55%),` +
    `radial-gradient(ellipse at 80% 90%, hsla(${hue + 25},45%,55%,.9), transparent 60%),` +
    `linear-gradient(150deg, hsl(${hue},42%,84%), hsl(${hue + 18},34%,58%))`;
}

/* ------------------------------ toasts ------------------------------ */
export function toast(content, { timeout = 3200, actions = null } = {}) {
  const host = $('#toasts');
  const el = h('div', { class: 'toast' }, h('span', { class: 'tdot' }));
  const body = typeof content === 'string' ? h('span', {}, content) : content;
  el.append(body);
  if (actions) el.append(actions);
  const x = h('button', { class: 'tx', title: t('close'), html: '<svg viewBox="0 0 12 12" width="11" height="11"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.5"/></svg>' });
  el.append(x);
  host.append(el);
  let timer;
  const close = () => { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  const arm = () => { if (timeout) timer = setTimeout(close, timeout); };
  x.onclick = close;
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  arm();
  while (host.children.length > 3) host.firstChild.remove();
  return { el, close };
}

/* ---------------------------- context menu --------------------------- */
const menu = () => $('#ctxmenu');
export function ctxMenu(x, y, items) {
  const m = menu();
  if (!m.dataset.swipe) { m.dataset.swipe = '1'; swipeToClose(m, { onClose: (dy) => slideAway(m, dy, closeCtx) }); }
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.append(h('hr')); continue; }
    if (it.label && !it.onClick) { m.append(h('div', { class: 'ctx-label' }, it.label)); continue; }
    m.append(h('button', { class: it.danger ? 'danger' : '', onClick: () => { closeCtx(); it.onClick(); } }, it.text));
  }
  m.classList.add('open');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 10) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 10) + 'px';
}
export function closeCtx() { menu().classList.remove('open'); }
addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctxmenu')) closeCtx(); }, true);
addEventListener('blur', closeCtx);

/* -------------------------------- modal ------------------------------ */
export function openModal(card) {
  const m = $('#modal');
  m.innerHTML = '';
  m.append(card);
  // on a phone the dialog is a sheet: pull it down to close
  swipeToClose(card, { onClose: (dy) => slideAway(card, dy, closeModal) });
  requestAnimationFrame(() => m.classList.add('open'));
  m.onclick = (e) => { if (e.target === m) closeModal(); };
}
export function closeModal() {
  const m = $('#modal');
  m.classList.remove('open');
  // the old dialog must not stay reachable with Tab once it is hidden
  const card = m.firstElementChild;
  setTimeout(() => { if (!m.classList.contains('open') && m.firstElementChild === card) m.innerHTML = ''; }, 400);
  // don't leave keyboard focus inside a hidden dialog (it would swallow the app's hotkeys)
  if (m.contains(document.activeElement)) document.activeElement.blur();
}

/* ---------------------------- drag helper ---------------------------- */
export function dragValue(el, { onStart, onMove, onEnd } = {}) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    onStart && onStart(e);
    const move = (ev) => onMove && onMove(ev);
    const up = (ev) => {
      el.classList.remove('drag');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onEnd && onEnd(ev);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

/**
 * Horizontal skeuomorphic fader with ticks, center detent, wheel + double-click reset.
 */
export function makeFader({ min, max, step = 1, value = 0, def = 0, majors = [], minors = [], labels = [], onInput, detent = null }) {
  const el = h('div', { class: 'fader', tabindex: 0 });
  const groove = h('div', { class: 'fader-groove' });
  const fill = h('div', { class: 'fader-fill' });
  const cap = h('div', { class: 'fader-cap' });
  const ticks = h('div', { class: 'fader-ticks' });
  el.append(groove, fill, ticks, cap);
  const pct = (v) => (v - min) / (max - min);
  for (const v of minors) ticks.append(h('i', { style: { left: pct(v) * 100 + '%' } }));
  for (const v of majors) ticks.append(h('i', { class: 'major', style: { left: pct(v) * 100 + '%' } }));
  for (const [v, t] of labels) ticks.append(h('span', { style: { left: pct(v) * 100 + '%' } }, t));
  let val = value;
  const origin = detent ?? min;
  const geom = () => { const r = el.getBoundingClientRect(); return { x0: r.left + 14, w: r.width - 28 }; };
  function paint() {
    const w = el.clientWidth - 28;
    const x = 14 + pct(val) * w;
    const ox = 14 + pct(origin) * w;
    cap.style.left = x + 'px';
    fill.style.left = Math.min(x, ox) + 'px';
    fill.style.width = Math.abs(x - ox) + 'px';
  }
  function set(v, emit = true) {
    v = clamp(Math.round(v / step) * step, min, max);
    if (detent != null && Math.abs(v - detent) < step * .5) v = detent;
    if (v === val && emit) return;
    val = +v.toFixed(4);
    paint();
    emit && onInput && onInput(val);
  }
  dragValue(el, {
    onStart: (e) => { el.classList.remove('anim'); const g = geom(); set(min + clamp((e.clientX - g.x0) / g.w, 0, 1) * (max - min)); },
    onMove: (e) => { const g = geom(); set(min + clamp((e.clientX - g.x0) / g.w, 0, 1) * (max - min)); }
  });
  el.addEventListener('dblclick', () => { el.classList.add('anim'); set(def); });
  el.addEventListener('wheel', (e) => { e.preventDefault(); el.classList.add('anim'); set(val + (e.deltaY < 0 ? step : -step)); }, { passive: false });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); el.classList.add('anim'); set(val + step); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); el.classList.add('anim'); set(val - step); }
  });
  new ResizeObserver(paint).observe(el);
  requestAnimationFrame(paint);
  return { el, set: (v, emit = false) => { el.classList.add('anim'); set(v, emit); paint(); }, get: () => val };
}

/** Vertical channel fader 0..1 */
export function makeVFader({ value = .5, onInput }) {
  const el = h('div', { class: 'vfader' }, h('div', { class: 'vg' }), h('div', { class: 'vf' }), h('div', { class: 'vc' }));
  const vf = el.querySelector('.vf'), vc = el.querySelector('.vc');
  let val = value;
  const paint = () => { const H = el.clientHeight - 20; vc.style.top = (10 + (1 - val) * H) + 'px'; vf.style.height = (val * H) + 'px'; };
  const fromY = (y) => { const r = el.getBoundingClientRect(); return clamp(1 - (y - r.top - 10) / (r.height - 20), 0, 1); };
  const set = (v) => { val = clamp(v, 0, 1); paint(); onInput && onInput(val); };
  dragValue(el, { onStart: (e) => set(fromY(e.clientY)), onMove: (e) => set(fromY(e.clientY)) });
  el.addEventListener('wheel', (e) => { e.preventDefault(); set(val + (e.deltaY < 0 ? .05 : -.05)); }, { passive: false });
  requestAnimationFrame(paint);
  return { el, set: (v) => { val = v; paint(); }, get: () => val };
}

/** Compact LCD-style range for the dark panels */
export function makeMiniRange({ label, value = .5, fmt: f = (v) => Math.round(v * 100) + '%', onInput }) {
  const valEl = h('span', {}, f(value));
  const g = h('div', { class: 'g' }), fi = h('div', { class: 'f' }), c = h('div', { class: 'c' });
  const range = h('div', { class: 'mini-range' }, g, fi, c);
  const el = h('div', { class: 'mini-fader' }, h('div', { class: 'lbl' }, h('span', {}, label), valEl), range);
  let val = value;
  const paint = () => { fi.style.width = val * 100 + '%'; c.style.left = val * 100 + '%'; valEl.textContent = f(val); };
  const fromX = (x) => { const r = range.getBoundingClientRect(); return clamp((x - r.left) / r.width, 0, 1); };
  const set = (v) => { val = v; paint(); onInput && onInput(val); };
  dragValue(range, { onStart: (e) => set(fromX(e.clientX)), onMove: (e) => set(fromX(e.clientX)) });
  paint();
  return { el, set: (v) => { val = v; paint(); } };
}

/* ------------------------------ popover ------------------------------ */
let openPop = null;
export function popover(anchor, content, { align = 'right' } = {}) {
  if (openPop) { const same = openPop.anchor === anchor; closePopover(); if (same) return null; }
  const el = h('div', { class: 'pop' }, content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect(), w = el.offsetWidth;
  el.style.top = r.bottom + 8 + 'px';
  el.style.left = clamp(align === 'right' ? r.right - w : r.left, 10, innerWidth - w - 10) + 'px';
  requestAnimationFrame(() => el.classList.add('open'));
  openPop = { el, anchor };
  setTimeout(() => { if (openPop && openPop.el === el) addEventListener('pointerdown', outside, true); }, 0);
  return el;
}
function outside(e) { if (openPop && !openPop.el.contains(e.target) && !openPop.anchor.contains(e.target)) closePopover(); }
export function closePopover() {
  if (!openPop) return false;
  const { el } = openPop; openPop = null;
  removeEventListener('pointerdown', outside, true);
  el.classList.remove('open'); setTimeout(() => el.remove(), 250);
  return true;
}
