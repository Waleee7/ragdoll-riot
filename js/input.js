// Input layer: keyboard, mouse and touch behind one action-based API.
//   held(action)     is the action down right now
//   pressed(action)  edge: true from the press until the next sim step ends
//   axis()           -1..1 horizontal (keys or virtual stick)
// Edges are latched, so a tap that lands between two sim steps (or during
// hit-stop) is never lost, and is never seen twice.
export const DEFAULT_KEYS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW', 'Space'],
  down: ['ArrowDown', 'KeyS'],
  punch: ['KeyJ'],
  kick: ['KeyK'],
  super: ['KeyL'],
};

export class Input {
  constructor({ canvas, touchRoot, keys = DEFAULT_KEYS }) {
    this.canvas = canvas;
    this.keys = keys;
    this.codeToActions = {};
    for (const [action, codes] of Object.entries(keys)) {
      for (const c of codes) (this.codeToActions[c] ||= []).push(action);
    }
    this.codes = new Set();
    this.latch = new Map();
    this.virtual = {};
    this.stick = { x: 0, y: 0 };
    this.aim = { x: 0, y: 0, at: -1e9 };
    // Touch UI is shown only on touch-first devices, or once a real touch is seen.
    this.touch = window.matchMedia('(pointer: coarse)').matches;
    this.onTouch = null;     // () => void, fired once when touch becomes active
    this.onGesture = null;   // () => void, any trusted user gesture (audio unlock)
    this.onKey = null;       // (KeyboardEvent) => void, for menu flow
    this.onPointerFlow = null; // (PointerEvent) => void, taps on the canvas

    addEventListener('keydown', (e) => this._keydown(e));
    addEventListener('keyup', (e) => this._keyup(e));
    addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });

    addEventListener('pointerdown', (e) => {
      this.onGesture?.();
      if (e.pointerType === 'touch') this._markTouch();
    }, { capture: true, passive: true });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this.aim.x = e.clientX; this.aim.y = e.clientY; this.aim.at = performance.now();
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      this.aim.x = e.clientX; this.aim.y = e.clientY; this.aim.at = performance.now();
      if (e.button === 0) this.latch.set('punch', 'mouse');
      else if (e.button === 2) this.latch.set('kick', 'mouse');
      this.onPointerFlow?.(e);
    });

    if (touchRoot) this._bindTouch(touchRoot);
  }

  held(action) {
    if (this.virtual[action]) return true;
    const codes = this.keys[action];
    if (codes) for (const c of codes) if (this.codes.has(c)) return true;
    return false;
  }
  pressed(action) { return this.latch.has(action); }
  source(action) { return this.latch.get(action); }
  axis() {
    const k = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    return k || this.stick.x;
  }
  endStep() { this.latch.clear(); }
  releaseAll() {
    this.codes.clear();
    for (const k of Object.keys(this.virtual)) this.virtual[k] = false;
    this.stick.x = this.stick.y = 0;
  }

  _markTouch() {
    if (this.touch) return;
    this.touch = true;
    this.onTouch?.();
  }

  _keydown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const acts = this.codeToActions[e.code];
    if (acts) {
      e.preventDefault();
      if (!e.repeat) for (const a of acts) this.latch.set(a, 'key');
      this.codes.add(e.code);
    }
    this.onGesture?.();
    this.onKey?.(e);
  }
  _keyup(e) { this.codes.delete(e.code); }

  _bindTouch(root) {
    const zone = root.querySelector('[data-stick-zone]');
    const base = root.querySelector('[data-stick]');
    const knob = root.querySelector('[data-knob]');
    const R = 54;
    let id = null, ox = 0, oy = 0;

    const setBase = (x, y) => {
      if (x === null) { base.style.removeProperty('left'); base.style.removeProperty('top'); base.style.removeProperty('bottom'); return; }
      const r = zone.getBoundingClientRect();
      base.style.left = `${x - r.left}px`; base.style.top = `${y - r.top}px`; base.style.bottom = 'auto';
    };
    const move = (x, y) => {
      let dx = x - ox, dy = y - oy;
      const len = Math.hypot(dx, dy) || 1;
      const m = Math.min(1, len / R);
      dx = (dx / len) * m; dy = (dy / len) * m;
      knob.style.transform = `translate(${dx * R}px, ${dy * R}px)`;
      const dz = (v) => (Math.abs(v) < 0.22 ? 0 : (v - Math.sign(v) * 0.22) / 0.78);
      this.stick.x = dz(dx); this.stick.y = dz(dy);
      const wantUp = dy < -0.6;
      if (wantUp && !this.virtual.up) this.latch.set('up', 'touch');
      this.virtual.up = wantUp;
      this.virtual.down = dy > 0.6;
    };
    const end = () => {
      id = null;
      this.stick.x = this.stick.y = 0;
      this.virtual.up = this.virtual.down = false;
      knob.style.transform = '';
      base.classList.remove('active');
      setBase(null);
    };

    zone.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      e.preventDefault();
      id = e.pointerId;
      zone.setPointerCapture(id);
      // Floating stick: centre it where the thumb lands (clamped inside the zone).
      const r = zone.getBoundingClientRect();
      ox = Math.min(Math.max(e.clientX, r.left + R + 8), r.right - R - 8);
      oy = Math.min(Math.max(e.clientY, r.top + R + 8), r.bottom - R - 8);
      setBase(ox, oy);
      base.classList.add('active');
      move(e.clientX, e.clientY);
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e.clientX, e.clientY); });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      zone.addEventListener(t, (e) => { if (e.pointerId === id) end(); });
    }

    for (const btn of root.querySelectorAll('[data-action]')) {
      const action = btn.dataset.action;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture(e.pointerId);
        this.virtual[action] = true;
        this.latch.set(action, 'touch');
        btn.classList.add('down');
      });
      const up = () => { this.virtual[action] = false; btn.classList.remove('down'); };
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(t, up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }
}
