'use strict';
/**
 * Spotify import through the official Web API and the user's own login (Authorization Code + PKCE).
 *
 *  • the user signs in on accounts.spotify.com in their own browser; we never see the password;
 *  • PKCE needs no client secret, so nothing secret lives in the app;
 *  • the redirect goes to a one-shot server on the loopback address (http://127.0.0.1:43117/callback),
 *    the only kind of http redirect Spotify accepts;
 *  • tokens are stored encrypted with the OS keychain (Electron safeStorage) when available.
 *
 * Spotify's rules (February 2026): an app in Development Mode serves up to 5 users and needs its owner
 * to have Premium; playlist contents are returned only for playlists the user owns or collaborates on.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = 43117;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read';
const AUTH = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const MAX_TRACKS = 10000;

let deps = null; // { userDir, openExternal, safeStorage }
let tokens = null; // { clientId, access, refresh, expires, user }
let pendingLogin = null;

const file = () => path.join(deps.userDir(), 'spotify.json');
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const validClientId = (id) => /^[0-9a-f]{32}$/i.test(String(id || '').trim());

function init(d) { deps = d; load(); }

function load() {
  try {
    const raw = fs.readFileSync(file());
    const json = deps.safeStorage && deps.safeStorage.isEncryptionAvailable() && raw[0] !== 0x7b
      ? deps.safeStorage.decryptString(raw) : raw.toString('utf8');
    tokens = JSON.parse(json);
  } catch { tokens = null; }
}
function persist() {
  try {
    if (!tokens) { fs.rmSync(file(), { force: true }); return; }
    const json = JSON.stringify(tokens);
    const data = deps.safeStorage && deps.safeStorage.isEncryptionAvailable() ? deps.safeStorage.encryptString(json) : json;
    fs.writeFileSync(file(), data);
  } catch {}
}

function status(clientId) {
  const ok = !!tokens && (!clientId || tokens.clientId === String(clientId).trim());
  return { connected: ok, user: ok ? tokens.user || '' : '', redirect: REDIRECT, waiting: !!pendingLogin };
}

function logout() { tokens = null; persist(); return status(); }

async function tokenRequest(params) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error === 'invalid_client' ? 'invalid-client' : data.error === 'invalid_grant' ? 'expired' : 'auth-failed');
    e.detail = data.error_description || data.error || res.status;
    throw e;
  }
  return data;
}

/** one-shot loopback server that waits for Spotify's redirect */
function waitForCallback(state) {
  return new Promise((resolve, reject) => {
    const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>Soft&amp;Deep Sound</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;font-family:Segoe UI,system-ui,sans-serif;background:#0b0b0d;color:#f2f2f3">
<div style="text-align:center"><div style="font-size:13px;letter-spacing:.3em;color:#8a8d95">SOFT&amp;DEEP SOUND</div>
<h1 style="font-weight:600;margin:14px 0 8px">${title}</h1><p style="color:#b3b5bb">${text}</p></div></body>`;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const err = u.searchParams.get('error');
      const ok = !err && u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ok ? page('Готово', 'Можно закрыть вкладку и вернуться в плеер.') : page('Вход отменён', 'Вернитесь в плеер и попробуйте ещё раз.'));
      finish(ok ? null : new Error(err === 'access_denied' ? 'denied' : 'auth-failed'), ok ? u.searchParams.get('code') : null);
    });
    const timer = setTimeout(() => finish(new Error('timeout')), 5 * 60 * 1000);
    let done = false;
    function finish(e, code) {
      if (done) return; done = true;
      clearTimeout(timer);
      server.close();
      e ? reject(e) : resolve(code);
    }
    server.on('error', (e) => finish(new Error(e.code === 'EADDRINUSE' ? 'port-busy' : 'auth-failed')));
    server.listen(PORT, '127.0.0.1');
    pendingLogin = { cancel: () => finish(new Error('cancelled')) };
  });
}

async function login(clientId) {
  clientId = String(clientId || '').trim();
  if (!validClientId(clientId)) throw new Error('bad-client-id');
  if (pendingLogin) pendingLogin.cancel();
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const wait = waitForCallback(state);
  const url = `${AUTH}?${new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: challenge, state
  })}`;
  await deps.openExternal(url);
  let code;
  try { code = await wait; } finally { pendingLogin = null; }
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
  tokens = { clientId, access: t.access_token, refresh: t.refresh_token, expires: Date.now() + (t.expires_in || 3600) * 1000 };
  try { const me = await api('/me'); tokens.user = me.display_name || me.id || ''; tokens.userId = me.id || ''; } catch {}
  persist();
  return status(clientId);
}

function cancelLogin() { if (pendingLogin) pendingLogin.cancel(); }

async function accessToken() {
  if (!tokens) throw new Error('not-connected');
  if (Date.now() < tokens.expires - 60000) return tokens.access;
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: tokens.clientId });
    tokens.access = t.access_token;
    if (t.refresh_token) tokens.refresh = t.refresh_token;
    tokens.expires = Date.now() + (t.expires_in || 3600) * 1000;
    persist();
    return tokens.access;
  } catch (e) {
    if (e.message === 'expired' || e.message === 'invalid-client') { tokens = null; persist(); throw new Error('not-connected'); }
    throw e;
  }
}

/** GET on the Web API; follows Spotify's own paging links only */
async function api(p, retry = 0) {
  const url = p.startsWith('https://') ? p : API + p;
  if (!url.startsWith(API + '/')) throw new Error('bad-url');
  const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}`, accept: 'application/json' } });
  if (res.status === 429 && retry < 3) {
    const wait = Math.min(10, Number(res.headers.get('retry-after')) || 2);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return api(p, retry + 1);
  }
  if (res.status === 401 && retry < 1 && tokens) { tokens.expires = 0; return api(p, retry + 1); }
  if (res.status === 403) throw new Error('forbidden');
  if (res.status === 404) throw new Error('not-found');
  if (!res.ok) throw new Error(`spotify-http-${res.status}`);
  return res.json();
}

const countOf = (pl) => (pl.items && typeof pl.items.total === 'number' ? pl.items.total : pl.tracks && typeof pl.tracks.total === 'number' ? pl.tracks.total : null);

async function playlists() {
  const me = tokens && tokens.userId;
  const out = [];
  let next = '/me/playlists?limit=50';
  while (next && out.length < 1000) {
    const page = await api(next);
    for (const p of page.items || []) {
      if (!p) continue;
      const owner = (p.owner && (p.owner.display_name || p.owner.id)) || '';
      out.push({
        id: p.id, name: p.name || '', count: countOf(p),
        image: (p.images && p.images[0] && p.images[0].url) || null,
        owner, own: !!(p.owner && me && p.owner.id === me) || !!p.collaborative,
        collaborative: !!p.collaborative
      });
    }
    next = page.next || null;
  }
  let liked = null;
  try { const l = await api('/me/tracks?limit=1'); liked = l.total ?? null; } catch {}
  return { user: (tokens && tokens.user) || '', liked, playlists: out };
}

/** Feb 2026 API: playlist entries carry the object in `item`; older responses used `track` */
function mapEntry(e) {
  const t = e && (e.item && typeof e.item === 'object' ? e.item : e.track && typeof e.track === 'object' ? e.track : null);
  if (!t || (t.type && t.type !== 'track') || !t.name) return null;
  return {
    title: String(t.name).trim(),
    artist: (t.artists || []).map((a) => a && a.name).filter(Boolean).join(', '),
    album: String((t.album && t.album.name) || '').trim(),
    duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : 0
  };
}

async function collect(first) {
  const tracks = [];
  let next = first;
  while (next && tracks.length < MAX_TRACKS) {
    const page = await api(next);
    for (const e of page.items || []) { const t = mapEntry(e); if (t) tracks.push(t); }
    next = page.next || null;
  }
  return tracks;
}

async function playlistTracks(id) {
  if (id === 'liked') return { source: 'spotify', kind: 'liked', title: '', tracks: await collect('/me/tracks?limit=50') };
  if (!/^[A-Za-z0-9]{10,40}$/.test(String(id))) throw new Error('bad-url');
  const meta = await api(`/playlists/${id}?fields=name,owner(display_name,id),items(total),tracks(total)`).catch((e) => {
    if (e.message === 'not-found') throw e; return {};
  });
  let tracks;
  try { tracks = await collect(`/playlists/${id}/items?limit=50`); }
  catch (e) {
    if (e.message !== 'not-found') throw e;
    tracks = await collect(`/playlists/${id}/tracks?limit=50`); // API before the February 2026 rename
  }
  // Spotify returns no contents for playlists the user neither owns nor collaborates on
  if (!tracks.length && (countOf(meta) || 0) > 0) throw new Error('not-owner');
  return {
    source: 'spotify', kind: 'playlist', title: meta.name || '',
    owner: (meta.owner && (meta.owner.display_name || meta.owner.id)) || '', tracks
  };
}

/** open.spotify.com/playlist/<id>, …/intl-xx/playlist/<id>, spotify:playlist:<id> */
function playlistIdFromUrl(raw) {
  const s = String(raw || '').trim();
  const m = /^spotify:playlist:([A-Za-z0-9]+)$/.exec(s) || /open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]+)/i.exec(s);
  return m ? m[1] : null;
}

module.exports = { init, status, login, logout, cancelLogin, playlists, playlistTracks, playlistIdFromUrl, REDIRECT, _mapEntry: mapEntry };
