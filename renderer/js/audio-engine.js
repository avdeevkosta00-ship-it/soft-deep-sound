/**
 * Audio graph
 *
 *   <audio> ─► MediaElementSource ─┬─► PitchShifter ─► fade ─► EQ (10 bands + preamp) ─┬─► master ─► destination
 *                                  │                                                    └─► vizAnalyser (visualizer)
 *                                  └─► voiceAnalyser (pre-FX, for ambient ducking)
 *   Ambient layers ─► ambientBus ─► duck ─► master
 */
export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    const c = this.ctx;
    this.src = c.createMediaElementSource(this.audio);
    this.fade = c.createGain();
    this.fade.gain.value = 0;
    this.master = c.createGain();
    this.viz = c.createAnalyser(); this.viz.fftSize = 4096; this.viz.smoothingTimeConstant = .72;
    this.voice = c.createAnalyser(); this.voice.fftSize = 2048; this.voice.smoothingTimeConstant = .55;
    this.ambientIn = c.createGain();

    // 10-band graphic equalizer
    this.eqBands = EQ_FREQS.map((f, i) => {
      const b = c.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f; b.Q.value = 1.1; b.gain.value = 0;
      return b;
    });
    this.preamp = c.createGain();
    this.eqGains = EQ_FREQS.map(() => 0); this.eqPre = 0; this.eqOn = true;
    let node = this.fade;
    for (const b of this.eqBands) { node.connect(b); node = b; }
    node.connect(this.preamp);

    this.src.connect(this.fade);
    this.src.connect(this.voice);
    this.preamp.connect(this.master);
    this.preamp.connect(this.viz);
    this.ambientIn.connect(this.master);
    this.master.connect(c.destination);

    this.pitchNode = null;
    this.semitones = 0; this.cents = 0; this.pitchOn = true; this.vinyl = false;
    this.volume = .8; this.muted = false;
    this.setVolume(this.volume);

    const a = this.audio;
    for (const ev of ['play', 'pause', 'ended', 'loadedmetadata', 'error', 'waiting', 'playing']) {
      a.addEventListener(ev, () => this.dispatchEvent(new Event(ev)));
    }
    this.loadSeq = 0; this.pauseSeq = 0; this.loading = false;
    this.ready = this.initWorklet();
  }

  async initWorklet() {
    try {
      const url = new URL('./pitch-worklet.js', import.meta.url);
      try { await this.ctx.audioWorklet.addModule(url); }
      catch { // fallback for custom-scheme module loading quirks
        const src = await (await fetch(url)).text();
        await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      }
      this.pitchNode = new AudioWorkletNode(this.ctx, 'sds-pitch-shifter', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit'
      });
      this.src.disconnect(this.fade);
      this.src.connect(this.pitchNode).connect(this.fade);
      this.applyPitch();
    } catch (e) { console.warn('Pitch worklet unavailable', e); }
  }

  get playing() { return !this.audio.paused && !this.audio.ended; }
  get time() { return this.audio.currentTime || 0; }
  get duration() { return isFinite(this.audio.duration) ? this.audio.duration : 0; }

  /**
   * Load a track. Rejects if the file can't be opened (missing / undecodable), and with an
   * AbortError when a newer load() replaced it before it was ready.
   */
  async load(url, { autoplay = true, at = 0 } = {}) {
    const my = ++this.loadSeq;
    this.pauseSeq++; // cancels a pause that is still fading out
    if (this.playing) await this.fadeTo(0, .12);
    if (my !== this.loadSeq) throw new DOMException('superseded', 'AbortError');
    const a = this.audio;
    this.loading = true;
    try {
      await new Promise((resolve, reject) => {
        const done = (ok, err) => { a.removeEventListener('loadedmetadata', onMeta); a.removeEventListener('error', onErr); clearTimeout(tm); ok ? resolve() : reject(err); };
        const onMeta = () => done(true);
        const onErr = () => done(false, new Error((a.error && a.error.message) || 'Cannot open file'));
        const tm = setTimeout(() => done(false, new Error('Timed out opening file')), 15000);
        a.addEventListener('loadedmetadata', onMeta); a.addEventListener('error', onErr);
        a.src = url;
        this.applyPitch();
      });
    } finally { if (my === this.loadSeq) this.loading = false; }
    if (my !== this.loadSeq) throw new DOMException('superseded', 'AbortError');
    if (at) a.currentTime = Math.min(at, Math.max(0, this.duration - 1));
    if (autoplay) await this.play();
  }

  async play() {
    if (!this.audio.src) return;
    this.pauseSeq++; // a play() wins over a pause() that is still fading out
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.fade.gain.cancelScheduledValues(this.ctx.currentTime);
    this.fade.gain.setValueAtTime(this.fade.gain.value, this.ctx.currentTime);
    try { await this.audio.play(); } catch (e) { if (e.name !== 'AbortError') console.warn(e); return; }
    this.fade.gain.linearRampToValueAtTime(1, this.ctx.currentTime + .22);
  }

  async pause() {
    const my = ++this.pauseSeq;
    await this.fadeTo(0, .16);
    if (my === this.pauseSeq) this.audio.pause();
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  fadeTo(v, sec) {
    const t = this.ctx.currentTime;
    const g = this.fade.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(v, t + sec);
    return new Promise((r) => setTimeout(r, sec * 1000 + 10));
  }

  seek(t) {
    if (!this.duration) return;
    const g = this.fade.gain, now = this.ctx.currentTime;
    if (this.playing) { // micro-dip hides the seek click
      g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + .03);
      setTimeout(() => { this.audio.currentTime = Math.max(0, Math.min(this.duration - .05, t)); g.linearRampToValueAtTime(1, this.ctx.currentTime + .08); }, 32);
    } else this.audio.currentTime = Math.max(0, Math.min(this.duration - .05, t));
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    const gain = this.muted ? 0 : Math.pow(this.volume, 1.8); // perceptual curve
    this.master.gain.setTargetAtTime(gain, this.ctx.currentTime, .03);
  }
  setMuted(m) { this.muted = m; this.setVolume(this.volume); }

  /* ------------------------------ pitch ------------------------------ */
  get pitchRatio() { return Math.pow(2, (this.semitones + this.cents / 100) / 12); }
  setPitch(semitones, cents = this.cents) { this.semitones = semitones; this.cents = cents; this.applyPitch(); }
  setPitchOn(on) { this.pitchOn = on; this.applyPitch(); }
  setVinyl(v) { this.vinyl = v; this.applyPitch(); }
  applyPitch() {
    const ratio = this.pitchOn ? this.pitchRatio : 1;
    const a = this.audio;
    if (this.vinyl) {
      // "Vinyl" mode: classic varispeed — key and tempo move together
      a.preservesPitch = false;
      a.playbackRate = ratio;
      this.pitchNode && this.pitchNode.parameters.get('ratio').setValueAtTime(1, this.ctx.currentTime);
    } else {
      a.preservesPitch = true;
      a.playbackRate = 1;
      this.pitchNode && this.pitchNode.parameters.get('ratio').setValueAtTime(ratio, this.ctx.currentTime);
    }
  }
  get rate() { return this.audio.playbackRate || 1; }

  /* ------------------------------- equalizer ------------------------------- */
  setEqBand(i, db) { this.eqGains[i] = db; this.applyEq(); }
  setEq(gains, pre = this.eqPre) { this.eqGains = [...gains]; this.eqPre = pre; this.applyEq(); }
  setEqOn(on) { this.eqOn = on; this.applyEq(); }
  applyEq() {
    const t = this.ctx.currentTime;
    this.eqBands.forEach((b, i) => b.gain.setTargetAtTime(this.eqOn ? this.eqGains[i] : 0, t, .04));
    this.preamp.gain.setTargetAtTime(this.eqOn ? Math.pow(10, this.eqPre / 20) : 1, t, .04);
  }
  /** combined magnitude response in dB for the curve display */
  eqResponse(freqs) {
    if (!this.eqShadow) { // detached copies, so reading the curve never touches live automation
      const oc = new OfflineAudioContext(1, 1, this.ctx.sampleRate);
      this.eqShadow = this.eqBands.map((b) => { const s = oc.createBiquadFilter(); s.type = b.type; s.frequency.value = b.frequency.value; s.Q.value = b.Q.value; return s; });
    }
    const f = new Float32Array(freqs), mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
    const total = new Float32Array(freqs.length).fill(this.eqOn ? this.eqPre : 0);
    this.eqShadow.forEach((s, i) => {
      s.gain.value = this.eqOn ? this.eqGains[i] : 0;
      s.getFrequencyResponse(f, mag, ph);
      for (let k = 0; k < mag.length; k++) total[k] += 20 * Math.log10(mag[k] || 1e-6);
    });
    return total;
  }
}
