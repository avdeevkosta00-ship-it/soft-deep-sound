/**
 * Playlist import, the pure part: reading track lists from files or pasted text, and finding
 * each imported track in the local library.
 *
 *  • CSV from Soundiiz, TuneMyMusic, Exportify and similar tools (any delimiter, quoted fields,
 *    headers in English or Russian), or plain text: one track per line, "Artist — Title";
 *  • matching compares titles and artists in one Latin spelling (so «Кино» meets "Kino"), ignores
 *    "feat.", "Remastered", "Explicit" and similar noise, but keeps versions apart (Remix ≠ original),
 *    and uses the length when both sides know it.
 */
import { latin } from './fuzzy.js';

/* ------------------------------------------------------------------ parsing */

/** RFC 4180-ish CSV: quotes, escaped quotes, newlines inside quotes */
function parseCsv(text, delim) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const COLS = {
  title: /^(track ?name|track ?title|song ?name|song|title|name|track|название|трек|песня|название трека)$/i,
  artist: /^(artist ?name\(s\)|artist ?names?|artists?|artist|performer|исполнител[ьи]|артист)$/i,
  album: /^(album ?name|album ?title|album|альбом)$/i,
  duration: /^(duration|duration ?\(ms\)|track ?duration ?\(ms\)|length|time|длительность|время)$/i,
  type: /^(type|тип)$/i,
  playlist: /^(playlist ?name|playlist|плейлист)$/i
};

function parseDuration(v, header) {
  const s = String(v || '').trim();
  if (!s) return 0;
  if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(s)) return s.split(':').reduce((a, x) => a * 60 + Number(x), 0);
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return /ms/i.test(header) || n > 20000 ? Math.round(n / 1000) : Math.round(n);
}

/** strips list numbering, bullets and a trailing time ("3:41") from a pasted line */
function cleanLine(l) {
  let s = l.replace(/\t+/g, ' — ').trim();
  s = s.replace(/^(\d{1,4}[.)]\s+|\d{1,4}\s+-\s+|[•·*▶►-]\s+)/, '');
  const time = /\s+\(?(\d{1,2}:\d{2}(?::\d{2})?)\)?$/.exec(s);
  let duration = 0;
  if (time) { duration = parseDuration(time[1]); s = s.slice(0, time.index).trim(); }
  return { s, duration };
}

function parseLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const { s, duration } = cleanLine(raw);
    if (!s || s.length > 300 || /^https?:\/\//i.test(s)) continue;
    // "Artist — Title" is the common form; the order is checked again when matching
    const m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(s);
    if (m) out.push({ artist: m[1].trim(), title: m[2].trim(), album: '', duration, loose: true });
    else out.push({ artist: '', title: s, album: '', duration, loose: true });
  }
  return out;
}

/**
 * text → { title, tracks: [{ title, artist, album, duration }], format }
 * `name` (file name) gives the playlist a title when the file itself has none.
 */
export function parseTrackList(text, name = '') {
  const src = String(text || '').replace(/^﻿/, '');
  const first = src.split(/\r?\n/).find((l) => l.trim()) || '';
  const delim = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length - 1]).sort((a, b) => b[1] - a[1])[0];
  let title = String(name || '').replace(/\.(csv|txt|tsv|m3u8?)$/i, '').trim();

  if (delim[1] >= 1) {
    const rows = parseCsv(src, delim[0]);
    const head = (rows[0] || []).map((x) => x.trim());
    const col = {};
    head.forEach((hname, i) => { for (const [k, re] of Object.entries(COLS)) if (col[k] === undefined && re.test(hname)) col[k] = i; });
    if (col.title !== undefined) {
      const tracks = [];
      let plName = '';
      for (const r of rows.slice(1)) {
        if (col.type !== undefined && /podcast|episode|show|audiobook|video|подкаст|эпизод|аудиокнига/i.test(r[col.type] || '')) continue;
        const t = String(r[col.title] || '').trim();
        if (!t) continue;
        // Exportify joins several artists with commas inside the field; Soundiiz uses ", " too
        tracks.push({
          title: t,
          artist: String(col.artist !== undefined ? r[col.artist] || '' : '').trim(),
          album: String(col.album !== undefined ? r[col.album] || '' : '').trim(),
          duration: col.duration !== undefined ? parseDuration(r[col.duration], head[col.duration]) : 0
        });
        if (!plName && col.playlist !== undefined) plName = String(r[col.playlist] || '').trim();
      }
      return { title: plName || title, tracks, format: 'csv' };
    }
  }
  // M3U with #EXTINF:<sec>,Artist - Title
  if (/^#EXTM3U/m.test(src)) {
    const tracks = [];
    for (const m of src.matchAll(/^#EXTINF:(-?\d+)[^,]*,(.+)$/gm)) {
      const [, sec, info] = m;
      const p = /^(.+?)\s+[—–-]\s+(.+)$/.exec(info.trim());
      tracks.push({ artist: p ? p[1].trim() : '', title: (p ? p[2] : info).trim(), album: '', duration: Math.max(0, Number(sec) || 0), loose: !p });
    }
    return { title, tracks, format: 'm3u' };
  }
  return { title, tracks: parseLines(src), format: 'text' };
}

/* ------------------------------------------------------------------ matching */

/** noise that never changes which recording it is */
const NOISE = /\b(feat|ft|featuring|prod|with)\b\.?.*$|\b(remaster(ed)?( \d{4})?|\d{4} remaster(ed)?|explicit|clean|radio edit|single version|album version|original mix|official( (audio|video))?|lyrics?|hq|hd|bonus track|deluxe( edition)?|mono|stereo)\b/gi;
/** words that mark a different version: kept and compared */
const VERSION_SRC = '(remix|rmx|edit|live|acoustic|instrumental|slowed|sped up|speed up|nightcore|reverb|cover|mix|version|demo|extended|vip|bootleg|mashup|караоке|минус|ремикс)';
const VERSION = new RegExp(`(?<![\\p{L}\\p{N}])${VERSION_SRC}(?![\\p{L}\\p{N}])`, 'giu');
const IS_VERSION = new RegExp(`(?<![\\p{L}\\p{N}])${VERSION_SRC}(?![\\p{L}\\p{N}])`, 'iu');

function cleanTitle(s) {
  let t = String(s || '');
  // drop bracketed noise like (feat. X) or [Remastered 2011], keep bracketed versions like (Remix)
  t = t.replace(/[([{]([^)\]}]*)[)\]}]/g, (m, inner) => (IS_VERSION.test(inner) ? ' ' + inner + ' ' : ' '));
  t = t.replace(/\s[-–—]\s(.*)$/, (m, tail) => (IS_VERSION.test(tail) ? ' ' + tail : ''));
  return latin(t.replace(NOISE, ' '));
}
const versions = (s) => new Set((String(s || '').toLowerCase().replace(NOISE, ' ').match(VERSION) || []).map((v) => v.replace('rmx', 'remix').replace('ремикс', 'remix')));
const artistsOf = (s) => String(s || '').split(/\s*(?:,|&|\+| x | и | and |feat\.?|ft\.?|featuring|;|\/)\s*/i).map((a) => latin(a)).filter(Boolean);

function bigrams(s) {
  const out = new Map();
  const x = ` ${s} `;
  for (let i = 0; i < x.length - 1; i++) { const g = x.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); }
  return out;
}
/** Dice similarity of letter pairs, 0…1 — robust to typos and word order */
function sim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  for (const [g, v] of A) if (B.has(g)) inter += Math.min(v, B.get(g));
  return (2 * inter) / (na + nb);
}

/** per-track index of the library, built once per import */
function indexLibrary(tracks) {
  return tracks.map((t) => {
    const file = String(t.path || '').split(/[\\/]/).pop().replace(/\.\w+$/, '');
    return { t, title: cleanTitle(t.title), artists: artistsOf(t.artist), file: latin(file), ver: versions(t.title + ' ' + file) };
  });
}

function scorePair(it, L) {
  const ver = versions(it.title);
  const titleS = Math.max(sim(it.cTitle, L.title), it.cTitle && L.title && (L.title.startsWith(it.cTitle) || it.cTitle.startsWith(L.title)) ? .88 : 0);
  let artistS = 0;
  if (!it.artists.length) artistS = .6; // nothing to compare: neutral
  else if (!L.artists.length) artistS = L.file && it.artists.some((a) => L.file.includes(a)) ? .9 : .45;
  else for (const a of it.artists) for (const b of L.artists) artistS = Math.max(artistS, sim(a, b), a && b && (a.includes(b) || b.includes(a)) ? .9 : 0);
  let s = titleS * .62 + artistS * .38;
  // a remix is not the original (and the other way round)
  const vA = [...ver].sort().join(), vB = [...L.ver].sort().join();
  if (vA !== vB) s -= .18;
  if (it.duration && L.t.duration) {
    const d = Math.abs(it.duration - L.t.duration);
    if (d <= 3) s += .05; else if (d > 20) s -= Math.min(.2, (d - 20) / 200 + .06);
  }
  // the file name alone ("Artist - Title.mp3") can confirm a track whose tags are empty
  if (!L.title && L.file) {
    const inFile = it.cTitle && L.file.includes(it.cTitle) && (!it.artists.length || it.artists.some((a) => L.file.includes(a)));
    s = Math.max(s, inFile ? .9 : sim(it.cTitle + ' ' + it.artists.join(' '), L.file) * .9);
  }
  return s;
}

export const MATCH = { sure: .8, maybe: .58 };

/**
 * items: [{ title, artist, album, duration }]
 * returns [{ item, track, score, status: 'found' | 'maybe' | 'missing', alt }] in the original order;
 * work is split into small slices so the window stays responsive on big libraries.
 */
export async function matchTracks(items, library, onProgress) {
  const lib = indexLibrary(library);
  // a cheap pre-filter: library tracks sharing a word with the title or artist
  const byWord = new Map();
  lib.forEach((L, i) => {
    for (const w of new Set([...L.title.split(' '), ...L.artists.flatMap((a) => a.split(' ')), ...L.file.split(' ')])) {
      if (w.length < 2) continue;
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(i);
    }
  });
  const out = [];
  const used = new Map();
  for (let n = 0; n < items.length; n++) {
    const raw = items[n];
    const tryOrder = (title, artist) => {
      const it = { title, cTitle: cleanTitle(title), artists: artistsOf(artist), duration: raw.duration || 0 };
      const cand = new Set();
      for (const w of new Set([...it.cTitle.split(' '), ...it.artists.flatMap((a) => a.split(' '))])) {
        const hit = byWord.get(w);
        if (hit && hit.length < 4000) hit.forEach((i) => cand.add(i));
      }
      let best = null;
      for (const i of cand) { const s = scorePair(it, lib[i]); if (!best || s > best.s) best = { s, L: lib[i] }; }
      return best;
    };
    let best = tryOrder(raw.title, raw.artist);
    // pasted lines may be "Title — Artist"; take whichever reading fits the library better
    if (raw.loose && raw.artist) {
      const flip = tryOrder(raw.artist, raw.title);
      if (flip && (!best || flip.s > best.s + .04)) best = flip;
    }
    const score = best ? Math.max(0, Math.min(1, best.s)) : 0;
    const status = score >= MATCH.sure ? 'found' : score >= MATCH.maybe ? 'maybe' : 'missing';
    const track = status === 'missing' ? null : best.L.t;
    if (track) used.set(track.id, (used.get(track.id) || 0) + 1);
    out.push({ item: { title: raw.title, artist: raw.artist, album: raw.album || '', duration: raw.duration || 0 }, track, score, status, accept: status === 'found' });
    if (n % 40 === 39) { onProgress && onProgress((n + 1) / items.length); await new Promise((r) => setTimeout(r, 0)); }
  }
  onProgress && onProgress(1);
  return out;
}

/** "Artist — Title" lines, for copying the list of tracks that are not in the library */
export const asLines = (items) => items.map((i) => (i.artist ? `${i.artist} — ${i.title}` : i.title)).join('\n');
