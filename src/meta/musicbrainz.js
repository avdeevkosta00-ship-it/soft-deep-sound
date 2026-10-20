'use strict';
/**
 * Library repair from open data: MusicBrainz (tags) and the Cover Art Archive (artwork), with Deezer and
 * iTunes catalogues as artwork fallbacks.
 *
 *  • only names the user already has (title, artist, duration) are sent — never the audio itself;
 *  • MusicBrainz asks for a descriptive User-Agent and at most one request per second, so every call
 *    goes through one queue; 503 (rate limit) is retried with a pause;
 *  • the user's files are never rewritten: results are stored in the library like a manual edit;
 *  • artwork is cached in our covers folder, one file per release, so an album shares one image;
 *    if the archive has none or does not answer, the public Deezer and iTunes catalogues are asked.
 */
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { httpFetch, safeFetch } = require('../search/http');

const MB = 'https://musicbrainz.org/ws/2';
const CAA = 'https://coverartarchive.org';
const MAX_COVER = 6 * 1024 * 1024;

let deps = null; // { version, coversDir }
let last = 0, chain = Promise.resolve();
const genreCache = new Map();

function init(d) { deps = d; }
const ua = () => `SoftDeepSound/${deps.version} ( https://github.com/infallibl3/soft-deep-sound )`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** one MusicBrainz request at a time, ≥1.1 s apart */
function mbGet(url) {
  const run = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = last + 1100 - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const res = await httpFetch(url, { headers: { 'user-agent': ua(), accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (res.status === 503) { await sleep(1500 * (attempt + 1)); continue; }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('mb-' + res.status);
      return res.json();
    }
    throw new Error('rate-limit');
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/* ------------------------------ matching ------------------------------ */
// "Song (Remastered 2011)", "Song - Radio Edit", "feat. X" → "Song"
const strip = (s) => String(s || '')
  .replace(/\s*[([][^)\]]*(remaster|edit|version|mix|mono|stereo|live|bonus|explicit|clean|deluxe|feat|ft\.)[^)\]]*[)\]]/gi, ' ')
  .replace(/\s+-\s+(\d{4}\s+)?(remaster|radio edit|single version|album version).*$/i, ' ')
  .replace(/\s(feat|ft)\.?\s.*$/i, ' ')
  .replace(/\s+/g, ' ').trim();
const norm = (s) => strip(s).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function sim(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s) => { const g = new Map(); const t = ` ${s} `; for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; };
  const ga = grams(a), gb = grams(b);
  let common = 0, total = 0;
  for (const [k, n] of ga) { common += Math.min(n, gb.get(k) || 0); total += n; }
  for (const n of gb.values()) total += n;
  return (2 * common) / total;
}
const ALT = /\b(live|video|demo|instrumental|acoustic|karaoke|rehearsal|remix|a cappella)\b/i;
const lucene = (s) => String(s).replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
const credit = (ac) => (ac || []).map((a) => a.name + (a.joinphrase || '')).join('').trim();

/** studio album, officially released, earliest first */
function releaseRank(r) {
  const rg = r['release-group'] || {};
  const sec = rg['secondary-types'] || [];
  let s = 0;
  if (r.status === 'Official') s += .4; else if (r.status === 'Bootleg') s -= .4;
  if (rg['primary-type'] === 'Album') s += .3; else if (rg['primary-type'] === 'EP' || rg['primary-type'] === 'Single') s += .15;
  if (!sec.length) s += .3; else if (['Live', 'Compilation', 'DJ-mix', 'Soundtrack', 'Remix'].some((k) => sec.includes(k))) s -= .2;
  return s;
}
function bestRelease(releases) {
  return [...(releases || [])].sort((a, b) => (releaseRank(b) - releaseRank(a)) || String(a.date || '9999').localeCompare(String(b.date || '9999')))[0] || null;
}

const words = (s) => norm(s).split(' ').filter(Boolean).map(lucene).join(' ');
/**
 * Recording searches, the exact title phrase first. File names often lose an apostrophe or a comma
 * («U weren t Here» for «U Weren’t Here»), and then the phrase finds nothing — the second search asks
 * for the same words in any form, and the usual title / artist / length checks sort the result.
 * Lazy: the second request is made only if the caller keeps iterating.
 */
function* searches(title, extra) {
  const qt = strip(title) || title;
  const get = (q) => mbGet(`${MB}/recording?fmt=json&limit=50&query=${encodeURIComponent(q)}`).then((d) => (d && d.recordings) || []);
  yield get(`recording:"${lucene(qt)}"${extra(true)}`);
  const w = words(qt);
  if (w) yield get(`recording:(${w})${extra(false)}`);
}

/**
 * Best recording for what we know about a track. Returns null when nothing is close enough.
 * Without an artist there is no lookup: dozens of covers share a title, and a wrong tag is worse than none.
 */
async function lookup({ title, artist, duration }) {
  title = String(title || '').trim(); artist = String(artist || '').trim();
  if (norm(title).length < 2 || !artist) return null;
  let best = null;
  for (const recs of searches(title, (exact) => exact ? ` AND artist:"${lucene(artist)}"` : ` AND artist:(${words(artist)})`)) {
    for (const rec of await recs) {
      const tSim = sim(title, rec.title);
      const aSim = sim(artist, credit(rec['artist-credit']));
      if (tSim < .6 || aSim < .5) continue;
      // a concert take or a video edit is a different recording unless the file itself says so
      const kind = `${rec.disambiguation || ''} ${rec.title}`.match(ALT);
      if (kind && !new RegExp(kind[1], 'i').test(title)) continue;
      let dScore = .4;
      if (duration > 0 && rec.length) {
        const diff = Math.abs(duration - rec.length / 1000);
        dScore = diff <= 3 ? 1 : diff <= 8 ? .6 : diff <= 15 ? .2 : -1;
      }
      if (dScore < 0) continue;
      const rel = bestRelease(rec.releases);
      const relQ = rel ? releaseRank(rel) : 0;
      // the canonical studio recording sits on many official releases; live and bootleg takes on few
      const n = Math.min(1, Math.log10(1 + (rec.releases || []).length) / 2); // 1 → .15, 10 → .52, 99+ → 1
      const confidence = Math.max(0, Math.min(1, tSim * .3 + aSim * .25 + dScore * .2 + relQ * .15 + n * .1));
      if (!best || confidence > best.confidence) best = { rec, rel, confidence };
    }
    if (best && best.confidence >= .55) break; // the exact phrase was enough — no second request
  }
  if (!best || best.confidence < .55) return null;
  const { rec, rel } = best;
  const ac = rec['artist-credit'] || [];
  return {
    mbid: rec.id, confidence: Math.round(best.confidence * 100) / 100,
    title: rec.title, artist: credit(ac), artistId: ac[0] && ac[0].artist && ac[0].artist.id,
    album: rel ? rel.title : '', year: rel && rel.date ? parseInt(rel.date, 10) || undefined : undefined,
    releaseId: rel ? rel.id : null, groupId: rel && rel['release-group'] ? rel['release-group'].id : null
  };
}

/**
 * Who sings it, when the file only knows a title («1546698_Apoplexy» → «Apoplexy»): recordings with that
 * exact title and a length within 3 s, grouped by artist; the artist whose recordings sit on clearly more
 * releases wins (the original is everywhere, covers and namesakes are not). Never certain — the caller
 * shows it as a suggestion.
 */
async function identify({ title, duration }) {
  title = String(title || '').trim();
  if (norm(title).length < 2 || !(duration > 0)) return null;
  const dur = ` AND dur:[${Math.round((duration - 3) * 1000)} TO ${Math.round((duration + 3) * 1000)}]`;
  const groups = new Map();
  for (const recs of searches(title, () => dur)) {
    for (const rec of await recs) {
      if (sim(title, rec.title) < 1) continue;
      const kind = `${rec.disambiguation || ''} ${rec.title}`.match(ALT);
      if (kind && !new RegExp(kind[1], 'i').test(title)) continue;
      // votes go to the main artist: «The Weeknd» and «The Weeknd feat. ROSALÍA» are one artist here
      const ac = rec['artist-credit'] || [];
      const name = ac[0] && ac[0].name;
      if (!name) continue;
      const k = norm(name);
      const g = groups.get(k) || { name, n: 0, recs: [] };
      g.n += (rec.releases || []).length; g.recs.push(rec);
      groups.set(k, g);
    }
    if (groups.size) break;
  }
  const top = [...groups.values()].sort((a, b) => b.n - a.n);
  if (!top.length || top[0].n < 3 || (top[1] && top[0].n < top[1].n * 2)) return null;
  // the solo recording before any «feat.» remix, then the most released one
  const solo = (r) => ((r['artist-credit'] || []).length === 1 ? 1 : 0);
  const rec = top[0].recs.sort((a, b) => (solo(b) - solo(a)) || ((b.releases || []).length - (a.releases || []).length))[0];
  const rel = bestRelease(rec.releases);
  return { artist: top[0].name, title: rec.title, album: rel ? rel.title : '', confidence: .7 };
}

/** genre from the album (release group), else from the artist; cached */
async function genre(groupId, artistId) {
  for (const [kind, id] of [['release-group', groupId], ['artist', artistId]]) {
    if (!id) continue;
    const key = kind + ':' + id;
    if (!genreCache.has(key)) {
      const d = await mbGet(`${MB}/${kind}/${id}?fmt=json&inc=genres`).catch(() => null);
      const g = ((d && d.genres) || []).sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 2).map((x) => x.name.replace(/\b\w/g, (c) => c.toUpperCase()));
      genreCache.set(key, g.join(', '));
    }
    if (genreCache.get(key)) return genreCache.get(key);
  }
  return '';
}

/** front cover of the release (or its release group) into the covers cache; returns the file path or null */
/** an image into the covers cache; a slow or busy server gets a second try. Returns the path or null. */
async function download(url, file, hosts) {
  const okHost = (u) => { if (!hosts.test(new URL(u).hostname)) throw new Error('blocked host'); };
  try { await fsp.access(file); return file; } catch {}
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await safeFetch(url, { headers: { 'user-agent': ua() }, signal: AbortSignal.timeout(30000) }, okHost);
      if (res.status === 404) { try { await res.body?.cancel(); } catch {} return null; }
      if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) { try { await res.body?.cancel(); } catch {} if (res.status >= 500) continue; return null; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_COVER) return null;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, buf);
      return file;
    } catch { /* timeout or network hiccup: once more */ }
  }
  return null;
}

/**
 * Album artwork, from the most fitting source that has it:
 *   1. Cover Art Archive (MusicBrainz's own) — the release group's front, then the release's;
 *   2. Deezer's public catalogue, 3. Apple's iTunes Search API — official open APIs, used only when the
 *      archive has no image or does not answer (it lives on archive.org, which can be slow).
 * The album must match by name and the artist must be close, or the image is not taken.
 */
async function cover({ releaseId, groupId, artist, album }) {
  const dir = deps.coversDir();
  // the release group's front is the album's canonical cover and exists more often than a single edition's
  for (const [kind, id] of [['release-group', groupId], ['release', releaseId]]) {
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) continue;
    const got = await download(`${CAA}/${kind}/${id}/front-500`, path.join(dir, `mb-${id}.jpg`), /(^|\.)coverartarchive\.org$|(^|\.)archive\.org$/);
    if (got) return got;
  }
  if (!artist || !album) return null;
  const key = crypto.createHash('sha1').update((artist + '|' + album).toLowerCase()).digest('hex').slice(0, 20);
  const file = path.join(dir, `art-${key}.jpg`);
  // «Song - Single», «Album (Deluxe)» in the stores vs «Song» in MusicBrainz
  const albumOk = (name) => sim(String(name || '').replace(/\s+-\s+(single|ep)$/i, ''), album) >= .75;
  const artistOk = (name) => sim(name, artist) >= .5 || norm(name).includes(norm(artist));
  const json = async (url) => {
    try { const r = await httpFetch(url, { headers: { 'user-agent': ua(), accept: 'application/json' }, signal: AbortSignal.timeout(12000) }); return r.ok ? r.json() : null; } catch { return null; }
  };
  const dz = await json(`https://api.deezer.com/search/album?q=${encodeURIComponent(`artist:"${artist}" album:"${album}"`)}`);
  const d = ((dz && dz.data) || []).find((a) => albumOk(a.title) && artistOk(a.artist && a.artist.name));
  if (d && (d.cover_xl || d.cover_big)) {
    const got = await download(d.cover_xl || d.cover_big, file, /(^|\.)dzcdn\.net$/);
    if (got) return got;
  }
  const it = await json(`https://itunes.apple.com/search?entity=album&limit=10&term=${encodeURIComponent(artist + ' ' + album)}`);
  const a = ((it && it.results) || []).find((x) => albumOk(x.collectionName) && artistOk(x.artistName));
  if (a && a.artworkUrl100) return download(a.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.'), file, /(^|\.)mzstatic\.com$/);
  return null;
}

/** everything the repair screen needs for one track */
async function repair(track, { wantCover = true, wantGenre = true } = {}) {
  // no artist: guess it from the title and length first; the result then stays a suggestion to check
  let guess = null;
  if (!String(track.artist || '').trim()) {
    guess = await identify(track);
    if (!guess) return null;
    track = { ...track, artist: guess.artist, title: guess.title };
  }
  const m = await lookup(track);
  if (!m) return null;
  if (guess) m.confidence = Math.min(m.confidence, guess.confidence);
  const [g, c] = await Promise.all([
    wantGenre ? genre(m.groupId, m.artistId).catch(() => '') : '',
    wantCover ? cover(m) : null
  ]);
  return { ...m, genre: g || undefined, cover: c };
}

module.exports = { init, repair, lookup, identify, sim, norm };
