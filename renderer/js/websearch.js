/**
 * Web search in open sources — Openverse, Internet Archive, ccMixter, Jamendo (with the user's key).
 * Shared by the desktop (main.js imports it, fetching through src/search/http.js) and the Android app
 * (bridge.js, fetching through Capacitor's native HTTP): one copy of the providers and of the matching rules.
 *
 * Every provider implements:  search(query, settings) -> Promise<Result[]>
 *   Result = { id, title, artist, provider, providerLabel, pageUrl, fileUrl, format, duration, license }
 *
 * Only sources with an open API and clear licensing (CC / public domain / artist-approved downloads)
 * are queried. To add a source, write one more object with the same shape and register it below.
 *
 * Query helpers: Cyrillic/Latin transliteration, wrong-keyboard-layout repair, typo-tolerant word matching
 * (mirrors renderer/js/fuzzy.js).
 */
const RU = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const EN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU_KEYS = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const toRu = Object.fromEntries([...EN_KEYS].map((c, i) => [c, RU_KEYS[i]]));
const toEn = Object.fromEntries([...RU_KEYS].map((c, i) => [c, EN_KEYS[i]]));

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ё/g, 'е')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const translit = (s) => [...norm(s)].map((c) => (RU[c] !== undefined ? RU[c] : c)).join('');
const latin = (s) => translit(s)
  .replace(/kh/g, 'h').replace(/ck/g, 'k').replace(/ph/g, 'f').replace(/w/g, 'v').replace(/x/g, 'ks').replace(/q/g, 'k')
  .replace(/j/g, 'y').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/(.)\1+/g, '$1');
const hasCyr = (s) => /[а-яё]/i.test(s);

function layoutSwap(q) {
  const s = String(q).toLowerCase();
  const cyr = (s.match(/[а-яё]/g) || []).length, lat = (s.match(/[a-z]/g) || []).length;
  if (!cyr && !lat) return null;
  const map = cyr > lat ? toEn : toRu;
  const out = [...s].map((c) => map[c] || c).join('');
  return out === s ? null : out;
}
/** a string typed in the wrong layout has almost no vowels (or Russian letters' keys like [ ; ' , .) */
function looksMistyped(q) {
  const raw = String(q).toLowerCase();
  if (/[a-z]/.test(raw) && /[\[\];',.`]/.test(raw.replace(/[.,]\s|[.,]$/g, ''))) return true;
  const words = norm(raw).split(' ').filter((w) => w.length >= 4);
  if (!words.length) return false;
  const ratio = (w) => (w.match(/[aeiouyаеёиоуыэюя]/g) || []).length / w.length;
  return words.filter((w) => ratio(w) < .2).length >= Math.ceil(words.length / 2);
}

function dist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) { const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); cur.push(v); if (v < best) best = v; }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
function wordHit(w, words, whole) {
  let best = 0;
  for (const x of words) {
    if (x === w) return 1;
    if (x.startsWith(w)) best = Math.max(best, .85);
    else if (w.length >= 3 && x.includes(w)) best = Math.max(best, .7);
    else if (best < .55) { const k = w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0; if (k && dist(w, x, k) <= k) best = .55; }
  }
  if (best < .7 && w.length >= 4 && whole.includes(w)) best = .7;
  return best;
}

/** relevance 0…1 of a result to the query */
function score(query, title, artist) {
  const q = latin(query).split(' ').filter(Boolean);
  if (!q.length) return 0;
  const hay = latin(`${artist} ${title}`), t = latin(title), words = hay.split(' ').filter(Boolean), whole = hay.replace(/ /g, '');
  let s = 0;
  for (const w of q) s += wordHit(w, words, whole);
  const phrase = q.join(' ');
  if (hay.includes(phrase)) s += 2;
  if (t === phrase) s += 2;
  if (/\b(sample|loop|sfx|jingle|ringtone)\b/.test(t)) s -= 1.5;
  return s / (q.length + 4);
}

/** strip what people type out of habit but sources never have in titles */
const NOISE = /\b(official|video|music video|lyrics?|lyric video|audio|hq|hd|4k|mp3|flac|320 ?kbps|download|free download|full album|скачать|бесплатно|слушать|онлайн|без регистрации|текст песни|клип)\b/gi;
function clean(q) {
  return String(q).replace(/[([{][^)\]}]*(official|video|lyric|audio|клип)[^)\]}]*[)\]}]/gi, ' ')
    .replace(NOISE, ' ').replace(/\b(feat|ft)\.?\s/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** spellings worth trying: cleaned query, then wrong-layout repair and transliteration as fallbacks */
function variants(query) {
  const base = clean(query) || String(query).trim();
  const out = [base];
  const sw = layoutSwap(base);
  if (sw && looksMistyped(base)) out.unshift(sw); // clearly mistyped: the repaired spelling goes first
  if (hasCyr(base)) out.push(translit(base));
  return [...new Set(out.filter((x) => x && x.length >= 2))].slice(0, 3);
}

const matchScore = score;

/**
 * @param getJSON (url, timeoutMs) => parsed JSON; throws on HTTP errors
 * @param tm      the UI-language string for a key ('untitled', 'seePage')
 */
/**
 * Promise.allSettled that does not wait forever for one slow source: once some source has found something
 * that really matches the query, the rest get 8 more seconds (Openverse can take 15 s on a query it has not seen).
 * A quick source answering with loose matches (Jamendo's genre tags) does not start the clock, or it would cut off
 * the source that has the real thing (Internet Archive needs a few seconds).
 */
function settleSoon(promises, useful = (v) => v.length > 0, grace = 8000) {
  return new Promise((resolve) => {
    const out = new Array(promises.length);
    let left = promises.length, timer = null;
    const done = () => { clearTimeout(timer); resolve(out.map((r) => r || { status: 'rejected', reason: new Error('timeout') })); };
    if (!left) return done();
    promises.forEach((p, i) => Promise.resolve(p).then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason })).then((r) => {
      if (out[i] || !timer && !left) return;
      out[i] = r;
      if (--left === 0) return done();
      if (!timer && r.status === 'fulfilled' && useful(r.value)) timer = setTimeout(done, grace);
    }));
  });
}

export function createWebSearch({ getJSON, tm }) {
  /** best relevance over all spellings of the query that were tried */
  const score = (query, title, artist, alts = [query]) => Math.max(...alts.map((q) => matchScore(q, title, artist)));
  const AUDIO_RE = /\.(mp3|ogg|oga|flac|wav|m4a|opus)(\?|$)/i;

  /* ----------------------------- Openverse (CC audio) ---------------------------- */
  const openverse = {
    key: 'openverse', label: 'Openverse',
    async search(query) {
      // music only (no sound effects / podcasts), with tags & titles weighted by Openverse itself;
      // anonymous clients get at most 20 per page (asking for more is answered with 401)
      const data = await getJSON(`https://api.openverse.org/v1/audio/?q=${encodeURIComponent(query)}&category=music&page_size=20`, 16000); // a query it has not seen before can take it 10 s+
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
      // f=js: the same JSON as f=json, without f=json's copy of the whole answer in an X-JSON header (16 KB+, too big for Node)
      const data = await getJSON(`https://ccmixter.org/api/query?f=js&search=${encodeURIComponent(query)}&search_type=all&limit=20`);
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
      const base = `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(s.jamendoClientId)}&format=json&limit=30&audioformat=mp32`;
      const ask = async (params) => {
        const data = await getJSON(base + params);
        // Jamendo reports errors (a bad key, a limit) inside a 200 answer
        if (data && data.headers && data.headers.status === 'failed') throw new Error('jamendo: ' + (data.headers.error_message || 'failed'));
        return (data && data.results) || [];
      };
      let list = await ask(`&order=relevance&search=${encodeURIComponent(query)}`);
      // its text search wants every word in the name («chill hip hop» finds nothing): a mood or genre query
      // goes on by tags, most listened first
      if (list.length < 8) {
        const tags = norm(query).replace(/(^| )hip hop( |$)/g, '$1hiphop$2').replace(/(^| )lo fi( |$)/g, '$1lofi$2').replace(/(^| )chill( |$)/g, '$1chillout$2').split(' ').filter((w) => w.length > 2).slice(0, 4);
        if (tags.length) {
          const have = new Set(list.map((t) => t.id));
          const add = (more) => { for (const t of more) if (!have.has(t.id)) { have.add(t.id); list.push(t); } };
          add(await ask(`&order=popularity_total&fuzzytags=${tags.map(encodeURIComponent).join('+')}`).catch(() => []));
          // all the tags together found little: each on its own, the longest words first
          if (tags.length > 1) for (const tag of [...tags].sort((x, y) => y.length - x.length).slice(0, 2)) {
            if (list.length >= 8) break;
            add(await ask(`&order=popularity_total&fuzzytags=${encodeURIComponent(tag)}`).catch(() => []));
          }
        }
      }
      return list.filter((t) => t.audio).map((t) => ({
        id: 'jm-' + t.id, title: t.name, artist: t.artist_name, provider: 'jamendo', providerLabel: 'Jamendo',
        pageUrl: t.shareurl || '', streamUrl: t.audio, cover: /^https:/.test(t.image || '') ? t.image : '',
        // downloadable only where the artist allowed it; listening is allowed for the whole catalogue
        fileUrl: t.audiodownload_allowed && t.audiodownload ? t.audiodownload : '', format: 'MP3', duration: t.duration || 0,
        album: t.album_name || '', license: t.license_ccurl ? licenseFromUrl(t.license_ccurl) : 'CC'
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
      const settled = await settleSoon(active.map((p) => p.search(q, settings)), (list) => list.some((r) => score(query, r.title, r.artist, alts) * (words + 4) >= Math.ceil(words / 2)));
      settled.forEach((st, i) => {
        if (st.status === 'rejected') {
          if (!errors.some((e) => e.provider === active[i].label)) errors.push({ provider: active[i].label, message: String(st.reason && st.reason.message || st.reason) });
          return;
        }
        for (const r of st.value) {
          const key = norm(`${r.artist}|${r.title}`);
          r.streamUrl = r.streamUrl || r.fileUrl;
          if (!/^https:\/\//i.test(r.streamUrl) || seen.has(r.streamUrl) || seen.has(key)) continue;
          seen.add(r.streamUrl); seen.add(key);
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

  return { searchAll, PROVIDERS, score };
}

export { norm, latin, translit, layoutSwap, looksMistyped, score, clean, variants };
