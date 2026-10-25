// Fixed-timestep loop: simulation at a constant `hz`, rendering once per
// animation frame with an interpolation factor `alpha` (0..1).
//
//  - A long frame is clamped (maxFrame) and at most `maxSteps` sim steps run per
//    frame; leftover time is dropped, so a slow device slows the game down
//    instead of entering a spiral of death.
//  - `timeScale` multiplies elapsed time (0 = hit-stop, <1 = slow-mo).
//  - The loop pauses when the tab is hidden or the window loses focus.
export class Engine {
  constructor({ update, render, beforeFrame, onPause, onResume, hz = 60, maxSteps = 5, maxFrame = 0.1 }) {
    this.update = update;
    this.render = render;
    this.beforeFrame = beforeFrame;
    this.onPause = onPause;
    this.onResume = onResume;
    this.step = 1 / hz;
    this.maxSteps = maxSteps;
    this.maxFrame = maxFrame;
    this.acc = 0;
    this.last = -1;
    this.alpha = 0;
    this.timeScale = 1;
    this.paused = false;
    this.running = false;
    this.stepsLast = 0;
    this.stats = { frameMs: 16.7, workMs: 0, fps: 60, dropped: 0, maxFrameMs: 0 };
    this._fpsAcc = 0; this._fpsN = 0;

    document.addEventListener('visibilitychange', () => { if (document.hidden) this._lost(); else this.last = -1; });
    window.addEventListener('blur', () => this._lost());
  }

  _lost() {
    if (this.paused) return;
    this.paused = true;
    this.onPause?.();
  }

  pause() { this._lost(); }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.last = -1;
    this.onResume?.();
  }

  start() {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this._tick);
  }

  _tick = (now) => {
    requestAnimationFrame(this._tick);
    if (this.last < 0) this.last = now;
    const raw = now - this.last;
    this.last = now;
    const dt = Math.min(raw / 1000, this.maxFrame);

    const w0 = performance.now();
    this.timeScale = this.beforeFrame ? this.beforeFrame(dt) : 1;

    let n = 0;
    if (!this.paused) {
      this.acc += dt * this.timeScale;
      while (this.acc >= this.step && n < this.maxSteps) {
        this.update(this.step);
        this.acc -= this.step;
        n++;
      }
      if (n === this.maxSteps && this.acc >= this.step) { this.acc = 0; this.stats.dropped++; }
    }
    this.stepsLast = n;
    this.alpha = this.acc / this.step;
    this.render(this.alpha, dt);

    // rolling stats for the ?debug overlay and perf tests
    const s = this.stats;
    s.frameMs += (raw - s.frameMs) * 0.05;
    s.workMs += (performance.now() - w0 - s.workMs) * 0.05;
    if (raw > s.maxFrameMs) s.maxFrameMs = raw;
    this._fpsAcc += raw; this._fpsN++;
    if (this._fpsAcc >= 500) { s.fps = (this._fpsN * 1000) / this._fpsAcc; this._fpsAcc = 0; this._fpsN = 0; }
  };
}
