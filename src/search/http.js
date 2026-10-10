'use strict';
/**
 * HTTP for search & downloads.
 * We use Node's own fetch (undici) on purpose: Electron's net.fetch pushes *response* headers through
 * a strict Latin-1 (ByteString) check and throws an uncatchable error in the main process when a
 * server sends a header with characters like ’ or «» (common in Content-Disposition file names).
 * Node's fetch tolerates such headers, so one odd server can no longer pop an error dialog.
 */
const dns = require('dns').promises;
const net = require('net');
const httpFetch = (url, opts = {}) => globalThis.fetch(url, opts);

/** private, loopback, link-local and other non-public addresses (IPv4 and IPv6) */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
/** the host must resolve only to public addresses */
async function assertPublicHost(hostname) {
  const h = hostname.replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (net.isIP(h)) { if (isPrivateIp(h)) throw new Error('blocked address'); return; }
  const addrs = await dns.lookup(h, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('blocked address');
}
/**
 * fetch that follows redirects by hand: every hop must pass `check(url)` and resolve to a public
 * address, so a public link can never bounce the request into the local network.
 */
async function safeFetch(url, opts = {}, check = () => {}, maxHops = 6) {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const u = new URL(current);
    check(u.href);
    await assertPublicHost(u.hostname);
    const res = await httpFetch(u.href, { ...opts, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      try { await res.body?.cancel(); } catch {}
      current = new URL(res.headers.get('location'), u).href;
      continue;
    }
    Object.defineProperty(res, 'finalUrl', { value: u.href });
    return res;
  }
  throw new Error('too many redirects');
}
module.exports = { httpFetch, safeFetch, isPrivateIp };
