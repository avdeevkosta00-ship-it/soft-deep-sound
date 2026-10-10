'use strict';
/**
 * "Any site" mode: the user pastes a link they found themselves.
 *  - a direct audio link  → one result, ready to download;
 *  - a web page           → we read its HTML (never render or run it) and collect every audio file
 *                           the page itself exposes: <audio>/<source>, og:audio meta, JSON-LD
 *                           contentUrl and plain links to .mp3/.ogg/.flac/.m4a/.wav/.opus.
 * Everything found still goes through safeDownload() checks (https, audio type, signature, size).
 */
const { assertSafeUrl } = require('./downloader');
const { tm } = require('../i18n-main');
const { safeFetch } = require('./http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36 SoftDeepSound/1.2';
const AUDIO_EXT = /\.(mp3|ogg|oga|flac|wav|m4a|opus|aac)(?:[?#]|$)/i;
const MAX_HTML = 4 * 1024 * 1024;

const decodeHtml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const stripTags = (s) => decodeHtml(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function nameFromUrl(u) {
  try {
    const last = decodeURIComponent(new URL(u).pathname.split('/').pop() || '');
    return last.replace(AUDIO_EXT, '').replace(/[_+]+/g, ' ').trim() || tm('audio');
  } catch { return tm('audio'); }
}
function splitArtist(name) {
  const m = name.split(/\s[-–—]\s/);
  return m.length >= 2 ? { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() } : { artist: '', title: name };
}

async function readText(res) {
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length; chunks.push(value);
    if (size > MAX_HTML) { try { reader.cancel(); } catch {} break; }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

async function extractAudio(input) {
  let url = String(input || '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  url = url.replace(/^http:/i, 'https:');
  assertSafeUrl(url);
  const res = await safeFetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,audio/*;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(15000) }, assertSafeUrl)
    .catch((e) => { throw new Error(/blocked|redirect/.test(e.message) ? tm('err.addr') : e.message); });
  if (!res.ok) throw new Error(tm('err.site', res.status));
  const finalUrl = res.finalUrl || url;
  const host = new URL(finalUrl).hostname.replace(/^www\./, '');
  const type = (res.headers.get('content-type') || '').toLowerCase();

  // 1) direct audio link
  if (type.startsWith('audio/') || (AUDIO_EXT.test(finalUrl) && !type.includes('html'))) {
    try { res.body && res.body.cancel(); } catch {}
    const { artist, title } = splitArtist(nameFromUrl(finalUrl));
    return { page: { url: finalUrl, title: '', host }, results: [mk(finalUrl, title, artist, host, finalUrl, 0)] };
  }
  if (!type.includes('html') && !type.includes('xml')) throw new Error(tm('err.nothing'));

  // 2) web page → collect audio the page exposes
  const html = await readText(res);
  const pageTitle = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const ogTitle = decodeHtml((html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || [])[1] || '');
  const found = new Map();
  const add = (raw, label) => {
    if (!raw) return;
    let abs;
    try { abs = new URL(decodeHtml(raw.trim()), finalUrl).href; } catch { return; }
    abs = abs.replace(/^http:/i, 'https:');
    if (!/^https:/i.test(abs)) return;
    const prev = found.get(abs);
    const name = (label && label.length > 1 && label.length < 160) ? label : (prev && prev.name) || nameFromUrl(abs);
    found.set(abs, { name, order: prev ? prev.order : found.size });
  };

  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["']og:audio(?::url|:secure_url)?["'][^>]*content=["']([^"']+)["']/gi)) add(m[1], ogTitle);
  for (const m of html.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:audio(?::url|:secure_url)?["']/gi)) add(m[1], ogTitle);
  for (const m of html.matchAll(/<(?:audio|source)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    if (/<source/i.test(m[0]) && /type=["'](?!audio)/i.test(m[0])) continue;
    add(m[1], ogTitle || pageTitle);
  }
  for (const m of html.matchAll(/"contentUrl"\s*:\s*"([^"]+)"/gi)) if (AUDIO_EXT.test(m[1])) add(m[1].replace(/\\\//g, '/'), ogTitle);
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) if (AUDIO_EXT.test(m[1])) add(m[1], stripTags(m[2]));
  // bare audio URLs inside inline scripts / data attributes
  for (const m of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>()]+?\.(?:mp3|ogg|flac|m4a|opus|wav)(?:\?[^\s"'<>()]*)?/gi)) add(m[0].replace(/\\\//g, '/'), '');

  const results = [...found.entries()].sort((a, b) => a[1].order - b[1].order).slice(0, 60).map(([u, v], i) => {
    const { artist, title } = splitArtist(v.name);
    return mk(u, title, artist, host, finalUrl, i);
  });
  return { page: { url: finalUrl, title: ogTitle || pageTitle, host }, results };
}

function mk(fileUrl, title, artist, host, pageUrl, i) {
  return {
    id: 'lk-' + Buffer.from(fileUrl).toString('base64').replace(/[^a-z0-9]/gi, '').slice(-24) + i,
    title: title || tm('audio'), artist, provider: 'link', providerLabel: host, pageUrl, fileUrl,
    format: ((fileUrl.match(AUDIO_EXT) || [])[1] || 'AUDIO').toUpperCase(), duration: 0, license: ''
  };
}

module.exports = { extractAudio };
