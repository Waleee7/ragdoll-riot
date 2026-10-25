// A fighter is a Verlet rig with a state machine on top.
//   upright states (idle / atk / hurt / air): points are placed by a procedural pose,
//   rag / dead: the Verlet integrator owns the points (real weight, real flop),
//   getup: points are pulled back to the idle pose.
// Launching = leaving the pose and handing the points their current velocity.
import { Rig, DT, G, B, N, HEAD, NECK, PELV, ELB_B, HAND_B, ELB_F, HAND_F, KNEE_B, FOOT_B, KNEE_F, FOOT_F } from './rig.js';
import { ease, lerp, clamp } from './juice.js';

/* Attack specs. a..b is the active (damaging) window as a fraction of dur.
   vx/vy are launch velocities in units/s before dividing by the victim's mass. */
export const ATK = {
  p1:    { dur: 0.25, a: 0.30, b: 0.58, part: HAND_F, r: 15, dmg: 1, vx: 300, vy: -70,  power: 0.30, launch: false, kb: 150, lunge: 150 },
  p2:    { dur: 0.29, a: 0.32, b: 0.60, part: HAND_B, r: 16, dmg: 1, vx: 380, vy: -90,  power: 0.42, launch: false, kb: 200, lunge: 170 },
  p3:    { dur: 0.46, a: 0.38, b: 0.64, part: HAND_F, r: 19, dmg: 2, vx: 280, vy: -950, power: 0.78, launch: true,  kb: 0,   lunge: 80 },
  k:     { dur: 0.50, a: 0.30, b: 0.58, part: FOOT_F, r: 19, dmg: 2, vx: 980, vy: -250, power: 0.92, launch: true,  kb: 0,   lunge: 150 },
  e1:    { dur: 0.54, a: 0.56, b: 0.78, part: HAND_F, r: 17, dmg: 11, vx: 420, vy: -110, power: 0.40, launch: false, kb: 160, tele: true },
  e2:    { dur: 0.38, a: 0.52, b: 0.74, part: HAND_F, r: 15, dmg: 6,  vx: 300, vy: -90,  power: 0.30, launch: false, kb: 130, tele: true },
  bash:  { dur: 0.62, a: 0.55, b: 0.76, part: HAND_F, r: 24, dmg: 9,  vx: 560, vy: -180, power: 0.50, launch: false, kb: 280, tele: true },
  smash: { dur: 0.92, a: 0.66, b: 0.84, part: HAND_F, r: 30, dmg: 26, vx: 820, vy: -520, power: 0.85, launch: true,  kb: 0,   tele: true },
  bsmash:{ dur: 1.00, a: 0.68, b: 0.84, part: HAND_F, r: 40, dmg: 30, vx: 960, vy: -600, power: 0.95, launch: true,  kb: 0,   tele: true },
  // area attacks are resolved by the game (boss shockwaves, the player's super), not by a hit sphere
  stomp: { dur: 1.15, a: 0.60, b: 0.70, part: HAND_F, r: 0,  dmg: 16, vx: 0,   vy: 0,    power: 0.80, launch: true,  kb: 0,   tele: true, area: true },
  roar:  { dur: 0.55, a: 0.30, b: 0.55, part: HAND_F, r: 0,  dmg: 0,  vx: 0,   vy: 0,    power: 1.00, launch: true,  kb: 0,   area: true },
};

const KIND = {
  player: { scale: 1.0,  hp: 100, mass: 1.0, speed: 255, color: '#f4f5f9', back: '#b3b7c8', lw: 6.4 },
  grunt:  { scale: 1.0,  hp: 3,   mass: 1.0, speed: 92,  color: '#ff3e3e', back: '#b22a35', lw: 6.2 },
  runner: { scale: 0.9,  hp: 2,   mass: 0.8, speed: 172, color: '#ff3e3e', back: '#b22a35', lw: 5.4 },
  shield: { scale: 1.06, hp: 5,   mass: 1.4, speed: 64,  color: '#ff3e3e', back: '#a2232e', lw: 6.2 },
  brute:  { scale: 1.42, hp: 10,  mass: 2.6, speed: 58,  color: '#ff3e3e', back: '#a2232e', lw: 5.6 },
  boss:   { scale: 2.05, hp: 40,  mass: 5.0, speed: 50,  color: '#ff3e3e', back: '#8f1d28', lw: 5.0 },
};

const P = { lean: 0, pdx: 0, crouch: 0, bob: 0, tilt: 0, ffx: 0, ffy: 0, fbx: 0, fby: 0, hfx: 0, hfy: 0, hbx: 0, hby: 0 };
const J = { jx: 0, jy: 0, ex: 0, ey: 0 };

// Two-bone IK. Writes the joint (knee/elbow) and the reachable end point into J.
function ik(ax, ay, tx, ty, l1, l2, bend) {
  let dx = tx - ax, dy = ty - ay;
  let d = Math.hypot(dx, dy) || 0.001;
  const maxD = l1 + l2 - 0.01, minD = Math.abs(l1 - l2) + 0.01;
  const cd = clamp(d, minD, maxD);
  const ux = dx / d, uy = dy / d;
  const a = (l1 * l1 - l2 * l2 + cd * cd) / (2 * cd);
  const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
  J.ex = ax + ux * cd; J.ey = ay + uy * cd;
  J.jx = ax + ux * a + bend * -uy * h;
  J.jy = ay + uy * a + bend * ux * h;
}

export class Fighter {
  constructor(kind, x, groundY) {
    const k = KIND[kind];
    this.kind = kind; this.team = kind === 'player' ? 'p' : 'e';
    this.k = k; this.s = k.scale; this.mass = k.mass;
    this.maxHp = k.hp; this.hp = k.hp;
    this.groundY = groundY;
    this.x = x; this.y = groundY; this.vx = 0; this.vy = 0; this.face = kind === 'player' ? 1 : -1;
    this.onGround = true;
    this.state = 'idle'; this.t = 0; this.time = Math.random() * 6;
    this.atk = null; this.atkName = ''; this.atkHit = new Set(); this.chainT = 0; this.lastPunch = -1;
    this.stunT = 0; this.flash = 0; this.invuln = 0; this.shakeT = 0;
    this.walkPh = Math.random() * 6; this.tele = false;
    this.ragT = 0; this.restT = 0; this.deadT = 0; this.fade = 1;
    this.bowl = false; this.bowled = new Set(); this.credit = false;
    this.guard = kind === 'shield';   // shield up: blocks punches from the front
    this.armor = kind === 'boss';     // flinches but never staggers or launches until KO
    this.zapCd = 0; this.stompFired = false;
    this.lo = -1e5; this.hi = 1e5; this.entering = false;
    this.evLand = 0; this.evGetup = false;
    this.tx = new Float32Array(N); this.ty = new Float32Array(N);
    this.rig = new Rig(this.s, 1);
    // AI state
    this.ai = { engage: false, cd: 0.6 + Math.random() * 0.8, hover: 150 + Math.random() * 90, jitter: Math.random() * 6 };
    this.speedMul = 1;
    this.pose();
    this.rig.snapPose(this.tx, this.ty);
    // scarf (player only): a short trailing chain
    this.scarf = kind === 'player' ? Array.from({ length: 6 }, () => ({ x: x, y: groundY - 70, px: x, py: groundY - 70 })) : null;
  }

  get alive() { return this.hp > 0; }
  get ragdolled() { return this.state === 'rag' || this.state === 'dead'; }
  get canAct() { return this.state === 'idle'; }

  /* ---------- state changes ---------- */
  startAttack(name) {
    this.atkName = name; this.atk = ATK[name]; this.atkHit.clear();
    this.state = 'atk'; this.t = 0;
    this.chainT = 0;
  }

  stagger(vx, dur) {
    this.state = 'hurt'; this.t = 0; this.stunT = dur; this.vx = vx; this.atk = null; this.tele = false;
    this.ai.engage = false;
  }

  launch(vx, vy, spin = 0) {
    this.state = this.hp > 0 ? 'rag' : 'dead';
    this.t = 0; this.ragT = 0; this.restT = 0; this.atk = null; this.tele = false;
    this.onGround = false; this.bowled.clear(); this.ai.engage = false;
    this.rig.launch(vx, vy, spin);
  }

  die() { if (this.state === 'rag') this.state = 'dead'; this.deadT = 0; }

  /* ---------- per-step ---------- */
  step(w) {
    this.groundY = w.groundY;
    this.time += DT; this.t += DT;
    if (this.flash > 0) this.flash -= DT;
    if (this.invuln > 0) this.invuln -= DT;
    if (this.shakeT > 0) this.shakeT -= DT;
    if (this.chainT > 0) this.chainT -= DT;
    if (this.zapCd > 0) this.zapCd -= DT;
    this.ai.cd -= DT;
    if (this.state === 'rag' || this.state === 'dead') this.stepRag(w);
    else if (this.state === 'getup') this.stepGetup(w);
    else this.stepKin(w);
    if (this.scarf) this.stepScarf();
  }

  stepKin(w) {
    const r = this.rig;
    // root motion
    if (!this.onGround) this.vy += G * DT;
    this.x += this.vx * DT;
    this.y += this.vy * DT;
    if (this.y >= w.groundY) {
      if (!this.onGround && this.vy > 380) this.evLand = this.vy;
      this.y = w.groundY; this.vy = 0; this.onGround = true;
    } else this.onGround = false;
    this.x = clamp(this.x, this.lo, this.hi);

    if (this.state === 'hurt') {
      this.vx *= 0.9;
      if (this.t >= this.stunT) { this.state = 'idle'; this.t = 0; }
    } else if (this.state === 'atk') {
      this.vx *= 0.86;
      if (this.t >= this.atk.dur) {
        const wasPunch = this.atkName[0] === 'p';
        this.state = 'idle'; this.t = 0; this.atk = null; this.tele = false;
        if (wasPunch) this.chainT = 0.38;
      }
    }
    if (this.onGround) this.walkPh += this.vx * this.face * DT * 0.075;

    this.pose();
    r.setPose(this.tx, this.ty);
  }

  stepRag(w) {
    const r = this.rig;
    r.integrate();
    r.solve(w.groundY, w.minX, w.maxX);
    this.ragT += DT;
    this.x = r.x[PELV]; this.y = w.groundY; this.vx = 0; this.vy = 0;
    this.onGround = r.grounded;
    if (this.state === 'dead') { this.deadT += DT; return; }
    if (r.grounded && r.energy() < 70) this.restT += DT; else this.restT = 0;
    if ((this.restT > 0.32 && this.ragT > 0.55) || this.ragT > 4.2) this.beginGetup(w);
  }

  beginGetup(w) {
    this.state = 'getup'; this.t = 0; this.bowl = false;
    this.x = clamp(this.rig.x[PELV], w.minX + 30, w.maxX - 30);
    this.y = w.groundY; this.onGround = true; this.vx = 0; this.vy = 0;
    this.evGetup = true;
    if (this.team === 'p') this.invuln = 1.1;
  }

  stepGetup(w) {
    const T = 0.5;
    this.pose();
    const k = 0.07 + 0.5 * ease.inQuad(clamp(this.t / T, 0, 1));
    this.rig.blendPose(this.tx, this.ty, k);
    this.x = this.rig.x[PELV];
    if (this.t >= T) { this.state = 'idle'; this.t = 0; this.ai.cd = Math.max(this.ai.cd, 0.4); }
  }

  stepScarf() {
    const s = this.scarf, r = this.rig, sc = this.s;
    s[0].px = s[0].x; s[0].py = s[0].y;
    s[0].x = r.x[NECK]; s[0].y = r.y[NECK] + 1;
    const drift = -this.face * 0.5 - this.vx * DT * 0.12;
    for (let i = 1; i < s.length; i++) {
      const p = s[i];
      const vx = (p.x - p.px) * 0.9, vy = (p.y - p.py) * 0.9;
      p.px = p.x; p.py = p.y;
      p.x += vx + drift; p.y += vy + 0.22;
      const q = s[i - 1];
      let dx = p.x - q.x, dy = p.y - q.y;
      const d = Math.hypot(dx, dy) || 1, L = 6.4 * sc;
      p.x = q.x + (dx / d) * L; p.y = q.y + (dy / d) * L;
    }
  }

  /* ---------- procedural pose ---------- */
  pose() {
    const s = this.s, d = this.face;
    P.lean = 0.12; P.pdx = 0; P.crouch = 0; P.bob = 0; P.tilt = 0;
    P.ffx = 14; P.ffy = 0; P.fbx = -14; P.fby = 0;
    P.hfx = 20; P.hfy = -2; P.hbx = 12; P.hby = 8;
    this.tele = false;

    const st = this.state;
    if (st === 'atk' && this.atk) this.poseAttack();
    else if (st === 'hurt') {
      const k = ease.outQuad(clamp(this.t / 0.1, 0, 1));
      P.lean = lerp(0.12, -0.4, k); P.tilt = -0.25 * k; P.crouch = 3 * k;
      P.hfx = lerp(20, -10, k); P.hfy = lerp(-2, -18, k);
      P.hbx = lerp(12, -26, k); P.hby = lerp(8, -4, k);
      P.ffx = 22; P.fbx = -18;
    } else if (!this.onGround) {
      P.lean = 0.06; P.ffx = 20; P.ffy = 18; P.fbx = -8; P.fby = 10; P.crouch = -2;
      P.hfx = 24; P.hfy = -28; P.hbx = -2; P.hby = -24;
    } else if (Math.abs(this.vx) > 14) {
      const ph = this.walkPh, sw = Math.sin(ph), cw = Math.cos(ph);
      const run = clamp(Math.abs(this.vx) / this.k.speed, 0, 1.2);
      const amp = 16 + 8 * run;
      P.ffx = 4 + sw * amp; P.fbx = -4 - sw * amp;
      P.ffy = Math.max(0, cw) * (6 + 6 * run); P.fby = Math.max(0, -cw) * (6 + 6 * run);
      P.bob = -Math.abs(cw) * 2.4; P.lean = 0.12 + 0.12 * run;
      P.hfx = 18 - sw * 6; P.hbx = 10 + sw * 6; P.hby = 8 - cw * 3; P.hfy = -3 + cw * 3;
    } else {
      P.bob = Math.sin(this.time * 4.2) * 1.3;
      P.hfy = -2 + Math.sin(this.time * 4.2 + 1) * 1.5;
    }

    const hipH = (B.thigh + B.shin) * s * 0.94;
    const pelX = this.x + d * P.pdx * s;
    const pelY = this.y - hipH + (P.crouch + P.bob) * s;
    const lean = P.lean;
    const neckX = pelX + d * Math.sin(lean) * B.torso * s;
    const neckY = pelY - Math.cos(lean) * B.torso * s;
    const hl = lean * 1.2 + P.tilt;
    const headX = neckX + d * Math.sin(hl) * B.head * s;
    const headY = neckY - Math.cos(hl) * B.head * s;

    const tx = this.tx, ty = this.ty;
    tx[HEAD] = headX; ty[HEAD] = headY;
    tx[NECK] = neckX; ty[NECK] = neckY;
    tx[PELV] = pelX; ty[PELV] = pelY;

    const th = B.thigh * s, sh = B.shin * s, ua = B.uarm * s, fa = B.farm * s;
    // legs: knees bend toward the facing direction
    ik(pelX, pelY, this.x + d * P.ffx * s, this.y - P.ffy * s, th, sh, -d);
    tx[KNEE_F] = J.jx; ty[KNEE_F] = J.jy; tx[FOOT_F] = J.ex; ty[FOOT_F] = J.ey;
    ik(pelX, pelY, this.x + d * P.fbx * s, this.y - P.fby * s, th, sh, -d);
    tx[KNEE_B] = J.jx; ty[KNEE_B] = J.jy; tx[FOOT_B] = J.ex; ty[FOOT_B] = J.ey;
    // arms: elbows hang down/back
    ik(neckX, neckY, neckX + d * P.hfx * s, neckY + P.hfy * s, ua, fa, d);
    tx[ELB_F] = J.jx; ty[ELB_F] = J.jy; tx[HAND_F] = J.ex; ty[HAND_F] = J.ey;
    ik(neckX, neckY, neckX + d * P.hbx * s, neckY + P.hby * s, ua, fa, d);
    tx[ELB_B] = J.jx; ty[ELB_B] = J.jy; tx[HAND_B] = J.ex; ty[HAND_B] = J.ey;
  }

  poseAttack() {
    const a = this.atk, name = this.atkName, u = clamp(this.t / a.dur, 0, 1);
    if (name === 'p1' || name === 'p2' || name === 'e1' || name === 'e2') {
      let e;
      if (a.tele) {
        // long, readable wind-up: pull back, hold with a tremble, then snap
        if (u < a.a * 0.35) e = -0.55 * ease.outQuad(u / (a.a * 0.35));
        else if (u < a.a * 0.82) e = -0.55 + Math.sin(this.t * 90) * 0.04;
        else if (u < a.a) e = lerp(-0.55, 1, ease.inCubic((u - a.a * 0.82) / (a.a * 0.18)));
        else if (u < a.b) e = 1;
        else e = 1 - ease.inOutQuad((u - a.b) / (1 - a.b));
        this.tele = u < a.a;
      } else if (u < a.a) {
        const k = u / a.a;
        e = k < 0.4 ? -0.3 * ease.outQuad(k / 0.4) : lerp(-0.3, 1, ease.inOutQuad((k - 0.4) / 0.6));
      } else if (u < a.b) e = 1;
      else e = 1 - ease.inOutQuad((u - a.b) / (1 - a.b));

      if (name === 'p2') {
        P.hbx = 12 + e * 62; P.hby = -3; P.hfx = 18; P.hfy = 0;
        P.lean = 0.1 + 0.24 * e; P.pdx = e * 12; P.ffx = 20 + e * 8; P.fbx = -16 - e * 4;
      } else {
        P.hfx = 18 + e * 54; P.hfy = -4 - e * 2; P.hbx = 8; P.hby = 6;
        P.lean = 0.12 + 0.2 * e; P.pdx = e * 9; P.ffx = 16 + e * 8;
      }
    } else if (name === 'p3') {
      // uppercut: sink, then explode upward
      if (u < a.a) {
        const k = ease.outQuad(u / a.a);
        P.crouch = 16 * k; P.hfx = lerp(20, 12, k); P.hfy = lerp(-2, 28, k); P.lean = lerp(0.12, 0.3, k);
        P.hbx = 6; P.hby = 12; P.ffx = 20; P.fbx = -18;
      } else {
        const k = u < a.b ? ease.outCubic((u - a.a) / (a.b - a.a)) : 1 - ease.inOutQuad((u - a.b) / (1 - a.b)) * 0.9;
        const q = clamp(k, 0, 1);
        P.crouch = lerp(16, -7, q); P.hfx = lerp(12, 24, q); P.hfy = lerp(28, -64, q);
        P.lean = lerp(0.3, -0.06, q); P.pdx = 8 * q; P.hbx = 4; P.hby = lerp(12, -10, q);
        P.ffx = 22; P.ffy = 0; P.fbx = -18; P.fby = q * 8;
      }
    } else if (name === 'k') {
      let e;
      if (u < a.a) e = 0.35 * ease.outQuad(u / a.a);
      else if (u < a.b) e = lerp(0.35, 1, ease.outCubic(Math.min(1, (u - a.a) / ((a.b - a.a) * 0.4))));
      else e = 1 - ease.inOutQuad((u - a.b) / (1 - a.b));
      P.ffx = lerp(14, 60, e); P.ffy = lerp(0, 42, e); P.pdx = 12 * e;
      P.lean = lerp(0.12, -0.3, e); P.tilt = -0.2 * e; P.fbx = -16 - 6 * e;
      P.hfx = lerp(20, -4, e); P.hfy = lerp(-2, 12, e); P.hbx = lerp(12, -26, e); P.hby = lerp(8, -14, e);
    } else if (name === 'bash') {
      // shield bash: brace behind the shield, then shove it forward
      let e;
      if (u < a.a) {
        const k = u / a.a;
        e = k < 0.6 ? -0.4 * ease.outQuad(k / 0.6) : -0.4 + Math.sin(this.t * 80) * 0.03;
      } else if (u < a.b) e = lerp(-0.4, 1, ease.outCubic(Math.min(1, (u - a.a) / ((a.b - a.a) * 0.5))));
      else e = 1 - ease.inOutQuad((u - a.b) / (1 - a.b));
      P.hfx = 22 + e * 30; P.hfy = -6; P.hbx = 16 + e * 24; P.hby = 2;
      P.lean = 0.14 + 0.22 * e; P.pdx = e * 14; P.ffx = 18 + e * 10; P.fbx = -18;
      this.tele = u < a.a;
    } else if (name === 'stomp') {
      // boss ground-pound: fists up and trembling, then slammed into the floor
      if (u < a.a) {
        const k = ease.inOutQuad(Math.min(1, (u / a.a) / 0.8));
        P.hfx = lerp(20, 4, k); P.hfy = lerp(-2, -70, k); P.hbx = lerp(12, -4, k); P.hby = lerp(8, -66, k);
        P.lean = lerp(0.12, -0.2, k); P.crouch = -4 * k;
        if (u / a.a > 0.8) P.hfy += Math.sin(this.t * 70) * 2;
        this.tele = true;
      } else {
        const k = u < a.b ? ease.outCubic((u - a.a) / (a.b - a.a)) : 1 - ease.inOutQuad((u - a.b) / (1 - a.b)) * 0.85;
        const q = clamp(k, 0, 1);
        P.hfx = lerp(4, 34, q); P.hfy = lerp(-70, 60, q); P.hbx = lerp(-4, 26, q); P.hby = lerp(-66, 58, q);
        P.lean = lerp(-0.2, 0.6, q); P.crouch = 18 * q; P.ffx = 24; P.fbx = -24;
      }
    } else if (name === 'roar') {
      // the player's super: sink, then throw the arms wide
      const k = u < a.a ? ease.outQuad(u / a.a) : 1;
      P.crouch = 10 * k * (u < a.a ? 1 : 1 - (u - a.a) / (1 - a.a));
      P.hfx = lerp(20, 26, k); P.hfy = lerp(-2, -40, k); P.hbx = lerp(12, -24, k); P.hby = lerp(8, -40, k);
      P.lean = lerp(0.12, -0.18, k); P.tilt = -0.25 * k; P.ffx = 22; P.fbx = -22;
    } else if (name === 'smash' || name === 'bsmash') {
      if (u < a.a) {
        const k = u / a.a;
        const up = ease.inOutQuad(Math.min(1, k / 0.72));
        P.hfx = lerp(20, 6, up); P.hfy = lerp(-2, -78, up);
        P.hbx = P.hfx - 6; P.hby = P.hfy + 4;
        P.lean = lerp(0.12, -0.32, up); P.crouch = -3 * up;
        if (k > 0.72) { P.hfx += Math.sin(this.t * 80) * 1.5; }
        if (k > 0.84) { const s2 = ease.inCubic((k - 0.84) / 0.16); P.hfx = lerp(6, 30, s2); P.hfy = lerp(-78, -30, s2); P.hbx = P.hfx - 6; P.hby = P.hfy + 4; P.lean = lerp(-0.32, 0.1, s2); }
        this.tele = true;
      } else {
        const k = u < a.b ? 1 : 1 - ease.inOutQuad((u - a.b) / (1 - a.b));
        P.hfx = lerp(20, 52, k); P.hfy = lerp(-2, 36, k); P.hbx = P.hfx - 8; P.hby = P.hfy + 4;
        P.lean = lerp(0.12, 0.55, k); P.pdx = 18 * k; P.crouch = 11 * k; P.ffx = 24 * k + 8; P.fbx = -22;
      }
    }
  }
}

/* ---------- drawing ---------- */
const X = new Float32Array(N), Y = new Float32Array(N);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

export function drawShadow(ctx, f, alpha) {
  const r = f.rig;
  const px = r.px[PELV] + (r.x[PELV] - r.px[PELV]) * alpha;
  const lowest = Math.max(r.y[FOOT_B], r.y[FOOT_F], r.y[PELV]);
  const h = clamp((f.groundY - lowest) / 260, 0, 1);
  const a = 0.38 * (1 - h) * f.fade;
  if (a < 0.02) return;
  const w = (f.ragdolled ? 46 : 30) * f.s * (1 - h * 0.5);
  ctx.globalAlpha = a;
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(px, f.groundY + 3, w, 6 * f.s, 0, 0, 6.2832); ctx.fill();
  ctx.globalAlpha = 1;
}

export function drawFighter(ctx, f, alpha, reduced, hitstopping) {
  const r = f.rig, k = f.k, s = f.s;
  let jx = 0, jy = 0;
  if (hitstopping && f.shakeT > 0) { jx = (Math.random() - 0.5) * 5; jy = (Math.random() - 0.5) * 3; }
  for (let i = 0; i < N; i++) {
    X[i] = r.px[i] + (r.x[i] - r.px[i]) * alpha + jx;
    Y[i] = r.py[i] + (r.y[i] - r.py[i]) * alpha + jy;
  }
  const flash = f.flash > 0;
  const main = flash ? '#ffffff' : k.color;
  const back = flash ? '#dfe2ee' : k.back;
  const lw = k.lw * s;

  let a = f.fade;
  if (f.invuln > 0 && !f.ragdolled && f.state !== 'getup') a *= reduced ? 0.7 : (Math.floor(f.time / 0.07) % 2 ? 0.45 : 0.95);
  ctx.globalAlpha = a;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = lw;

  // scarf sits behind the body
  if (f.scarf) {
    ctx.strokeStyle = '#ff3e3e';
    const sc = f.scarf;
    for (let i = 1; i < sc.length; i++) {
      ctx.lineWidth = Math.max(1.6, 5.4 - i * 0.8);
      ctx.beginPath();
      ctx.moveTo(sc[i - 1].px + (sc[i - 1].x - sc[i - 1].px) * alpha, sc[i - 1].py + (sc[i - 1].y - sc[i - 1].py) * alpha);
      ctx.lineTo(sc[i].px + (sc[i].x - sc[i].px) * alpha, sc[i].py + (sc[i].y - sc[i].py) * alpha);
      ctx.stroke();
    }
    ctx.lineWidth = lw;
  }

  const path = (a0, a1, a2) => { ctx.beginPath(); ctx.moveTo(X[a0], Y[a0]); ctx.lineTo(X[a1], Y[a1]); ctx.lineTo(X[a2], Y[a2]); ctx.stroke(); };

  ctx.strokeStyle = back;
  path(NECK, ELB_B, HAND_B);
  path(PELV, KNEE_B, FOOT_B);
  ctx.strokeStyle = main;
  ctx.beginPath(); ctx.moveTo(X[NECK], Y[NECK]); ctx.lineTo(X[PELV], Y[PELV]); ctx.stroke();
  if (f.kind === 'brute' || f.kind === 'boss') {
    // shoulder plate
    ctx.lineWidth = lw * 1.7; ctx.strokeStyle = flash ? '#fff' : '#c8283a';
    const nx = X[NECK], ny = Y[NECK], tx = X[HEAD] - nx, ty = Y[HEAD] - ny, tl = Math.hypot(tx, ty) || 1;
    const px = -ty / tl * 6.4 * s, py = tx / tl * 6.4 * s;
    ctx.beginPath(); ctx.moveTo(nx - px, ny - py); ctx.lineTo(nx + px, ny + py); ctx.stroke();
    ctx.lineWidth = lw; ctx.strokeStyle = main;
  }
  path(PELV, KNEE_F, FOOT_F);
  path(NECK, ELB_F, HAND_F);

  // fists
  ctx.fillStyle = main;
  ctx.beginPath(); ctx.arc(X[HAND_F], Y[HAND_F], lw * (f.tele ? 1.15 : 0.78), 0, 6.2832); ctx.fill();
  ctx.beginPath(); ctx.arc(X[HAND_B], Y[HAND_B], lw * 0.7, 0, 6.2832); ctx.fill();

  // head
  const hr = B.headR * s;
  if (f.kind === 'runner') {
    // headband tails stream out behind, longer at a sprint
    const d = f.face, hx = X[HEAD] - d * hr * 0.8, hy = Y[HEAD] - hr * 0.35;
    const wag = Math.sin(f.time * 18) * 3 * s, stretch = 1 + Math.min(1, Math.abs(f.vx) / 180) * 0.8;
    ctx.strokeStyle = flash ? '#fff' : '#ffd0d0'; ctx.lineWidth = 2.2 * s;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - d * 14 * s * stretch, hy + 3 * s + wag); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hx, hy + 2 * s); ctx.lineTo(hx - d * 11 * s * stretch, hy + 9 * s - wag); ctx.stroke();
    ctx.lineWidth = lw;
  }
  ctx.beginPath(); ctx.arc(X[HEAD], Y[HEAD], hr, 0, 6.2832); ctx.fill();
  if (f.kind === 'runner' && !flash) {
    ctx.strokeStyle = '#ffd0d0'; ctx.lineWidth = 2.4 * s;
    ctx.beginPath(); ctx.moveTo(X[HEAD] - hr * 0.96, Y[HEAD] - hr * 0.35); ctx.lineTo(X[HEAD] + hr * 0.96, Y[HEAD] - hr * 0.35); ctx.stroke();
  }
  if (f.kind === 'brute' || f.kind === 'boss') {
    ctx.strokeStyle = flash ? '#fff' : '#ffd0d0'; ctx.lineWidth = 2.4 * s;
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(X[HEAD] + sgn * hr * 0.7, Y[HEAD] - hr * 0.55);
      ctx.lineTo(X[HEAD] + sgn * hr * 1.35, Y[HEAD] - hr * 1.5);
      ctx.stroke();
    }
  }
  // eye slit shows facing
  if (!flash) {
    ctx.strokeStyle = '#090a0f'; ctx.lineWidth = 2.6 * Math.min(1.3, s);
    const dir = f.face;
    const dead = f.state === 'dead';
    if (f.kind === 'boss' && !dead) {
      // shades, with a glint
      const x0 = X[HEAD] + dir * hr * 0.05, x1 = X[HEAD] + dir * hr * 0.98;
      ctx.fillStyle = '#090a0f';
      ctx.fillRect(Math.min(x0, x1), Y[HEAD] - hr * 0.42, Math.abs(x1 - x0), hr * 0.4);
      ctx.fillStyle = '#eceef4';
      ctx.fillRect(X[HEAD] + dir * hr * 0.62 - 1.5, Y[HEAD] - hr * 0.36, 3, 2.4);
    } else {
      ctx.beginPath();
      if (dead) { // X eyes
        const ex = X[HEAD] + dir * hr * 0.45, ey = Y[HEAD] - 1;
        ctx.moveTo(ex - 2.5, ey - 2.5); ctx.lineTo(ex + 2.5, ey + 2.5); ctx.moveTo(ex + 2.5, ey - 2.5); ctx.lineTo(ex - 2.5, ey + 2.5);
      } else { ctx.moveTo(X[HEAD] + dir * hr * 0.15, Y[HEAD] - 1.5); ctx.lineTo(X[HEAD] + dir * hr * 0.78, Y[HEAD] - 1.5); }
      ctx.stroke();
    }
  }

  // riot shield on the front arm while the guard is up
  if (f.guard && !f.ragdolled) {
    const d = f.face, w = 12 * s, h = 54 * s;
    const cx = X[HAND_F] + d * 4 * s, cy = Y[HAND_F] + 6 * s;
    ctx.fillStyle = flash ? '#ffffff' : 'rgba(16,18,26,.94)';
    ctx.strokeStyle = flash ? '#ffffff' : '#eceef4'; ctx.lineWidth = 2.6 * s;
    roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 4 * s);
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#ff3e3e'; ctx.lineWidth = 2 * s;
    ctx.beginPath(); ctx.moveTo(cx - w / 2 + 2 * s, cy - 4 * s); ctx.lineTo(cx + w / 2 - 2 * s, cy - 4 * s); ctx.stroke();
  }

  // attack telegraph: a bold "!" over the head
  if (f.tele && f.team === 'e') {
    const blink = Math.floor(f.t / 0.06) % 2 === 0;
    ctx.globalAlpha = 1;
    ctx.fillStyle = blink ? '#ffffff' : '#ff3e3e';
    ctx.strokeStyle = '#090a0f'; ctx.lineWidth = 4;
    ctx.font = `${Math.round(26 * Math.min(1.4, s))}px "Futura Condensed ExtraBold","Impact","Arial Narrow Bold",sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.strokeText('!', X[HEAD], Y[HEAD] - hr - 16 * s); ctx.fillText('!', X[HEAD], Y[HEAD] - hr - 16 * s);
  }
  ctx.globalAlpha = 1;
}
