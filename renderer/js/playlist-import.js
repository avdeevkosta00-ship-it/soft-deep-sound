/**
 * «Импорт плейлиста»: brings a playlist over from another service as a list of names and rebuilds it
 * from the local library.
 *   1. source — a Deezer / Spotify link, the user's own Spotify playlists (official API, own login),
 *      or a CSV / text list (Soundiiz, TuneMyMusic, Exportify, copy-paste: covers Yandex Music, VK…);
 *   2. matching — every name is looked up in the library (typos, Cyrillic ↔ Latin, versions);
 *   3. review — found / unsure / missing; missing tracks can be searched in open sources or added
 *      as files later. The playlist remembers what is missing and can check again.
 */
import { $, h, esc, toast, openModal, closeModal } from './ui.js';
import { t as tr, tn } from './i18n.js';
import { ICON } from './icons.js';
import { parseTrackList, matchTracks, asLines } from './import-match.js';

const SPOTIFY_DASH = 'https://developer.spotify.com/dashboard';
const SOUNDIIZ = 'https://soundiiz.com/';
const TUNEMYMUSIC = 'https://www.tunemymusic.com/';
const SVG = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
const IC = {
  link: ICON.kLink,
  account: SVG('<circle cx="12" cy="8.6" r="3.6"/><path d="M5 19.5c1.2-3.4 3.9-5.1 7-5.1s5.8 1.7 7 5.1"/>'),
  file: SVG('<path d="M7 3.8h6.6L18 8.2v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1z"/><path d="M13.4 3.8v4.6H18M9 13h6M9 16.4h4"/>'),
  lock: SVG('<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
  heart: SVG('<path d="M12 19.2s-7-4.2-7-9.4A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.2c0 5.2-7 9.4-7 9.4z"/>')
};

/** error codes from the main process → readable text */
function errText(e) {
  const m = String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const known = ['bad-url', 'not-found', 'rate-limit', 'not-connected', 'not-owner', 'forbidden', 'denied', 'timeout', 'port-busy',
    'bad-client-id', 'invalid-client', 'auth-failed', 'cancelled', 'empty'];
  const code = known.find((k) => m === k || m.startsWith(k));
  return code ? tr('pi.err.' + code) : tr('pi.err.generic', { msg: m });
}

export function createPlaylistImport(ctx) {
  const { S, bridge, save, art, artistOf, createPlaylist, setView, openSearchView, pickFiles } = ctx;
  const sp = bridge.importer && bridge.importer.spotify;
  let state = { tab: 'link', parsed: null, results: null, view: 'found', busy: false };
  let card = null;

  const shell = (...kids) => h('div', { class: 'modal-card pi-card' },
    h('div', { class: 'v-kicker' }, tr('pi.kicker')), ...kids);

  /* ------------------------------ step 1: source ------------------------------ */
  function renderStart() {
    const tabs = [['link', IC.link, 'pi.src.link', 'pi.src.linkD'], ['spotify', IC.account, 'pi.src.sp', 'pi.src.spD'], ['file', IC.file, 'pi.src.file', 'pi.src.fileD']];
    const pane = h('div', { class: 'pi-pane' });
    const srcs = h('div', { class: 'ss-moods pi-sources', role: 'tablist' }, ...tabs.map(([k, ico, name, desc]) => {
      const b = h('button', { class: 'ss-mood' + (state.tab === k ? ' on' : ''), role: 'tab', 'aria-selected': String(state.tab === k), dataset: { k } },
        h('span', { class: 'ss-ico', html: ico }), h('b', {}, tr(name)), h('small', {}, tr(desc)));
      b.onclick = () => { state.tab = k; srcs.querySelectorAll('.ss-mood').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); }); fillPane(); };
      return b;
    }));
    const fillPane = () => {
      pane.innerHTML = '';
      pane.append(state.tab === 'link' ? linkPane() : state.tab === 'spotify' ? spotifyPane() : filePane());
    };
    card = shell(h('h3', {}, tr('pi.title')), srcs, pane,
      h('div', { class: 'modal-acts' }, h('span', { class: 'grow pi-note' }, tr('pi.note')), h('button', { class: 'chip-btn', onClick: closeModal }, tr('pi.close'))));
    fillPane();
    openModal(card);
  }

  function linkPane() {
    const input = h('input', { class: 'set-input wide', placeholder: tr('pi.link.ph'), spellcheck: 'false' });
    const go = h('button', { class: 'chip-btn on' }, tr('pi.link.go'));
    const run = async () => {
      const url = input.value.trim();
      if (!url) { input.focus(); return; }
      if (/deezer\.(com|page\.link)|dzr\.page\.link/i.test(url)) return load(() => bridge.importer.deezer(url), 'Deezer');
      const id = spotifyId(url);
      if (id) {
        const st = sp ? await sp.status(S.settings.spotifyClientId) : { connected: false };
        if (!st.connected) { state.tab = 'spotify'; renderStart(); toast(tr('pi.link.needLogin')); return; }
        return load(() => sp.tracks(id), 'Spotify');
      }
      if (/music\.yandex|vk\.com|vk\.ru|music\.apple|soundcloud|youtube|youtu\.be/i.test(url)) { state.tab = 'file'; renderStart(); toast(tr('pi.link.useFile')); return; }
      toast(tr('pi.err.bad-url'));
    };
    go.onclick = run;
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') run(); if (e.key === 'Escape') closeModal(); };
    setTimeout(() => input.focus(), 80);
    return h('div', { class: 'pi-link' },
      h('div', { class: 'pi-row-in' }, input, go),
      h('ul', { class: 'pi-hints' },
        h('li', {}, h('b', {}, 'Deezer'), ' — ', tr('pi.link.deezer')),
        h('li', {}, h('b', {}, 'Spotify'), ' — ', tr('pi.link.spotify')),
        h('li', {}, h('b', {}, tr('pi.link.othersT')), ' — ', tr('pi.link.others'))));
  }

  function spotifyPane() {
    const box = h('div', { class: 'pi-sp' }, h('div', { class: 'pi-wait' }, tr('pi.loading')));
    (async () => {
      if (!sp) { box.innerHTML = ''; box.append(h('div', { class: 'notice' }, tr('pi.sp.desktopOnly'))); return; }
      const st = await sp.status(S.settings.spotifyClientId).catch(() => ({ connected: false }));
      box.innerHTML = '';
      if (st.connected) box.append(await spotifyList(st));
      else box.append(spotifySetup(st));
    })();
    return box;
  }

  function spotifySetup(st) {
    const id = h('input', { class: 'set-input wide mono', placeholder: tr('pi.sp.idPh'), value: S.settings.spotifyClientId || '', spellcheck: 'false' });
    id.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') closeModal(); };
    id.onchange = () => { S.settings.spotifyClientId = id.value.trim(); save(); };
    const redirect = st.redirect || 'http://127.0.0.1:43117/callback';
    const copy = h('button', { class: 'chip-btn pi-copy' }, tr('pi.copy'));
    copy.onclick = () => { navigator.clipboard.writeText(redirect).then(() => { copy.textContent = tr('pi.copied'); setTimeout(() => (copy.textContent = tr('pi.copy')), 1600); }); };
    const login = h('button', { class: 'chip-btn on' }, tr('pi.sp.login'));
    const status = h('div', { class: 'pi-sp-status' });
    login.onclick = async () => {
      const v = id.value.trim();
      S.settings.spotifyClientId = v; save();
      if (!/^[0-9a-f]{32}$/i.test(v)) { toast(tr('pi.err.bad-client-id')); id.focus(); return; }
      login.disabled = true;
      status.innerHTML = '';
      const cancel = h('button', { class: 'text-btn', onClick: () => sp.cancel() }, tr('pi.cancel'));
      status.append(h('span', { class: 'pi-spin' }), h('span', {}, tr('pi.sp.waiting')), cancel);
      try { await sp.login(v); state.tab = 'spotify'; renderStart(); }
      catch (e) { status.innerHTML = ''; if (!/cancelled/.test(String(e && e.message))) toast(errText(e), { timeout: 7000 }); }
      finally { login.disabled = false; }
    };
    return h('div', {},
      h('ol', { class: 'pi-steps' },
        h('li', {}, h('span', {}, tr('pi.sp.s1')), h('button', { class: 'text-btn', onClick: () => bridge.web.open(SPOTIFY_DASH) }, tr('pi.sp.open'))),
        h('li', {}, h('span', {}, tr('pi.sp.s2')), h('div', { class: 'pi-code' }, h('code', {}, redirect), copy)),
        h('li', {}, h('span', {}, tr('pi.sp.s3')), id)),
      h('div', { class: 'pi-row-act' }, status, h('span', { class: 'grow' }), login),
      h('div', { class: 'notice pi-small' }, tr('pi.sp.limits')));
  }

  async function spotifyList(st) {
    const wrap = h('div', {});
    const head = h('div', { class: 'pi-sp-head' },
      h('span', {}, tr('pi.sp.as', { name: st.user || 'Spotify' })),
      h('button', { class: 'text-btn', onClick: async () => { await sp.logout(); renderStart(); } }, tr('pi.sp.logout')));
    const list = h('div', { class: 'pi-pl-list' }, h('div', { class: 'pi-wait' }, h('span', { class: 'pi-spin' }), tr('pi.loading')));
    wrap.append(head, list);
    try {
      const data = await sp.playlists();
      list.innerHTML = '';
      const row = (ico, name, sub, locked, onClick) => {
        const b = h('button', { class: 'pi-pl' + (locked ? ' locked' : '') },
          typeof ico === 'string' ? h('span', { class: 'pi-pl-art', html: ico }) : ico,
          h('span', { class: 'pi-pl-meta' }, h('b', {}, name), h('small', {}, sub)),
          locked ? h('span', { class: 'pi-lock', title: tr('pi.sp.lockedT'), html: IC.lock }) : null);
        b.onclick = onClick;
        return b;
      };
      if (data.liked !== null) list.append(row(IC.heart, tr('pi.sp.liked'), tn('tracks', data.liked || 0), false, () => load(() => sp.tracks('liked'), 'Spotify', tr('pi.sp.liked'))));
      for (const p of data.playlists) {
        const img = p.image ? h('span', { class: 'pi-pl-art', style: { backgroundImage: `url("${p.image}")` } }) : h('span', { class: 'pi-pl-art', html: ICON.note || IC.file });
        const sub = [p.count != null ? tn('tracks', p.count) : '', p.own ? '' : tr('pi.sp.by', { name: p.owner })].filter(Boolean).join(' · ');
        list.append(row(img, p.name, sub, !p.own, () => (p.own ? load(() => sp.tracks(p.id), 'Spotify', p.name) : toast(tr('pi.err.not-owner'), { timeout: 7000 }))));
      }
      if (!list.children.length) list.append(h('div', { class: 'pi-wait' }, tr('pi.sp.none')));
    } catch (e) {
      list.innerHTML = '';
      list.append(h('div', { class: 'notice' }, errText(e)));
      if (/not-connected/.test(String(e && e.message))) setTimeout(renderStart, 1200);
    }
    return wrap;
  }

  function filePane() {
    const fileIn = h('input', { type: 'file', accept: '.csv,.txt,.tsv,.m3u,.m3u8,text/csv,text/plain', style: { display: 'none' } });
    const drop = h('div', { class: 'pi-drop', tabindex: '0' },
      h('span', { class: 'ss-ico', html: IC.file }),
      h('b', {}, tr('pi.file.drop')), h('small', {}, tr('pi.file.formats')));
    const readFile = async (f) => {
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { toast(tr('pi.err.big')); return; }
      const text = await f.text();
      parseAndMatch(text, f.name);
    };
    drop.onclick = () => fileIn.click();
    drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } };
    fileIn.onchange = () => readFile(fileIn.files[0]);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); readFile(e.dataTransfer.files[0]); });
    const area = h('textarea', { class: 'pi-text', placeholder: tr('pi.file.ph'), spellcheck: 'false' });
    area.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') closeModal(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) parse.click(); };
    const parse = h('button', { class: 'chip-btn on' }, tr('pi.file.parse'));
    parse.onclick = () => { if (!area.value.trim()) { area.focus(); return; } parseAndMatch(area.value, ''); };
    return h('div', { class: 'pi-file' }, fileIn,
      h('div', { class: 'pi-file-grid' }, drop, h('div', { class: 'pi-paste' }, area, h('div', { class: 'pi-row-act' }, h('small', { class: 'pi-note' }, tr('pi.file.pasteHint')), h('span', { class: 'grow' }), parse))),
      h('div', { class: 'notice pi-small' }, h('span', {},
        tr('pi.file.howto1'), ' ',
        h('button', { class: 'text-btn inline', onClick: () => bridge.web.open(SOUNDIIZ) }, 'Soundiiz'), ' ', tr('pi.or'), ' ',
        h('button', { class: 'text-btn inline', onClick: () => bridge.web.open(TUNEMYMUSIC) }, 'TuneMyMusic'), ' ',
        tr('pi.file.howto2'))));
  }

  /* ------------------------------ step 2: load + match ------------------------------ */
  function busy(text) {
    const bar = h('i');
    const label = h('span', {}, text);
    card = shell(h('h3', {}, tr('pi.title')), h('div', { class: 'pi-busy' }, h('div', { class: 'ex-prog-row' }, label, h('span', { class: 'pi-spin' })), h('div', { class: 'ex-bar' }, bar)));
    openModal(card);
    return { set: (k, txt) => { bar.style.transform = `scaleX(${Math.max(.03, Math.min(1, k))})`; if (txt) label.textContent = txt; } };
  }

  async function load(fetcher, sourceName, fallbackTitle) {
    const b = busy(tr('pi.reading', { src: sourceName }));
    b.set(.08);
    try {
      const pl = await fetcher();
      if (!pl || !pl.tracks || !pl.tracks.length) throw new Error('empty');
      if (!pl.title && fallbackTitle) pl.title = fallbackTitle;
      await runMatch(pl, b);
    } catch (e) {
      toast(errText(e), { timeout: 8000 });
      renderStart();
    }
  }

  async function parseAndMatch(text, name) {
    const pl = parseTrackList(text, name);
    if (!pl.tracks.length) { toast(tr('pi.err.empty')); return; }
    pl.source = 'file';
    await runMatch(pl, busy(tr('pi.matching', { n: pl.tracks.length })));
  }

  async function runMatch(pl, b) {
    if (!S.tracks.length) { state.parsed = pl; state.results = pl.tracks.map((item) => ({ item, track: null, score: 0, status: 'missing', accept: false })); return renderResults(); }
    b.set(.1, tr('pi.matching', { n: pl.tracks.length }));
    state.parsed = pl;
    state.results = await matchTracks(pl.tracks, S.tracks, (k) => b.set(.1 + k * .9));
    state.view = state.results.some((r) => r.status === 'found') ? 'found' : state.results.some((r) => r.status === 'maybe') ? 'maybe' : 'missing';
    renderResults();
  }

  /* ------------------------------ step 3: review ------------------------------ */
  function renderResults() {
    const R = state.results, pl = state.parsed;
    const count = (s) => R.filter((r) => r.status === s).length;
    const srcName = { deezer: 'Deezer', spotify: 'Spotify', file: tr('pi.src.file') }[pl.source] || '';
    const name = h('input', { class: 'set-input wide pi-name', value: pl.title || tr('pi.defaultName', { src: srcName }), maxlength: '60' });
    name.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') closeModal(); };
    const list = h('div', { class: 'pi-res' });
    const create = h('button', { class: 'chip-btn on' });
    const paintCreate = () => {
      const n = R.filter((r) => r.track && r.accept).length;
      create.textContent = n ? tr('pi.create', { n: tn('tracks', n) }) : tr('pi.createEmpty');
    };
    const views = [['found', tr('pi.v.found'), count('found')], ['maybe', tr('pi.v.maybe'), count('maybe')], ['missing', tr('pi.v.missing'), count('missing')]];
    const seg = h('div', { class: 'seg pi-seg' }, ...views.map(([k, label, n]) => {
      const b = h('button', { class: state.view === k ? 'on' : '' }, label, h('em', { class: 'pi-n' + (k === 'missing' && n ? ' warn' : '') }, n));
      b.onclick = () => { state.view = k; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); fill(); };
      return b;
    }));
    const extra = h('div', { class: 'pi-extra' });
    const fill = () => {
      list.innerHTML = ''; extra.innerHTML = '';
      const rows = R.map((r, i) => [r, i]).filter(([r]) => r.status === state.view);
      if (!rows.length) list.append(h('div', { class: 'pi-empty' }, tr('pi.v.empty.' + state.view)));
      rows.forEach(([r, i], n) => list.append(resultRow(r, i, n, paintCreate)));
      if (state.view === 'missing' && rows.length) {
        const copy = h('button', { class: 'chip-btn' }, tr('pi.copyList'));
        copy.onclick = () => navigator.clipboard.writeText(asLines(rows.map(([r]) => r.item))).then(() => toast(tr('pi.copiedList', { n: rows.length })));
        const add = h('button', { class: 'chip-btn' }, tr('pi.addFiles'));
        add.onclick = async () => {
          const ok = await pickFiles();
          if (!ok) return;
          await runMatch(pl, busy(tr('pi.matching', { n: pl.tracks.length })));
        };
        extra.append(h('span', { class: 'pi-note' }, tr('pi.missingHint')), h('span', { class: 'grow' }), copy, add);
      }
      if (state.view === 'maybe' && rows.length) {
        const all = h('button', { class: 'chip-btn' }, tr('pi.acceptAll'));
        all.onclick = () => { rows.forEach(([r]) => (r.accept = true)); fill(); paintCreate(); };
        extra.append(h('span', { class: 'pi-note' }, tr('pi.maybeHint')), h('span', { class: 'grow' }), all);
      }
    };
    create.onclick = () => {
      const ids = R.filter((r) => r.track && r.accept).map((r) => r.track.id);
      const missing = R.filter((r) => !(r.track && r.accept)).map((r) => r.item);
      const plName = name.value.trim().slice(0, 60) || tr('pi.defaultName', { src: srcName });
      const created = createPlaylist(plName, ids);
      created.importInfo = { source: pl.source, at: Date.now(), total: R.length };
      if (missing.length) created.missing = missing.slice(0, 5000);
      save();
      closeModal();
      setView({ type: 'playlist', id: created.id });
      toast(missing.length ? tr('pi.doneSome', { name: plName, n: tn('tracks', ids.length), m: missing.length }) : tr('pi.doneAll', { name: plName, n: tn('tracks', ids.length) }), { timeout: 6000 });
    };
    const back = h('button', { class: 'chip-btn', onClick: renderStart }, tr('pi.back'));
    card = shell(
      h('h3', {}, tr('pi.review')),
      h('div', { class: 'pi-sum' },
        h('b', {}, tr('pi.sum', { found: count('found') + R.filter((r) => r.status === 'maybe' && r.accept).length, total: R.length })),
        srcName ? h('span', {}, tr('pi.from', { src: srcName })) : null),
      h('label', { class: 'ss-lbl' }, tr('pi.nameLbl')), name,
      seg, list, extra,
      h('div', { class: 'modal-acts' }, back, h('span', { class: 'grow' }), create));
    fill(); paintCreate();
    openModal(card);
    if (!S.tracks.length) toast(tr('pi.emptyLib'), { timeout: 7000 });
  }

  function resultRow(r, i, n, onChange) {
    const it = r.item;
    const src = h('div', { class: 'pi-src-meta' }, h('b', {}, it.title), h('small', {}, it.artist || '—'));
    const row = h('div', { class: 'pi-item ' + r.status, style: { '--i': Math.min(n, 14) } });
    if (r.track) {
      const chk = h('button', { class: 'pi-chk' + (r.accept ? ' on' : ''), role: 'checkbox', 'aria-checked': String(!!r.accept), title: tr('pi.include'), html: ICON.check });
      chk.onclick = () => { r.accept = !r.accept; chk.classList.toggle('on', r.accept); chk.setAttribute('aria-checked', String(r.accept)); onChange(); };
      const loc = r.track;
      row.append(chk, src, h('span', { class: 'pi-arrow', 'aria-hidden': 'true' }, '→'),
        h('div', { class: 'pi-local' }, h('div', { class: 'thumb', style: { background: art(loc) } }),
          h('div', { class: 'pi-src-meta' }, h('b', {}, loc.title || '—'), h('small', {}, artistOf(loc)))),
        r.status === 'maybe' ? h('span', { class: 'pi-score mono', title: tr('pi.scoreT') }, Math.round(r.score * 100) + '%') : h('span'));
    } else {
      const find = h('button', { class: 'chip-btn sm' }, tr('pi.findWeb'));
      find.onclick = () => { closeModal(); openSearchView([it.artist, it.title].filter(Boolean).join(' ')); };
      row.append(h('span', { class: 'pi-dot' }), src, h('span'), h('span', { class: 'pi-dur mono' }, it.duration ? fmtTime(it.duration) : ''), find);
    }
    return row;
  }

  /* ------------------------------ missing tracks of a saved playlist ------------------------------ */
  async function recheck(pl) {
    if (!pl || !pl.missing || !pl.missing.length) return 0;
    const res = await matchTracks(pl.missing, S.tracks);
    const found = res.filter((r) => r.status === 'found').map((r) => r.track.id).filter((id) => !pl.trackIds.includes(id));
    pl.trackIds.push(...found);
    pl.missing = res.filter((r) => r.status !== 'found').map((r) => r.item);
    if (!pl.missing.length) delete pl.missing;
    pl.updatedAt = Date.now();
    save();
    return found.length;
  }

  function showMissing(pl) {
    const items = pl.missing || [];
    const list = h('div', { class: 'pi-res' }, ...items.map((it, n) => {
      const find = h('button', { class: 'chip-btn sm' }, tr('pi.findWeb'));
      find.onclick = () => { closeModal(); openSearchView([it.artist, it.title].filter(Boolean).join(' ')); };
      return h('div', { class: 'pi-item missing', style: { '--i': Math.min(n, 14) } }, h('span', { class: 'pi-dot' }),
        h('div', { class: 'pi-src-meta' }, h('b', {}, it.title), h('small', {}, it.artist || '—')), h('span'), h('span', { class: 'pi-dur mono' }, it.duration ? fmtTime(it.duration) : ''), find);
    }));
    const copy = h('button', { class: 'chip-btn' }, tr('pi.copyList'));
    copy.onclick = () => navigator.clipboard.writeText(asLines(items)).then(() => toast(tr('pi.copiedList', { n: items.length })));
    openModal(h('div', { class: 'modal-card pi-card' },
      h('div', { class: 'v-kicker' }, tr('pi.kicker')), h('h3', {}, tr('pi.missingTitle', { name: esc(pl.name) })),
      h('p', { class: 'pi-note' }, tr('pi.missingHint')), list,
      h('div', { class: 'modal-acts' }, copy, h('span', { class: 'grow' }), h('button', { class: 'chip-btn on', onClick: closeModal }, tr('pi.close')))));
  }

  return {
    open: (tab) => { state = { tab: tab || state.tab || 'link', parsed: null, results: null, view: 'found' }; renderStart(); },
    recheck, showMissing
  };
}

function spotifyId(raw) {
  const s = String(raw || '').trim();
  const m = /^spotify:playlist:([A-Za-z0-9]+)$/.exec(s) || /open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]+)/i.exec(s);
  return m ? m[1] : null;
}
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
