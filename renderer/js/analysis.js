// Decodes a track off the UI thread and asks the worker for waveform peaks + BPM.
const pending = new Map();
let seq = 0;
let worker = null;
async function getWorker() {
  if (worker) return worker;
  const url = new URL('./bpm-worker.js', import.meta.url);
  if (location.protocol === 'http:' || location.protocol === 'https:') worker = new Worker(url);
  else { // custom app scheme (sds://): a blob worker is the most portable way to spawn it
    const src = await (await fetch(url)).text();
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  }
  worker.onmessage = onMessage;
  worker.onerror = (e) => { // a crashed worker must not leave jobs (and the background queue) hanging
    const err = new Error(e.message || 'analysis worker crashed');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    try { worker.terminate(); } catch {}
    worker = null;
  };
  return worker;
}
function onMessage(e) {
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data);
}

let decodeCtx = null;
export async function analyzeTrack(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  // a dedicated low-rate context keeps decode memory & CPU modest
  decodeCtx = decodeCtx || new OfflineAudioContext(1, 1, 22050);
  const buf = await decodeCtx.decodeAudioData(ab);
  const channels = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c).slice());
  const id = ++seq;
  const w = await getWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, channels, sampleRate: buf.sampleRate }, channels.map((c) => c.buffer));
  });
}
