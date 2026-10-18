'use strict';
/**
 * Deezer playlist / album import through Deezer's public API (api.deezer.com).
 * No keys, no login: the API is open for public playlists and albums.
 * Only the track list (title, artist, album, duration) is read; nothing is downloaded.
 */
const { safeFetch } = require('../search/http');

const API = 'https://api.deezer.com';
const PAGE = 100;
const MAX_TRACKS = 5000;

const isDeezerHost = (h) => /(^|\.)deezer\.com$/i.test(h) || /(^|\.)deezer\.page\.link$/i.test(h) || /(^|\.)dzr\.page\.link$/i.test(h);

/** deezer.com/xx/playlist/123, deezer.com/album/123, short links link.deezer.com/s/… and deezer.page.link/… */
async function resolveUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw new Error('bad-url'); }
  if (!isDeezerHost(url.hostname)) throw new Error('bad-url');
  const direct = /\/(playlist|album)\/(\d+)/.exec(url.pathname);
  if (direct) return { type: direct[1], id: direct[2] };
  // short links redirect to the full address; follow them by hand, staying on Deezer hosts
  const res = await safeFetch(url.href, { headers: { 'user-agent': 'Mozilla/5.0 SoftDeepSound' } }, (u) => {
    if (!isDeezerHost(new URL(u).hostname)) throw new Error('bad-url');
  });
  try { await res.body?.cancel(); } catch {}
  const m = /\/(playlist|album)\/(\d+)/.exec(new URL(res.finalUrl).pathname);
  if (!m) throw new Error('bad-url');
  return { type: m[1], id: m[2] };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`deezer-http-${res.status}`);
  const data = await res.json();
  // Deezer reports errors inside a 200 response
  if (data && data.error) {
    const code = data.error.code;
    throw new Error(code === 800 ? 'not-found' : code === 4 ? 'rate-limit' : 'deezer-error');
  }
  return data;
}

const mapTrack = (t, albumTitle) => ({
  title: String(t.title || '').trim(),
  artist: String((t.artist && t.artist.name) || '').trim(),
  album: String((t.album && t.album.title) || albumTitle || '').trim(),
  duration: Number(t.duration) || 0
});

async function importDeezer(raw) {
  const { type, id } = await resolveUrl(raw);
  const meta = await getJson(`${API}/${type}/${id}`);
  const tracks = [];
  let next = `${API}/${type}/${id}/tracks?limit=${PAGE}&index=0`;
  while (next && tracks.length < MAX_TRACKS) {
    const page = await getJson(next);
    for (const t of page.data || []) {
      if (t && t.type === 'track' && t.title) tracks.push(mapTrack(t, type === 'album' ? meta.title : ''));
    }
    // follow only Deezer's own "next" links
    next = page.next && /^https:\/\/api\.deezer\.com\//.test(page.next) ? page.next : null;
  }
  return {
    source: 'deezer',
    kind: type,
    title: String(meta.title || '').trim(),
    owner: type === 'album' ? String((meta.artist && meta.artist.name) || '') : String((meta.creator && meta.creator.name) || ''),
    tracks: tracks.filter((t) => t.title)
  };
}

module.exports = { importDeezer, resolveUrl };
