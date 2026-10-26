/**
 * Deep View — full-screen "Now Playing".
 * Opens with a shared-element transition: the artwork flies from the Now Playing panel
 * into place while the backdrop (the cover itself, blurred) fades in and the details
 * rise in a short stagger. Closing is the same motion in reverse, a bit faster.
 */
import { $, h, esc, fmt, clamp, dragValue } from './ui.js';
import { t as tr, tn } from './i18n.js';
import { ICON } from './icons.js';
import { WaveSeek } from './visualizer.js';
import { swipeToClose, slideAway } from './gestures.js';
import { findSimilar, analyzed, quality } from './smart.js';
import { parseLyrics, lineAt, wordAt } from './lyrics.js';

const ENTER = 'cubic-bezier(.16,.84,.24,1)', EXIT = 'cubic-bezier(.5,0,.75,.3)';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class DeepView {
  constructor(api) {
    this.api = api; // { engine, getTrack, tracks, art, artistOf, playIds, playNext, next, prev, toggle, ensureAnalysis, ensureFormat, onSimilar, getLyrics, openSettings }
    this.el = null; this.open = false; this.busy = false;
    this.mode = 'info'; // 'info' — analysis and similar tracks, 'lyrics' — the words
    this.ly = null;     // { id, data, idx } for the lyrics on screen
  }
  get isOpen() { return this.open; }
  toggle() { this.open ? this.close() : this.show(); }

  /** L: open straight on the lyrics, or switch to them / back when already open */
  toggleLyrics() {
    if (!this.open) return this.show('lyrics');
    this.setMode(this.mode === 'lyrics' ? 'info' : 'lyrics');
  }

  /** seconds the lyrics are shifted for a track (+ = later) */
  offset(t) { return (t && t.lyricsOffset) || 0; }

  /** karaoke: the sung part of the current line fills in word by word */
  followWords(idx, time) {
    const list = this.el.querySelector('.ly-lines'), lines = this.ly.data.lines;
    const row = list && list.children[idx], line = lines[idx];
    if (this.kRow && this.kRow !== row) this.kRow.querySelectorAll('.ly-w').forEach((w) => w.style.removeProperty('--k'));
    this.kRow = row;
    if (!row || !line || !line.words) return;
    const at = wordAt(line, time, lines[idx + 1] && lines[idx + 1].t);
    row.querySelectorAll('.ly-w').forEach((w, i) => w.style.setProperty('--k', i < at.i ? 1 : i === at.i ? at.p.toFixed(3) : 0));
  }

  /** «на весь экран»: only the words, big, over the blurred cover — for singing along */
  toggleTv(on) {
    if (!this.open) { this.show('lyrics'); setTimeout(() => this.toggleTv(true), 500); return; }
    if (this.mode !== 'lyrics') this.setMode('lyrics');
    this.tv = on ?? !this.tv;
    this.el.classList.toggle('ly-tv', this.tv);
    if (this.ly) { this.ly.idx = -2; setTimeout(() => this.followLyrics(this.api.engine.time, true), 350); }
  }

  setMode(mode) {
    this.mode = mode;
    if (!this.el) return;
    this.el.classList.toggle('mode-lyrics', mode === 'lyrics');
    if (mode !== 'lyrics' && this.tv) { this.tv = false; this.el.classList.remove('ly-tv'); }
    this.el.querySelectorAll('.dv-modes button').forEach((b) => { const on = b.dataset.mode === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    if (mode === 'lyrics') this.loadLyrics();
  }

  /** the cover Deep View grows out of and returns to */
  origin() { const f = $('#coverFrame'); return f.offsetParent ? f : $('#deckCover'); }

  show(mode) {
    if (mode) this.mode = mode;
    if (this.open && mode) return this.setMode(mode);
    const t = this.api.getTrack();
    if (!t || this.open || this.busy) return;
    this.open = true; this.busy = true;
    const el = this.el = this.build(t);
    document.body.append(el);
    document.body.classList.add('deep-open');
    // pull Deep View down to go back to the list (from the top bar, the cover, or anywhere scrolled to the top)
    swipeToClose(el, { threshold: 140, onClose: (dy) => slideAway(el, dy, () => this.close(true)) });
    const from = this.origin(), src = from.getBoundingClientRect();
    const cover = el.querySelector('.dv-cover');
    const dst = cover.getBoundingClientRect();
    const items = [...el.querySelectorAll('.dv-in')];
    const done = () => { if (this.closing) return; this.busy = false; el.classList.add('settled'); el.querySelector('.dv-close').focus({ preventScroll: true }); };
    if (reduced()) { el.classList.add('shown'); done(); }
    else {
      from.style.visibility = 'hidden';
      el.querySelector('.dv-bg').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease-out', fill: 'both' });
      const dx = src.left - dst.left, dy = src.top - dst.top, s = src.width / dst.width;
      // a phone repaints a big cover on every frame of a changing corner radius: there it flies by transform alone
      const lite = matchMedia('(max-width: 760px)').matches;
      cover.animate(lite ? [{ transform: `translate(${dx}px, ${dy}px) scale(${s})` }, { transform: 'none' }] : [{ transform: `translate(${dx}px, ${dy}px) scale(${s})`, borderRadius: `${24 / s}px` }, { transform: 'none', borderRadius: '30px' }],
        { duration: 640, easing: ENTER, fill: 'both' }).finished.catch(() => {}).then(() => { if (!this.closing) from.style.visibility = ''; done(); });
      items.forEach((n, i) => n.animate([{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }],
        { duration: 520, delay: 140 + i * 45, easing: ENTER, fill: 'both' }));
      el.classList.add('shown');
    }
    this.bindLoop();
    this.api.ensureFormat(t).then(() => this.refreshMeta());
    this.api.ensureAnalysis(t);
  }

  /** @param gone the overlay already left the screen (pulled down): just clean up */
  close(gone) {
    this.tv = false;
    if (!this.open || this.closing) return;
    const el = this.el;
    // interrupt a still-running opening animation so Esc always works
    if (this.busy) el.getAnimations({ subtree: true }).forEach((a) => { if (a instanceof CSSAnimation) return; try { a.finish(); } catch {} });
    this.busy = true; this.closing = true;
    if (this.onFocus) { removeEventListener('focus', this.onFocus); this.onFocus = null; this.awaitPaste = null; }
    const to = this.origin();
    const finish = () => { if (this.el !== el) return; el.remove(); this.el = null; this.open = false; this.busy = false; this.closing = false; document.body.classList.remove('deep-open'); cancelAnimationFrame(this.raf); to.style.visibility = ''; };
    if (reduced() || gone) return finish();
    const cover = el.querySelector('.dv-cover'), dst = to.getBoundingClientRect(), src = cover.getBoundingClientRect();
    const dx = dst.left - src.left, dy = dst.top - src.top, s = dst.width / src.width;
    [...el.querySelectorAll('.dv-in')].forEach((n) => n.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(10px)' }], { duration: 180, easing: EXIT, fill: 'both' }));
    el.querySelector('.dv-bg').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, delay: 80, easing: 'ease-in', fill: 'both' });
    to.style.visibility = 'hidden';
    const lite = matchMedia('(max-width: 760px)').matches;
    cover.animate(lite ? [{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${s})` }] : [{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${s})`, borderRadius: `${24 / s}px` }],
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
    } else {
      // same track, maybe renamed (e.g. from a lyrics suggestion)
      this.el.querySelector('.dv-title').textContent = t.title;
      const ar = this.el.querySelector('.dv-artist');
      ar.replaceChildren(this.api.artistOf(t), ...(t.album ? [h('span', {}, ' — ' + t.album)] : []), ...(t.year ? [h('span', { class: 'dv-year' }, ' · ' + t.year)] : []));
      this.refreshMeta(); this.refreshAnalysis();
    }
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
    const modes = h('div', { class: 'seg dv-modes', role: 'group', 'aria-label': tr('ly.modes') },
      ...[['info', tr('ly.info')], ['lyrics', tr('ly.title')]].map(([k, label]) => h('button', { dataset: { mode: k }, class: this.mode === k ? 'on' : '', 'aria-pressed': String(this.mode === k), onClick: () => this.setMode(k) }, label)));
    const seek = h('div', { class: 'dv-seek' }, h('canvas'));
    const cur = h('span', { class: 'time dv-cur' }, '0:00'), dur = h('span', { class: 'time' }, fmt(t.duration));

    const el = h('div', { class: 'deep', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('dv.kicker'), dataset: { id: t.id } },
      h('div', { class: 'dv-bg' }, h('div', { class: 'dv-bg-art', style: { background: a.art(t) } }), h('div', { class: 'dv-bg-tint' })),
      h('div', { class: 'dv-top dv-in' }, h('div', { class: 'v-kicker' }, tr('dv.kicker')), modes, h('span', { class: 'dv-hint' }, tr('dv.hint')), close),
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
            h('div', { class: 'dv-sim' })),
          // dv-in: the lyrics fade in and out with the rest, so they never hang over the interface while closing
          h('section', { class: 'dv-lyrics dv-in', 'aria-live': 'off' }),
          h('div', { class: 'ly-foot dv-in' }))));
    if (this.mode === 'lyrics') el.classList.add('mode-lyrics');
    if (this.mode === 'lyrics' && this.tv) el.classList.add('ly-tv');
    el.addEventListener('dblclick', (e) => { if (e.target.closest('.dv-cover, .dv-bg, .dv-top')) this.close(); });
    this.wave = new WaveSeek(seek.querySelector('canvas'), { onDark: true });
    this.wave.set(t.peaks || null);
    const pAt = (x) => { const r = seek.getBoundingClientRect(); return clamp((x - r.left) / r.width, 0, 1); };
    this.dragP = null;
    dragValue(seek, {
      onStart: (e) => { this.dragP = pAt(e.clientX); },
      onMove: (e) => { this.dragP = pAt(e.clientX); },
      onEnd: (e) => { if (this.dragP !== null) { if (e && e.type === 'pointerup') this.dragP = pAt(e.clientX); a.engine.seek(this.dragP * a.engine.duration); } this.dragP = null; }
    });
    this.ui = { cur, dur };
    this.refreshMeta(el); this.refreshAnalysis(el);
    this.ly = null;
    if (this.mode === 'lyrics') queueMicrotask(() => this.loadLyrics());
    return el;
  }

  bindLoop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.open || !this.el) return;
      // schedule first: one bad frame must never stop the clock, the waveform and the lyrics for good
      this.raf = requestAnimationFrame(tick);
      const e = this.api.engine, d = e.duration;
      const time = this.dragP !== null && this.dragP !== undefined ? this.dragP * d : e.time; // while dragging: where the finger is
      this.wave.progress(d ? time / d : 0);
      this.ui.cur.textContent = fmt(time);
      if (this.mode === 'lyrics') { try { this.followLyrics(e.time); } catch (err) { console.warn('lyrics:', err); } }
    };
    this.raf = requestAnimationFrame(tick);
  }

  /* ------------------------------ lyrics ------------------------------ */
  /** online: look past the user's own text and show what LRCLIB has as a preview they can take or leave */
  async loadLyrics(force, { online = false } = {}) {
    const t = this.api.getTrack(), box = this.el && this.el.querySelector('.dv-lyrics');
    if (!t || !box || (!force && this.ly && this.ly.id === t.id)) return;
    // each load owns its own state: an answer that arrives after Deep View was closed and reopened
    // (LRCLIB can take seconds) must not touch the new window's lyrics
    const ly = this.ly = { id: t.id, data: null, idx: -2 };
    const foot = this.el.querySelector('.ly-foot');
    box.innerHTML = ''; foot.textContent = '';
    box.append(h('div', { class: 'ly-state' }, h('span', { class: 'spin' }), tr('ly.loading')));
    let res;
    try { res = await this.api.getLyrics(t, force, online); } catch (e) { res = { error: true }; }
    if (this.ly !== ly || !box.isConnected || this.api.getTrack() !== t) return;
    box.innerHTML = '';
    const note = (text, ...acts) => box.append(h('div', { class: 'ly-state' }, h('span', {}, text), h('div', { class: 'ly-acts' }, ...acts, ...this.ownActions(t))));
    const back = () => h('button', { class: 'chip-btn', onClick: () => this.loadLyrics(true) }, tr('ly.keep'));
    if (!res || res.error) return note(tr('ly.error'), h('button', { class: 'chip-btn', onClick: () => this.loadLyrics(true, { online }) }, tr('ly.retry')), online ? back() : null);
    this.suggestName(t, res.match);
    const data = res.text ? parseLyrics(res.text) : null;
    if (data && data.instrumental) return note(tr('ly.instrumental'));
    if (!data || !data.lines.length) {
      if (online) return note(tr('ly.onlineNone'), back());
      return note(res.offline ? tr('ly.offline') : tr('ly.none'),
        res.offline ? h('button', { class: 'chip-btn', onClick: () => { this.close(); this.api.openSettings(); } }, tr('ly.settings'))
          : h('button', { class: 'chip-btn', onClick: () => this.loadLyrics(true) }, tr('ly.again')));
    }
    ly.data = data;
    const list = h('div', { class: 'ly-lines' + (data.synced ? ' synced' : '') });
    data.lines.forEach((l, i) => {
      const row = h(data.synced ? 'button' : 'p', { class: 'ly-line' + (l.text ? '' : ' gap') + (l.words ? ' kara' : ''), dataset: { i } },
        ...(l.words ? l.words.map((w) => h('span', { class: 'ly-w' }, w.w)) : [l.text || (data.synced ? '♪' : '')]));
      if (data.synced) row.onclick = () => this.api.engine.seek(l.t + this.offset(t));
      list.append(row);
    });
    const src = { lrc: tr('ly.srcLrc'), tags: tr('ly.srcTags'), own: tr('ly.srcOwn'), lrclib: 'LRCLIB' }[res.source] || '';
    box.append(list);
    foot.append(h('span', {}, (data.synced ? (data.karaoke ? tr('ly.karaoke') : tr('ly.synced')) : tr('ly.plain')) + (src ? ' · ' + src : '')));
    if (data.synced) {
      // a line late or early against the voice: nudge the whole text, remembered for this track
      const val = h('b', { class: 'ly-off-v' });
      const paintOff = () => { const o = this.offset(t); val.textContent = (o > 0 ? '+' : o < 0 ? '−' : '±') + Math.abs(o).toFixed(2) + ' ' + tr('pb.s'); };
      const nudge = (d) => { this.api.setLyricsOffset(t, Math.round((this.offset(t) + d) * 100) / 100); paintOff(); ly.idx = -2; this.followLyrics(this.api.engine.time, true); };
      paintOff();
      foot.append(h('span', { class: 'ly-off', title: tr('ly.offsetT') },
        h('button', { class: 'text-btn', 'aria-label': tr('ly.earlier'), onClick: () => nudge(-.25) }, '−'), val,
        h('button', { class: 'text-btn', 'aria-label': tr('ly.later'), onClick: () => nudge(.25) }, '+')));
    }
    foot.append(h('button', { class: 'text-btn ly-again ly-tvbtn', onClick: () => this.toggleTv() }, tr('ly.tv')));
    // found online but maybe not the right one, or only plain text: one more fresh lookup
    if (res.source === 'lrclib' && !online) foot.append(h('button', { class: 'text-btn ly-again', onClick: () => this.loadLyrics(true) }, tr('ly.again')));
    // the user's own text (a .lrc, the tags, one they pasted): the internet can still be asked, without touching it
    if (['lrc', 'own', 'tags'].includes(res.source)) foot.append(h('button', { class: 'text-btn ly-again', onClick: () => this.loadLyrics(true, { online: true }) }, tr('ly.online')));
    if (online) this.previewBar(t, res.text);
    this.followLyrics(this.api.engine.time, true);
  }

  /*
   * The extra, hands-on source: the user looks the song up on Genius in the browser, copies the words and
   * comes back — the player offers to keep them. Nothing is fetched from Genius by the player itself.
   */
  ownActions(t) {
    if (!this.api.saveLyrics) return [];
    const genius = h('button', { class: 'chip-btn' }, tr('ly.genius'));
    genius.onclick = () => {
      this.api.openUrl('https://genius.com/search?q=' + encodeURIComponent([t.artist, t.title].filter(Boolean).join(' ')));
      this.awaitPaste = t.id;
      if (!this.onFocus) { this.onFocus = () => this.offerClipboard(); addEventListener('focus', this.onFocus); }
    };
    const paste = h('button', { class: 'chip-btn' }, tr('ly.paste'));
    paste.onclick = () => this.editLyrics(t, '');
    return [genius, paste];
  }

  /** back from the browser: if the clipboard now holds something lyric-shaped, offer it — never save on its own */
  async offerClipboard() {
    const t = this.api.getTrack();
    if (!this.open || this.mode !== 'lyrics' || !t || this.awaitPaste !== t.id || !this.el) return;
    const text = String(await this.api.readClipboard().catch(() => '') || '').trim();
    const lines = text.split(/\n/).filter((l) => l.trim());
    if (lines.length < 4 || text.length < 60 || /^https?:\/\//.test(text)) return;
    const box = this.el.querySelector('.dv-lyrics');
    if (!box || box.querySelector('.ly-offer, .ly-edit')) return;
    const offer = h('div', { class: 'ly-offer' },
      h('b', {}, tr('ly.offerT')),
      h('div', { class: 'ly-preview' }, lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n…' : '')),
      h('div', { class: 'ly-acts' },
        h('button', { class: 'chip-btn on', onClick: () => this.keepLyrics(t, text) }, tr('ly.offerYes')),
        h('button', { class: 'chip-btn', onClick: () => this.editLyrics(t, text) }, tr('ly.offerEdit')),
        h('button', { class: 'text-btn', onClick: () => { this.awaitPaste = null; offer.remove(); } }, tr('ly.offerNo'))));
    box.prepend(offer);
    box.scrollTop = 0;
  }

  editLyrics(t, text) {
    const box = this.el && this.el.querySelector('.dv-lyrics');
    if (!box) return;
    box.innerHTML = '';
    const area = h('textarea', { class: 'ly-area', spellcheck: 'false', placeholder: tr('ly.pastePh') });
    area.value = text;
    area.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.loadLyrics(true); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click(); });
    const save = h('button', { class: 'chip-btn on', onClick: () => { if (area.value.trim()) this.keepLyrics(t, area.value); else area.focus(); } }, tr('ly.save'));
    box.append(h('div', { class: 'ly-edit' }, h('small', {}, tr('ly.pasteHint')), area,
      h('div', { class: 'ly-acts' }, save, h('button', { class: 'text-btn', onClick: () => this.loadLyrics(true) }, tr('pi.cancel')))));
    setTimeout(() => area.focus(), 30);
  }

  async keepLyrics(t, text) {
    this.awaitPaste = null;
    try { await this.api.saveLyrics(t, text); }
    catch (e) { console.error(e); return; }
    if (this.api.getTrack() === t) this.loadLyrics(true);
  }

  /**
   * The track only had a title (often a garbled file name) and the lyrics were found by guessing who sings it:
   * say so, and offer to give the track its real name. Nothing is renamed without the click.
   */
  suggestName(t, m) {
    const foot = this.el && this.el.querySelector('.ly-foot');
    this.el && this.el.querySelectorAll('.ly-suggest').forEach((n) => n.remove());
    if (!m || !m.artist || !this.api.renameTrack) return;
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    if (same(m.artist, t.artist) && same(m.title, t.title)) return;
    const bar = h('div', { class: 'ly-suggest' },
      h('span', {}, tr('ly.guess', { name: `${m.artist} — ${m.title}` })),
      h('button', { class: 'chip-btn on', onClick: () => { this.api.renameTrack(t, m); bar.remove(); } }, tr('ly.rename')),
      h('button', { class: 'text-btn', onClick: () => bar.remove() }, tr('ly.notIt')));
    foot.before(bar);
  }

  /** the online result over the user's own text: replace theirs (the old file is kept as .lrc.bak) or keep it */
  previewBar(t, text) {
    const foot = this.el && this.el.querySelector('.ly-foot');
    if (!foot) return;
    const bar = h('div', { class: 'ly-suggest' },
      h('span', {}, tr('ly.previewT')),
      h('button', { class: 'chip-btn on', onClick: async () => { try { await this.api.saveLyrics(t, text, true); this.loadLyrics(true); } catch {} } }, tr('ly.replace')),
      h('button', { class: 'text-btn', onClick: () => this.loadLyrics(true) }, tr('ly.keep')));
    foot.before(bar);
  }

  /** light the line being sung and keep it in the middle of the box */
  followLyrics(time, jump) {
    const ly = this.ly;
    if (!ly || !ly.data || !ly.data.synced || !this.el) return;
    time -= this.offset(this.api.getTrack());
    const idx = lineAt(ly.data.lines, time);
    if (ly.data.karaoke) this.followWords(idx, time);
    if (idx === ly.idx && !jump) return;
    ly.idx = idx;
    const list = this.el.querySelector('.ly-lines');
    if (!list) return;
    list.querySelectorAll('.ly-line.now, .ly-line.past').forEach((n) => n.classList.remove('now', 'past'));
    [...list.children].forEach((n, i) => { if (i < idx) n.classList.add('past'); });
    const row = list.children[idx];
    if (row) row.classList.add('now');
    const box = this.el.querySelector('.dv-lyrics');
    const target = row ? row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2 : 0;
    box.scrollTo({ top: Math.max(0, target), behavior: jump || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
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
