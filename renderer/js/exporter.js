/**
 * Export of a track "as you hear it": Sound Pitcher + Equalizer + Ambient Generator (with Smart Duck)
 * rendered offline (faster than real time) and encoded to WAV (16-bit) or MP3 (320 kbps, LAME in a worker).
 *
 *   decode ─► BufferSource (varispeed in Vinyl mode) ─► PitchShifter ─► EQ ×10 ─► preamp ─┬─► out
 *   ambient layers (looped) ─► bus ─► tone ─► duck (envelope precomputed from the vocal band) ─┘
 */
import { EQ_FREQS } from './audio-engine.js';
import { LAYERS } from './ambient.js';

const workletURL = new URL('./pitch-worklet.js', import.meta.url);
const lameURL = new URL('../vendor/lame.min.js', import.meta.url);

/** Snapshot of everything that colours the sound right now. */
export function captureState(engine, ambient) {
  const ratio = engine.pitchOn ? engine.pitchRatio : 1;
  const pitch = { ratio, vinyl: !!engine.vinyl, semis: engine.semitones, cents: engine.cents, active: Math.abs(ratio - 1) > 1e-4 };
  const eqActive = engine.eqOn && (engine.eqGains.some((g) => Math.abs(g) > .01) || Math.abs(engine.eqPre) > .01);
  const eq = { active: eqActive, gains: [...engine.eqGains], pre: engine.eqPre };
  const layers = LAYERS.map(({ key, name }) => ({ key, name, ...ambient.layers[key] }))
    .filter((l) => l.on && l.buffer && l.level > 0.001)
    .map((l) => ({ key: l.key, name: l.name, buffer: l.buffer, level: l.level }));
  const amb = { active: layers.length > 0 && ambient.master > 0.001, layers, master: ambient.master, depth: ambient.depth, sensitivity: ambient.sensitivity };
  const tempo = { value: engine.tempo || 1, active: Math.abs((engine.tempo || 1) - 1) > 1e-3 };
  const reverb = { ...engine.reverb, active: !!(engine.reverb && engine.reverb.on && engine.reverb.mix > .001), ir: engine.convolver && engine.convolver.buffer };
  return { pitch, tempo, reverb, eq, ambient: amb, any: pitch.active || tempo.active || reverb.active || eq.active || amb.active };
}

/** Short human tag for the file name / title, e.g. "Pitch +2 · EQ · Rain + Fire" */
export function describe(st, t) {
  const parts = [];
  if (st.pitch.active) {
    const v = st.pitch.semis + st.pitch.cents / 100;
    const n = Math.round(v * 100) / 100;
    parts.push(`${st.pitch.vinyl ? 'Vinyl' : 'Pitch'} ${n > 0 ? '+' : ''}${n}`);
  }
  if (st.tempo && st.tempo.active) parts.push(`×${st.tempo.value.toFixed(2)}`);
  if (st.reverb && st.reverb.active) parts.push('Reverb');
  if (st.eq.active) parts.push('EQ');
  if (st.ambient.active) parts.push(st.ambient.layers.map((l) => t(l.name)).join(' + '));
  return parts.join(' · ');
}

async function addWorklet(ctx) {
  try { await ctx.audioWorklet.addModule(workletURL); }
  catch {
    const src = await (await fetch(workletURL)).text();
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  }
}

/** Vocal-band envelope → duck gain targets, same law as the live Smart Duck (40 ms frames). */
async function duckCurve(buffer, rate, amb, frames) {
  const sr = buffer.sampleRate;
  // mono + band-passed copy (300–3400 Hz) of the source
  const oc = new OfflineAudioContext(1, buffer.length, sr);
  const s = oc.createBufferSource(); s.buffer = buffer;
  const hp = oc.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300; hp.Q.value = .6;
  const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400; lp.Q.value = .6;
  s.connect(hp).connect(lp).connect(oc.destination); s.start();
  const band = (await oc.startRendering()).getChannelData(0);
  const chans = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chans.push(buffer.getChannelData(c));
  const hop = 0.04 * rate * sr; // 40 ms of output time, measured in source samples
  const dbs = new Float32Array(frames), ratios = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = Math.floor(f * hop), b = Math.min(buffer.length, Math.floor((f + 1) * hop));
    let pv = 1e-12, pt = 1e-12;
    for (let i = a; i < b; i += 2) {
      let x = 0; for (const ch of chans) x += ch[i]; x /= chans.length;
      pt += x * x; pv += band[i] * band[i];
    }
    const n = Math.max(1, (b - a) / 2);
    dbs[f] = 10 * Math.log10(pv / n + 1e-12);
    ratios[f] = pv / pt;
  }
  let avg = 0; for (let f = 0; f < frames; f++) avg += dbs[f]; avg /= Math.max(1, frames);
  const out = new Float32Array(frames);
  let env = 0;
  for (let f = 0; f < frames; f++) {
    avg = avg * .992 + dbs[f] * .008;
    const thr = avg + 4 - amb.sensitivity * 10;
    const loud = Math.min(1, Math.max(0, (dbs[f] - thr) / 8));
    const vocalish = Math.min(1, Math.max(0, (ratios[f] - .18) / .32));
    const presence = loud * vocalish;
    env += (presence - env) * (presence > env ? .45 : .045);
    out[f] = 1 - amb.depth * env;
  }
  return out;
}

/**
 * Render the processed track. `onProgress(0..1)`; returns { left, right, sampleRate, peakFix }.
 */
export async function renderProcessed(buffer, st, onProgress = () => {}) {
  const sr = buffer.sampleRate;
  const vinyl = st.pitch.vinyl && st.pitch.active;
  const tempo = st.tempo && st.tempo.active ? st.tempo.value : 1;
  const rate = (vinyl ? st.pitch.ratio : 1) * tempo;
  // tempo alone must keep the key: the shifter takes back what the faster playback raised
  const shiftRatio = (vinyl ? 1 : (st.pitch.active ? st.pitch.ratio : 1)) / (vinyl ? 1 : tempo);
  const shifter = Math.abs(shiftRatio - 1) > 1e-4;
  const win = Math.round(sr * 0.065);
  const lat = shifter ? Math.round(win / 2 + 4) : 0; // worklet delay, trimmed off afterwards
  const outLen = Math.ceil(buffer.length / rate);
  const oc = new OfflineAudioContext(2, outLen + lat + 64, sr);
  const dur = (outLen + lat) / sr;

  const src = oc.createBufferSource(); src.buffer = buffer; src.playbackRate.value = rate;
  let node = src;
  if (shifter) {
    await addWorklet(oc);
    const p = new AudioWorkletNode(oc, 'sds-pitch-shifter', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
      processorOptions: { ratio: shiftRatio }
    });
    p.parameters.get('ratio').value = shiftRatio;
    node = node.connect(p);
  }
  if (st.eq.active) {
    EQ_FREQS.forEach((f, i) => {
      const b = oc.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f; b.Q.value = 1.1; b.gain.value = st.eq.gains[i];
      node = node.connect(b);
    });
    const pre = oc.createGain(); pre.gain.value = Math.pow(10, st.eq.pre / 20);
    node = node.connect(pre);
  }
  if (st.reverb && st.reverb.active && st.reverb.ir) {
    // same impulse and balance as live playback
    const out = oc.createGain(), cv = oc.createConvolver(), wet = oc.createGain();
    cv.buffer = st.reverb.ir; wet.gain.value = st.reverb.mix * 1.4; out.gain.value = 1;
    const dry = oc.createGain(); dry.gain.value = 1 - st.reverb.mix * .35;
    node.connect(dry).connect(out); node.connect(cv).connect(wet).connect(out);
    node = out;
  }
  node.connect(oc.destination);
  src.start(0);

  if (st.ambient.active) {
    const a = st.ambient;
    const bus = oc.createGain(); bus.gain.value = a.master;
    const tone = oc.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 9000; tone.Q.value = .5;
    const duck = oc.createGain();
    bus.connect(tone).connect(duck).connect(oc.destination);
    const end = outLen / sr;
    for (const l of a.layers) {
      const s = oc.createBufferSource(); s.buffer = l.buffer; s.loop = true;
      const g = oc.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.setTargetAtTime(l.level, 0, .6); // the same gentle fade-in as live
      g.gain.setTargetAtTime(0, Math.max(.5, end - 2.4), .5); // and a soft tail at the end
      s.connect(g).connect(bus);
      s.start(0, Math.random() * l.buffer.duration);
    }
    if (a.depth > 0) {
      const frames = Math.ceil(end / .04);
      const curve = await duckCurve(buffer, rate, a, frames);
      duck.gain.setValueAtTime(curve[0] ?? 1, 0);
      for (let f = 1; f < frames; f++) {
        if (Math.abs(curve[f] - curve[f - 1]) < .002) continue;
        duck.gain.setTargetAtTime(curve[f], f * .04 + lat / sr, curve[f] < curve[f - 1] ? .05 : .4);
      }
    }
  }

  // progress: suspend every few seconds of audio
  const step = Math.max(2, dur / 40);
  for (let t = step; t < dur; t += step) {
    const at = t;
    oc.suspend(Math.round(at * sr / 128) * 128 / sr).then(() => { onProgress(at / dur); oc.resume(); }).catch(() => {});
  }
  const out = await oc.startRendering();
  onProgress(1);

  const left = out.getChannelData(0).slice(lat, lat + outLen);
  const right = out.getChannelData(1).slice(lat, lat + outLen);
  // keep it from clipping when the EQ / ambient pushed it over 0 dBFS
  let peak = 0;
  for (let i = 0; i < outLen; i++) { const v = Math.max(Math.abs(left[i]), Math.abs(right[i])); if (v > peak) peak = v; }
  let peakFix = 0;
  if (peak > .989) {
    const k = .966 / peak; peakFix = 20 * Math.log10(k);
    for (let i = 0; i < outLen; i++) { left[i] *= k; right[i] *= k; }
  }
  return { left, right, sampleRate: sr, peakFix };
}

/* ---------------------------------- encoders ---------------------------------- */
const enc = new TextEncoder();
const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

function riffInfo(tags) {
  const fields = [['INAM', tags.title], ['IART', tags.artist], ['IPRD', tags.album], ['ICMT', tags.comment], ['ISFT', 'Soft&Deep Sound']]
    .filter(([, v]) => v);
  const chunks = [];
  for (const [id, v] of fields) {
    const b = enc.encode(String(v) + '\0');
    chunks.push(...enc.encode(id), ...u32(b.length), ...b);
    if (b.length & 1) chunks.push(0);
  }
  if (!chunks.length) return new Uint8Array(0);
  return new Uint8Array([...enc.encode('LIST'), ...u32(chunks.length + 4), ...enc.encode('INFO'), ...chunks]);
}

export function encodeWav({ left, right, sampleRate }, tags = {}) {
  const n = left.length, dataBytes = n * 4;
  const info = riffInfo(tags);
  const buf = new ArrayBuffer(44 + dataBytes + info.length);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + dataBytes + info.length, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    // TPDF dither to 16-bit
    const d = (Math.random() - Math.random()) / 32768;
    v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round((left[i] + d) * 32767))), true);
    v.setInt16(o + 2, Math.max(-32768, Math.min(32767, Math.round((right[i] + d) * 32767))), true);
    o += 4;
  }
  new Uint8Array(buf, o).set(info);
  return new Uint8Array(buf);
}

function id3(tags) {
  const frame = (id, text) => {
    const body = new Uint8Array([1, 0xff, 0xfe, ...new Uint8Array(new Uint16Array([...String(text)].flatMap((ch) => { const c = ch.codePointAt(0); return c > 0xffff ? [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)] : [c]; })).buffer)]);
    const s = body.length;
    return [...enc.encode(id), (s >>> 24) & 255, (s >>> 16) & 255, (s >>> 8) & 255, s & 255, 0, 0, ...body];
  };
  const frames = [];
  if (tags.title) frames.push(...frame('TIT2', tags.title));
  if (tags.artist) frames.push(...frame('TPE1', tags.artist));
  if (tags.album) frames.push(...frame('TALB', tags.album));
  if (tags.genre) frames.push(...frame('TCON', tags.genre));
  frames.push(...frame('TSSE', 'Soft&Deep Sound'));
  const size = frames.length;
  const syncsafe = [(size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127];
  return new Uint8Array([...enc.encode('ID3'), 3, 0, 0, ...syncsafe, ...frames]);
}

const MP3_WORKER = `
self.onmessage = (e) => {
  const { left, right, sampleRate, kbps } = e.data;
  const mp3 = new lamejs.Mp3Encoder(2, sampleRate, kbps);
  const N = 1152 * 32, out = [];
  const L = new Int16Array(N), R = new Int16Array(N);
  let total = 0;
  for (let i = 0; i < left.length; i += N) {
    const n = Math.min(N, left.length - i);
    for (let k = 0; k < n; k++) {
      const d = (Math.random() - Math.random()) / 32768;
      L[k] = Math.max(-32768, Math.min(32767, Math.round((left[i + k] + d) * 32767)));
      R[k] = Math.max(-32768, Math.min(32767, Math.round((right[i + k] + d) * 32767)));
    }
    const b = mp3.encodeBuffer(n === N ? L : L.subarray(0, n), n === N ? R : R.subarray(0, n));
    if (b.length) { out.push(new Uint8Array(b)); total += b.length; }
    if ((i / N) % 8 === 0) self.postMessage({ progress: i / left.length });
  }
  const f = mp3.flush(); if (f.length) { out.push(new Uint8Array(f)); total += f.length; }
  const all = new Uint8Array(total); let o = 0; for (const b of out) { all.set(b, o); o += b.length; }
  self.postMessage({ done: all }, [all.buffer]);
};`;

let lameSrc = null;
export async function encodeMp3(pcm, tags = {}, onProgress = () => {}) {
  let { left, right, sampleRate } = pcm;
  if (![32000, 44100, 48000].includes(sampleRate)) { // LAME (MPEG-1) rates only
    const target = sampleRate > 48000 ? 48000 : 44100;
    const len = Math.ceil(left.length * target / sampleRate);
    const src = new AudioBuffer({ numberOfChannels: 2, length: left.length, sampleRate });
    src.copyToChannel(left, 0); src.copyToChannel(right, 1);
    const oc = new OfflineAudioContext(2, len, target);
    const s = oc.createBufferSource(); s.buffer = src; s.connect(oc.destination); s.start();
    const r = await oc.startRendering();
    left = r.getChannelData(0); right = r.getChannelData(1); sampleRate = target;
  }
  lameSrc = lameSrc || await (await fetch(lameURL)).text();
  const url = URL.createObjectURL(new Blob([lameSrc, '\n', MP3_WORKER], { type: 'text/javascript' }));
  const w = new Worker(url);
  try {
    const data = await new Promise((resolve, reject) => {
      w.onmessage = (e) => { if (e.data.done) resolve(e.data.done); else onProgress(e.data.progress); };
      w.onerror = (e) => reject(new Error(e.message || 'MP3 encoder failed'));
      w.postMessage({ left, right, sampleRate, kbps: 320 });
    });
    const tag = id3(tags);
    const outp = new Uint8Array(tag.length + data.length);
    outp.set(tag); outp.set(data, tag.length);
    return outp;
  } finally { w.terminate(); URL.revokeObjectURL(url); }
}
