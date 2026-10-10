/**
 * Track analysis worker: waveform peaks for the seek bar + tempo (BPM) estimation.
 *
 * Tempo: onset-strength envelope (log energy flux of a low band + a high band, 10 ms hop)
 *  → autocorrelation over 55–200 BPM lags, reinforced by 2× and 3× multiples (comb),
 *  → weighted by a log-normal tempo prior around 120 BPM (reduces half/double errors),
 *  → parabolic interpolation for sub-frame precision, then folded into 70–180 BPM.
 * Beat phase: the offset that maximises the onset sum on the beat grid.
 */
self.onmessage = (e) => {
  const { id, channels, sampleRate } = e.data;
  try {
    const mono = mix(channels);
    const peaks = computePeaks(mono, 480);
    const tempo = detectTempo(mono, sampleRate);
    const extra = analyzeSound(channels, mono, sampleRate, tempo);
    self.postMessage({ id, peaks, ...tempo, ...extra, av: 2 });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};

function mix(chs) {
  if (chs.length === 1) return chs[0];
  const n = chs[0].length, out = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) out[i] += c[i];
  const k = 1 / chs.length;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

function computePeaks(x, bins) {
  const out = new Array(bins).fill(0);
  const step = x.length / bins;
  let gmax = 1e-9;
  for (let b = 0; b < bins; b++) {
    const s = Math.floor(b * step), e = Math.floor((b + 1) * step);
    let m = 0, sq = 0;
    for (let i = s; i < e; i += 4) { const v = Math.abs(x[i]); if (v > m) m = v; sq += v * v; }
    const rms = Math.sqrt(sq / Math.max(1, (e - s) / 4));
    out[b] = m * .35 + rms * .65 * 1.6;
    if (out[b] > gmax) gmax = out[b];
  }
  return out.map((v) => Math.round(Math.min(1, v / gmax) * 100));
}

function detectTempo(x, sr) {
  const hop = Math.round(sr * 0.01);
  const hopSec = hop / sr;
  // analyse up to 150 s, skipping the intro when the track is long enough
  const start = x.length / sr > 60 ? Math.floor(Math.min(20 * sr, x.length * .1)) : 0;
  const end = Math.min(x.length, start + 150 * sr);
  const frames = Math.floor((end - start) / hop);
  if (frames < 400) return { bpm: null, confidence: 0, offset: 0 };

  const aLo = 1 - Math.exp(-2 * Math.PI * 180 / sr);
  const aHi = 1 - Math.exp(-2 * Math.PI * 2500 / sr);
  let lo1 = 0, lo2 = 0, hi = 0;
  const eLo = new Float32Array(frames), eHi = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sl = 0, sh = 0;
    const s0 = start + f * hop;
    for (let i = 0; i < hop; i++) {
      const v = x[s0 + i];
      lo1 += aLo * (v - lo1); lo2 += aLo * (lo1 - lo2);
      hi += aHi * (v - hi);
      const h = v - hi;
      sl += lo2 * lo2; sh += h * h;
    }
    eLo[f] = Math.log1p(sl * 1000);
    eHi[f] = Math.log1p(sh * 1000);
  }
  // onset strength = half-wave rectified flux, minus local mean
  const on = new Float32Array(frames);
  for (let f = 1; f < frames; f++) on[f] = Math.max(0, eLo[f] - eLo[f - 1]) + .6 * Math.max(0, eHi[f] - eHi[f - 1]);
  const W = 25;
  const cs = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) cs[f + 1] = cs[f] + on[f];
  const o = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = Math.max(0, f - W), b = Math.min(frames, f + W + 1);
    o[f] = Math.max(0, on[f] - (cs[b] - cs[a]) / (b - a));
  }

  const minLag = Math.floor(60 / 200 / hopSec), maxLag = Math.ceil(60 / 55 / hopSec);
  const acLen = maxLag * 3 + 2;
  const ac = new Float32Array(acLen);
  for (let L = 1; L < acLen; L++) {
    let s = 0;
    for (let f = 0; f + L < frames; f++) s += o[f] * o[f + L];
    ac[L] = s / (frames - L);
  }
  const score = new Float32Array(maxLag + 2);
  let best = minLag, bestV = -1, sum = 0, cnt = 0;
  for (let L = minLag; L <= maxLag; L++) {
    const comb = ac[L] + .5 * ac[2 * L] + .25 * ac[3 * L];
    const bpm = 60 / (L * hopSec);
    const prior = Math.exp(-.5 * Math.pow(Math.log2(bpm / 120) / .9, 2));
    score[L] = comb * prior;
    sum += score[L]; cnt++;
    if (score[L] > bestV) { bestV = score[L]; best = L; }
  }
  // parabolic interpolation around the peak
  let lag = best;
  const y0 = score[best - 1] || 0, y1 = score[best], y2 = score[best + 1] || 0;
  const den = y0 - 2 * y1 + y2;
  if (den < 0) lag = best + .5 * (y0 - y2) / den;
  let bpm = 60 / (lag * hopSec);
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;

  const mean = sum / cnt;
  let varr = 0;
  for (let L = minLag; L <= maxLag; L++) varr += (score[L] - mean) ** 2;
  const sd = Math.sqrt(varr / cnt) || 1e-9;
  const confidence = Math.max(0, Math.min(1, ((bestV - mean) / sd - 1.5) / 3));

  // beat phase on the grid
  const P = 60 / bpm / hopSec;
  let bestPh = 0, bestS = -1;
  for (let ph = 0; ph < P; ph += 1) {
    let s = 0;
    for (let t = ph; t < frames; t += P) s += o[Math.round(t)] || 0;
    if (s > bestS) { bestS = s; bestPh = ph; }
  }
  const offset = (start / sr) + bestPh * hopSec;
  return { bpm: Math.round(bpm * 10) / 10, confidence, offset };
}


/* ===================================================================================
 * v2 analysis: key, loudness (LUFS, BS.1770 K-weighting with gating), peak-to-loudness,
 * and a few "character" descriptors (energy, bass, vocal-band, brightness).
 * All of it runs on the 22 kHz decode, which is plenty for these measurements.
 * =================================================================================== */
const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const CAMELOT_MAJ = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MIN = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
// Krumhansl–Kessler key profiles
const P_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const P_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

function corr(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; n += x * y; da += x * x; db += y * y; }
  return n / Math.sqrt(da * db || 1);
}

function biquad(x, sr, type, f0, Q, gainDb = 0) {
  const A = Math.pow(10, gainDb / 40), w = 2 * Math.PI * f0 / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'highshelf') {
    const sq = 2 * Math.sqrt(A) * al;
    b0 = A * ((A + 1) + (A - 1) * cs + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sq);
    a0 = (A + 1) - (A - 1) * cs + sq; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sq;
  } else { // highpass
    b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
  }
  const out = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}

/** Integrated loudness, ITU-R BS.1770-4 (400 ms blocks, 75 % overlap, −70 LUFS absolute & −10 LU relative gates). */
function loudness(channels, sr) {
  const kw = channels.map((c) => biquad(biquad(c, sr, 'highshelf', 1681.97, 0.7072, 3.99984), sr, 'highpass', 38.1355, 0.5003));
  const block = Math.round(0.4 * sr), hop = Math.round(0.1 * sr), n = kw[0].length;
  const ms = [];
  for (let s = 0; s + block <= n; s += hop) {
    let z = 0;
    for (const c of kw) { let a = 0; for (let i = s; i < s + block; i++) a += c[i] * c[i]; z += a / block; }
    ms.push(z);
  }
  const L = (z) => -0.691 + 10 * Math.log10(z || 1e-12);
  const abs = ms.filter((z) => L(z) > -70);
  if (!abs.length) return -70;
  const relGate = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((z) => L(z) > relGate);
  return L(rel.reduce((a, b) => a + b, 0) / (rel.length || 1));
}

function analyzeSound(channels, mono, sr, tempo) {
  const out = {};
  // --- loudness & peak
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > peak) peak = v; }
  out.lufs = Math.round(loudness(channels, sr) * 10) / 10;
  const peakDb = 20 * Math.log10(peak || 1e-9);
  out.peakDb = Math.round(peakDb * 10) / 10;
  out.plr = Math.round((peakDb - out.lufs) * 10) / 10;

  // --- spectrum: chroma + band energies (frames from the middle 120 s)
  const N = 4096, hop = 4096;
  const start = mono.length > sr * 150 ? Math.floor((mono.length - sr * 120) / 2) : 0;
  const end = Math.min(mono.length, start + sr * 120);
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  const chroma = new Float64Array(12);
  let eLow = 0, eMid = 0, eHigh = 0, eAll = 1e-12, cNum = 0, cDen = 1e-12;
  const hz = sr / N;
  const pcOfBin = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) { const f = k * hz; if (f >= 55 && f <= 2000) pcOfBin[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12; }
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s = start; s + N <= end; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = mono[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k], f = k * hz;
      eAll += p; cNum += f * p; cDen += p;
      if (f < 250) eLow += p; else if (f >= 300 && f <= 3400) eMid += p; else if (f >= 4000) eHigh += p;
      if (pcOfBin[k] >= 0) chroma[pcOfBin[k]] += Math.log1p(p * 1e4);
    }
  }
  // key: best correlation of chroma with the 24 rotated profiles
  let best = { r: -2, tonic: 0, minor: false }, second = -2;
  for (let t = 0; t < 12; t++) {
    const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + t) % 12]);
    for (const [prof, minor] of [[P_MAJ, false], [P_MIN, true]]) {
      const r = corr(rot, prof);
      if (r > best.r) { second = best.r; best = { r, tonic: t, minor }; } else if (r > second) second = r;
    }
  }
  out.key = NOTES[best.tonic] + (best.minor ? ' minor' : ' major');
  out.keyTonic = best.tonic; out.keyMinor = best.minor;
  out.camelot = (best.minor ? CAMELOT_MIN : CAMELOT_MAJ)[best.tonic];
  out.keyConf = Math.max(0, Math.min(1, (best.r - second) * 6 + best.r * .5));

  // --- character (0..1)
  const share = (e) => e / eAll;
  out.bass = clamp01((share(eLow) - 0.15) / 0.6);
  out.vocal = clamp01((share(eMid) - 0.08) / 0.45);
  const centroid = cNum / cDen;
  out.bright = clamp01((Math.log2(centroid / 400)) / 3.2);
  const loudN = clamp01((out.lufs + 28) / 20);
  const tempoN = tempo && tempo.bpm ? clamp01((tempo.bpm - 70) / 90) : 0.4;
  out.energy = Math.round((loudN * 0.55 + tempoN * 0.25 + out.bright * 0.2) * 100) / 100;
  for (const k of ['bass', 'vocal', 'bright']) out[k] = Math.round(out[k] * 100) / 100;
  return out;
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
