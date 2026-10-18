/**
 * Fine-tuning on top of the four themes:
 *   • accent colour — the theme's own, a preset, any custom colour, or «from the cover» (follows the
 *     artwork of the playing track). Every accent-derived variable is recomputed and kept readable:
 *     darker on light themes, brighter on dark ones;
 *   • the living background — live / calm / still / off;
 *   • glass blur — less / normal / more.
 * Everything is set as inline custom properties on <html>, so the theme files stay untouched and
 * «as in the theme» simply removes the overrides.
 */
import { h } from './ui.js';
import { t as tr } from './i18n.js';

export const PRESETS = [
  ['cobalt', '#1f45e8'], ['violet', '#7c4dff'], ['fuchsia', '#e0359b'], ['coral', '#ff5a3c'],
  ['amber', '#f0a020'], ['mint', '#14b88c'], ['teal', '#0fa3c4'], ['steel', '#8a94a6']
];
const VARS = ['--accent', '--accent-2', '--accent-rgb', '--accent-deep', '--on-accent', '--hot', '--hot-2', '--hot-rgb', '--wave-1', '--wave-2',
  '--blue-rgb', '--n1', '--n2', '--n3', '--n1-rgb', '--n3-rgb', '--shape-c1', '--shape-c2', '--shape-c3',
  '--line', '--line-faint', '--shade', '--glass-edge', '--groove', '--groove-edge', '--chrome-4', '--viz-a'];
const BLUR = { less: '8px', more: '44px' };

const hexToRgb = (x) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(x || '')); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
const rgbToHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

export function createAppearance({ S, save, hslToRgb, rgbToHsl, coverColor, onChange }) {
  const look = () => S.settings.look;
  let coverRgb = null;

  /** the colour to use right now, or null for the theme's own */
  function wanted() {
    const a = look().accent;
    if (a === 'cover') return coverRgb;
    return a && a !== 'theme' ? hexToRgb(a) : null;
  }

  function apply() {
    const root = document.documentElement, st = root.style, L = look();
    VARS.forEach((v) => st.removeProperty(v));
    const rgb = wanted();
    if (rgb) {
      const light = root.dataset.tone === 'light';
      let [hh, ss, ll] = rgbToHsl(...rgb);
      // the accent is also a text colour (titles, artist lines): keep it readable on the theme's background
      ll = light ? Math.min(Math.max(ll, .3), .5) : Math.max(Math.min(ll, .74), .6);
      if (ss > .08) ss = Math.min(.95, Math.max(ss, .45));
      const a = hslToRgb(hh, ss, ll);
      const a2 = hslToRgb((hh + (light ? 12 : 28)) % 360, ss, Math.min(.8, ll + .14));
      const a3 = hslToRgb((hh + 330) % 360, ss * .9, Math.min(.82, ll + .2));
      const deep = hslToRgb(hh, ss, Math.max(.16, ll - .17));
      const j = (c) => c.join(' '), rgba = (c, k) => `rgba(${c.join(', ')}, ${k})`;
      const lum = (c) => { const f = c.map((v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * f[0] + .7152 * f[1] + .0722 * f[2]; };
      const set = {
        '--accent': rgbToHex(a), '--accent-2': rgbToHex(a2), '--accent-rgb': j(a), '--accent-deep': rgbToHex(deep),
        '--on-accent': lum(a) > .45 ? '#0b0c10' : '#ffffff',
        '--hot': rgbToHex(a), '--hot-2': rgbToHex(a2), '--hot-rgb': j(a), '--wave-1': j(a), '--wave-2': j(a2), '--blue-rgb': j(a2),
        '--n1': rgbToHex(a), '--n2': rgbToHex(a2), '--n3': rgbToHex(a3), '--n1-rgb': j(a), '--n3-rgb': j(a3),
        '--shape-c1': j(light ? a : a3), '--shape-c2': j(light ? a2 : a), '--shape-c3': j(light ? a3 : a2),
        '--viz-a': rgba(a, light ? .12 : .14)
      };
      // light themes tint their lines, glass edges and grooves with the accent too
      if (light) Object.assign(set, { '--line': rgba(a, .3), '--line-faint': rgba(a, .1), '--shade': rgba(a, .06), '--glass-edge': rgba(a, .14),
        '--groove': rgba(a, .055), '--groove-edge': rgba(a, .14), '--chrome-4': rgba(a, .25) });
      for (const [k, v] of Object.entries(set)) st.setProperty(k, v);
    }
    root.dataset.fx = L.fx || 'live';
    if (BLUR[L.blur]) st.setProperty('--blur', BLUR[L.blur]); else st.removeProperty('--blur');
    onChange && onChange();
  }

  /** «from the cover»: called whenever the playing track changes */
  async function onTrack(t) {
    if (look().accent !== 'cover') return;
    const rgb = t ? await coverColor(t) : null;
    if (look().accent !== 'cover') return;
    coverRgb = rgb;
    apply();
  }

  function setLook(patch, track) {
    Object.assign(look(), patch);
    save();
    if (patch.accent === 'cover') onTrack(track); else apply();
  }

  /* ------------------------------ controls ------------------------------ */
  function accentRow(getTrack, compact) {
    const row = h('div', { class: 'ap-swatches', role: 'radiogroup', 'aria-label': tr('ap.accent') });
    const mark = () => row.querySelectorAll('.ap-sw').forEach((b) => { const on = b.dataset.v === look().accent || (b.dataset.v === 'custom' && /^#/.test(look().accent) && !PRESETS.some((p) => p[1] === look().accent)); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    const sw = (v, title, style, extra) => {
      const b = h('button', { class: 'ap-sw ' + (extra || ''), role: 'radio', title, 'aria-label': title, dataset: { v }, style });
      b.onclick = () => { setLook({ accent: v }, getTrack()); mark(); };
      return b;
    };
    row.append(sw('theme', tr('ap.theme'), {}, 'theme'));
    PRESETS.forEach(([k, hex]) => row.append(sw(hex, tr('ap.c.' + k), { background: hex })));
    // any colour: the native picker behind a swatch
    const custom = /^#/.test(look().accent) && !PRESETS.some((p) => p[1] === look().accent) ? look().accent : '#ff7a59';
    const pick = h('input', { type: 'color', value: custom, tabindex: '-1', 'aria-hidden': 'true' });
    const cb = h('label', { class: 'ap-sw custom', role: 'radio', title: tr('ap.custom'), 'aria-label': tr('ap.custom'), dataset: { v: 'custom' }, tabindex: '0', style: { '--c': custom } }, pick);
    pick.oninput = () => { cb.style.setProperty('--c', pick.value); setLook({ accent: pick.value }, getTrack()); mark(); };
    cb.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick.click(); } };
    row.append(cb);
    const cov = h('button', { class: 'ap-sw cover', role: 'radio', title: tr('ap.coverT'), 'aria-label': tr('ap.coverT'), dataset: { v: 'cover' } });
    cov.onclick = () => { setLook({ accent: 'cover' }, getTrack()); mark(); };
    row.append(cov);
    mark();
    if (compact) return row;
    return h('div', { class: 'set-row ap-row' }, h('div', {}, h('b', {}, tr('ap.accent')), h('small', {}, tr('ap.accentD'))), row);
  }

  function seg(key, options, label, desc) {
    const s = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label }, ...options.map(([v, text]) => {
      const b = h('button', { class: look()[key] === v ? 'on' : '', role: 'radio', 'aria-checked': String(look()[key] === v) }, text);
      b.onclick = () => { setLook({ [key]: v }); s.querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }); };
      return b;
    }));
    return h('div', { class: 'set-row' }, h('div', {}, h('b', {}, label), h('small', {}, desc)), s);
  }

  /** the «Оформление» block for Settings */
  function panel(getTrack) {
    return h('div', { class: 'ap' },
      accentRow(getTrack),
      seg('fx', [['live', tr('ap.fx.live')], ['calm', tr('ap.fx.calm')], ['still', tr('ap.fx.still')], ['off', tr('ap.fx.off')]], tr('ap.fx'), tr('ap.fxD')),
      seg('blur', [['less', tr('ap.blur.less')], ['normal', tr('ap.blur.normal')], ['more', tr('ap.blur.more')]], tr('ap.blur'), tr('ap.blurD')));
  }

  return { apply, onTrack, panel, accentRow };
}
