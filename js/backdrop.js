// The cached background layer (#bg) and the location transitions.
//
// The art is painted once per resize / location change. A transition is the ONLY time the layer is
// re-blitted every frame: the old picture and the new one are each painted once into an offscreen canvas
// and composited for a few hundred ms, then the layer is left holding the final picture again.
// Both pictures are fitted to the same floor line, so nothing on the floor moves when they swap.
// The incoming picture is prepared BEFORE the break (prep): the old layer is copied and the new one painted in a few
// bands, one per frame, so the wipe's first frame only composites two ready canvases instead of painting a full screen.
// The layer runs at min(devicePixelRatio, 2): the art (1920 px wide) has no detail beyond that, and a 3x layer is 2.25x the pixels.
import { VARIANTS, fitCover, stageOfVariant } from './stages.js';
import * as art from './art.js';
import { paintImage, paintProcedural, paintPaper, paintWalls, vignette } from './paint.js';
import { clamp, ease } from './juice.js';

const mk = () => document.createElement('canvas');
const BANDS = 5;      // the incoming picture is painted in this many horizontal bands, one per frame

export class Backdrop {
  constructor(bgCanvas) {
    this.cv = bgCanvas;
    this.cur = null;            // variant id shown (or being committed to)
    this.F = null;              // fit of the current picture: { k, ox, oy, iw, ih, shown } (shown = real art, not fallback)
    this.T = null;              // active transition
    this.fromC = null; this.toC = null;
    this.P = null;              // the incoming picture being prepared ahead of time: { vid, F, i, n, done }
    this.view = null; this.V = null;
    this.onCommit = null;       // (variantId) => void, fired when the swap becomes real (palette, hazards, ...)
    this.onDone = null;
    this.m = { start: 0, first: 0, prep: 0, prepMax: 0 };   // timings (ms) of the last transition, for the ?debug perf hook
  }

  get active() { return !!this.T; }

  fitFor(vid, view, V) {
    const v = VARIANTS[vid], img = art.peek(vid);
    if (!img) return { shown: false, k: 1, ox: 0, oy: 0, iw: 1, ih: 1, floor: v.floorOut };
    return { ...fitCover(view.w, view.h, V.ground * V.s, img.naturalWidth, img.naturalHeight, v.floorOut, v.focusX ?? 0.5), shown: true, floor: v.floorOut };
  }

  // Paint one location into a context (scaled to CSS px). Returns its fit.
  paintTo(c, vid, view, V, band) {
    const dpr = view.bgDpr || view.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (band) { c.save(); c.beginPath(); c.rect(0, band[0], view.w, band[1] - band[0]); c.clip(); }
    const stage = stageOfVariant(vid), F = this.fitFor(vid, view, V), img = F.shown ? art.peek(vid) : null;
    if (img) { paintImage(c, img, F, view); vignette(c, view, stage.id === 'margins' ? 0.1 : 0.34); }
    else {
      if (stage.id === 'margins') paintPaper(c, view, V); else paintProcedural(c, view, V, stage.id === 'pit' ? '#ff8a2a' : '#ff3e3e');
      vignette(c, view, stage.id === 'margins' ? 0.1 : 0.6);
    }
    paintWalls(c, stage.id, view, V);
    if (band) c.restore();
    return F;
  }

  // (Re)paint the layer from scratch for the current variant.
  paint(view, V) {
    this.view = view; this.V = V;
    if (this.T) this.finish(true);
    this.drop();
    if (!this.cur) return;
    this.F = this.paintTo(this.cv.getContext('2d'), this.cur, view, V);
  }

  // Prepare the incoming picture a little per frame (call every frame while a break is coming). True when it is ready to wipe in.
  prep(vid) {
    const { view, V } = this;
    if (!view || this.T) return false;
    let P = this.P;
    if (P && P.vid !== vid) { this.drop(); P = null; }
    if (P?.done) return true;
    const t0 = performance.now();
    if (!P) {
      const w = this.cv.width, h = this.cv.height;
      const from = (this.fromC ||= mk()), to = (this.toC ||= mk());
      from.width = to.width = w; from.height = to.height = h;
      from.getContext('2d').drawImage(this.cv, 0, 0);
      const F = this.fitFor(vid, view, V);
      this.P = P = { vid, F, i: 0, n: F.shown ? BANDS : 1, done: false };
    } else {
      const dpr = view.bgDpr || view.dpr, n = P.n;
      const y = (i) => Math.round((view.h * i) / n * dpr) / dpr;   // band edges on whole device pixels: no seams
      const to = this.toC.getContext('2d');
      if (n === 1) this.paintTo(to, vid, view, V); else this.paintTo(to, vid, view, V, [y(P.i), P.i === n - 1 ? view.h : y(P.i + 1)]);
      if (++P.i >= n) { P.done = true; P.F = this.fitFor(vid, view, V); }
    }
    const ms = performance.now() - t0;
    this.m.prep = ms; this.m.prepMax = Math.max(this.m.prepMax, ms);
    return !!this.P?.done;
  }

  prepared(vid) { return !!this.P?.done && this.P.vid === vid; }

  // Throw away a half-prepared (or unused) incoming picture and free its buffers.
  drop() {
    if (!this.P) return;
    this.P = null;
    if (!this.T && this.fromC) this.fromC.width = this.fromC.height = this.toC.width = this.toC.height = 0;
  }

  setCurrent(vid, view, V) { this.cur = vid; this.paint(view || this.view, V || this.V); }

  // Begin a transition to `vid` (tag marks whose it is: 'break' for a break-through). kind: 'wipe' (from side dir: +1 right, -1 left) or 'fade'.
  start(vid, kind, dir, dur, commitAt = 0.5, tag = null) {
    if (!this.view) return false;
    const t0 = performance.now();
    if (this.T) this.finish(true);
    const { view, V } = this;
    let F;
    if (this.prepared(vid)) F = this.P.F;          // painted ahead of time: nothing heavy left to do on this frame
    else {
      this.drop();
      const w = this.cv.width, h = this.cv.height;
      const from = (this.fromC ||= mk()), to = (this.toC ||= mk());
      from.width = to.width = w; from.height = to.height = h;
      from.getContext('2d').drawImage(this.cv, 0, 0);
      F = this.paintTo(to.getContext('2d'), vid, view, V);
    }
    this.P = null;
    this.T = { vid, kind, dir: dir || 1, dur, t: 0, p: 0, commitAt, committed: false, F, front: 0, fresh: true, tag };
    this.m.start = performance.now() - t0;
    return true;
  }

  step(dt) {
    const T = this.T; if (!T) return;
    T.t += dt; T.p = clamp(T.t / T.dur, 0, 1);
    if (!T.committed && T.p >= T.commitAt) this.commit();
    if (T.p >= 1) this.finish(false);
  }

  commit() {
    const T = this.T; if (!T || T.committed) return;
    T.committed = true; this.cur = T.vid; this.F = T.F;
    this.onCommit?.(T.vid, T);
  }

  // End the transition: leave the layer holding the new picture, free the offscreen buffers.
  finish(snap) {
    const T = this.T; if (!T) return;
    this.commit();
    this.T = null;
    const c = this.cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.drawImage(this.toC, 0, 0);
    this.fromC.width = this.fromC.height = this.toC.width = this.toC.height = 0;
    this.onDone?.(snap);
  }

  // Drop a transition without committing it (a restart). The caller repaints the layer.
  cancel() {
    if (!this.T) { this.drop(); return; }
    this.T = null; this.P = null;
    if (this.fromC) this.fromC.width = this.fromC.height = this.toC.width = this.toC.height = 0;
  }

  // Per frame while a transition runs: composite old + new onto the layer.
  render() {
    const T = this.T; if (!T) return;
    if (!T.fresh) return this.draw(T);
    const t0 = performance.now();
    this.draw(T); T.fresh = false;
    this.m.first = performance.now() - t0;
  }

  draw(T) {
    const c = this.cv.getContext('2d'), w = this.cv.width, h = this.cv.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.drawImage(this.fromC, 0, 0);
    if (T.kind === 'fade') {
      c.globalAlpha = ease.inOutQuad(T.p); c.drawImage(this.toC, 0, 0); c.globalAlpha = 1;
      return;
    }
    // wipe: the new picture arrives behind a slanted front that travels from the side the body flew
    const e = ease.inOutCubic(T.p), sk = h * 0.16, d = T.dir;
    const xf = d > 0 ? (w + sk) - e * (w + 2 * sk) : -sk + e * (w + 2 * sk);   // front x (mid-height)
    T.front = xf;
    c.save();
    c.beginPath();
    if (d > 0) { c.moveTo(xf + sk, 0); c.lineTo(w, 0); c.lineTo(w, h); c.lineTo(xf - sk, h); }
    else { c.moveTo(0, 0); c.lineTo(xf + sk, 0); c.lineTo(xf - sk, h); c.lineTo(0, h); }
    c.closePath(); c.clip();
    c.drawImage(this.toC, 0, 0);
    c.restore();
    // the tear: dark shadow on the old side, a hard bright edge, a few jagged teeth
    const dpr = this.view.bgDpr || this.view.dpr;
    const band = 46 * dpr, sx = -d;     // shadow falls toward the OLD picture
    c.save();
    const g = c.createLinearGradient(xf, 0, xf + sx * band, 0);
    g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.beginPath();
    if (d > 0) { c.moveTo(xf + sk, 0); c.lineTo(xf + sk - band, 0); c.lineTo(xf - sk - band, h); c.lineTo(xf - sk, h); }
    else { c.moveTo(xf + sk, 0); c.lineTo(xf + sk + band, 0); c.lineTo(xf - sk + band, h); c.lineTo(xf - sk, h); }
    c.closePath(); c.fill();
    c.strokeStyle = '#ffffff'; c.lineWidth = 3 * dpr; c.lineJoin = 'miter';
    c.beginPath();
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const y = (h * i) / n, x = xf + sk - (2 * sk * i) / n + (i % 2 ? 9 : -9) * dpr * Math.sin(T.t * 40 + i);
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    }
    c.stroke();
    c.strokeStyle = '#ff3e3e'; c.lineWidth = 1.4 * dpr; c.stroke();
    c.restore();
  }
}
