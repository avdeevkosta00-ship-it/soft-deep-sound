/**
 * Built-in tour: the screen dims, one control at a time is lit, an arrow points at it and a short card
 * says what it does. First launch gets a short welcome (WELCOME); the rest is shown once the first music
 * plays (the showcase built in app.js). The «?» button in the title bar replays the full tour (STEPS).
 * Keys: → / Enter — next, ← — back, Esc — close. Controls hidden by the panel layout are skipped.
 * A step may have enter() — run before it is shown (e.g. open Deep View) — and wait: ms to let it settle.
 */
import { h } from './ui.js';
import { t as tr } from './i18n.js';

export const WELCOME = [
  { key: 'hello' },
  { key: 'add', sel: '.import-card' },
  { key: 'search', sel: '#search' },
  { key: 'later', sel: '#helpBtn' }
];

export const STEPS = [
  { key: 'hello' },
  { key: 'add', sel: '.import-card' },
  { key: 'search', sel: '#search' },
  { key: 'session', sel: '#sessionBtn' },
  { key: 'playlists', sel: '.side-head' },
  { key: 'np', sel: '#coverFrame' },
  { key: 'viz', sel: '.viz-wrap' },
  { key: 'seek', sel: '.timeline' },
  { key: 'tools', sel: '#toolsBtn' },
  { key: 'sd', sel: '#sdSwitch' },
  { key: 'theme', sel: '#themeBtn' },
  { key: 'layout', sel: '#layoutBtn' },
  { key: 'help', sel: '#helpBtn' }
];
const PAD = 8, GAP = 70, M = 16, CARD_W = 330;

function visibleRect(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return null;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return null;
  return r;
}

export function createTour({ onDone, beforeStep } = {}) {
  let root = null, i = 0, steps = [], onKey = null, onResize = null, run = {}, token = 0;

  function close(done = true) {
    if (!root) return;
    const r = root; root = null;
    r.classList.add('out');
    setTimeout(() => r.remove(), 320);
    removeEventListener('keydown', onKey, true);
    removeEventListener('resize', onResize);
    run.onClose && run.onClose();
    if (done) (run.onDone || onDone) && (run.onDone || onDone)();
  }

  /** list — the steps to show (default: the full tour); opts.onDone / opts.onClose override the defaults */
  function start(list = STEPS, opts = {}) {
    if (root) close(false);
    run = opts;
    beforeStep && beforeStep();
    // only the steps whose control is on screen right now (panels can be hidden in the layout);
    // steps with enter() open their own UI first, so they are checked when shown
    steps = list.filter((s) => !s.sel || s.enter || visibleRect(document.querySelector(s.sel)));
    i = 0;
    const spot = h('div', { class: 'tour-spot' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'tour-arrow');
    svg.innerHTML = '<defs><marker id="tourHead" viewBox="0 0 10 10" refX="7.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1.2 8.6 5 1 8.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker></defs><path class="ta-line" marker-end="url(#tourHead)"/><circle class="ta-dot" r="3.2"/>';
    const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-live': 'polite' });
    root = h('div', { class: 'tour', id: 'tour' }, spot, svg, card);
    // clicks never reach the app underneath; a click on the lit control just moves on
    root.addEventListener('click', (e) => { if (e.target === root || e.target === spot) go(1); });
    document.body.append(root);
    onKey = (e) => {
      if (!root) return;
      const k = e.key;
      if (['ArrowRight', 'Enter', 'ArrowLeft', 'Escape', ' '].includes(k)) { e.preventDefault(); e.stopImmediatePropagation(); }
      if (k === 'ArrowRight' || k === 'Enter') go(1);
      else if (k === 'ArrowLeft') go(-1);
      else if (k === 'Escape') close();
    };
    addEventListener('keydown', onKey, true);
    onResize = () => root && layout(false);
    addEventListener('resize', onResize);
    requestAnimationFrame(() => { root.classList.add('on'); show(); });
  }

  function go(d) {
    const n = i + d;
    if (n < 0) return;
    if (n >= steps.length) { close(); return; }
    i = n; show();
  }

  function show() {
    const s = steps[i], my = ++token;
    if (!s.enter) return render();
    // let the UI the step opens settle before the spotlight measures it
    root.querySelector('.tour-card').classList.add('wait');
    s.enter();
    setTimeout(() => { if (root && my === token) render(); }, s.wait || 0);
  }

  function render() {
    const s = steps[i], card = root.querySelector('.tour-card');
    card.classList.remove('wait');
    const last = i === steps.length - 1, first = i === 0;
    card.innerHTML = '';
    card.classList.toggle('hello', !s.sel);
    const next = h('button', { class: 'chip-btn on', onClick: () => go(1) }, first ? tr('tour.begin') : last ? tr('tour.finish') : tr('tour.next'));
    card.append(...[
      !s.sel ? h('div', { class: 'tour-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')) : null,
      h('div', { class: 'tour-step mono' }, first ? tr('tour.kicker') : `${String(i).padStart(2, '0')} / ${String(steps.length - 1).padStart(2, '0')}`),
      h('h4', {}, tr(`tour.${s.key}.t`)),
      h('p', {}, tr(`tour.${s.key}.d`)),
      h('div', { class: 'tour-acts' },
        last ? h('span') : h('button', { class: 'text-btn', onClick: () => close() }, tr('tour.skip')),
        h('span', { class: 'grow' }),
        !first ? h('button', { class: 'chip-btn', onClick: () => go(-1) }, tr('tour.back')) : null,
        next)].filter(Boolean));
    card.setAttribute('aria-label', tr(`tour.${s.key}.t`));
    layout(true);
    next.focus({ preventScroll: true });
  }

  function layout(animate) {
    const s = steps[i];
    const spot = root.querySelector('.tour-spot'), card = root.querySelector('.tour-card'), svg = root.querySelector('.tour-arrow');
    const line = svg.querySelector('.ta-line'), dot = svg.querySelector('.ta-dot');
    const el = s.sel && document.querySelector(s.sel);
    const r = el && visibleRect(el);
    card.style.width = (s.sel ? CARD_W : 380) + 'px';
    const cw = card.offsetWidth, ch = card.offsetHeight;
    if (!r) {
      Object.assign(spot.style, { left: innerWidth / 2 + 'px', top: innerHeight / 2 + 'px', width: '0px', height: '0px', borderRadius: '50%' });
      spot.classList.add('none');
      Object.assign(card.style, { left: (innerWidth - cw) / 2 + 'px', top: (innerHeight - ch) / 2 + 'px' });
      svg.classList.remove('show');
      return;
    }
    spot.classList.remove('none');
    const br = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 10;
    const S = { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
    Object.assign(spot.style, { left: S.x + 'px', top: S.y + 'px', width: S.w + 'px', height: S.h + 'px', borderRadius: Math.min(S.h / 2, br + PAD) + 'px' });

    // the side with the most room gets the card
    const room = { right: innerWidth - (S.x + S.w), left: S.x, bottom: innerHeight - (S.y + S.h), top: S.y };
    const fits = { right: room.right >= cw + GAP + M, left: room.left >= cw + GAP + M, bottom: room.bottom >= ch + GAP + M, top: room.top >= ch + GAP + M };
    const side = ['right', 'bottom', 'left', 'top'].find((k) => fits[k]) || Object.entries(room).sort((a, b) => b[1] - a[1])[0][0];
    const cx = S.x + S.w / 2, cy = S.y + S.h / 2;
    let x, y;
    if (side === 'right') { x = S.x + S.w + GAP; y = cy - ch / 2; }
    if (side === 'left') { x = S.x - GAP - cw; y = cy - ch / 2; }
    if (side === 'bottom') { x = cx - cw / 2; y = S.y + S.h + GAP; }
    if (side === 'top') { x = cx - cw / 2; y = S.y - GAP - ch; }
    x = Math.max(M, Math.min(innerWidth - cw - M, x));
    y = Math.max(M + 30, Math.min(innerHeight - ch - M, y));
    Object.assign(card.style, { left: x + 'px', top: y + 'px' });

    // arrow: from the card edge that faces the control to the lit frame, with a gentle bend
    let a, b;
    if (side === 'right') { a = [x - 6, Math.max(y + 24, Math.min(y + ch - 24, cy))]; b = [S.x + S.w + 4, cy]; }
    if (side === 'left') { a = [x + cw + 6, Math.max(y + 24, Math.min(y + ch - 24, cy))]; b = [S.x - 4, cy]; }
    if (side === 'bottom') { a = [Math.max(x + 30, Math.min(x + cw - 30, cx)), y - 6]; b = [cx, S.y + S.h + 4]; }
    if (side === 'top') { a = [Math.max(x + 30, Math.min(x + cw - 30, cx)), y + ch + 6]; b = [cx, S.y - 4]; }
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const bend = Math.min(36, len * .28);
    const c = [mx - (dy / len) * bend, my + (dx / len) * bend];
    line.setAttribute('d', `M${a[0]},${a[1]} Q${c[0]},${c[1]} ${b[0]},${b[1]}`);
    dot.setAttribute('cx', a[0]); dot.setAttribute('cy', a[1]);
    svg.classList.add('show');
    if (animate) {
      const L = line.getTotalLength();
      line.style.transition = 'none';
      line.style.strokeDasharray = L; line.style.strokeDashoffset = L;
      line.getBoundingClientRect();
      line.style.transition = 'stroke-dashoffset 520ms cubic-bezier(.22,.9,.26,1) 180ms';
      line.style.strokeDashoffset = 0;
      card.classList.remove('enter'); void card.offsetWidth; card.classList.add('enter');
    }
  }

  return { start, close: () => close(false), get isOpen() { return !!root; } };
}
