/**
 * Audio graph
 *
 *   deck A <audio> ─► src ─► xf ─► lvl ─┐
 *   deck B <audio> ─► src ─► xf ─► lvl ─┴─► mix ─┬─► PitchShifter ─► fade ─► EQ (10 bands + preamp) ─► out ─┬─► master ─► destination
 *                                               │                                      └─► reverb ─► wet ─┘    └─► vizAnalyser
 *                                               └─► voiceAnalyser (pre-FX, for ambient ducking)
 *   Ambient layers ─► ambientBus ─► duck ─► master
 *
 * Two decks so one track can fade into the next (crossfade); `audio` is always the deck that is «current».
 * xf — the crossfade envelope of a deck, lvl — its loudness normalisation (one gain per track).
 */
export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const REVERB_ROOMS = { room: { sec: 1.2, decay: 3.2 }, hall: { sec: 2.8, decay: 2.4 }, cathedral: { sec: 5.5, decay: 1.8 } };

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    const c = this.ctx;
    this.mix = c.createGain();
    this.decks = [0, 1].map(() => {
      const audio = new Audio();
      audio.preload = 'auto'; audio.crossOrigin = 'anonymous';
      const src = c.createMediaElementSource(audio);
      const xf = c.createGain(), lvl = c.createGain();
      src.connect(xf).connect(lvl).connect(this.mix);
      return { audio, src, xf, lvl };
    });
    this.cur = 0;
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

    // reverb: a parallel wet path, off (wet = 0) unless asked for
    this.out = c.createGain();
    this.convolver = c.createConvolver();
    this.wet = c.createGain(); this.wet.gain.value = 0;
    this.preamp.connect(this.out);
    this.preamp.connect(this.convolver).connect(this.wet).connect(this.out);
    this.reverb = { on: false, room: 'hall', mix: .3 };

    this.mix.connect(this.fade);
    this.mix.connect(this.voice);
    this.out.connect(this.master);
    this.out.connect(this.viz);
    this.ambientIn.connect(this.master);
    this.master.connect(c.destination);

    this.pitchNode = null;
    this.semitones = 0; this.cents = 0; this.pitchOn = true; this.vinyl = false;
    this.tempo = 1; // playback speed without changing the key
    this.volume = .8; this.muted = false;
    this.setVolume(this.volume);
    this.crossfade = 0; // seconds; 0 = off
    this.nearFired = false;

    for (const [i, d] of this.decks.entries()) {
      for (const ev of ['play', 'pause', 'ended', 'loadedmetadata', 'error', 'waiting', 'playing']) {
        // only the current deck speaks for the player; the one fading out stays silent
        d.audio.addEventListener(ev, () => { if (i === this.cur) this.dispatchEvent(new Event(ev)); });
      }
      d.audio.addEventListener('timeupdate', () => {
        if (i !== this.cur || !this.crossfade || this.nearFired || this.xfading) return;
        const left = this.duration - this.time;
        if (this.duration > this.crossfade * 2 + 4 && left > 0 && left <= this.crossfade + .25 && !d.audio.paused) {
          this.nearFired = true;
          this.dispatchEvent(new Event('nearend'));
        }
      });
    }
    this.loadSeq = 0; this.pauseSeq = 0; this.loading = false;
    this.ready = this.initWorklet();
  }

  /** the deck that is playing (or about to) */
  get deck() { return this.decks[this.cur]; }
  get audio() { return this.deck.audio; }
  get idle() { return this.decks[1 - this.cur]; }

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
      this.mix.disconnect(this.fade);
      this.mix.connect(this.pitchNode).connect(this.fade);
      this.applyPitch();
    } catch (e) { console.warn('Pitch worklet unavailable', e); }
  }

  get playing() { return !this.audio.paused && !this.audio.ended; }
  get time() { return this.audio.currentTime || 0; }
  get duration() { return isFinite(this.audio.duration) ? this.audio.duration : 0; }

  /** open a file on a deck, resolve on metadata */
  openOn(d, url) {
    const a = d.audio;
    return new Promise((resolve, reject) => {
      const done = (ok, err) => { a.removeEventListener('loadedmetadata', onMeta); a.removeEventListener('error', onErr); clearTimeout(tm); ok ? resolve() : reject(err); };
      const onMeta = () => done(true);
      const onErr = () => done(false, new Error((a.error && a.error.message) || 'Cannot open file'));
      const tm = setTimeout(() => done(false, new Error('Timed out opening file')), 15000);
      a.addEventListener('loadedmetadata', onMeta); a.addEventListener('error', onErr);
      a.src = url;
      this.applyRate(a);
    });
  }

  /**
   * Load a track. Rejects if the file can't be opened (missing / undecodable), and with an
   * AbortError when a newer load() replaced it before it was ready.
   * crossfade (seconds): the next track starts on the other deck while this one fades out.
   * gainDb: loudness normalisation for this track.
   */
  async load(url, { autoplay = true, at = 0, crossfade = 0, gainDb = 0 } = {}) {
    const my = ++this.loadSeq;
    this.pauseSeq++; // cancels a pause that is still fading out
    this.nearFired = false;
    if (crossfade > 0 && this.playing && autoplay) return this.crossTo(url, crossfade, gainDb, my, at);
    this.stopIdle();
    if (this.playing) await this.fadeTo(0, .12);
    if (my !== this.loadSeq) throw new DOMException('superseded', 'AbortError');
    const d = this.deck, now = this.ctx.currentTime;
    d.xf.gain.cancelScheduledValues(now); d.xf.gain.setValueAtTime(1, now);
    this.setDeckGain(d, gainDb, true);
    this.loading = true;
    try { await this.openOn(d, url); }
    finally { if (my === this.loadSeq) this.loading = false; }
    if (my !== this.loadSeq) throw new DOMException('superseded', 'AbortError');
    if (at) d.audio.currentTime = Math.min(at, Math.max(0, this.duration - 1));
    if (autoplay) await this.play();
  }

  /** the overlap: new track on the idle deck, equal-power curves, then the decks swap roles */
  async crossTo(url, sec, gainDb, my, at) {
    const next = this.idle, prev = this.deck;
    this.loading = true;
    try { await this.openOn(next, url); }
    finally { if (my === this.loadSeq) this.loading = false; }
    if (my !== this.loadSeq) throw new DOMException('superseded', 'AbortError');
    if (at) next.audio.currentTime = at;
    const t0 = this.ctx.currentTime, n = 32;
    const up = new Float32Array(n), down = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1); up[i] = Math.sin(x * Math.PI / 2); down[i] = Math.cos(x * Math.PI / 2); }
    this.setDeckGain(next, gainDb, true);
    next.xf.gain.cancelScheduledValues(t0); next.xf.gain.setValueCurveAtTime(up, t0, sec);
    prev.xf.gain.cancelScheduledValues(t0); prev.xf.gain.setValueCurveAtTime(down, t0, sec);
    try { await next.audio.play(); } catch (e) { if (e.name !== 'AbortError') console.warn(e); }
    this.cur = 1 - this.cur; // from here on the new track is «the» track
    this.xfading = true;
    this.dispatchEvent(new Event('play'));
    this.dispatchEvent(new Event('loadedmetadata'));
    clearTimeout(this.xfTimer);
    this.xfTimer = setTimeout(() => { this.xfading = false; if (this.idle === prev) { prev.audio.pause(); } }, sec * 1000 + 80);
  }

  /** silence and release the deck that is not current (e.g. a crossfade cut short) */
  stopIdle() {
    clearTimeout(this.xfTimer); this.xfading = false;
    const d = this.idle, now = this.ctx.currentTime;
    d.xf.gain.cancelScheduledValues(now); d.xf.gain.setValueAtTime(0, now);
    if (!d.audio.paused) d.audio.pause();
  }

  async play() {
    if (!this.audio.src) return;
    this.pauseSeq++; // a play() wins over a pause() that is still fading out
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.fade.gain.cancelScheduledValues(this.ctx.currentTime);
    this.fade.gain.setValueAtTime(this.fade.gain.value, this.ctx.currentTime);
    try { await this.audio.play(); } catch (e) { if (e.name !== 'AbortError') console.warn(e); return; }
    if (this.xfading && this.idle.audio.paused) this.idle.audio.play().catch(() => {}); // the overlap resumes too
    this.fade.gain.linearRampToValueAtTime(1, this.ctx.currentTime + .22);
  }

  async pause() {
    const my = ++this.pauseSeq;
    await this.fadeTo(0, .16);
    if (my === this.pauseSeq) { this.audio.pause(); if (this.xfading) this.idle.audio.pause(); }
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
    if (this.xfading) this.stopIdle(); // seeking ends the overlap
    this.nearFired = false;
    const g = this.fade.gain, now = this.ctx.currentTime;
    if (this.playing) { // micro-dip hides the seek click
      g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + .03);
      setTimeout(() => { this.audio.currentTime = Math.max(0, Math.min(this.duration - .05, t)); g.linearRampToValueAtTime(1, this.ctx.currentTime + .08); }, 32);
    } else this.audio.currentTime = Math.max(0, Math.min(this.duration - .05, t));
  }

  /** release the current file (used when the playing track is removed from the library) */
  unload() { this.stopIdle(); const a = this.audio; a.pause(); a.removeAttribute('src'); a.load(); }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    const gain = this.muted ? 0 : Math.pow(this.volume, 1.8); // perceptual curve
    this.master.gain.setTargetAtTime(gain, this.ctx.currentTime, .03);
  }
  setMuted(m) { this.muted = m; this.setVolume(this.volume); }

  /* --------------------------- loudness normalisation --------------------------- */
  setDeckGain(d, db, instant) {
    const v = Math.pow(10, (db || 0) / 20), now = this.ctx.currentTime;
    d.lvl.gain.cancelScheduledValues(now);
    if (instant) d.lvl.gain.setValueAtTime(v, now); else d.lvl.gain.setTargetAtTime(v, now, .4);
  }
  /** the current track's gain changed (e.g. its loudness was just measured) */
  setTrackGain(db) { this.setDeckGain(this.deck, db, false); }

  /* ------------------------------ pitch & tempo ------------------------------ */
  get pitchRatio() { return Math.pow(2, (this.semitones + this.cents / 100) / 12); }
  setPitch(semitones, cents = this.cents) { this.semitones = semitones; this.cents = cents; this.applyPitch(); }
  setPitchOn(on) { this.pitchOn = on; this.applyPitch(); }
  setVinyl(v) { this.vinyl = v; this.applyPitch(); }
  setTempo(r) { this.tempo = Math.max(.5, Math.min(2, r || 1)); this.applyPitch(); }
  applyRate(a) {
    const ratio = this.pitchOn ? this.pitchRatio : 1;
    // «Vinyl» is classic varispeed (key and tempo move together); tempo alone keeps the key
    a.preservesPitch = !this.vinyl;
    a.playbackRate = (this.vinyl ? ratio : 1) * this.tempo;
  }
  applyPitch() {
    const ratio = this.pitchOn ? this.pitchRatio : 1;
    for (const d of this.decks) this.applyRate(d.audio);
    this.pitchNode && this.pitchNode.parameters.get('ratio').setValueAtTime(this.vinyl ? 1 : ratio, this.ctx.currentTime);
  }
  get rate() { return this.audio.playbackRate || 1; }

  /* --------------------------------- reverb --------------------------------- */
  /** a synthetic impulse response: decaying stereo noise, a touch darker as it fades */
  impulse(room) {
    const { sec, decay } = REVERB_ROOMS[room] || REVERB_ROOMS.hall;
    const sr = this.ctx.sampleRate, n = Math.floor(sr * sec), buf = this.ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); let lp = 0;
      for (let i = 0; i < n; i++) {
        const x = i / n, k = .55 - x * .4;
        lp += k * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * Math.pow(1 - x, decay) * (i < sr * .004 ? i / (sr * .004) : 1);
      }
    }
    return buf;
  }
  setReverb({ on = this.reverb.on, room = this.reverb.room, mix = this.reverb.mix } = {}) {
    if (room !== this.reverb.room || !this.convolver.buffer) this.convolver.buffer = this.impulse(room);
    this.reverb = { on, room, mix };
    const t = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(on ? mix * 1.4 : 0, t, .08);
    this.out.gain.setTargetAtTime(on ? 1 - mix * .35 : 1, t, .08); // keep the sum from getting louder
  }

  /* ------------------------------ output device ------------------------------ */
  async outputs() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput'); } catch { return []; }
  }
  /** '' = the system default */
  async setOutput(id) {
    if (typeof this.ctx.setSinkId !== 'function') return false;
    try { await this.ctx.setSinkId(id || ''); return true; } catch (e) { console.warn('output device:', e.message); return false; }
  }

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
