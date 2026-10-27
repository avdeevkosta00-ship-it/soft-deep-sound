/**
 * Track names from file names, without the junk sites add:
 *   «1546698_Apoplexy»                         → Apoplexy
 *   «Bee_Hunter_-_Apoplexy_(zaycev.net)»        → Bee Hunter — Apoplexy
 *   «01. Artist - Song [320 kbps] (Official Audio)» → Artist — Song
 * Shared by the main process (import, lyrics lookup) and the renderer (Library health) —
 * main loads it with import(), so there is one copy of the rules.
 */
const TLD = 'ru|net|com|org|me|fm|cc|info|biz|su|ua|by|kz|io|to|club|pro|top|xyz|online|site|mobi|tv|in|co|cloud|live|music';
const SITE = new RegExp(`\\s*[\\[({]?\\s*(?:https?://)?(?:www\\.)?[\\p{L}\\p{N}-]+\\.(?:${TLD})\\b\\s*[\\])}]?`, 'giu');
const JUNK = '(?:official\\s*(?:music\\s*)?(?:audio|video|visualizer)|lyrics?(?:\\s*video)?|audio|hq|hd|\\d{2,3}\\s*kbps|kbps|mp3|flac|free\\s*download|скачать|бесплатно|music\\s*video|visualizer|премьера(?:\\s*(?:трека|клипа))?|клип)';
// \b only knows Latin letters, so word edges are spelled out to work for Cyrillic too
const L = '(?<![\\p{L}\\p{N}])', R = '(?![\\p{L}\\p{N}])';
const JUNK_BRACKET = new RegExp(`\\s*[\\[({][^\\])}]*${L}${JUNK}${R}[^\\])}]*[\\])}]`, 'giu');
// at the very end, outside brackets: words that are never a real title go on their own; ambiguous ones
// (audio, lyrics, hd, клип…) only after a spaced dash or bar — «Song - Lyrics» yes, «not-audio», «Video Killed…» no
const SURE = '(?:official\\s*(?:music\\s*)?(?:audio|video|visualizer)|\\d{2,3}\\s*kbps|free\\s*download|скачать|бесплатно|премьера(?:\\s*(?:трека|клипа))?)';
const JUNK_TAIL = new RegExp(`(?:\\s*[-–—|]?\\s*${L}${SURE}|\\s+[-–—|]\\s*${L}${JUNK})\\s*$`, 'iu');

/** site names, ids and «official audio»-style junk out of one name (a tag value or a whole file name) */
export function stripJunk(raw) {
  let s = String(raw || '').replace(/\.(mp3|flac|wav|ogg|oga|opus|m4a|aac|webm)$/i, '');
  s = s.replace(/_+/g, ' ').replace(/\s*\+\s*/g, ' ');          // Bee_Hunter_-_Apoplexy, Song+Name
  s = s.replace(SITE, ' ').replace(JUNK_BRACKET, ' ');
  for (let i = 0; i < 2; i++) s = s.replace(JUNK_TAIL, '');
  return tidy(s);
}
/** download ids and track numbers at the edges of one part of a name */
function tidy(s) {
  return s.replace(/^\s*\d{4,}\s*[-.\s]+(?=\S)/u, '')            // 1546698_Apoplexy (download ids)
    .replace(/^\s*\d{1,3}\s*(?:[.)]|\s[-–—])\s+/u, '')           // 01. Song, 1) Song, 01 - Song
    .replace(/\s*[-(\[]?\s*\b\d{5,}\b\s*[)\]]?\s*$/u, '')       // Song_8812734
    .replace(/\s*\(\d\)\s*$/u, '')                               // Song (1) — a browser's copy
    .replace(/\s{2,}/g, ' ').replace(/^[\s\-–—.,|]+|[\s\-–—.,|]+$/g, '').trim();
}

/** a file name → { artist, title } («Artist - Title» is split; the title is tidied again on its own) */
export function cleanName(raw) {
  const s = stripJunk(raw);
  const parts = s.split(/\s[-–—]\s/);
  const out = parts.length >= 2 ? { artist: parts[0].trim(), title: tidy(parts.slice(1).join(' - ')) } : { artist: '', title: s };
  if (!out.title) return { artist: '', title: String(raw || '').trim() };
  return out;
}

/** true when the name still carries download junk that cleanName would remove */
export function isMessy(title, artist) {
  const full = (artist ? artist + ' - ' : '') + String(title || '');
  const c = cleanName(full);
  return !!title && (c.title !== String(title).trim() || (!!c.artist && c.artist !== String(artist || '').trim()));
}
