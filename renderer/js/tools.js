/**
 * Tool rack: Sound Pitcher, Ambient Generator, Equalizer, Space (tempo + reverb).
 * Opens as a drawer above the deck (no separate windows); each tool is a "plugin" chassis.
 */
import { $, $$, h, makeFader, makeVFader, makeMiniRange, clamp, dragValue } from './ui.js';
import { ICON } from './icons.js';
import { LAYERS } from './ambient.js';
import { EQ_FREQS } from './audio-engine.js';
import { t } from './i18n.js';



export const EQ_PRESETS = {
  flat: { name: 'eq.flat', g: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { name: 'eq.bass', g: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  warm: { name: 'eq.warm', g: [3, 3, 2, 1, 0, -1, -1, -2, -3, -3] },
  vocal: { name: 'eq.vocal', g: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  bright: { name: 'eq.bright', g: [0, 0, 0, 0, 0, 1, 2, 4, 5, 5] },
  loud: { name: 'eq.loud', g: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5] },
  lofi: { name: 'eq.lofi', g: [-6, -2, 1, 2, 2, 1, -1, -4, -8, -12] },
  night: { name: 'eq.night', g: [-3, -2, -1, 0, 0, 0, -1, -2, -3, -4] }
};
const hzLabel = (f) => (f >= 1000 ? f / 1000 + 'k' : String(f));

function chassis({ title, sub, code, powered, onPower }) {
  const power = h('button', { class: 'power-btn' + (powered ? ' on' : ''), title: t('tl.onoff'), html: ICON.power });
  power.onclick = () => { const on = !power.classList.contains('on'); power.classList.toggle('on', on); onPower(on); };
  const el = h('div', { class: 'plugin' },
    h('div', { class: 'plug-head' },
      h('div', { class: 'plug-screws' }, h('i'), h('i')),
      h('div', { class: 'plug-name' }, h('div', { class: 'plug-title', html: title }), h('div', { class: 'plug-sub', html: `<span>S<i style="font-family:var(--serif)">&amp;</i>D</span><span>${sub}</span><b>${code}</b>` })),
      h('div', { class: 'plug-power' }, power)
    ),
    h('div', { class: 'plug-body' })
  );
  return { el, body: el.querySelector('.plug-body'), power };
}

/** Bipolar vertical fader (−range…+range), fill grows from the centre line. */
function makeEqFader({ value = 0, range = 12, onInput }) {
  const el = h('div', { class: 'eqf', tabindex: 0 }, h('div', { class: 'eqf-g' }), h('div', { class: 'eqf-mid' }), h('div', { class: 'eqf-f' }), h('div', { class: 'eqf-c' }));
  const fill = el.querySelector('.eqf-f'), cap = el.querySelector('.eqf-c');
  let val = value;
  const paint = () => {
    const H = el.clientHeight - 16, mid = 8 + H / 2, y = 8 + (1 - (val + range) / (2 * range)) * H;
    cap.style.top = y + 'px';
    fill.style.top = Math.min(y, mid) + 'px'; fill.style.height = Math.abs(y - mid) + 'px';
    el.classList.toggle('neg', val < 0);
  };
  const fromY = (y) => { const r = el.getBoundingClientRect(); return clamp((1 - (y - r.top - 8) / (r.height - 16)) * 2 * range - range, -range, range); };
  const set = (v) => { v = Math.round(v * 2) / 2; if (Math.abs(v) < .35) v = 0; val = clamp(v, -range, range); paint(); onInput && onInput(val); };
  dragValue(el, { onStart: (e) => { el.classList.remove('anim'); set(fromY(e.clientY)); }, onMove: (e) => set(fromY(e.clientY)) });
  el.addEventListener('dblclick', () => { el.classList.add('anim'); set(0); });
  el.addEventListener('wheel', (e) => { e.preventDefault(); set(val + (e.deltaY < 0 ? .5 : -.5)); }, { passive: false });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); set(val + .5); }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); set(val - .5); }
  });
  new ResizeObserver(paint).observe(el);
  requestAnimationFrame(paint);
  return { el, set: (v) => { el.classList.add('anim'); val = v; paint(); }, get: () => val };
}

export class Tools {
  constructor({ engine, ambient, settings, save, onState }) {
    Object.assign(this, { engine, ambient, settings, save, onState });
    this.rack = $('#rack'); this.body = $('#rackBody'); this.btn = $('#toolsBtn');
    this.current = null;
    this.panels = {};
    this.btn.onclick = () => this.toggle();
    $('#rackClose').onclick = () => this.close();
    $$('.rack-tab').forEach((t) => (t.onclick = () => this.show(t.dataset.tool)));
    this.restore();
    this.loop();
  }

  restore() {
    const p = this.settings.pitch, a = this.settings.ambient, q = this.settings.eq;
    Object.assign(this.engine, { semitones: p.semi, cents: p.cents, vinyl: p.vinyl, pitchOn: p.on });
    this.engine.applyPitch();
    this.engine.eqOn = q.on; this.engine.setEq(q.gains, q.pre);
    const fx = this.settings.fx || { tempo: 1, reverb: { on: false, room: 'hall', mix: .3 } };
    this.engine.setTempo(fx.tempo); this.engine.setReverb(fx.reverb);
    Object.assign(this.ambient, { depth: a.depth, sensitivity: a.sens });
    this.ambient.setMaster(a.master);
    for (const { key } of LAYERS) this.ambient.layers[key].level = a.levels[key] ?? .5;
    this.leds();
  }

  get isOpen() { return this.rack.classList.contains('open'); }
  toggle() { this.isOpen ? this.close() : this.open(); }
  open(tool) {
    this.rack.classList.add('open'); document.body.classList.add('rack-open'); this.rack.setAttribute('aria-hidden', 'false'); this.btn.classList.add('open');
    this.show(tool || this.current);
  }
  close() { this.rack.classList.remove('open'); document.body.classList.remove('rack-open'); this.rack.setAttribute('aria-hidden', 'true'); this.btn.classList.remove('open'); }

  show(tool) {
    if (!this.isOpen) return this.open(tool);
    this.current = tool || null;
    $$('.rack-tab').forEach((t) => t.classList.toggle('active', t.dataset.tool === tool));
    this.body.innerHTML = '';
    if (!tool) return this.body.append(this.menu());
    const panel = this[tool + 'Panel']();
    this.panels[tool] = panel;
    this.body.append(panel.el);
  }

  menu() {
    const tile = (key, ico, title, sub, i) => h('button', { class: 'tool-tile', style: { '--i': i }, onClick: () => this.show(key) },
      h('div', { class: 'tt-ico', html: ico }), h('div', {}, h('b', {}, title), h('small', {}, sub)));
    return h('div', { class: 'rack-menu' },
      tile('pitch', ICON.pitch, t('tl.pitchT'), t('tl.pitchD'), 0),
      tile('ambient', ICON.ambient, t('tl.ambT'), t('tl.ambD'), 1),
      tile('eq', ICON.eq, t('tl.eqT'), t('tl.eqD'), 2),
      tile('space', ICON.ambient, t('tl.spT'), t('tl.spD'), 3));
  }

  leds() {
    const e = this.engine;
    const state = {
      pitch: e.pitchOn && (e.semitones !== 0 || e.cents !== 0),
      ambient: this.ambient.anyOn,
      eq: e.eqOn && (e.eqGains.some((g) => g !== 0) || e.eqPre !== 0),
      space: e.tempo !== 1 || e.reverb.on
    };
    for (const [k, on] of Object.entries(state)) {
      $(`[data-led="${k}"]`)?.classList.toggle('on', on);
      $(`.rack-tab[data-tool="${k}"]`)?.classList.toggle('on', on);
    }
    this.onState && this.onState(state);
  }

  persist() {
    const e = this.engine, a = this.ambient;
    this.settings.pitch = { semi: e.semitones, cents: e.cents, vinyl: e.vinyl, on: e.pitchOn };
    this.settings.ambient = { depth: a.depth, sens: a.sensitivity, master: a.master, levels: Object.fromEntries(LAYERS.map(({ key }) => [key, a.layers[key].level])) };
    this.settings.eq = { on: e.eqOn, gains: [...e.eqGains], pre: e.eqPre, preset: this.settings.eq.preset };
    this.settings.fx = { tempo: e.tempo, reverb: { ...e.reverb } };
    this.save();
  }

  /* ------------------------------ SOUND PITCHER ------------------------------ */
  pitchPanel() {
    const e = this.engine;
    const c = chassis({
      title: 'Sound Pitcher', sub: t('pt.sub'), code: 'FX·01', powered: e.pitchOn,
      onPower: (on) => { e.setPitchOn(on); this.leds(); this.persist(); }
    });
    const big = h('div', { class: 'big' }), interval = h('div', { class: 'interval' }), ratio = h('div', { class: 'ratio' });
    const lcd = h('div', { class: 'lcd pitch-lcd' }, h('div', { class: 'lbl' }, t('pt.lcd')), big, interval, ratio);
    const paint = () => {
      const s = e.semitones, ct = e.cents;
      big.innerHTML = `<b>${s > 0 ? '+' : s < 0 ? '−' : '±'}${Math.abs(s)}</b><span style="font-size:18px;opacity:.6"> ${t('pt.st')}</span>` +
        (ct ? `<span class="acc" style="font-size:15px;margin-left:6px">${ct > 0 ? '+' : '−'}${Math.abs(ct)}¢</span>` : '');
      const IV = t('pt.iv');
      interval.textContent = s === 0 ? IV[0] : `${IV[Math.abs(s)]} ${s > 0 ? t('pt.up') : t('pt.down')}`;
      ratio.textContent = `×${e.pitchRatio.toFixed(3)}${e.vinyl ? ' · ' + t('pt.vinylTag') : ''}`;
    };
    const semi = makeFader({
      min: -12, max: 12, step: 1, value: e.semitones, def: 0, detent: 0,
      majors: [-12, -7, -5, 0, 5, 7, 12], minors: Array.from({ length: 25 }, (_, i) => i - 12),
      labels: [[-12, '−12'], [-7, '−7'], [-5, '−5'], [0, '0'], [5, '+5'], [7, '+7'], [12, '+12']],
      onInput: (v) => { e.setPitch(v); paint(); this.leds(); this.persist(); }
    });
    const cents = makeFader({
      min: -50, max: 50, step: 1, value: e.cents, def: 0, detent: 0, majors: [-50, -25, 0, 25, 50],
      labels: [[-50, '−50¢'], [0, t('pt.fine')], [50, '+50¢']],
      onInput: (v) => { e.setPitch(e.semitones, v); paint(); this.leds(); this.persist(); }
    });
    cents.el.style.height = '46px';
    const key = h('button', { class: e.vinyl ? '' : 'on' }, t('pt.key'));
    const vin = h('button', { class: e.vinyl ? 'on' : '' }, t('pt.vinyl'));
    const setMode = (v) => { e.setVinyl(v); key.classList.toggle('on', !v); vin.classList.toggle('on', v); paint(); this.persist(); };
    key.onclick = () => setMode(false); vin.onclick = () => setMode(true);
    const step = (d) => { const v = clamp(e.semitones + d, -12, 12); semi.set(v); e.setPitch(v); paint(); this.leds(); this.persist(); };
    const reset = () => { semi.set(0); cents.set(0); e.setPitch(0, 0); paint(); this.leds(); this.persist(); };
    c.body.append(
      h('div', { class: 'pitch-grid' }, lcd, h('div', {}, semi.el, cents.el)),
      h('div', { class: 'plug-row' },
        h('div', { class: 'seg' }, key, vin), h('span', { class: 'grow' }),
        h('button', { class: 'chip-btn', onClick: () => step(-1) }, '− 1 ' + t('pt.st')),
        h('button', { class: 'chip-btn', onClick: () => step(1) }, '+ 1 ' + t('pt.st')),
        h('button', { class: 'chip-btn', onClick: reset }, t('pt.reset'))));
    paint();
    return c;
  }

  /* ---------------------------- AMBIENT GENERATOR ---------------------------- */
  ambientPanel() {
    const a = this.ambient;
    const c = chassis({
      title: t('am.title'), sub: t('am.sub'), code: 'FX·02', powered: a.anyOn,
      onPower: (on) => {
        if (on) { const keys = this.lastAmb && this.lastAmb.length ? this.lastAmb : ['rain']; keys.forEach((k) => a.setLayer(k, true).then(sync)); }
        else { this.lastAmb = LAYERS.map((l) => l.key).filter((k) => a.layers[k].on); LAYERS.forEach((l) => a.setLayer(l.key, false)); }
        setTimeout(() => { sync(); this.leds(); }, 0);
      }
    });
    const chans = [];
    const sync = () => {
      for (const ch of chans) ch.el.classList.toggle('on', a.layers[ch.key].on);
      c.power.classList.toggle('on', a.anyOn);
      this.leds();
    };
    const grid = h('div', { class: 'amb-grid' });
    for (const { key, name } of LAYERS) {
      const pct = h('div', { class: 'amb-pct' }, Math.round(a.layers[key].level * 100) + '%');
      const ico = h('div', { class: 'amb-ico', title: t('tl.onoff'), html: ICON[key] });
      const vf = makeVFader({ value: a.layers[key].level, onInput: (v) => { a.setLevel(key, v); pct.textContent = Math.round(v * 100) + '%'; this.persist(); } });
      const el = h('div', { class: 'amb-ch' }, ico, h('div', { class: 'amb-name' }, t(name)), vf.el, pct);
      ico.onclick = async () => {
        const turnOn = !a.layers[key].on;
        if (turnOn && !a.layers[key].buffer) el.classList.add('loading');
        await a.setLayer(key, turnOn);
        el.classList.remove('loading'); sync();
      };
      chans.push({ key, el });
      grid.append(el);
    }
    const voice = h('div', { class: 'dm-bar voice', title: t('am.voice') }, h('i'));
    const duck = h('div', { class: 'dm-bar', title: t('am.duckT') }, h('i'));
    const ranges = h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' } },
      makeMiniRange({ label: t('am.depth'), value: a.depth, onInput: (v) => { a.depth = v; this.persist(); } }).el,
      makeMiniRange({ label: t('am.sens'), value: a.sensitivity, onInput: (v) => { a.sensitivity = v; this.persist(); } }).el,
      makeMiniRange({ label: t('am.level'), value: a.master, onInput: (v) => { a.setMaster(v); this.persist(); } }).el);
    grid.append(h('div', { class: 'lcd duck-panel' }, h('div', { class: 'lbl' }, t('am.duck')), h('div', { class: 'duck-meter' }, voice, duck, ranges)));
    c.body.append(grid);
    c.meters = { voice: voice.firstChild, duck: duck.firstChild };
    sync();
    return c;
  }

  /* -------------------------------- EQUALIZER -------------------------------- */
  eqPanel() {
    const e = this.engine;
    const c = chassis({
      title: t('eq.title'), sub: t('eq.sub'), code: 'FX·03', powered: e.eqOn,
      onPower: (on) => { e.setEqOn(on); drawCurve(); this.leds(); this.persist(); }
    });
    const canvas = h('canvas', { class: 'eq-curve' });
    const faders = [];
    const vals = [];
    const presetSeg = h('div', { class: 'seg eq-presets' });
    const markPreset = (key) => { this.settings.eq.preset = key; $$('button', presetSeg).forEach((b) => b.classList.toggle('on', b.dataset.k === key)); };
    const changed = () => { markPreset(null); drawCurve(); this.leds(); this.persist(); };

    const preVal = h('div', { class: 'eqv' }, fmtDb(e.eqPre));
    const pre = makeEqFader({ value: e.eqPre, onInput: (v) => { e.setEq(e.eqGains, v); preVal.textContent = fmtDb(v); changed(); } });
    const cols = h('div', { class: 'eq-cols' },
      h('div', { class: 'eq-col pre' }, preVal, pre.el, h('div', { class: 'eqhz' }, t('eq.pre'))),
      h('div', { class: 'eq-sep' }));
    EQ_FREQS.forEach((f, i) => {
      const v = h('div', { class: 'eqv' }, fmtDb(e.eqGains[i]));
      const fd = makeEqFader({ value: e.eqGains[i], onInput: (db) => { e.setEqBand(i, db); v.textContent = fmtDb(db); changed(); } });
      faders.push(fd); vals.push(v);
      cols.append(h('div', { class: 'eq-col' }, v, fd.el, h('div', { class: 'eqhz' }, hzLabel(f), h('small', {}, f >= 1000 ? t('eq.khz') : t('eq.hz')))));
    });
    for (const [k, p] of Object.entries(EQ_PRESETS)) {
      const b = h('button', { dataset: { k } }, t(p.name));
      b.onclick = () => {
        const g = p.g, top = Math.max(0, ...g);
        const preDb = -Math.round(top * .5 * 2) / 2; // headroom so boosts don't clip
        e.setEq(g, preDb);
        g.forEach((db, i) => { faders[i].set(db); vals[i].textContent = fmtDb(db); });
        pre.set(preDb); preVal.textContent = fmtDb(preDb);
        markPreset(k); drawCurve(); this.leds(); this.persist();
      };
      presetSeg.append(b);
    }
    c.body.append(h('div', { class: 'lcd eq-lcd' }, canvas), cols, h('div', { class: 'plug-row' }, presetSeg));
    markPreset(this.settings.eq.preset ?? null);

    const freqs = Array.from({ length: 220 }, (_, i) => 20 * Math.pow(1000, i / 219));
    const drawCurve = () => {
      const r = canvas.getBoundingClientRect(); if (!r.width) return;
      const d = devicePixelRatio || 1; canvas.width = r.width * d; canvas.height = r.height * d;
      const g = canvas.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
      const W = r.width, H = r.height, y = (db) => H / 2 - db / 15 * (H / 2 - 6);
      const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff4a1c';
      g.clearRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
      for (const db of [-12, -6, 0, 6, 12]) { g.beginPath(); g.moveTo(0, y(db) + .5); g.lineTo(W, y(db) + .5); g.stroke(); }
      g.fillStyle = 'rgba(255,255,255,.35)'; g.font = '9px JBMono, monospace';
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = Math.log(f / 20) / Math.log(1000) * W;
        g.fillRect(x, 0, 1, H); g.fillText(hzLabel(f), x + 3, H - 4);
      }
      const resp = e.eqResponse(freqs);
      const pts = freqs.map((f, i) => [i / (freqs.length - 1) * W, y(clamp(resp[i], -15, 15))]);
      g.beginPath(); g.moveTo(0, H / 2); pts.forEach(([x, yy]) => g.lineTo(x, yy)); g.lineTo(W, H / 2); g.closePath();
      const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, acc + '55'); grad.addColorStop(.5, acc + '08'); grad.addColorStop(1, acc + '44');
      g.fillStyle = grad; g.fill();
      g.beginPath(); pts.forEach(([x, yy], i) => (i ? g.lineTo(x, yy) : g.moveTo(x, yy)));
      g.strokeStyle = acc; g.lineWidth = 2; g.shadowColor = acc; g.shadowBlur = 8; g.stroke(); g.shadowBlur = 0;
    };
    new ResizeObserver(drawCurve).observe(canvas);
    c.drawCurve = drawCurve;
    return c;
  }

  /* ------------------------------ SPACE: tempo + reverb ------------------------------ */
  spacePanel() {
    const e = this.engine;
    const c = chassis({
      title: t('sp.title'), sub: t('sp.sub'), code: 'FX·04', powered: e.reverb.on,
      onPower: (on) => { e.setReverb({ on }); roomSeg.classList.toggle('off', !on); this.leds(); this.persist(); }
    });
    // tempo: speed without changing the key
    const big = h('div', { class: 'big' }), note = h('div', { class: 'interval' });
    const paint = () => {
      big.innerHTML = `<b>×${e.tempo.toFixed(2)}</b>`;
      note.textContent = e.tempo === 1 ? t('sp.tempo1') : e.tempo < 1 ? t('sp.slower') : t('sp.faster');
    };
    const lcd = h('div', { class: 'lcd pitch-lcd' }, h('div', { class: 'lbl' }, t('sp.tempo')), big, note);
    const tempo = makeFader({
      min: 50, max: 150, step: 1, value: Math.round(e.tempo * 100), def: 100, detent: 100,
      majors: [50, 75, 100, 125, 150], minors: Array.from({ length: 21 }, (_, i) => 50 + i * 5),
      labels: [[50, '×0.5'], [75, '×0.75'], [100, '×1'], [125, '×1.25'], [150, '×1.5']],
      onInput: (v) => { e.setTempo(v / 100); paint(); this.leds(); this.persist(); }
    });
    // reverb: room, then how much of it
    const roomSeg = h('div', { class: 'seg' + (e.reverb.on ? '' : ' off') }, ...['room', 'hall', 'cathedral'].map((k) => {
      const b = h('button', { class: e.reverb.room === k ? 'on' : '', dataset: { k } }, t('sp.r.' + k));
      b.onclick = () => { e.setReverb({ room: k, on: true }); c.power.classList.add('on'); roomSeg.classList.remove('off');
        roomSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); this.leds(); this.persist(); };
      return b;
    }));
    const mix = makeMiniRange({ label: t('sp.mix'), value: e.reverb.mix, onInput: (v) => { e.setReverb({ mix: v }); this.persist(); } });
    const reset = () => { tempo.set(100); e.setTempo(1); paint(); this.leds(); this.persist(); };
    c.body.append(
      h('div', { class: 'pitch-grid' }, lcd, h('div', {}, tempo.el)),
      h('div', { class: 'plug-row' }, h('span', { class: 'sp-lbl' }, t('sp.reverb')), roomSeg, h('div', { class: 'sp-mix' }, mix.el), h('span', { class: 'grow' }),
        h('button', { class: 'chip-btn', onClick: reset }, t('sp.reset'))));
    paint();
    return c;
  }

  loop() {
    const frame = () => {
      requestAnimationFrame(frame);
      if (!this.isOpen || document.documentElement.classList.contains('win-hidden') || document.hidden) return;
      const amb = this.panels.ambient;
      if (this.current === 'ambient' && amb && amb.meters) {
        amb.meters.voice.style.height = Math.round(this.ambient.voiceLevel * 100) + '%';
        amb.meters.duck.style.height = Math.round(this.ambient.reduction * 100) + '%';
      }
    };
    requestAnimationFrame(frame);
  }
}
function fmtDb(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(Math.abs(v) % 1 ? 1 : 0); }
