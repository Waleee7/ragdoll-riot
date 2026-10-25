// Juice: easing, screen shake, hit-stop, slow-mo, flash and zoom punch.
// All durations are real-time milliseconds, so they keep working while the
// simulation is frozen (hit-stop) or slowed (slow-mo).

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
export const sign = (v) => (v < 0 ? -1 : 1);

export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  outBack: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  outElastic: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
};

export class Juice {
  constructor() {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduced = mq.matches;
    mq.addEventListener?.('change', (e) => { this.reduced = e.matches; });

    this.amp = 0; // current shake amplitude in CSS px
    this.ox = 0; this.oy = 0; this.angle = 0;
    this.hitstopMs = 0;
    this.slowMs = 0; this.slowDur = 1; this.slowScale = 1;
    this.flashA = 0; this.flashColor = '#ffffff';
    this.zoomMs = 0; this.zoomDur = 1; this.zoomAmt = 0; this.zoom = 0;
    this.fx = 0; this.fy = 0;
  }

  // Impulse shake. Takes the larger of old/new plus a little of the smaller, so
  // rapid hits stack without running away.
  shake(px) {
    const v = px * (this.reduced ? 0.2 : 1);
    this.amp = Math.min(34, Math.max(this.amp, v) + Math.min(this.amp, v) * 0.35);
  }

  // Freeze the simulation for `ms` (render and shake keep running).
  hitstop(ms) { this.hitstopMs = Math.max(this.hitstopMs, ms); }

  // Scale sim time by `scale` for `ms`; eases back to 1 over the last third.
  slowmo(scale, ms) {
    this.slowScale = scale; this.slowMs = ms; this.slowDur = ms;
  }

  flash(a, color = '#ffffff') {
    this.flashA = Math.max(this.flashA, a * (this.reduced ? 0.25 : 1));
    this.flashColor = color;
  }

  // Quick camera push toward a screen-space point.
  zoomPunch(amount, ms, fx, fy) {
    if (this.reduced) return;
    this.zoomAmt = amount; this.zoomMs = ms; this.zoomDur = ms; this.fx = fx; this.fy = fy;
  }

  // Advance by real seconds; returns the sim time scale for this frame.
  update(dt) {
    this.amp *= Math.exp(-dt * 11);
    if (this.amp < 0.06) this.amp = 0;
    this.ox = (Math.random() * 2 - 1) * this.amp;
    this.oy = (Math.random() * 2 - 1) * this.amp;
    this.angle = this.reduced ? 0 : (Math.random() * 2 - 1) * this.amp * 0.0007;

    this.flashA = Math.max(0, this.flashA - dt * 3.2);

    if (this.zoomMs > 0) {
      this.zoomMs = Math.max(0, this.zoomMs - dt * 1000);
      const p = 1 - this.zoomMs / this.zoomDur; // 0..1
      // fast in (first 25%), slow out
      const k = p < 0.25 ? ease.outCubic(p / 0.25) : 1 - ease.inOutQuad((p - 0.25) / 0.75);
      this.zoom = this.zoomAmt * k;
    } else this.zoom = 0;

    if (this.hitstopMs > 0) {
      this.hitstopMs -= dt * 1000;
      return 0;
    }
    if (this.slowMs > 0) {
      this.slowMs = Math.max(0, this.slowMs - dt * 1000);
      const p = this.slowMs / this.slowDur; // 1 -> 0
      if (p > 0.34) return this.slowScale;
      return lerp(1, this.slowScale, ease.outQuad(p / 0.34));
    }
    return 1;
  }

  // Apply shake + rotation about (cx, cy) and zoom about the punch focus.
  applyCamera(ctx, cx, cy) {
    ctx.translate(cx + this.ox, cy + this.oy);
    if (this.angle) ctx.rotate(this.angle);
    ctx.translate(-cx, -cy);
    if (this.zoom > 0.0005) {
      const z = 1 + this.zoom;
      ctx.translate(this.fx, this.fy);
      ctx.scale(z, z);
      ctx.translate(-this.fx, -this.fy);
    }
  }

  drawFlash(ctx, w, h) {
    if (this.flashA < 0.01) return;
    ctx.globalAlpha = Math.min(1, this.flashA);
    ctx.fillStyle = this.flashColor;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  reset() {
    this.amp = 0; this.hitstopMs = 0; this.slowMs = 0; this.flashA = 0; this.zoom = 0; this.zoomMs = 0;
  }
}
