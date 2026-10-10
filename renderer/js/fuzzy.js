/**
 * Smarter local search.
 *  • every query word must be found, but a word can match by prefix, inside a word,
 *    across a missing space ("silentboy"), or with a typo (1–2 letters off, by length);
 *  • Cyrillic and Latin meet in the middle: both sides are transliterated, so «кино» finds "Kino"
 *    and "bladi" finds «Блади»;
 *  • a query typed in the wrong keyboard layout ("ьфвщттф" → «madonna») is tried too;
 *  • ranking: exact > prefix > inside > typo, title > artist > album > genre > file name,
 *    plus a small bonus for the whole phrase and for tracks you actually play.
 */
const RU = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'i', є: 'e', ґ: 'g' };
const EN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU_KEYS = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const toRu = Object.fromEntries([...EN_KEYS].map((c, i) => [c, RU_KEYS[i]]));
const toEn = Object.fromEntries([...RU_KEYS].map((c, i) => [c, EN_KEYS[i]]));

export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ё/g, 'е')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** a single Latin "spelling" for comparing Russian and English text; doubled letters and soft variants collapse */
export const latin = (s) => [...norm(s)].map((c) => (RU[c] !== undefined ? RU[c] : c)).join('')
  .replace(/kh/g, 'h').replace(/ck/g, 'k').replace(/ph/g, 'f').replace(/w/g, 'v').replace(/x/g, 'ks').replace(/q/g, 'k')
  .replace(/j/g, 'y').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/ee/g, 'i').replace(/oo/g, 'u')
  .replace(/(.)\1+/g, '$1');

/** the same keystrokes in the other layout, or null if that makes no sense */
export function layoutSwap(q) {
  const s = String(q).toLowerCase();
  const cyr = (s.match(/[а-яё]/g) || []).length, lat = (s.match(/[a-z]/g) || []).length;
  if (!cyr && !lat) return null;
  const map = cyr > lat ? toEn : toRu;
  const out = [...s].map((c) => map[c] || c).join('');
  return out === s ? null : out;
}

/** Damerau–Levenshtein distance with an early exit above `max` */
function dist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length, m = b.length;
  let p2 = null, p1 = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= m; j++) {
      let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (p2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2] + 1);
      cur.push(v); if (v < best) best = v;
    }
    if (best > max) return max + 1;
    p2 = p1; p1 = cur;
  }
  return p1[m];
}
const typoBudget = (len) => (len >= 8 ? 2 : len >= 4 ? 1 : 0);

const FIELDS = [['title', 1], ['artist', .9], ['album', .6], ['genre', .4], ['file', .3]];
const cache = new WeakMap();
function indexOf(t) {
  const file = String(t.path || '').split(/[\\/]/).pop().replace(/\.\w+$/, '');
  const sig = `${t.title}|${t.artist}|${t.album}|${t.genre}|${file}`;
  const c = cache.get(t);
  if (c && c.sig === sig) return c;
  const src = { title: t.title, artist: t.artist, album: t.album, genre: t.genre, file };
  const f = {};
  for (const [k] of FIELDS) {
    const l = latin(src[k]);
    f[k] = { whole: l.replace(/ /g, ''), words: l.split(' ').filter(Boolean), raw: norm(src[k]) };
  }
  const v = { sig, f };
  cache.set(t, v);
  return v;
}

/** how well one query word matches one field (0…1) */
function wordScore(w, field) {
  let best = 0;
  for (const x of field.words) {
    if (x === w) return 1;
    if (x.startsWith(w)) best = Math.max(best, w.length >= 2 ? .9 : .6);
    else if (w.length >= 3 && x.includes(w)) best = Math.max(best, .7);
    else if (best < .55) {
      const k = typoBudget(w.length);
      if (k && (dist(w, x, k) <= k || (x.length > w.length && dist(w, x.slice(0, w.length), k) <= k))) best = .55;
    }
  }
  if (best < .7 && w.length >= 4 && field.whole.includes(w)) best = .7; // "silentboy"
  return best;
}

function scoreTrack(t, words, phrase) {
  const ix = indexOf(t);
  let total = 0, missed = 0;
  for (const w of words) {
    let b = 0;
    for (const [k, wt] of FIELDS) { const s = wordScore(w, ix.f[k]) * wt; if (s > b) b = s; }
    if (!b) missed++;
    total += b;
  }
  if (missed > (words.length >= 4 ? 1 : 0)) return 0;
  const title = ix.f.title.words.join(' ');
  if (phrase.length > 2) {
    if (title.startsWith(phrase)) total += 1.2;
    else if (title.includes(phrase)) total += .8;
    else if (ix.f.artist.words.join(' ').startsWith(phrase)) total += .6;
  }
  total += Math.min(.4, Math.log10(1 + (t.plays || 0)) * .2);
  return total;
}

/** returns { list, via } — `via` is the alternative spelling that worked (wrong keyboard layout), or null */
export function search(tracks, q, limit = 200) {
  const run = (query) => {
    const phrase = latin(query), words = phrase.split(' ').filter(Boolean);
    if (!words.length) return [];
    const out = [];
    for (const t of tracks) { const s = scoreTrack(t, words, phrase); if (s > 0) out.push([s, t]); }
    return out.sort((a, b) => b[0] - a[0]);
  };
  const main = run(q);
  const alt = layoutSwap(q);
  let via = null, res = main;
  if (alt) {
    const other = run(alt);
    // prefer the swapped layout only when it is clearly the better reading
    if (other.length && (!main.length || other[0][0] > main[0][0] * 1.4)) { res = other; via = alt; }
  }
  return { list: res.slice(0, limit).map((x) => x[1]), via };
}
