'use strict';
/**
 * Safe downloader: the only way remote bytes reach the disk.
 *  - https only, no IP literals / localhost (SSRF guard)
 *  - Content-Type must be audio/* (or octet-stream with an audio extension)
 *  - hard size cap, streamed to a temp file
 *  - magic-byte sniffing: the file must really be MP3/FLAC/OGG/WAV/M4A, the extension is derived from bytes
 *  - sanitized file name, never overwrites existing files
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable } = require('stream');
const { safeFetch } = require('./http');

const { tm } = require('../i18n-main');
const MAX_BYTES = 300 * 1024 * 1024;

function assertSafeUrl(u) {
  const url = new URL(u);
  if (url.protocol !== 'https:') throw new Error(tm('err.https'));
  const h = url.hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || /^[\d.]+$/.test(h) || h.includes(':')) throw new Error(tm('err.addr'));
  return url;
}

function sniff(buf) {
  const s = (a, b) => buf.slice(a, b).toString('latin1');
  if (s(0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (s(0, 4) === 'fLaC') return 'flac';
  if (s(0, 4) === 'OggS') return 'ogg';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'wav';
  if (s(4, 8) === 'ftyp') return 'm4a';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}

const sanitize = (s) => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

async function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i}).${ext}`);
  return p;
}

async function safeDownload(item, dir, onProgress = () => {}) {
  assertSafeUrl(item.fileUrl);
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36 SoftDeepSound/1.2', Accept: 'audio/*,*/*;q=0.8' };
  if (item.pageUrl && /^https:/i.test(item.pageUrl)) headers.Referer = item.pageUrl; // many hosts refuse files without the page as referer
  // every redirect hop is checked (https, public address) before it is requested
  const res = await safeFetch(item.fileUrl, { headers, signal: AbortSignal.timeout(10 * 60 * 1000) }, assertSafeUrl)
    .catch((e) => { throw new Error(/blocked|redirect/.test(e.message) ? tm('err.addr') : e.message); });
  if (!res.ok) throw new Error(tm('err.status', res.status));

  const type = (res.headers.get('content-type') || '').toLowerCase();
  const okType = type.startsWith('audio/') || type.includes('ogg') ||
    ((type.includes('octet-stream') || type.includes('binary') || !type) && /\.(mp3|ogg|flac|wav|m4a|opus)(\?|$)/i.test(item.fileUrl));
  if (!okType) throw new Error(tm('err.notAudio', type || 'unknown'));
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  if (total > MAX_BYTES) throw new Error(tm('err.tooBig'));

  const tmp = path.join(dir, `.sds-${Date.now()}-${Math.random().toString(36).slice(2)}.part`);
  const out = fs.createWriteStream(tmp);
  let received = 0, head = Buffer.alloc(0), lastEmit = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      received += chunk.length;
      if (received > MAX_BYTES) throw new Error(tm('err.tooBig'));
      if (head.length < 16) head = Buffer.concat([head, Buffer.from(chunk)]).slice(0, 16);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (now - lastEmit > 120) { lastEmit = now; onProgress({ received, total }); }
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    const ext = sniff(head);
    if (!ext) throw new Error(tm('err.sniff'));
    const base = sanitize(item.artist ? `${item.artist} - ${item.title}` : item.title) || 'track';
    const final = await uniquePath(dir, base, ext);
    await fsp.rename(tmp, final);
    onProgress({ received, total: received, done: true });
    return final;
  } catch (e) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

module.exports = { safeDownload, sniff, assertSafeUrl };
