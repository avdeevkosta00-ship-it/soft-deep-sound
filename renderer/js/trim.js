/**
 * «Вырезать фрагмент»: pick a start and an end on the track's waveform, listen to the piece, save it as a
 * new file (MP3 320 or WAV). The original file is never touched. Short fades at the cuts avoid clicks.
 */
import { h, toast, openModal, closeModal, clamp, dragValue } from './ui.js';
import { t as tr } from './i18n.js';
import { encodeWav, encodeMp3 } from './exporter.js';

export function createTrim({ S, bridge, engine, art, artistOf, save, addExported }) {
  let busy = false;

  function open(t) {
    if (!t) return;
    if (busy) { toast(tr('ex.busy')); return; }
    const dur = t.duration || engine.duration || 0;
    if (!dur) { toast(tr('tm.noDur')); return; }
    // start from what is playing: a 30-second piece around the current moment
    const now = S.current === t ? engine.time : dur * .25;
    let a = clamp(now - 5, 0, Math.max(0, dur - 1)), b = clamp(a + 30, a + 1, dur);
    const peaks = t.peaks || null;
    const cv = h('canvas', { class: 'tm-wave' });
    const selEl = h('div', { class: 'tm-sel' }), hA = h('div', { class: 'tm-h a', tabindex: 0, role: 'slider', 'aria-label': tr('tm.start') }), hB = h('div', { class: 'tm-h b', tabindex: 0, role: 'slider', 'aria-label': tr('tm.end') });
    const playHead = h('div', { class: 'tm-play' });
    const wrap = h('div', { class: 'tm-wrap' }, cv, selEl, playHead, hA, hB);
    const lblA = h('b', { class: 'mono' }), lblB = h('b', { class: 'mono' }), lblL = h('b', { class: 'mono' });
    const paint = () => {
      selEl.style.left = (a / dur * 100) + '%'; selEl.style.width = ((b - a) / dur * 100) + '%';
      hA.style.left = (a / dur * 100) + '%'; hB.style.left = (b / dur * 100) + '%';
      lblA.textContent = fmtMs(a); lblB.textContent = fmtMs(b); lblL.textContent = fmtMs(b - a);
      hA.setAttribute('aria-valuetext', fmtMs(a)); hB.setAttribute('aria-valuetext', fmtMs(b));
    };
    const draw = () => {
      const r = cv.getBoundingClientRect(); if (!r.width) return;
      const d = devicePixelRatio || 1; cv.width = r.width * d; cv.height = r.height * d;
      const g = cv.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
      const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink-3').trim() || '#888';
      g.clearRect(0, 0, r.width, r.height); g.fillStyle = ink;
      const n = Math.floor(r.width / 3);
      for (let i = 0; i < n; i++) {
        const v = peaks ? peaks[Math.floor(i / n * peaks.length)] / 100 : .25 + .2 * Math.sin(i / 5) ** 2;
        const hh = Math.max(2, v * (r.height - 8));
        g.fillRect(i * 3, (r.height - hh) / 2, 2, hh);
      }
    };
    const at = (x) => { const r = wrap.getBoundingClientRect(); return clamp((x - r.left) / r.width, 0, 1) * dur; };
    dragValue(hA, { onMove: (e) => { a = clamp(at(e.clientX), 0, b - .5); paint(); } });
    dragValue(hB, { onMove: (e) => { b = clamp(at(e.clientX), a + .5, dur); paint(); } });
    const keys = (which) => (e) => {
      const step = e.shiftKey ? 1 : .1;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); e.stopPropagation();
      const d = e.key === 'ArrowRight' ? step : -step;
      if (which === 'a') a = clamp(a + d, 0, b - .5); else b = clamp(b + d, a + .5, dur);
      paint();
    };
    hA.addEventListener('keydown', keys('a')); hB.addEventListener('keydown', keys('b'));

    // listen to the piece on its own element, so the main player keeps its place
    const audition = new Audio(bridge.mediaUrl(t.path));
    let raf = 0;
    const stopListen = () => { audition.pause(); cancelAnimationFrame(raf); playHead.style.opacity = 0; listen.textContent = tr('tm.listen'); };
    const listen = h('button', { class: 'chip-btn' }, tr('tm.listen'));
    listen.onclick = () => {
      if (!audition.paused) return stopListen();
      if (engine.playing) engine.pause();
      audition.currentTime = a; audition.play().catch(() => {});
      listen.textContent = tr('tm.stop'); playHead.style.opacity = 1;
      const tick = () => {
        if (audition.currentTime >= b) return stopListen();
        playHead.style.left = (audition.currentTime / dur * 100) + '%';
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    const fromNow = h('button', { class: 'text-btn' }, tr('tm.fromNow'));
    fromNow.onclick = () => { if (S.current === t) { a = clamp(engine.time, 0, b - .5); paint(); } };

    const o = S.settings;
    const fmtSeg = h('div', { class: 'seg' }, ...['mp3', 'wav'].map((f) => h('button', { class: o.exportFormat === f ? 'on' : '',
      onClick: (e) => { o.exportFormat = f; fmtSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === e.currentTarget)); save(); } }, f === 'mp3' ? 'MP3 · 320 kbps' : 'WAV · 16-bit')));
    const name = h('input', { class: 'set-input wide', value: `${t.title} (${tr('tm.piece')})`, 'aria-label': tr('ex.name') });
    name.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape' && !busy) closeModal(); };
    const goBtn = h('button', { class: 'chip-btn on' }, tr('tm.save'));
    const card = h('div', { class: 'modal-card tm-card' },
      h('div', { class: 'v-kicker' }, tr('tm.kicker')), h('h3', {}, tr('tm.title')),
      h('div', { class: 'ex-src' }, h('div', { class: 'thumb', style: { background: art(t) } }), h('div', { class: 'web-meta' }, h('div', { class: 't' }, t.title), h('div', { class: 'a' }, artistOf(t)))),
      wrap,
      h('div', { class: 'tm-times' }, h('span', {}, tr('tm.start'), ' ', lblA), h('span', {}, tr('tm.len'), ' ', lblL), h('span', {}, tr('tm.end'), ' ', lblB)),
      h('div', { class: 'plug-row' }, listen, fromNow, h('span', { class: 'grow' }), h('small', { class: 'h-note' }, tr('tm.hint'))),
      h('label', { class: 'ed-row' }, h('span', {}, tr('ex.name')), name),
      h('div', { class: 'ed-row' }, h('span', {}, tr('ex.format')), fmtSeg),
      h('div', { class: 'modal-acts' }, h('small', { class: 'h-note' }, tr('tm.note')), h('span', { class: 'grow' }),
        h('button', { class: 'chip-btn', onClick: () => { stopListen(); closeModal(); } }, tr('ed.cancel')), goBtn));

    goBtn.onclick = async () => {
      if (busy) return;
      stopListen();
      const title = name.value.trim() || t.title;
      const target = await bridge.exporter.pick(title, o.exportFormat);
      if (!target) return;
      busy = true; goBtn.disabled = true; goBtn.textContent = tr('tm.saving');
      try {
        const res = await fetch(bridge.mediaUrl(t.path));
        if (!res.ok) throw new Error(tr('toast.fileGone', { title: t.title }));
        const buf = await engine.ctx.decodeAudioData(await res.arrayBuffer());
        const sr = buf.sampleRate, s0 = Math.floor(a * sr), s1 = Math.min(buf.length, Math.ceil(b * sr)), n = s1 - s0;
        const ch = (k) => buf.getChannelData(Math.min(k, buf.numberOfChannels - 1)).slice(s0, s1);
        const left = ch(0), right = ch(1);
        // 8 ms fades at both cuts: no click where the waveform is cut mid-swing
        const f = Math.min(Math.floor(sr * .008), Math.floor(n / 4));
        for (let i = 0; i < f; i++) { const k = i / f; left[i] *= k; right[i] *= k; left[n - 1 - i] *= k; right[n - 1 - i] *= k; }
        const pcm = { left, right, sampleRate: sr };
        const tags = { title, artist: t.artist, album: t.album, genre: t.genre, comment: `${fmtMs(a)}–${fmtMs(b)}` };
        const data = target.format === 'mp3' ? await encodeMp3(pcm, tags) : encodeWav(pcm, tags);
        const fp = await bridge.exporter.write(target.path, data);
        if (card.isConnected) closeModal();
        await addExported(fp, t, title, `${fmtMs(a)}–${fmtMs(b)}`);
      } catch (e) {
        console.error(e); toast(tr('ex.fail', { msg: e.message || e }));
        goBtn.disabled = false; goBtn.textContent = tr('tm.save');
      } finally { busy = false; }
    };
    openModal(card);
    new ResizeObserver(() => { draw(); paint(); }).observe(wrap);
    requestAnimationFrame(() => { draw(); paint(); });
  }

  return { open };
}

function fmtMs(s) { const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`; }
