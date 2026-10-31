/**
 * Library repair on the phone: tags from MusicBrainz, artwork from the Cover Art Archive with Deezer and
 * iTunes as fallbacks. A port of src/meta/musicbrainz.js (the desktop runs that one in the main process) —
 * the matching rules are the same, so a fix in one belongs in the other.
 *
 *  • only names the user already has (title, artist, duration) are sent, never the audio;
 *  • MusicBrainz wants at most one request per second: every call goes through one queue, 503 is retried;
 *  • the user's files are never rewritten: results are stored in the library like a manual edit;
 *  • artwork is cached one file per release (or per artist + album), so an album shares one image.
 *
 * The network and the artwork cache come from the platform:
 *   getJSON(url)        → parsed JSON, null on 404, throws on other errors (native HTTP: no CORS in the way)
 *   saveImage(url, key) → a local file path, or null when the server has no image (hosts are checked natively)
 */
const MB = 'https://musicbrainz.org/ws/2';
const CAA = 'https://coverartarchive.org';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ matching (as in src/meta/musicbrainz.js) ------------------------------ */
// "Song (Remastered 2011)", "Song - Radio Edit", "feat. X" → "Song"
const strip = (s) => String(s || '')
  .replace(/\s*[([][^)\]]*(remaster|edit|version|mix|mono|stereo|live|bonus|explicit|clean|deluxe|feat|ft\.)[^)\]]*[)\]]/gi, ' ')
  .replace(/\s+-\s+(\d{4}\s+)?(remaster|radio edit|single version|album version).*$/i, ' ')
  .replace(/\s(feat|ft)\.?\s.*$/i, ' ')
  .replace(/\s+/g, ' ').trim();
export const norm = (s) => strip(s).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function sim(a, b) {
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
const words = (s) => norm(s).split(' ').filter(Boolean).map(lucene).join(' ');

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

/** a short, file-name-safe key for an artist + album pair */
async function keyOf(s) {
  try {
    const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s.toLowerCase()));
    return [...new Uint8Array(d)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 0; for (const ch of s.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return 'h' + h.toString(16);
  }
}

export function createRepair({ getJSON, saveImage }) {
  let last = 0, chain = Promise.resolve();
  const genreCache = new Map();

  /** one MusicBrainz request at a time, ≥1.1 s apart */
  function mbGet(url) {
    const run = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const wait = last + 1100 - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        try { return await getJSON(url); }
        catch (e) { if (!/^503\b/.test(String(e && e.message))) throw e; await sleep(1500 * (attempt + 1)); }
      }
      throw new Error('rate-limit');
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  /** recording searches, the exact title phrase first, then the same words in any form (lazy) */
  function* searches(title, extra) {
    const qt = strip(title) || title;
    const get = (q) => mbGet(`${MB}/recording?fmt=json&limit=50&query=${encodeURIComponent(q)}`).then((d) => (d && d.recordings) || []);
    yield get(`recording:"${lucene(qt)}"${extra(true)}`);
    const w = words(qt);
    if (w) yield get(`recording:(${w})${extra(false)}`);
  }

  /** best recording for what we know about a track; null when nothing is close enough (no artist → no lookup) */
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
        const n = Math.min(1, Math.log10(1 + (rec.releases || []).length) / 2);
        const confidence = Math.max(0, Math.min(1, tSim * .3 + aSim * .25 + dScore * .2 + relQ * .15 + n * .1));
        if (!best || confidence > best.confidence) best = { rec, rel, confidence };
      }
      if (best && best.confidence >= .55) break;
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

  /** who sings it, when the file only knows a title: the artist whose recordings sit on clearly more releases */
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

  const save = (url, key) => saveImage(url, key).catch(() => null);
  const json = (url) => getJSON(url).catch(() => null);

  /** album artwork: Cover Art Archive first, then Deezer's and Apple's public catalogues if the album matches */
  async function cover({ releaseId, groupId, artist, album }) {
    for (const [kind, id] of [['release-group', groupId], ['release', releaseId]]) {
      if (!id || !/^[0-9a-f-]{36}$/.test(id)) continue;
      const got = await save(`${CAA}/${kind}/${id}/front-500`, 'mb-' + id);
      if (got) return got;
    }
    if (!artist || !album) return null;
    const key = 'art-' + await keyOf(artist + '|' + album);
    const albumOk = (name) => sim(String(name || '').replace(/\s+-\s+(single|ep)$/i, ''), album) >= .75;
    const artistOk = (name) => sim(name, artist) >= .5 || norm(name).includes(norm(artist));
    const dz = await json(`https://api.deezer.com/search/album?q=${encodeURIComponent(`artist:"${artist}" album:"${album}"`)}`);
    const d = ((dz && dz.data) || []).find((a) => albumOk(a.title) && artistOk(a.artist && a.artist.name));
    if (d && (d.cover_xl || d.cover_big)) {
      const got = await save(d.cover_xl || d.cover_big, key);
      if (got) return got;
    }
    const it = await json(`https://itunes.apple.com/search?entity=album&limit=10&term=${encodeURIComponent(artist + ' ' + album)}`);
    const a = ((it && it.results) || []).find((x) => albumOk(x.collectionName) && artistOk(x.artistName));
    if (a && a.artworkUrl100) return save(a.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.'), key);
    return null;
  }

  /** everything the repair screen needs for one track — the same answer as the desktop's meta:repair */
  async function repair(track, { wantCover = true, wantGenre = true } = {}) {
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

  return { repair };
}
