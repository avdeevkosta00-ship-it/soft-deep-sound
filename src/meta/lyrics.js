'use strict';
/**
 * Song lyrics, from the closest source first:
 *   1. a .lrc file next to the track ("Song.mp3" → "Song.lrc") — the user's own, works offline;
 *   2. lyrics embedded in the file's tags (ID3 USLT, Vorbis LYRICS, MP4 ©lyr);
 *   3. LRCLIB (lrclib.net) — an open lyrics database with time-synced lines, only when allowed in
 *      settings and only for the track the user opened lyrics for. Only title, artist, album and
 *      length are sent. Answers (and misses) are cached in userData/lyrics.
 * The user can also paste lyrics they found themselves (e.g. on Genius): saved as a .lrc next to the track.
 * Returns { source, text } where text is LRC (synced) or plain; the renderer parses it.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { httpFetch } = require('../search/http');

const API = 'https://lrclib.net/api';
const MAX_FILE = 512 * 1024;
const MISS_TTL = 14 * 864e5; // a miss is asked again after two weeks…
const RULES = 2;             // …or at once after the lookup improves (2: lost apostrophes, «weren t»)

let deps = null; // { version, userDir, audioExt }
let mm = null;
function init(d) { deps = d; }
const cacheDir = () => path.join(deps.userDir(), 'lyrics');
const ua = () => `SoftDeepSound/${deps.version} (https://github.com/infallibl3/soft-deep-sound)`;

/** UTF-8 first; old .lrc files from Russian players are often Windows-1251 */
function decode(buf) {
  const utf = buf.toString('utf8').replace(/^﻿/, '');
  if (!utf.includes('�')) return utf;
  try { return new TextDecoder('windows-1251').decode(buf); } catch { return utf; }
}

async function fromSidecar(file) {
  const dir = path.dirname(file), base = path.basename(file, path.extname(file)).toLowerCase();
  let names;
  try { names = await fsp.readdir(dir); } catch { return null; }
  const hit = names.find((n) => n.toLowerCase() === base + '.lrc');
  if (!hit) return null;
  const p = path.join(dir, hit);
  const st = await fsp.stat(p).catch(() => null);
  if (!st || !st.isFile() || st.size > MAX_FILE) return null;
  const text = decode(await fsp.readFile(p)).trim();
  return text ? { source: 'lrc', text } : null;
}

async function fromTags(file) {
  mm = mm || require('music-metadata');
  try {
    const meta = await mm.parseFile(file, { duration: false, skipCovers: true });
    const text = (meta.common.lyrics || []).map((s) => String(s || '').trim()).filter(Boolean).join('\n\n');
    return text ? { source: 'tags', text } : null;
  } catch { return null; }
}

async function fromLrclib({ title, artist, album, duration }, force) {
  // names from download sites carry junk («1546698_Apoplexy», «(zaycev.net)»): search with the clean ones
  const { stripJunk } = await deps.names();
  title = stripJunk(title); artist = stripJunk(artist);
  if (!title) return null;
  // without an artist only the length can tell one «Apoplexy» from another
  if (!artist && !(duration > 0)) return null;
  // RULES is part of the key: when the lookup gets better, old «nothing found» answers are not trusted any more
  const key = crypto.createHash('sha1').update([RULES, artist, title, album, Math.round(duration || 0)].join('|').toLowerCase()).digest('hex');
  const file = path.join(cacheDir(), key + '.json');
  // «search again» skips what was remembered: the last attempt may have hit a busy server
  if (!force) try {
    const c = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (c.text || Date.now() - c.at < MISS_TTL) return c.text ? { source: 'lrclib', text: c.text, match: c.match || null } : c.match ? { source: null, text: '', match: c.match } : null;
  } catch {}
  const headers = { 'user-agent': ua(), 'lrclib-client': ua(), accept: 'application/json' };
  const ask = async (url) => {
    for (let attempt = 0; ; attempt++) {
      const res = await httpFetch(url, { headers, signal: AbortSignal.timeout(12000) });
      if (res.status === 404) return null;
      if (res.ok) return res.json();
      // a busy server gets two more tries; anything else (or a third failure) is reported, not cached
      if (res.status < 500 || attempt >= 2) throw new Error('lrclib-' + res.status);
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  };
  const pick = (r) => r && !r.instrumental && (r.syncedLyrics || r.plainLyrics) ? (r.syncedLyrics || r.plainLyrics).trim() : r && r.instrumental ? '[instrumental]' : '';
  let text = '', match = null;
  if (!artist) {
    // only a title: ask MusicBrainz who sings a song of that name and length; the answer comes back as a
    // suggestion («Похоже, это …») — the lyrics are looked up under that name
    const guess = await deps.identify({ title, duration }).catch(() => null);
    if (!guess) { await remember(file, '', null); return null; }
    match = { artist: guess.artist, title: guess.title, album: guess.album || '' };
    artist = guess.artist; title = guess.title; album = album || guess.album || '';
  }
  const q = new URLSearchParams({ track_name: title, artist_name: artist });
  if (album) q.set('album_name', album);
  if (duration > 0) q.set('duration', String(Math.round(duration)));
  text = pick(await ask(`${API}/get?${q}`));
  if (!text) {
    // the exact lookup needs album and length to agree; the search is looser — accept only a close length
    const list = await ask(`${API}/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`) || [];
    const fit = list.filter((r) => !(duration > 0) || !r.duration || Math.abs(r.duration - duration) <= 3);
    text = pick(fit.find((r) => r.syncedLyrics) || fit[0]);
  }
  if (!text) {
    // file names lose apostrophes («U Weren t Here»), and the search then looks for «weren» and «t»:
    // ask again in free form with the pieces joined, and keep only an entry that really is this track
    const joined = joinPieces(title);
    for (const q of [`${artist} ${joined}`, joined]) {
      const list = await ask(`${API}/search?${new URLSearchParams({ q })}`) || [];
      const best = pickFit(list, { title, artist, duration });
      if (best) { text = pick(best); break; }
    }
  }
  await remember(file, text, match);
  // no words, but the real name is still worth suggesting
  return text ? { source: 'lrclib', text, match } : match ? { source: null, text: '', match } : null;
}
/** «Weren t», «don t», «I m» → «Werent», «dont», «Im»: what a lost apostrophe leaves behind, joined back */
function joinPieces(s) {
  return String(s).replace(/(\p{L}+) (t|s|re|ll|ve|d|m)(?!\p{L})/giu, '$1$2');
}
/**
 * The search entry that is this track: same title (spelling aside), a close artist and length.
 * Some uploads have artist and title swapped — those count too.
 */
function pickFit(list, { title, artist, duration }) {
  const flat = (x) => deps.norm(joinPieces(x || '')).replace(/ /g, '');
  const tOk = (x) => flat(x) === flat(title) || deps.sim(joinPieces(x || ''), joinPieces(title)) >= .9;
  const aOk = (x) => !artist || (!!x && (deps.sim(x, artist) >= .5 || flat(x).includes(flat(artist)) || flat(artist).includes(flat(x))));
  const fit = list.filter((r) => (r.syncedLyrics || r.plainLyrics) && (!(duration > 0) || (r.duration && Math.abs(r.duration - duration) <= 3)) &&
    ((tOk(r.trackName) && aOk(r.artistName)) || (tOk(r.artistName) && aOk(r.trackName))));
  return fit.find((r) => r.syncedLyrics) || fit[0] || null;
}

async function remember(file, text, match) {
  try { await fsp.mkdir(cacheDir(), { recursive: true }); await fsp.writeFile(file, JSON.stringify({ at: Date.now(), text, match })); } catch {}
}

/* lyrics the user pasted themselves: a .lrc next to the track, or our own copy when that folder is read-only */
const ownFile = (file) => path.join(cacheDir(), 'own', crypto.createHash('sha1').update(file.toLowerCase()).digest('hex') + '.lrc');
async function fromOwnCopy(file) {
  try { const text = (await fsp.readFile(ownFile(file), 'utf8')).trim(); return text ? { source: 'own', text } : null; } catch { return null; }
}
const isAudio = (file) => path.isAbsolute(file) && deps.audioExt.has(path.extname(file).toLowerCase()) && fs.existsSync(file);

/**
 * Never overwrites a .lrc that is already there — unless the user asked to replace their text with one found
 * online: then the old file is kept next to it as «.lrc.bak». Returns where the text went.
 */
async function save(file, text, replace = false) {
  text = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!isAudio(file) || !text || text.length > MAX_FILE / 2) throw new Error('bad-lyrics');
  const side = path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.lrc');
  const body = '﻿' + text + '\n';
  if (replace && fs.existsSync(side)) {
    try { await fsp.copyFile(side, side + '.bak'); await fsp.writeFile(side, body); return { where: 'lrc', backup: true }; }
    catch { throw new Error('read-only'); } // the old file stays in charge: say so rather than pretend
  }
  try {
    await fsp.writeFile(side, body, { flag: 'wx' });
    if (replace) await fsp.rm(ownFile(file), { force: true }).catch(() => {});
    return { where: 'lrc' };
  } catch {
    const own = ownFile(file);
    await fsp.mkdir(path.dirname(own), { recursive: true });
    await fsp.writeFile(own, text);
    return { where: 'app' };
  }
}

/** skipLocal: «search online» next to the user's own text — look past the .lrc, the tags and our copy */
async function get(t, { online, force, skipLocal }) {
  const file = String(t.path || '');
  if (isAudio(file) && !skipLocal) {
    const own = (await fromSidecar(file)) || (await fromTags(file)) || (await fromOwnCopy(file));
    if (own) return own;
  }
  if (!online && !skipLocal) return { source: null, text: '', offline: true };
  return (await fromLrclib(t, force)) || { source: null, text: '' };
}

module.exports = { init, get, save };
