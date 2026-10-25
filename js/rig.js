// Verlet ragdoll rig: 11 point-masses joined by distance sticks.
// The same point set is also driven kinematically by poses while a fighter is
// upright (see fighter.js), so launching one into a ragdoll is just "stop
// overwriting the points and let the integrator take over" with the velocity
// the points already had.
export const DT = 1 / 60;
export const G = 2400;                 // gravity, units/s^2
const GSTEP = G * DT * DT;             // per-step displacement

export const HEAD = 0, NECK = 1, PELV = 2, ELB_B = 3, HAND_B = 4, ELB_F = 5, HAND_F = 6,
  KNEE_B = 7, FOOT_B = 8, KNEE_F = 9, FOOT_F = 10;
export const N = 11;

// body proportions (scale 1 stands ~100 units tall)
export const B = { head: 14, torso: 32, thigh: 22, shin: 22, uarm: 17, farm: 17, headR: 10.5 };

// Heavy trunk, light extremities: impulses fan out into believable flop.
const MASS = [1.3, 2.4, 3.4, 0.6, 0.45, 0.6, 0.45, 1.3, 0.95, 1.3, 0.95];
const RAD = [10.5, 3, 4.5, 2.5, 3.5, 2.5, 3.5, 3, 4, 3, 4];

const REST = 0.28;      // ground bounce
const FRIC = 0.86;      // ground friction per step (velocity kept)
const WALL_REST = 0.45;
const AIR = 0.9985;

export class Rig {
  constructor(scale = 1, massMul = 1) {
    this.s = scale;
    this.massMul = massMul;
    this.x = new Float32Array(N); this.y = new Float32Array(N);
    this.px = new Float32Array(N); this.py = new Float32Array(N);
    this.vyPre = new Float32Array(N); this.vxPre = new Float32Array(N);
    this.im = new Float32Array(N);       // inverse mass
    this.rad = new Float32Array(N);
    for (let i = 0; i < N; i++) { this.im[i] = 1 / (MASS[i] * massMul); this.rad[i] = RAD[i] * scale; }
    const s = scale;
    // [a, b, length, stiffness, minOnly]
    this.sticks = [
      [HEAD, NECK, B.head * s, 1, 0], [NECK, PELV, B.torso * s, 1, 0],
      [NECK, ELB_B, B.uarm * s, 1, 0], [ELB_B, HAND_B, B.farm * s, 1, 0],
      [NECK, ELB_F, B.uarm * s, 1, 0], [ELB_F, HAND_F, B.farm * s, 1, 0],
      [PELV, KNEE_B, B.thigh * s, 1, 0], [KNEE_B, FOOT_B, B.shin * s, 1, 0],
      [PELV, KNEE_F, B.thigh * s, 1, 0], [KNEE_F, FOOT_F, B.shin * s, 1, 0],
      // keeps the spine from folding the head into the pelvis
      [HEAD, PELV, (B.head + B.torso) * s * 0.9, 0.35, 1],
    ];
    // result of the last solve()
    this.impact = 0; this.impactX = 0; this.impactY = 0;
    this.wallHit = 0; this.wallX = 0; this.wallY = 0;
    this.grounded = false;
  }

  // Kinematic: place every point at its target, keeping Verlet history for velocity.
  setPose(tx, ty) {
    for (let i = 0; i < N; i++) {
      this.px[i] = this.x[i]; this.py[i] = this.y[i];
      this.x[i] = tx[i]; this.y[i] = ty[i];
    }
  }

  // Teleport with zero velocity.
  snapPose(tx, ty) {
    for (let i = 0; i < N; i++) {
      this.x[i] = this.px[i] = tx[i]; this.y[i] = this.py[i] = ty[i];
    }
  }

  // Pull points toward targets by factor k (get-up).
  blendPose(tx, ty, k) {
    for (let i = 0; i < N; i++) {
      this.px[i] = this.x[i]; this.py[i] = this.y[i];
      this.x[i] += (tx[i] - this.x[i]) * k;
      this.y[i] += (ty[i] - this.y[i]) * k;
    }
  }

  // Give every point a velocity (units/s) with per-limb scatter and a bit of spin.
  launch(vx, vy, spin = 0) {
    const cx = this.x[PELV], cy = this.y[PELV];
    for (let i = 0; i < N; i++) {
      const light = 1 + (1 / (MASS[i] * 0.45)) * 0.045; // extremities whip a little faster
      const rx = this.x[i] - cx, ry = this.y[i] - cy;
      const jx = (Math.random() - 0.5) * 0.12, jy = (Math.random() - 0.5) * 0.12;
      const ux = (vx * light * (1 + jx) - ry * spin) * DT;
      const uy = (vy * light * (1 + jy) + rx * spin) * DT;
      this.px[i] = this.x[i] - ux; this.py[i] = this.y[i] - uy;
    }
  }

  // Add a velocity change to all points (juggle hits, bowling).
  kick(vx, vy) {
    for (let i = 0; i < N; i++) { this.px[i] -= vx * DT; this.py[i] -= vy * DT; }
  }

  scaleVelocity(k) {
    for (let i = 0; i < N; i++) {
      this.px[i] = this.x[i] - (this.x[i] - this.px[i]) * k;
      this.py[i] = this.y[i] - (this.y[i] - this.py[i]) * k;
    }
  }

  // Average speed of the trunk in units/s (for rest + bowling checks).
  speed() {
    const a = PELV, b = NECK;
    const vx = (this.x[a] - this.px[a] + this.x[b] - this.px[b]) * 0.5;
    const vy = (this.y[a] - this.py[a] + this.y[b] - this.py[b]) * 0.5;
    return Math.hypot(vx, vy) / DT;
  }

  // Total motion of all points (units/s), for deciding the body has come to rest.
  energy() {
    let e = 0;
    for (let i = 0; i < N; i++) e += Math.abs(this.x[i] - this.px[i]) + Math.abs(this.y[i] - this.py[i]);
    return (e / N) / DT;
  }

  integrate() {
    for (let i = 0; i < N; i++) {
      const vx = (this.x[i] - this.px[i]) * AIR;
      const vy = (this.y[i] - this.py[i]) * AIR;
      this.px[i] = this.x[i]; this.py[i] = this.y[i];
      this.x[i] += vx; this.y[i] += vy + GSTEP;
      this.vyPre[i] = vy + GSTEP; this.vxPre[i] = vx;
    }
  }

  solve(groundY, minX, maxX, iters = 7) {
    const x = this.x, y = this.y, im = this.im, rad = this.rad, sticks = this.sticks;
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < sticks.length; k++) {
        const st = sticks[k], a = st[0], b = st[1];
        let dx = x[b] - x[a], dy = y[b] - y[a];
        const d = Math.hypot(dx, dy);
        if (d < 1e-6) continue;
        if (st[4] && d >= st[2]) continue;
        const diff = ((d - st[2]) / d) * st[3];
        const w = im[a] + im[b];
        dx *= diff / w; dy *= diff / w;
        x[a] += dx * im[a]; y[a] += dy * im[a];
        x[b] -= dx * im[b]; y[b] -= dy * im[b];
      }
      for (let i = 0; i < N; i++) {
        const lim = groundY - rad[i];
        if (y[i] > lim) y[i] = lim;
        const lo = minX + rad[i], hi = maxX - rad[i];
        if (x[i] < lo) x[i] = lo; else if (x[i] > hi) x[i] = hi;
      }
    }

    // velocity response once per step (not once per iteration)
    this.impact = 0; this.wallHit = 0; this.grounded = false;
    for (let i = 0; i < N; i++) {
      const lim = groundY - rad[i];
      if (y[i] >= lim - 0.05) {
        this.grounded = true;
        const v = this.vyPre[i];
        if (v > this.impact && v > 1.2) { this.impact = v; this.impactX = x[i]; this.impactY = groundY; }
        this.py[i] = v > 3 ? y[i] + v * REST : y[i];       // bounce only on a real hit
        const vx = x[i] - this.px[i];
        this.px[i] = x[i] - vx * FRIC;
      }
      const lo = minX + rad[i], hi = maxX - rad[i];
      if (x[i] <= lo + 0.05 || x[i] >= hi - 0.05) {
        const v = this.vxPre[i];
        const into = (x[i] <= lo + 0.05 && v < 0) || (x[i] >= hi - 0.05 && v > 0);
        if (into) {
          if (Math.abs(v) > this.wallHit && Math.abs(v) > 2.5) { this.wallHit = Math.abs(v); this.wallX = x[i]; this.wallY = y[i]; }
          this.px[i] = Math.abs(v) > 2.5 ? x[i] + v * WALL_REST : x[i];  // reflect, damped
        }
      }
    }
  }
}
