/**
 * "Intelligence" layer — everything runs locally on the analysis already stored per track:
 *  - similarity between tracks (with human-readable reasons),
 *  - Smart Session: builds a queue for a mood / length / tempo with smooth transitions,
 *  - Library Health: stats, broken titles (mojibake), duplicates, quality.
 */
import { t as tr, tn } from './i18n.js';

/* ------------------------------- key helpers ------------------------------- */
const cam = (c) => (c ? { n: parseInt(c, 10), l: c.slice(-1) } : null);
/** harmonic compatibility on the Camelot wheel: same key 1, relative/adjacent ≈ .8, two steps .4 */
export function keyCompat(a, b) {
  const x = cam(a), y = cam(b);
  if (!x || !y) return null;
  const d = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  if (d === 0) return x.l === y.l ? 1 : 0.85;
  if (d === 1) return x.l === y.l ? 0.8 : 0.45;
  if (d === 2) return x.l === y.l ? 0.4 : 0.15;
  return 0;
}
/** tempo distance that tolerates half/double time */
function bpmClose(a, b) {
  if (!a || !b) return null;
  const r = Math.min(Math.abs(a - b), Math.abs(a - 2 * b), Math.abs(2 * a - b)) / Math.max(a, b);
  return Math.exp(-Math.pow(r / 0.07, 2));
}
const near = (a, b, span) => (a == null || b == null ? null : Math.max(0, 1 - Math.abs(a - b) / span));
const normTok = (s) => String(s || '').toLowerCase().split(/[,;/]/).map((x) => x.trim()).filter(Boolean);

export const analyzed = (t) => t && t.av === 2;

/** Similarity of b to a in 0..1 plus the reasons that made it similar. */
export function similarity(a, b) {
  const parts = [];
  const add = (w, v) => { if (v != null) parts.push([w, v]); };
  const sBpm = bpmClose(a.bpm, b.bpm), sKey = keyCompat(a.camelot, b.camelot);
  const sEnergy = near(a.energy, b.energy, 0.5), sBass = near(a.bass, b.bass, 0.6), sVocal = near(a.vocal, b.vocal, 0.6), sBright = near(a.bright, b.bright, 0.6);
  const sLoud = near(a.lufs, b.lufs, 10);
  const ga = normTok(a.genre), gb = normTok(b.genre);
  const sGenre = ga.length && gb.length ? (ga.some((g) => gb.includes(g)) ? 1 : 0) : null;
  add(0.22, sBpm); add(0.14, sKey); add(0.16, sEnergy); add(0.1, sBass); add(0.08, sVocal); add(0.1, sBright); add(0.06, sLoud); add(0.1, sGenre);
  add(0.04, a.artist && b.artist ? (a.artist === b.artist ? 1 : 0.3) : null);
  if (!parts.length) return { score: 0, reasons: [] };
  const wsum = parts.reduce((s, [w]) => s + w, 0);
  let score = parts.reduce((s, [w, v]) => s + w * v, 0) / wsum;
  // confidence: fewer known features → pull towards the middle
  score = score * Math.min(1, wsum / 0.6) + 0.35 * (1 - Math.min(1, wsum / 0.6));
  if (b.plays) score = Math.min(1, score + Math.min(0.04, b.plays * 0.01));

  const reasons = [];
  if (sBpm != null && sBpm > 0.6) reasons.push(tr('why.bpm', { a: Math.round(b.bpm), b: Math.round(a.bpm) }));
  if (sKey != null && sKey >= 0.8) reasons.push(a.camelot === b.camelot ? tr('why.keySame', { k: b.camelot }) : tr('why.keyNear', { a: b.camelot, b: a.camelot }));
  if (sEnergy != null && sEnergy > 0.8) reasons.push(tr('why.energy'));
  if (sBass != null && sBright != null && (sBass + sBright) / 2 > 0.8) reasons.push(tr('why.spectrum'));
  if (sGenre === 1) reasons.push(tr('why.genre', { g: gb.find((g) => ga.includes(g)) }));
  if (a.artist && a.artist === b.artist) reasons.push(tr('why.artist'));
  if (b.plays) reasons.push(tn('why.plays', b.plays));
  return { score, reasons };
}

export function findSimilar(seed, tracks, n = 12) {
  const key = (t) => `${t.title}|${t.artist}`.toLowerCase().trim();
  const seen = new Set([key(seed)]); // one entry per song: skip duplicates of the seed and of each other
  return tracks.filter((t) => t.id !== seed.id && t.path !== seed.path)
    .map((t) => ({ t, ...similarity(seed, t) }))
    .filter((x) => x.score > 0.45)
    .sort((x, y) => y.score - x.score)
    .filter((x) => { const k = key(x.t); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, n);
}

/* ------------------------------- smart session ------------------------------- */
export const MOODS = {
  calm: { target: { energy: 0.3, bright: 0.35, bass: 0.4, vocal: 0.4 }, minor: null, icon: 'calm' },
  deep: { target: { energy: 0.5, bright: 0.35, bass: 0.7, vocal: 0.35 }, minor: 0.6, icon: 'deep' },
  energetic: { target: { energy: 0.82, bright: 0.6, bass: 0.65, vocal: 0.5 }, minor: null, icon: 'energetic' },
  dark: { target: { energy: 0.45, bright: 0.22, bass: 0.6, vocal: 0.35 }, minor: 0.9, icon: 'dark' }
};
export function moodScore(t, mood) {
  const m = MOODS[mood];
  if (!analyzed(t)) return 0.35;
  let d = 0, w = 0;
  for (const [k, v] of Object.entries(m.target)) { const kw = k === 'energy' ? 2 : 1; d += kw * Math.abs((t[k] ?? 0.5) - v); w += kw; }
  let s = 1 - d / w;
  if (m.minor != null && t.keyMinor != null) s = s * 0.8 + 0.2 * (t.keyMinor ? m.minor : 1 - m.minor);
  return s;
}

/**
 * Build a session: rank by mood, keep within tempo & history rules, then order the picks
 * so each next track is the most similar to the previous one (smooth transitions).
 */
export function buildSession(tracks, opts) {
  const { mood, minutes, bpm = null, noRepeat = true, recent = [], artistCap = 2, seed = null } = opts;
  const target = minutes * 60;
  const recentSet = new Set(noRepeat ? recent.slice(-30) : []);
  let pool = tracks.filter((t) => t.duration > 30 && !recentSet.has(t.id));
  if (bpm) pool = pool.filter((t) => t.bpm && t.bpm >= bpm[0] && t.bpm <= bpm[1]);
  pool = pool.map((t) => ({ t, s: moodScore(t, mood) + Math.random() * 0.06 })).sort((a, b) => b.s - a.s);
  // candidate pool ≈ 1.6× the target length, best mood matches first
  const cand = [];
  let acc = 0;
  for (const p of pool) { cand.push(p); acc += p.t.duration; if (acc > target * 1.6 && cand.length > 6) break; }
  if (!cand.length) return { ids: [], total: 0 };

  const out = [];
  let cur = seed && cand.find((c) => c.t.id === seed.id) ? cand.find((c) => c.t.id === seed.id) : cand[0];
  if (seed && !cand.includes(cur)) cur = { t: seed, s: 1 };
  const used = new Set();
  let total = 0;
  while (cur && total < target) {
    out.push(cur.t); used.add(cur.t.id); total += cur.t.duration;
    const lastArtists = out.slice(-artistCap).map((t) => t.artist || '');
    const capHit = artistCap && lastArtists.length === artistCap && lastArtists.every((a) => a && a === lastArtists[0]);
    let best = null, bestV = -1;
    for (const c of cand) {
      if (used.has(c.t.id)) continue;
      if (capHit && c.t.artist === lastArtists[0]) continue;
      const v = c.s * 0.55 + similarity(cur.t, c.t).score * 0.45;
      if (v > bestV) { bestV = v; best = c; }
    }
    cur = best;
  }
  const bpms = out.filter((t) => t.bpm).map((t) => t.bpm);
  return { ids: out.map((t) => t.id), total, avgBpm: bpms.length ? Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length) : null };
}

/* ------------------------------- library health ------------------------------- */
const CYR = /[Ѐ-ӿ]/g;
/** "Ïðèâåò" → "Привет": cp1251 bytes that were read as Latin-1. Returns null when not applicable. */
export function fixMojibake(s) {
  if (!s || /[Ѐ-ӿ]/.test(s)) return null;
  const hi = (s.match(/[À-ÿ]/g) || []).length;
  if (hi < 3) return null;
  const bytes = new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  if ([...s].some((c) => c.charCodeAt(0) > 255)) return null;
  try {
    const out = new TextDecoder('windows-1251').decode(bytes);
    const letters = (out.match(/\p{L}/gu) || []).length || 1;
    return (out.match(CYR) || []).length / letters > 0.5 ? out : null;
  } catch { return null; }
}
/** obviously broken text: replacement chars, control chars, box-drawing, odd Latin-Extended mixes */
export function looksBroken(s) {
  if (!s) return false;
  if (/[�\u0000-\u001F─-▟]/.test(s)) return true;
  const ext = (s.match(/[ƀ-ɏɐ-ʯ]/g) || []).length;
  const sym = (s.match(/[^\p{L}\p{N}\s\-–—_.,'’"!?&()\[\]:;#+/]/gu) || []).length;
  return ext >= 2 || (s.length > 3 && sym / s.length > 0.25);
}
export function titleFromPath(p) {
  const base = String(p || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  const m = base.split(/\s[-–—]\s/);
  return m.length >= 2 ? { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() } : { artist: '', title: base };
}

const normTitle = (s) => String(s || '').toLowerCase()
  .replace(/\.(mp3|flac|wav|m4a|ogg)$/, '')
  .replace(/\((\d+|copy|копия|remaster(ed)?[^)]*|\d{4} remaster[^)]*)\)|\[[^\]]*\]/g, ' ')
  .replace(/\b(copy|копия|feat\.?|ft\.?)\b.*$/g, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function quality(t) {
  const c = String(t.codec || t.format || '').toLowerCase();
  if (t.lossless || /flac|alac|wav|pcm|aiff/.test(c)) return 'lossless';
  if (!t.bitrate) return 'unknown';
  if (t.bitrate >= 315) return 'q320';
  if (t.bitrate >= 250) return 'q256';
  if (t.bitrate >= 185) return 'q192';
  return 'qlow';
}
const qRank = { lossless: 5, q320: 4, q256: 3, q192: 2, qlow: 1, unknown: 0 };

export function healthReport(tracks, missing = new Set()) {
  const artists = new Set(), albums = new Set();
  let secs = 0, analyzedN = 0;
  const noCover = [], noArtist = [], broken = [], gone = [];
  const qual = { lossless: 0, q320: 0, q256: 0, q192: 0, qlow: 0, unknown: 0 };
  const groups = new Map();
  for (const t of tracks) {
    if (t.artist) artists.add(t.artist.toLowerCase());
    if (t.album) albums.add((t.artist + '|' + t.album).toLowerCase());
    secs += t.duration || 0;
    if (analyzed(t)) analyzedN++;
    if (!t.cover) noCover.push(t);
    if (!t.artist || !t.genre) noArtist.push(t);
    if (missing.has(t.id)) gone.push(t);
    qual[quality(t)]++;
    const fix = fixMojibake(t.title) || fixMojibake(t.artist);
    if (fix || looksBroken(t.title) || looksBroken(t.artist)) broken.push({ t, fixTitle: fixMojibake(t.title), fixArtist: fixMojibake(t.artist), fromFile: titleFromPath(t.path) });
    const k = normTitle(t.title) + '|' + normTitle(t.artist);
    if (normTitle(t.title).length > 1) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  }
  const dupes = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // split by duration (within 4 s) — same name but a different edit isn't a duplicate
    const sorted = [...g].sort((a, b) => (a.duration || 0) - (b.duration || 0));
    let cluster = [sorted[0]];
    const flush = () => { if (cluster.length > 1) dupes.push(rankGroup(cluster)); };
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs((sorted[i].duration || 0) - (cluster[0].duration || 0)) <= 4) cluster.push(sorted[i]);
      else { flush(); cluster = [sorted[i]]; }
    }
    flush();
  }
  return { count: tracks.length, artists: artists.size, albums: albums.size, secs, analyzed: analyzedN, noCover, noArtist, broken, gone, qual, dupes };
}
function rankGroup(g) {
  const sorted = [...g].sort((a, b) => (qRank[quality(b)] - qRank[quality(a)]) || ((b.bitrate || 0) - (a.bitrate || 0)) || ((b.size || 0) - (a.size || 0)));
  return { best: sorted[0], items: sorted };
}
