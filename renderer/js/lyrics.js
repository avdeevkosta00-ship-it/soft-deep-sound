/**
 * LRC / plain lyrics → lines.
 *   [mm:ss.xx]text — one or several stamps per line; [offset:±ms] shifts everything;
 *   enhanced LRC: <mm:ss.xx> before a word times that word (karaoke) — kept as `words`;
 *   [ar:], [ti:]… headers are skipped.
 * Returns { synced, karaoke, lines: [{ t, text, words? }] } — t in seconds (null for plain lyrics);
 * words: [{ t, w }] when the line has word timings.
 */
const STAMP = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const WORD = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;
const secs = (m, s) => +m * 60 + parseFloat(String(s).replace(':', '.'));

/** «<00:12.10>Тем, <00:12.60>кто…» → [{ t: 12.1, w: 'Тем, ' }, …] (text before the first stamp starts at the line time) */
function wordsOf(raw, lineT) {
  const marks = [...raw.matchAll(WORD)];
  if (!marks.length) return null;
  const out = [];
  const head = raw.slice(0, marks[0].index).replace(STAMP, '');
  if (head.trim()) out.push({ t: lineT, w: head });
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : raw.length;
    const w = raw.slice(m.index + m[0].length, end);
    if (w) out.push({ t: secs(m[1], m[2]), w });
  });
  return out.length ? out : null;
}

export function parseLyrics(text) {
  const src = String(text || '').replace(/\r/g, '');
  if (/^\s*\[instrumental\]\s*$/i.test(src)) return { synced: false, instrumental: true, lines: [] };
  const out = [];
  let offset = 0, synced = false, karaoke = false;
  for (const raw of src.split('\n')) {
    const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) { offset = +off[1] / 1000; continue; }
    if (/^\s*\[(ar|ti|al|au|by|length|re|ve|tool|#)\s*:/i.test(raw)) continue;
    const stamps = [...raw.matchAll(STAMP)];
    const body = raw.replace(STAMP, '').replace(WORD, '').replace(/\s+/g, ' ').trim();
    if (stamps.length) {
      synced = true;
      for (const m of stamps) {
        const t = secs(m[1], m[2]), words = wordsOf(raw.replace(STAMP, ''), t);
        if (words) karaoke = true;
        out.push({ t, text: body, words });
      }
    } else out.push({ t: null, text: raw.trim() });
  }
  if (synced) {
    // a positive offset means the words come earlier
    const lines = out.filter((l) => l.t != null).map((l) => ({ t: Math.max(0, l.t - offset), text: l.text,
      words: l.words && l.words.map((w) => ({ t: Math.max(0, w.t - offset), w: w.w })) })).sort((a, b) => a.t - b.t);
    return { synced: true, karaoke, lines };
  }
  // plain text: keep stanza breaks, drop runs of empty lines and the ones at the edges
  const lines = out.filter((l, i, a) => l.text || (i > 0 && a[i - 1].text));
  while (lines.length && !lines[lines.length - 1].text) lines.pop();
  return { synced: false, karaoke: false, lines };
}

/** index of the line being sung at `time` (−1 before the first one) */
export function lineAt(lines, time) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= time + .15) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** how far the singer is through a karaoke line: index of the current word and 0..1 inside it */
export function wordAt(line, time, nextT) {
  const ws = line.words;
  if (!ws || !ws.length) return null;
  let i = -1;
  for (let k = 0; k < ws.length; k++) if (ws[k].t <= time) i = k;
  if (i < 0) return { i: -1, p: 0 };
  const end = i + 1 < ws.length ? ws[i + 1].t : (nextT ?? ws[i].t + 1);
  return { i, p: Math.max(0, Math.min(1, (time - ws[i].t) / Math.max(.05, end - ws[i].t))) };
}
