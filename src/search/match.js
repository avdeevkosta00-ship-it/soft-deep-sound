'use strict';
/**
 * Query helpers for web search (main process). Mirrors renderer/js/fuzzy.js:
 * Cyrillic/Latin transliteration, wrong-keyboard-layout repair, typo-tolerant word matching.
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

module.exports = { norm, latin, translit, layoutSwap, looksMistyped, score, clean, variants };
