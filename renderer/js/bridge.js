/**
 * Bridge to the main process. In Electron this is window.sds (preload).
 * Opened in a plain browser (UI development / tests) a mock with synthesized demo tracks is used.
 */
export const isMock = !window.sds;

function wav(channels, sr) {
  const n = channels[0].length, nc = channels.length;
  const buf = new ArrayBuffer(44 + n * nc * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * nc * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * nc * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { v.setInt16(o, Math.max(-1, Math.min(1, channels[c][i])) * 32767, true); o += 2; }
  return new Blob([buf], { type: 'audio/wav' });
}

async function demoTrack(bpm, root, seconds = 36) {
  const sr = 22050;
  const ctx = new OfflineAudioContext(2, sr * seconds, sr);
  const beat = 60 / bpm;
  const out = ctx.createGain(); out.gain.value = .6; out.connect(ctx.destination);
  for (let t = 0; t < seconds; t += beat) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + .12);
    g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(.001, t + .28);
    o.connect(g).connect(out); o.start(t); o.stop(t + .3);
    const hb = ctx.createBufferSource(); const nb = ctx.createBuffer(1, sr * .05, sr); const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * .008));
    hb.buffer = nb; const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6000;
    const hg = ctx.createGain(); hg.gain.value = .25; hb.connect(hp).connect(hg).connect(out); hb.start(t + beat / 2);
  }
  const chord = [0, 4, 7, 11].map((s) => root * Math.pow(2, s / 12));
  for (const f of chord) {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const g = ctx.createGain(); g.gain.value = .05; o.connect(g).connect(out); o.start(0);
  }
  // "vocal" phrases: formant-filtered saw in bars 3-4, 7-8 … (exercises Smart Duck)
  const bar = beat * 4;
  for (let b = 2; b * bar < seconds; b += 4) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = root * 2;
    const vib = ctx.createOscillator(); vib.frequency.value = 5.5; const vg = ctx.createGain(); vg.gain.value = 6; vib.connect(vg).connect(o.frequency);
    const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 800; f1.Q.value = 6;
    const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1200; f2.Q.value = 8;
    const g = ctx.createGain(); const t0 = b * bar, t1 = t0 + bar * 2;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(.9, t0 + .1); g.gain.setValueAtTime(.9, t1 - .2); g.gain.linearRampToValueAtTime(0, t1);
    o.connect(f1).connect(g); o.connect(f2).connect(g); g.connect(out);
    o.start(t0); vib.start(t0); o.stop(t1); vib.stop(t1);
  }
  const buf = await ctx.startRendering();
  return URL.createObjectURL(wav([buf.getChannelData(0), buf.getChannelData(1)], sr));
}

const DEMO = [
  ['Glass Horizon', 'Aerolume', 'Skylines', 124, 110],
  ['Runner Line', 'Faith & Rooftops', 'Catalyst', 96, 98],
  ['Soft Signal', 'Mira Vale', 'Low Light', 140, 130.8],
  ['Deep Current', 'Northbound', 'Undertow', 78, 87.3],
  ['Chrome Weather', 'Aerolume', 'Skylines', 110, 123.5],
  ['Frosted Avenue', 'Lumen Park', 'Glasshouse', 132, 146.8, 128],
  ['Ïðèâåò ìèð', 'Êèíî', '', 118, 98, 192],
  ['Glass Horizon', 'Aerolume', 'Skylines', 124, 110, 128]
];
const BR = [320, 256, 1411, 192, 320, 128, 192, 128];

function mock() {
  let store = null;
  try { store = JSON.parse(localStorage.getItem('sds-mock') || 'null'); } catch {}
  const urls = new Map();
  return {
    isElectron: false,
    mediaUrl: (p) => urls.get(p) || p,
    pathForFile: (f) => { const u = URL.createObjectURL(f); urls.set(f.name, u); return f.name; },
    store: { load: async () => null, save: async () => true },
    library: {
      pick: async () => DEMO.map((d, i) => `demo://${i}`),
      probe: async (paths) => Promise.all(paths.map(async (p) => {
        const i = +p.split('//')[1];
        const d = DEMO[i];
        if (p.startsWith('export://')) return { id: 'x' + p.length + Math.random().toString(36).slice(2, 6), path: p, title: p.slice(9).replace(/\.\w+$/, ''), artist: '', album: '', duration: 36, cover: null, format: p.endsWith('.wav') ? 'WAV' : 'MP3', addedAt: Date.now(), bpm: null };
        if (!d) return { id: 'f' + Math.random().toString(36).slice(2), path: p, title: p, artist: '', album: '', duration: 0, cover: null, format: 'MP3', addedAt: Date.now(), bpm: null };
        if (!urls.has(p)) urls.set(p, await demoTrack(d[3], d[4]));
        return { id: 'demo' + i, path: p, title: d[0], artist: d[1], album: d[2], duration: 36, cover: null, format: BR[i] === 1411 ? 'FLAC' : 'MP3', bitrate: BR[i], codec: BR[i] === 1411 ? 'FLAC' : 'MPEG 1 Layer 3', lossless: BR[i] === 1411, sampleRate: 44100, genre: i % 2 ? 'Electronic' : 'Ambient', year: 2020 + i, addedAt: Date.now() - i * 1000, bpm: null };
      })),
      exists: async () => true,
      existsMany: async (paths) => paths.map((p) => !p.includes('//4')),
      formatInfo: async (paths) => Object.fromEntries(paths.map((p) => { const i = +p.split('//')[1]; return [p, { bitrate: BR[i] || 192, sampleRate: 44100, bitDepth: null, codec: 'MPEG 1 Layer 3', lossless: false, channels: 2, size: 4200000, genre: 'Electronic', year: 2021 }]; })),
      reveal: async () => {}
    },
    web: {
      search: async (q) => {
        await new Promise((r) => setTimeout(r, 900));
        return {
          results: [
            { id: 'w1', title: `${q} (Live Session)`, artist: 'Open Stage Collective', providerLabel: 'Internet Archive', provider: 'archive', fileUrl: 'https://archive.org/download/x/a.mp3', pageUrl: 'https://archive.org/details/x', format: 'MP3', duration: 214, license: 'CC BY 4.0' },
            { id: 'w2', title: `${q} — Ambient Mix`, artist: 'Freesound user', providerLabel: 'Openverse · freesound', provider: 'openverse', fileUrl: 'https://cdn.freesound.org/a.mp3', pageUrl: 'https://freesound.org/x', format: 'MP3', duration: 182, license: 'CC0 1.0' },
            { id: 'w3', title: `${q} Instrumental`, artist: 'Jamendo Artist', providerLabel: 'Openverse · jamendo', provider: 'openverse', fileUrl: 'https://prod-1.storage.jamendo.com/a.mp3', pageUrl: 'https://jamendo.com/x', format: 'MP3', duration: 245, license: 'CC BY-SA 3.0' }
          ], errors: []
        };
      },
      download: async (item) => {
        for (let i = 1; i <= 10; i++) { await new Promise((r) => setTimeout(r, 120)); window.__mockProgress && window.__mockProgress({ id: item.id, received: i * 1e5, total: 1e6 }); }
        if (!urls.has('demo://0')) urls.set('demo://0', await demoTrack(DEMO[0][3], DEMO[0][4]));
        return { id: 'dl' + item.id, path: 'demo://0', title: item.title, artist: item.artist, album: 'Web', duration: 36, cover: null, format: 'MP3', addedAt: Date.now(), bpm: null };
      },
      extract: async (u) => {
        await new Promise((r) => setTimeout(r, 700));
        if (/fail/.test(u)) throw new Error('Сайт ответил 404');
        return { page: { url: u, title: 'Demo Artist — Night Drive (Free Download)', host: 'example.com' }, results: [
          { id: 'lk1', title: 'Night Drive', artist: 'Demo Artist', provider: 'link', providerLabel: 'example.com', fileUrl: 'https://example.com/a.mp3', pageUrl: u, format: 'MP3', duration: 0, license: '' },
          { id: 'lk2', title: 'Night Drive (Instrumental)', artist: 'Demo Artist', provider: 'link', providerLabel: 'cdn.example.com', fileUrl: 'https://cdn.example.com/b.ogg', pageUrl: u, format: 'OGG', duration: 0, license: '' }] };
      },
      open: async (u) => window.open(u, '_blank'),
      onProgress: (cb) => { window.__mockProgress = cb; }
    },
    exporter: {
      pick: async (name, format) => ({ path: `export://${name}.${format}`, format }),
      write: async (p, data) => { urls.set(p, URL.createObjectURL(new Blob([data], { type: p.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg' }))); window.__lastExport = data; return p; }
    },
    covers: {
      pick: () => new Promise((res) => {
        const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*';
        i.onchange = () => { const f = i.files[0]; res(f ? URL.createObjectURL(f) : null); };
        i.click();
      })
    },
    app: { paths: async () => ({ downloads: '~/Music/Soft&Deep Sound', userData: '(browser)' }), prefs: async () => ({ closeToTray: true }), setPref: async () => true },
    media: { state: (st) => { window.__media = st; }, onCommand: (cb) => { window.__mediaCmd = cb; } },
    win: { min() {}, max() {}, close() {}, onState() {} },
    onOpenFiles() {}
  };
}

export const bridge = window.sds || mock();
