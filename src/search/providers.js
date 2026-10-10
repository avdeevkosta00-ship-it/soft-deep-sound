'use strict';
/**
 * Web search providers (main process — no CORS, renderer never touches remote HTML).
 *
 * Every provider implements:  search(query, settings) -> Promise<Result[]>
 *   Result = { id, title, artist, provider, providerLabel, pageUrl, fileUrl, format, duration, license }
 *
 * Only sources with an open API and clear licensing (CC / public domain / artist-approved downloads)
 * are queried. To add a source, write one more object with the same shape and register it below.
 */
const { httpFetch: doFetch } = require('./http');

const { tm } = require('../i18n-main');
const UA = 'SoftDeepSound/1.0 (desktop music player)';

async function getJSON(url, timeout = 10000) {
  const res = await doFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const { norm, score: matchScore, variants } = require('./match');
/** best relevance over all spellings of the query that were tried */
const score = (query, title, artist, alts = [query]) => Math.max(...alts.map((q) => matchScore(q, title, artist)));
const AUDIO_RE = /\.(mp3|ogg|oga|flac|wav|m4a|opus)(\?|$)/i;

/* ----------------------------- Openverse (CC audio) ---------------------------- */
const openverse = {
  key: 'openverse', label: 'Openverse',
  async search(query) {
    // music only (no sound effects / podcasts), with tags & titles weighted by Openverse itself
    const data = await getJSON(`https://api.openverse.org/v1/audio/?q=${encodeURIComponent(query)}&category=music&page_size=40`);
    return (data.results || [])
      .filter((r) => r.url && /^https:/i.test(r.url) && (AUDIO_RE.test(r.url) || /mp3|ogg|flac|wav|m4a/i.test(r.filetype || '')))
      .filter((r) => !r.duration || r.duration >= 40000) // skip jingles & samples
      .map((r) => ({
        id: 'ov-' + r.id,
        title: r.title || tm('untitled'),
        artist: r.creator || '',
        provider: 'openverse',
        providerLabel: `Openverse · ${r.source || r.provider || ''}`.replace(/ · $/, ''),
        pageUrl: r.foreign_landing_url || '',
        fileUrl: r.url,
        format: (r.filetype || (r.url.match(AUDIO_RE) || [])[1] || '').toUpperCase(),
        duration: r.duration ? r.duration / 1000 : 0,
        license: `${(r.license || '').toUpperCase()} ${r.license_version || ''}`.trim()
      }));
  }
};

/* -------------------------------- Internet Archive ------------------------------ */
function iaLength(v) {
  if (!v) return 0;
  if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  const p = v.split(':').map(Number);
  return p.reduce((a, b) => a * 60 + b, 0);
}
const internetArchive = {
  key: 'archive', label: 'Internet Archive',
  async search(query) {
    // search titles & creators (not full text), music collections only
    const esc = query.replace(/[()":\\]/g, ' ');
    const q = `(title:(${esc}) OR creator:(${esc})) AND mediatype:(audio) AND -collection:(podcasts OR oldtimeradio OR librivoxaudio)`;
    const url = 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent(q) +
      '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=licenseurl&rows=10&output=json&sort[]=downloads+desc';
    const data = await getJSON(url);
    const docs = (data.response && data.response.docs) || [];
    const items = await Promise.all(docs.map(async (d) => {
      try {
        const meta = await getJSON(`https://archive.org/metadata/${encodeURIComponent(d.identifier)}/files`, 8000);
        const files = (meta.result || []).filter((f) => /mp3/i.test(f.format || '') || /\.mp3$/i.test(f.name));
        const creator = Array.isArray(d.creator) ? d.creator[0] : d.creator || '';
        return files
          .map((f) => ({
            id: `ia-${d.identifier}-${f.name}`,
            title: f.title || f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' '),
            artist: f.creator || f.artist || creator,
            provider: 'archive',
            providerLabel: 'Internet Archive',
            pageUrl: `https://archive.org/details/${d.identifier}`,
            fileUrl: `https://archive.org/download/${encodeURIComponent(d.identifier)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
            format: 'MP3',
            duration: iaLength(f.length),
            license: d.licenseurl ? licenseFromUrl(d.licenseurl) : 'Archive.org'
          }))
          .sort((a, b) => score(query, b.title, b.artist) - score(query, a.title, a.artist))
          .slice(0, 3);
      } catch { return []; }
    }));
    return items.flat();
  }
};
function licenseFromUrl(u) {
  const m = /licenses\/([a-z-]+)\/([\d.]+)/i.exec(u);
  if (m) return `CC ${m[1].toUpperCase()} ${m[2]}`;
  if (/publicdomain/i.test(u)) return 'Public Domain';
  return tm('seePage');
}

/* ------------------------------- ccMixter (CC remixes) ----------------------------- */
function mmss(v) { if (!v) return 0; const p = String(v).split(':').map(Number); return p.reduce((a, b) => a * 60 + b, 0); }
const ccmixter = {
  key: 'ccmixter', label: 'ccMixter',
  async search(query) {
    const data = await getJSON(`https://ccmixter.org/api/query?f=json&search=${encodeURIComponent(query)}&search_type=all&limit=20`);
    const out = [];
    for (const u of Array.isArray(data) ? data : []) {
      const f = (u.files || []).find((x) => /\.mp3$/i.test(x.download_url || x.file_name || ''));
      if (!f || !f.download_url) continue;
      out.push({
        id: 'cc-' + u.upload_id, title: u.upload_name, artist: u.user_real_name || u.user_name || '',
        provider: 'ccmixter', providerLabel: 'ccMixter', pageUrl: u.file_page_url || '',
        fileUrl: f.download_url.replace(/^http:/i, 'https:'), format: 'MP3',
        duration: mmss(f.file_format_info && f.file_format_info.ps), license: u.license_name || 'CC'
      });
    }
    return out;
  }
};

/* --------------------------- Jamendo (optional API key) ------------------------- */
const jamendo = {
  key: 'jamendo', label: 'Jamendo',
  enabled: (s) => !!(s && s.jamendoClientId),
  async search(query, s) {
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(s.jamendoClientId)}` +
      `&format=json&limit=20&audioformat=mp32&audiodownload_allowed=true&search=${encodeURIComponent(query)}`;
    const data = await getJSON(url);
    return (data.results || []).filter((t) => t.audiodownload || t.audio).map((t) => ({
      id: 'jm-' + t.id, title: t.name, artist: t.artist_name, provider: 'jamendo', providerLabel: 'Jamendo',
      pageUrl: t.shareurl || '', fileUrl: t.audiodownload || t.audio, format: 'MP3', duration: t.duration || 0,
      license: t.license_ccurl ? licenseFromUrl(t.license_ccurl) : 'CC'
    }));
  }
};

const PROVIDERS = [openverse, internetArchive, ccmixter, jamendo];

/**
 * Query all enabled providers in parallel; one slow/broken source never blocks the rest.
 * Returns { results, errors } — results de-duplicated by file URL and ranked by relevance.
 */
async function searchAll(query, settings = {}) {
  query = String(query || '').trim().slice(0, 200);
  if (query.length < 2) return { results: [], errors: [] };
  const active = PROVIDERS.filter((p) => (p.enabled ? p.enabled(settings) : true) &&
    !(settings.disabledProviders || []).includes(p.key));
  const alts = variants(query);
  const errors = [], seen = new Set(), results = [];
  const words = norm(alts[0]).split(' ').filter(Boolean).length;
  const relevantCount = () => results.filter((r) => r.score * (words + 4) >= Math.ceil(words / 2)).length;
  const tried = [];
  // 1st spelling always; the others (transliteration, layout repair) only if the first found little
  for (const q of alts) {
    if (tried.length && relevantCount() >= 6) break;
    tried.push(q);
    const settled = await Promise.allSettled(active.map((p) => p.search(q, settings)));
    settled.forEach((st, i) => {
      if (st.status === 'rejected') {
        if (!errors.some((e) => e.provider === active[i].label)) errors.push({ provider: active[i].label, message: String(st.reason && st.reason.message || st.reason) });
        return;
      }
      for (const r of st.value) {
        const key = norm(`${r.artist}|${r.title}`);
        if (!/^https:\/\//i.test(r.fileUrl) || seen.has(r.fileUrl) || seen.has(key)) continue;
        seen.add(r.fileUrl); seen.add(key);
        r.score = score(query, r.title, r.artist, alts);
        results.push(r);
      }
    });
  }
  // a provider that failed on one spelling but answered another is not an error
  // keep only results that actually match at least half of the query words
  const relevant = results.filter((r) => r.score * (words + 4) >= Math.ceil(words / 2));
  const list = relevant.length >= 3 ? relevant : results;
  list.sort((a, b) => b.score - a.score);
  return { results: list.slice(0, 40), errors, query: tried[0] !== query ? tried[0] : null, tried };
}

module.exports = { searchAll, PROVIDERS, score };
