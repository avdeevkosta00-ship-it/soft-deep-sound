/**
 * LRC / plain lyrics → lines.
 *   [mm:ss.xx]text — one or several stamps per line; [offset:±ms] shifts everything;
 *   <mm:ss.xx> word stamps (enhanced LRC) are dropped; [ar:], [ti:]… headers are skipped.
 * Returns { synced, lines: [{ t, text }] } — t in seconds (null for plain lyrics).
 */
const STAMP = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;

export function parseLyrics(text) {
  const src = String(text || '').replace(/\r/g, '');
  if (/^\s*\[instrumental\]\s*$/i.test(src)) return { synced: false, instrumental: true, lines: [] };
  const out = [];
  let offset = 0, synced = false;
  for (const raw of src.split('\n')) {
    const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) { offset = +off[1] / 1000; continue; }
    if (/^\s*\[(ar|ti|al|au|by|length|re|ve|tool|#)\s*:/i.test(raw)) continue;
    const stamps = [...raw.matchAll(STAMP)];
    const body = raw.replace(STAMP, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim();
    if (stamps.length) {
      synced = true;
      for (const m of stamps) out.push({ t: +m[1] * 60 + parseFloat(m[2].replace(':', '.')), text: body });
    } else out.push({ t: null, text: raw.trim() });
  }
  if (synced) {
    // a positive offset means the words come earlier
    const lines = out.filter((l) => l.t != null).map((l) => ({ t: Math.max(0, l.t - offset), text: l.text })).sort((a, b) => a.t - b.t);
    return { synced: true, lines };
  }
  // plain text: keep stanza breaks, drop runs of empty lines and the ones at the edges
  const lines = out.filter((l, i, a) => l.text || (i > 0 && a[i - 1].text));
  while (lines.length && !lines[lines.length - 1].text) lines.pop();
  return { synced: false, lines };
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
