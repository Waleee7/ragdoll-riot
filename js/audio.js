// WebAudio sound-effect synth. No samples: every sound is oscillators + filtered noise.
// The AudioContext is only created inside a user gesture (unlock()), so the page
// is silent until the first key / click / tap. Mute is a persisted toggle.

export class Sfx {
  constructor(store, slug = 'game') {
    this.store = store;
    this.key = `${slug}:muted`;
    this.muted = !!store.get(this.key, false);
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.last = {};
    this.voices = 0;
  }

  // Call from a trusted gesture handler (keydown / pointerdown).
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'interactive' });
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.12;
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.9;
        this.master.connect(comp); comp.connect(this.ctx.destination);
        // 1s of white noise, reused by every noise voice
        const len = this.ctx.sampleRate;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { /* audio is optional */ }
  }

  setMuted(m) {
    this.muted = m;
    this.store.set(this.key, m);
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.01);
  }

  get ready() { return !!this.ctx && !this.muted && this.ctx.state === 'running'; }

  tone({ f = 440, f2 = f, dur = 0.15, type = 'sine', vol = 0.3, delay = 0, attack = 0.002 }) {
    const c = this.ctx, t0 = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t0);
    if (f2 !== f) o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
    this.voices++; o.onended = () => { this.voices--; };
  }

  noise({ dur = 0.1, type = 'bandpass', f = 1200, f2 = f, q = 1, vol = 0.3, delay = 0, attack = 0.002 }) {
    const c = this.ctx, t0 = c.currentTime + delay;
    const s = c.createBufferSource(); s.buffer = this.noiseBuf;
    const fl = c.createBiquadFilter(); fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(f, t0);
    if (f2 !== f) fl.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(fl); fl.connect(g); g.connect(this.master);
    s.start(t0, Math.random() * 0.5); s.stop(t0 + dur + 0.02);
    this.voices++; s.onended = () => { this.voices--; };
  }

  // play('hit', 0.8): name + intensity 0..1+
  play(name, p = 1) {
    if (!this.ready || this.voices > 28) return;
    const now = this.ctx.currentTime;
    if (now - (this.last[name] || 0) < 0.025) return; // de-dupe same-frame spam
    this.last[name] = now;
    this[`_${name}`]?.(p);
  }

  /* ---- presets ---- */
  _ui() { this.tone({ f: 660, f2: 990, dur: 0.07, type: 'square', vol: 0.12 }); }
  _start() {
    this.tone({ f: 220, f2: 440, dur: 0.18, type: 'sawtooth', vol: 0.18 });
    this.tone({ f: 440, f2: 880, dur: 0.22, type: 'square', vol: 0.1, delay: 0.06 });
  }
  _swing(p) { this.noise({ dur: 0.1, f: 500, f2: 2600 + 800 * p, q: 0.7, vol: 0.1 + 0.05 * p }); }
  _jump() { this.tone({ f: 260, f2: 560, dur: 0.14, type: 'square', vol: 0.08 }); }
  _hit(p) {
    this.noise({ dur: 0.05 + 0.09 * p, f: 2400 - 1200 * p, f2: 380, q: 0.9, vol: 0.4 + 0.2 * p });
    this.tone({ f: 190 - 70 * p, f2: 42, dur: 0.12 + 0.12 * p, vol: 0.55 + 0.2 * p });
    if (p > 0.55) this.tone({ f: 110, f2: 28, dur: 0.32, type: 'triangle', vol: 0.28 });
  }
  _kill(p) {
    this.tone({ f: 520, f2: 70, dur: 0.28, type: 'sawtooth', vol: 0.16 });
    this.noise({ dur: 0.22, type: 'lowpass', f: 3200, f2: 200, vol: 0.32 });
    this.tone({ f: 70, f2: 28, dur: 0.4, vol: 0.5 * p });
  }
  _thud(p) {
    this.tone({ f: 95, f2: 34, dur: 0.18, vol: Math.min(0.7, 0.25 + 0.4 * p) });
    this.noise({ dur: 0.12, type: 'lowpass', f: 900, f2: 120, vol: Math.min(0.5, 0.15 + 0.3 * p) });
  }
  _hurt() {
    this.tone({ f: 240, f2: 70, dur: 0.22, type: 'sawtooth', vol: 0.22 });
    this.noise({ dur: 0.14, f: 900, f2: 200, vol: 0.3 });
  }
  _windup() { this.tone({ f: 180, f2: 340, dur: 0.2, type: 'triangle', vol: 0.07 }); }
  _combo(p) { this.tone({ f: 420 * Math.pow(1.122, Math.min(12, p)), dur: 0.12, type: 'square', vol: 0.1 }); }
  _wave() {
    [0, 4, 7, 12].forEach((n, i) =>
      this.tone({ f: 330 * Math.pow(2, n / 12), dur: 0.16, type: 'square', vol: 0.1, delay: i * 0.07 }));
  }
  _clear() {
    [0, 7, 12, 16, 19].forEach((n, i) =>
      this.tone({ f: 392 * Math.pow(2, n / 12), dur: 0.22, type: 'triangle', vol: 0.16, delay: i * 0.08 }));
  }
  _finisher() {
    this.tone({ f: 60, f2: 24, dur: 0.9, vol: 0.55 });
    this.noise({ dur: 0.7, type: 'lowpass', f: 2400, f2: 90, vol: 0.3 });
  }
  _block() {
    this.tone({ f: 1800, f2: 1300, dur: 0.09, type: 'square', vol: 0.1 });
    this.tone({ f: 2600, f2: 2100, dur: 0.16, type: 'triangle', vol: 0.09, delay: 0.01 });
    this.noise({ dur: 0.05, f: 4200, q: 2, vol: 0.16 });
  }
  _guard() {
    this.noise({ dur: 0.26, f: 3000, f2: 600, q: 1.2, vol: 0.32 });
    this.tone({ f: 900, f2: 140, dur: 0.3, type: 'sawtooth', vol: 0.13 });
  }
  _zap() {
    this.tone({ f: 120, f2: 90, dur: 0.32, type: 'square', vol: 0.14 });
    this.tone({ f: 1800, f2: 400, dur: 0.18, type: 'sawtooth', vol: 0.07 });
    this.noise({ dur: 0.3, type: 'highpass', f: 3000, f2: 6000, q: 0.8, vol: 0.26 });
  }
  _ready() {
    [0, 7, 12].forEach((n, i) => this.tone({ f: 523 * Math.pow(2, n / 12), dur: 0.14, type: 'square', vol: 0.09, delay: i * 0.06 }));
  }
  _super() {
    this.tone({ f: 80, f2: 30, dur: 0.9, vol: 0.6 });
    this.noise({ dur: 0.8, type: 'lowpass', f: 5000, f2: 120, vol: 0.4 });
    this.tone({ f: 220, f2: 880, dur: 0.3, type: 'sawtooth', vol: 0.12 });
  }
  _stomp() {
    this.tone({ f: 55, f2: 22, dur: 0.7, vol: 0.6 });
    this.noise({ dur: 0.5, type: 'lowpass', f: 1400, f2: 80, vol: 0.38 });
  }
  _boss() {
    [0, 0, -5, 0].forEach((n, i) =>
      this.tone({ f: 110 * Math.pow(2, n / 12), dur: 0.26, type: 'sawtooth', vol: 0.16, delay: i * 0.22 }));
  }
  _tip() { this.tone({ f: 880, f2: 1320, dur: 0.06, vol: 0.05 }); }
  _over() {
    [0, -3, -7, -12].forEach((n, i) =>
      this.tone({ f: 330 * Math.pow(2, n / 12), f2: 330 * Math.pow(2, (n - 2) / 12), dur: 0.3, type: 'sawtooth', vol: 0.14, delay: i * 0.16 }));
  }
}
