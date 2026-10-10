/**
 * Movable panels: resize with splitters, swap places by dragging the top grip,
 * hide/show side panels. Layout is stored in settings and animated with FLIP.
 */
import { $, $$, h, clamp, popover, closePopover } from './ui.js';
import { ICON } from './icons.js';
import { t } from './i18n.js';

const DEF = () => ({ order: ['side', 'main', 'np'], w: { side: 252, np: 328 }, hidden: { side: false, np: false } });
const LIMITS = { side: [220, 400], np: [250, 500] };
const NAMES = { side: 'lay.side', main: 'lay.main', np: 'lay.np' };

export class Layout {
  constructor(settings, save, onChange) {
    this.settings = settings; this.save = save; this.onChange = onChange;
    if (!settings.layout || !Array.isArray(settings.layout.order)) settings.layout = DEF();
    this.app = $('#app');
    this.panels = Object.fromEntries($$('.panel').map((p) => [p.dataset.panel, p]));
    this.splitters = [];
    for (const [k, p] of Object.entries(this.panels)) this.addHandle(k, p);
    addEventListener('resize', () => this.apply(false));
    this.apply(false);
  }
  get L() { return this.settings.layout; }
  visible() { return this.L.order.filter((k) => k === 'main' || !this.L.hidden[k]); }

  addHandle(key, panel) {
    const grip = h('div', { class: 'ph-grip', title: t('lay.grip'), 'data-i18n-title': 'lay.grip' });
    const handle = h('div', { class: 'panel-handle' }, grip);
    if (key !== 'main') {
      const hide = h('button', { class: 'ph-btn', title: t('lay.hide'), 'data-i18n-title': 'lay.hide', html: '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>' });
      hide.onclick = () => this.setHidden(key, true);
      handle.append(hide);
    }
    panel.prepend(handle);
    grip.addEventListener('pointerdown', (e) => this.startSwap(e, key, handle));
  }

  apply(animate = true) {
    const first = animate ? Object.fromEntries(Object.entries(this.panels).map(([k, p]) => [k, p.getBoundingClientRect()])) : null;
    const vis = this.visible();
    // shrink side widths proportionally if the window is too narrow for them
    const fixed = vis.filter((k) => k !== 'main').reduce((s, k) => s + this.L.w[k], 0);
    const room = innerWidth - 24 - (vis.length - 1) * 12 - 420;
    const k = fixed > room && fixed > 0 ? Math.max(.6, room / fixed) : 1;
    this.app.style.gridTemplateColumns = vis.map((key) => (key === 'main' ? 'minmax(0, 1fr)' : Math.round(this.L.w[key] * k) + 'px')).join(' ');
    for (const [key, p] of Object.entries(this.panels)) {
      const shown = vis.includes(key);
      p.classList.toggle('panel-hidden', !shown);
      if (shown) { p.style.gridColumn = vis.indexOf(key) + 1; p.style.gridRow = 2; }
    }
    if (first) {
      for (const [key, p] of Object.entries(this.panels)) {
        if (!vis.includes(key) || !first[key].width) continue;
        const last = p.getBoundingClientRect();
        const dx = first[key].left - last.left, sx = first[key].width / last.width;
        if (Math.abs(dx) < 1 && Math.abs(sx - 1) < .01) continue;
        p.animate([{ transform: `translateX(${dx}px) scaleX(${sx})`, transformOrigin: 'left' }, { transform: 'none', transformOrigin: 'left' }],
          { duration: 460, easing: 'cubic-bezier(.22,.9,.26,1)' });
      }
    }
    requestAnimationFrame(() => this.placeSplitters());
    this.onChange && this.onChange();
  }

  placeSplitters() {
    this.splitters.forEach((s) => s.remove());
    this.splitters = [];
    const vis = this.visible();
    for (let i = 0; i < vis.length - 1; i++) {
      const a = this.panels[vis[i]].getBoundingClientRect();
      const target = vis[i] !== 'main' ? vis[i] : vis[i + 1];
      const sign = vis[i] !== 'main' ? 1 : -1;
      const sp = h('div', { class: 'splitter', title: t('lay.split'), style: { left: a.right + 'px', top: a.top + 'px', height: a.height + 'px' } });
      sp.addEventListener('pointerdown', (e) => this.startResize(e, sp, target, sign));
      sp.addEventListener('dblclick', () => { this.L.w[target] = DEF().w[target]; this.save(); this.apply(true); });
      // inside #app so it shares the app's stacking context and never draws over the tool rack or dialogs
      (document.getElementById('app') || document.body).append(sp);
      this.splitters.push(sp);
    }
  }

  startResize(e, sp, key, sign) {
    e.preventDefault();
    const x0 = e.clientX, w0 = this.L.w[key];
    sp.classList.add('drag'); document.body.classList.add('resizing');
    const move = (ev) => {
      this.L.w[key] = Math.round(clamp(w0 + sign * (ev.clientX - x0), ...LIMITS[key]));
      this.apply(false);
      const s = this.splitters.find((x) => x.classList.contains('drag')) || this.splitters[0];
      s && s.classList.add('drag');
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing'); this.splitters.forEach((s) => s.classList.remove('drag'));
      this.save();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  }

  startSwap(e, key, handle) {
    e.preventDefault();
    const src = this.panels[key], r = src.getBoundingClientRect();
    const ghost = h('div', { class: 'panel-ghost', style: { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' } }, t(NAMES[key]).toUpperCase());
    document.body.append(ghost);
    src.classList.add('swap-source'); handle.classList.add('active');
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    let over = null;
    const move = (ev) => {
      ghost.style.left = ev.clientX - ox + 'px'; ghost.style.top = ev.clientY - oy + 'px';
      const hit = this.visible().find((k) => { if (k === key) return false; const b = this.panels[k].getBoundingClientRect(); return ev.clientX > b.left && ev.clientX < b.right && ev.clientY > b.top && ev.clientY < b.bottom; });
      if (hit !== over) { over && this.panels[over].classList.remove('swap-target'); over = hit; over && this.panels[over].classList.add('swap-target'); }
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      ghost.remove(); src.classList.remove('swap-source'); handle.classList.remove('active');
      if (over) {
        this.panels[over].classList.remove('swap-target');
        const o = this.L.order, i = o.indexOf(key), j = o.indexOf(over);
        [o[i], o[j]] = [o[j], o[i]];
        this.save(); this.apply(true);
      }
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  }

  setHidden(key, hidden) { this.L.hidden[key] = hidden; this.save(); this.apply(true); }
  reset() { this.settings.layout = DEF(); this.save(); this.apply(true); }

  menu(anchor) {
    const item = (label, on, fn) => {
      const b = h('button', {}, h('span', { class: 'chk' + (on ? ' on' : '') }), label);
      b.onclick = () => { fn(); closePopover(); };
      return b;
    };
    popover(anchor, h('div', { class: 'layout-menu', style: { width: '250px' } },
      h('div', { class: 'pop-title' }, t('lay.title')),
      item(t('lay.side'), !this.L.hidden.side, () => this.setHidden('side', !this.L.hidden.side)),
      item(t('lay.np'), !this.L.hidden.np, () => this.setHidden('np', !this.L.hidden.np)),
      h('button', { onClick: () => { this.L.order.reverse(); this.save(); this.apply(true); closePopover(); } }, h('span', { class: 'chk' }), t('lay.mirror')),
      h('button', { onClick: () => { this.reset(); closePopover(); } }, h('span', { class: 'chk' }), t('lay.reset')),
      h('div', { class: 'pop-title', style: { paddingTop: '10px', lineHeight: 1.5, letterSpacing: '.06em', fontSize: '10px' } }, t('lay.hint'))));
  }
}
