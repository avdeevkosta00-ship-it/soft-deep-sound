/**
 * Library repair, the part people see:
 *   • «Найти музыку на компьютере» — the main process looks in the usual places and on every drive,
 *     the user ticks the folders to add;
 *   • «Обложки и теги из интернета» — for tracks missing artwork, album, year or genre the main process
 *     asks MusicBrainz / Cover Art Archive. Only empty fields are filled, nothing the user has is
 *     overwritten, the files on disk stay untouched, and every change is shown before it is applied.
 */
import { $, h, toast, openModal, closeModal } from './ui.js';
import { t as tr, tn } from './i18n.js';
import { ICON } from './icons.js';

const SURE = .85;            // pre-ticked from this confidence up
const RECHECK = 30 * 864e5;  // a track MusicBrainz knew nothing about is asked again after 30 days…
const RULES = 2;             // …or right away once the search improves (2: words search for lost apostrophes)

export function createLibraryRepair(ctx) {
  const { S, bridge, save, art, artistOf, render, importPaths, pickImport } = ctx;
  const job = { running: false, cancel: false, done: 0, total: 0, found: 0, results: null };

  /* ------------------------------ find music on this computer ------------------------------ */
  async function openFinder() {
    if (!bridge.library.scan) return pickImport('folder');
    const card = h('div', { class: 'modal-card lr-card' },
      h('div', { class: 'v-kicker' }, tr('lr.kicker')), h('h3', {}, tr('lr.findT')),
      h('div', { class: 'lr-wait' }, h('span', { class: 'pi-spin' }), tr('lr.scanning')));
    openModal(card);
    let found = [];
    try { found = await bridge.library.scan(); } catch (e) { console.error(e); }
    if (!card.isConnected) return; // closed while scanning
    card.querySelector('.lr-wait').remove();
    if (!found.length) {
      card.append(h('p', { class: 'lr-note' }, tr('lr.none')),
        h('div', { class: 'modal-acts' }, h('span', { class: 'grow' }), h('button', { class: 'chip-btn', onClick: closeModal }, tr('pi.close')),
          h('button', { class: 'chip-btn on', onClick: () => { closeModal(); pickImport('folder'); } }, tr('v.folder'))));
      return;
    }
    const picked = new Set(found.map((f) => f.path));
    const add = h('button', { class: 'chip-btn on' });
    const paint = () => {
      const n = found.filter((f) => picked.has(f.path)).reduce((s, f) => s + f.count, 0);
      add.textContent = n ? tr('lr.addN', { n: tn('tracks', n) }) : tr('lr.pickSome');
      add.disabled = !n;
    };
    const rows = found.map((f) => {
      const name = f.path.split(/[\\/]/).filter(Boolean).pop() || f.path;
      const row = h('button', { class: 'lr-folder on', role: 'checkbox', 'aria-checked': 'true' },
        h('span', { class: 'lr-tick', 'aria-hidden': 'true' }),
        h('span', { class: 'lr-fmeta' }, h('b', {}, name), h('small', { class: 'mono' }, f.path)),
        h('em', { class: 'lr-count' }, tn('tracks', f.count)));
      row.onclick = () => {
        const on = !picked.has(f.path);
        on ? picked.add(f.path) : picked.delete(f.path);
        row.classList.toggle('on', on); row.setAttribute('aria-checked', String(on)); paint();
      };
      return row;
    });
    add.onclick = () => { const paths = found.filter((f) => picked.has(f.path)).map((f) => f.path); closeModal(); importPaths(paths); };
    paint();
    card.querySelector('h3').textContent = tr('lr.foundT', { n: tn('folders', found.length) });
    card.append(h('p', { class: 'lr-note' }, tr('lr.foundD')), h('div', { class: 'lr-list' }, ...rows),
      h('div', { class: 'modal-acts' },
        h('button', { class: 'text-btn', onClick: () => { closeModal(); pickImport('folder'); } }, tr('lr.other')),
        h('span', { class: 'grow' }), h('button', { class: 'chip-btn', onClick: closeModal }, tr('pi.close')), add));
  }

  /* ------------------------------ artwork and tags from MusicBrainz ------------------------------ */
  const real = (t) => !/^(demo|export):/.test(String(t.path));
  const lacks = (t) => !t.cover || !t.album || !t.year || !t.genre;
  /** tracks worth asking about: missing something, and with an artist to search by — or, without one, a length
   *  (MusicBrainz then guesses the artist from title + length, and the match is never pre-ticked) */
  function candidates(ids) {
    const pool = ids ? ids.map((id) => S.tracks.find((t) => t.id === id)).filter(Boolean) : S.tracks;
    return pool.filter((t) => real(t) && (t.artist ? lacks(t) : t.duration > 0) && !(t.mbTried && t.mbRules === RULES && Date.now() - t.mbTried < RECHECK));
  }
  /** only empty fields are filled — what the user already has always wins */
  function changes(t, m) {
    const c = {};
    if (!t.artist && m.artist) { c.artist = m.artist; if (m.title && m.title !== t.title) c.title = m.title; }
    if (!t.cover && m.cover) c.cover = m.cover;
    if (!t.album && m.album) c.album = m.album;
    if (!t.year && m.year) c.year = m.year;
    if (!t.genre && m.genre) c.genre = m.genre;
    return c;
  }

  async function start(ids) {
    if (job.running) return;
    const list = candidates(ids);
    if (!list.length) { toast(tr('lr.nothing')); return; }
    Object.assign(job, { running: true, cancel: false, done: 0, total: list.length, found: 0, results: [] });
    paintRepair();
    // a few tracks at once: MusicBrainz calls still queue up in the main process, artwork downloads overlap
    let next = 0;
    const worker = async () => {
      while (!job.cancel && next < list.length) {
        const t = list[next++];
        let m = null;
        try { m = await bridge.meta.repair({ title: t.title, artist: t.artist, duration: t.duration, wantCover: !t.cover, wantGenre: !t.genre }); }
        catch (e) { console.warn('repair:', e.message); if (/rate-limit/.test(e.message)) await new Promise((r) => setTimeout(r, 4000)); }
        job.done++;
        if (m) {
          const c = changes(t, m);
          if (Object.keys(c).length) { job.results.push({ t, m, c, accept: m.confidence >= SURE }); job.found++; }
        } else { t.mbTried = Date.now(); t.mbRules = RULES; }
        paintRepair();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    job.running = false;
    save();
    paintRepair(true);
  }

  function apply() {
    const chosen = (job.results || []).filter((r) => r.accept);
    for (const { t, m, c } of chosen) {
      if (c.cover) { t.origCover = t.cover || null; t.cover = c.cover; t.customCover = true; }
      const F = ['artist', 'title', 'album', 'year', 'genre'];
      for (const k of F) if (c[k] != null) t[k] = c[k];
      t.edited = [...new Set([...(t.edited || []), ...F.filter((k) => c[k] != null)])];
      t.mbid = m.mbid;
    }
    // what the user did not take is not offered again for a while
    for (const r of job.results || []) if (!r.accept) { r.t.mbTried = Date.now(); r.t.mbRules = RULES; }
    job.results = null;
    save();
    render(false);
    ctx.refreshArt(); // Now Playing, the deck and Up Next show the new artwork right away
    toast(chosen.length ? tr('lr.applied', { n: tn('tracks', chosen.length) }) : tr('lr.skipped'));
  }

  /** the card at the top of «Состояние медиатеки» */
  function repairCard() {
    const box = h('section', { class: 'lr-repair', id: 'lrRepair' });
    fillRepair(box);
    return box;
  }
  function paintRepair(full) {
    const box = $('#lrRepair');
    if (!box) return;
    if (full || !box.querySelector('.lr-prog')) return fillRepair(box);
    box.querySelector('.lr-prog i').style.transform = `scaleX(${Math.max(.03, job.done / Math.max(1, job.total))})`;
    box.querySelector('.lr-prog-t').textContent = tr('lr.progress', { done: job.done, total: job.total, found: job.found });
  }
  function fillRepair(box) {
    box.innerHTML = '';
    const head = (title, text, ...acts) => h('div', { class: 'lr-head' },
      h('span', { class: 'lr-ico', html: ICON.health }),
      h('div', { class: 'lr-htext' }, h('b', {}, title), h('small', {}, text)), ...acts);

    if (job.running) {
      const stop = h('button', { class: 'chip-btn', onClick: () => { job.cancel = true; stop.disabled = true; } }, tr('pi.cancel'));
      box.append(head(tr('lr.repT'), tr('lr.repRun'), stop),
        h('div', { class: 'lr-prog' }, h('div', { class: 'ex-prog-row' }, h('span', { class: 'lr-prog-t' }, tr('lr.progress', { done: job.done, total: job.total, found: job.found })), h('span', { class: 'pi-spin' })),
          h('div', { class: 'ex-bar' }, h('i', { style: { transform: `scaleX(${Math.max(.03, job.done / Math.max(1, job.total))})` } }))));
      return;
    }
    if (job.results && job.results.length) return fillResults(box, head);
    if (job.results) { job.results = null; box.append(head(tr('lr.repT'), tr('lr.noneFound'))); return; }

    const n = candidates().length;
    const noArtist = S.tracks.filter((t) => real(t) && !t.artist && !(t.duration > 0)).length;
    box.classList.toggle('ok', !n);
    box.append(head(tr('lr.repT'), n ? tr('lr.repD', { n: tn('tracksGen', n) }) : tr('lr.repOk'),
      n ? h('button', { class: 'chip-btn on', onClick: () => start() }, tr('lr.repGo')) : null));
    if (n) box.append(h('div', { class: 'lr-privacy' }, tr('lr.privacy')));
    if (noArtist) box.append(h('div', { class: 'lr-privacy' }, tr('lr.noArtist', { n: tn('tracksGen', noArtist) })));
  }
  function fillResults(box, head) {
    const R = job.results.sort((a, b) => b.m.confidence - a.m.confidence);
    const applyBtn = h('button', { class: 'chip-btn on' });
    const paintApply = () => { const k = R.filter((r) => r.accept).length; applyBtn.textContent = k ? tr('lr.apply', { n: k }) : tr('lr.applyNone'); };
    applyBtn.onclick = apply;
    const all = h('button', { class: 'text-btn' }, tr('lr.all'));
    const list = h('div', { class: 'lr-results' });
    const rows = R.slice(0, 400).map((r, i) => {
      const what = [r.c.artist && `${r.c.artist} — ${r.c.title || r.t.title}`, r.c.album, r.c.year, r.c.genre].filter(Boolean).join(' · ');
      const row = h('button', { class: 'lr-res' + (r.accept ? ' on' : ''), role: 'checkbox', 'aria-checked': String(r.accept), style: { '--i': Math.min(i, 14) } },
        h('span', { class: 'lr-tick', 'aria-hidden': 'true' }),
        h('span', { class: 'lr-thumb', style: { background: r.c.cover ? `url("${bridge.mediaUrl(r.c.cover)}") center/cover` : art(r.t) } },
          r.c.cover ? h('i', { class: 'lr-new' }, tr('lr.newCover')) : null),
        h('span', { class: 'lr-fmeta' }, h('b', {}, r.t.title), h('small', {}, artistOf(r.t))),
        h('span', { class: 'lr-will' }, h('small', {}, what ? tr('lr.adds') : tr('lr.onlyCover')), h('span', {}, what || '—')),
        h('em', { class: 'lr-conf' + (r.m.confidence >= SURE ? '' : ' unsure'), title: tr('lr.confT') }, r.m.confidence >= SURE ? tr('lr.sure') : tr('lr.unsure')));
      row.onclick = () => { r.accept = !r.accept; row.classList.toggle('on', r.accept); row.setAttribute('aria-checked', String(r.accept)); paintApply(); };
      return [r, row];
    });
    all.onclick = () => { rows.forEach(([r, row]) => { r.accept = true; row.classList.add('on'); row.setAttribute('aria-checked', 'true'); }); paintApply(); };
    list.append(...rows.map(([, row]) => row));
    paintApply();
    const sure = R.filter((r) => r.m.confidence >= SURE).length;
    box.append(head(tr('lr.resT', { n: tn('tracksGen', R.length) }), tr('lr.resD', { sure, unsure: R.length - sure }),
      h('button', { class: 'chip-btn', onClick: () => { for (const r of R) r.accept = false; apply(); } }, tr('lr.discard')), applyBtn),
      h('div', { class: 'lr-bar' }, h('small', {}, tr('lr.resHint')), h('span', { class: 'grow' }), all), list);
  }

  /** after an import: offer to complete what the new files are missing */
  function suggestAfterImport(ids) {
    const n = candidates(ids).length;
    if (!n || job.running) return;
    const go = h('button', { class: 'tchip' }, tr('lr.suggestBtn'));
    const tt = toast(h('span', {}, tr('lr.suggest', { n: tn('tracksGen', n) })), { timeout: 9000, actions: h('div', { class: 'tchips' }, go) });
    go.onclick = () => { tt.close(); ctx.setView({ type: 'health' }); setTimeout(() => start(ids), 120); };
  }

  return { openFinder, repairCard, start, suggestAfterImport, get running() { return job.running; } };
}

