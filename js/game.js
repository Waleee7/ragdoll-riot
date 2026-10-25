// RAGDOLL RIOT: a stickman ragdoll arena brawler.
// Punch, kick and launch waves of stickmen. Hits are Verlet ragdolls with real
// weight; every impact gets hit-stop, shake scaled to force, sparks and dust, and
// the last enemy of each wave gets a slow-mo beat.
// Waves mix grunts, runners, shields and brutes, and every 5th wave brings the boss.
// The ring ropes are live: bodies launched into them get zapped. Hits fill the RIOT
// meter, and a full meter unleashes a super that blasts the whole ring.
import { clamp, lerp, ease, rand, sign } from './juice.js';
import { Fighter, ATK, drawFighter, drawShadow } from './fighter.js';
import { DT, HEAD, NECK, PELV } from './rig.js';

const ACCENT = '#ff3e3e';
const BG = '#090a0f';
const DISPLAY = '"Futura Condensed ExtraBold","Impact","Haettenschweiler","Arial Narrow Bold",sans-serif';
const ROPES = [48, 92, 136];            // rope heights above the floor, world units
const REACH = { grunt: 68, runner: 60, shield: 76, brute: 96 };
const BOSS_NAME = 'THE BOUNCER';
const TIPS_KEY = 'ragdoll-riot:tips';
const TIP_RUNS = 3;                     // a tip shows on the first few runs that reach it

const V = { attractMin: 18, s: 1, ox: 0, arenaW: 1000, H: 620, ground: 500, w: 1, h: 1, touch: false };
const W = {};          // world state, rebuilt by reset()
let shell = null;
let hud = null;

const g = { slug: 'ragdoll-riot', name: 'RAGDOLL RIOT' };

/* ============================== setup / layout ============================== */
g.setup = (sh) => {
  shell = sh;
  g.shell = sh;
  const $ = (id) => document.getElementById(id);
  hud = {
    hp: $('rr-hp'), fill: $('rr-hp-fill'), hpn: $('rr-hp-n'),
    wave: $('rr-wave'), combo: $('rr-combo'),
    mult: $('rr-mult'), hits: $('rr-hits'), cbar: $('rr-cbar'),
    riot: $('rr-riot'), riotFill: $('rr-riot-fill'),
    boss: $('rr-boss'), bossFill: $('rr-boss-fill'),
    tip: $('tip'), legend: $('legend'), live: $('sr-live'),
    superBtn: document.querySelector('#touch [data-action="super"]'),
    banner: $('banner'),
    last: { hp: -1, wave: -1, mult: -1, hits: -1, vis: null, riot: -1, full: null, boss: -1, bossOn: null },
  };
};

g.resize = (view) => {
  V.w = view.w; V.h = view.h;
  V.touch = shell.input.touch;
  const aspect = view.w / view.h;
  if (aspect >= 1.2) {
    V.H = 620; V.s = view.h / V.H;
    V.arenaW = Math.min(view.w / V.s, 1240);
    V.ox = (view.w - V.arenaW * V.s) / 2;
    V.ground = V.H - (V.touch ? 148 : 120);
  } else {
    V.arenaW = 600; V.s = view.w / V.arenaW; V.ox = 0;
    V.H = view.h / V.s;
    V.ground = V.H * 0.70;
  }
  V.attractMin = aspect >= 1.2 ? V.arenaW * 0.5 : 18;   // keep the title-screen fight clear of the text panel
  buildBackground(view);
  if (W.player) {
    // keep fighters on the new floor / inside the new walls
    for (const f of allFighters()) { f.groundY = V.ground; if (f.onGround && !f.ragdolled) f.y = V.ground; }
  }
};

/* ============================== background (cached) ============================== */
function buildBackground(view) {
  const c = shell.bgCanvas.getContext('2d');   // painted once per resize; the main canvas stays transparent
  c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  const w = view.w, h = view.h, s = V.s, gy = V.ground * s;

  c.fillStyle = BG; c.fillRect(0, 0, w, h);
  // back wall
  let grd = c.createLinearGradient(0, 0, 0, gy);
  grd.addColorStop(0, '#0b0c13'); grd.addColorStop(1, '#12141d');
  c.fillStyle = grd; c.fillRect(0, 0, w, gy);

  // wall panels
  c.strokeStyle = 'rgba(255,255,255,.035)'; c.lineWidth = 1;
  const step = 150 * s;
  for (let x = V.ox % step; x < w; x += step) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, gy); c.stroke(); }

  // spotlight cones
  const cones = [0.18, 0.5, 0.82];
  cones.forEach((k, i) => {
    const cx = V.ox + V.arenaW * s * k, topW = 10 * s, botW = 230 * s;
    const cg = c.createLinearGradient(0, 0, 0, gy);
    cg.addColorStop(0, i === 1 ? 'rgba(255,62,62,.16)' : 'rgba(236,238,244,.10)');
    cg.addColorStop(1, 'rgba(236,238,244,0)');
    c.fillStyle = cg;
    c.beginPath(); c.moveTo(cx - topW, 0); c.lineTo(cx + topW, 0); c.lineTo(cx + botW, gy); c.lineTo(cx - botW, gy); c.closePath(); c.fill();
  });

  // LED band on the back wall
  const bandY = gy - 170 * s;
  const bg2 = c.createLinearGradient(0, bandY - 14, 0, bandY + 14);
  bg2.addColorStop(0, 'rgba(255,62,62,0)'); bg2.addColorStop(0.5, 'rgba(255,62,62,.20)'); bg2.addColorStop(1, 'rgba(255,62,62,0)');
  c.fillStyle = bg2; c.fillRect(0, bandY - 14, w, 28);
  c.fillStyle = 'rgba(255,62,62,.55)'; c.fillRect(0, bandY - 1, w, 2);

  // floor
  grd = c.createLinearGradient(0, gy, 0, h);
  grd.addColorStop(0, '#171a26'); grd.addColorStop(1, '#090a0f');
  c.fillStyle = grd; c.fillRect(0, gy, w, h - gy);
  // perspective grid
  c.save();
  c.beginPath(); c.rect(0, gy, w, h - gy); c.clip();
  c.strokeStyle = 'rgba(236,238,244,.06)';
  const vx = w / 2, vy = gy - 240 * s;
  for (let i = -16; i <= 16; i++) {
    c.beginPath(); c.moveTo(vx + i * 22 * s, gy); c.lineTo(vx + i * 150 * s, h + 20); c.stroke();
  }
  for (let k = 1; k < 9; k++) {
    const y = gy + Math.pow(k / 8, 1.8) * (h - gy);
    c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); c.stroke();
  }
  c.restore();

  // lit edge of the floor
  const eg = c.createLinearGradient(0, gy - 46, 0, gy);
  eg.addColorStop(0, 'rgba(255,62,62,0)'); eg.addColorStop(1, 'rgba(255,62,62,.22)');
  c.fillStyle = eg; c.fillRect(0, gy - 46, w, 46);
  c.fillStyle = ACCENT; c.fillRect(0, gy - 1, w, 2);

  // outside the ring (visible on very wide screens)
  if (V.ox > 2) {
    c.fillStyle = 'rgba(9,10,15,.62)';
    c.fillRect(0, 0, V.ox, h); c.fillRect(w - V.ox, 0, V.ox, h);
  }
  // the ring: three live ropes across the back, strung between corner posts at the arena edges
  const L = V.ox, R = V.ox + V.arenaW * s;
  c.lineCap = 'round';
  for (const hgt of ROPES) {
    const y = gy - hgt * s;
    c.strokeStyle = 'rgba(0,0,0,.5)'; c.lineWidth = 5 * s; ropePath(c, L, R, y + 2.5 * s, s); c.stroke();
    c.strokeStyle = '#2a2e3e'; c.lineWidth = 3.4 * s; ropePath(c, L, R, y, s); c.stroke();
    c.strokeStyle = 'rgba(255,62,62,.5)'; c.lineWidth = 1.2 * s; ropePath(c, L, R, y, s); c.stroke();
  }
  for (const x of [L, R]) drawPost(c, x, gy, s);

  // vignette
  const vg = c.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.35, w / 2, h * 0.55, Math.max(w, h) * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.6)');
  c.fillStyle = vg; c.fillRect(0, 0, w, h);
}

function ropePath(c, L, R, y, s) { c.beginPath(); c.moveTo(L, y); c.quadraticCurveTo((L + R) / 2, y + 9 * s, R, y); }

function drawPost(c, x, gy, s) {
  const pw = 13 * s, top = gy - 162 * s;
  c.fillStyle = '#141722'; c.fillRect(x - pw / 2, top, pw, gy - top);
  c.fillStyle = 'rgba(255,255,255,.07)'; c.fillRect(x - pw / 2, top, 2 * s, gy - top);
  c.fillStyle = 'rgba(255,62,62,.8)'; c.fillRect(x - s, top + 8 * s, 2 * s, gy - top - 16 * s);
  c.fillStyle = '#eceef4';
  c.fillRect(x - pw / 2 - 2 * s, top - 5 * s, pw + 4 * s, 6 * s);
  for (const hgt of ROPES) c.fillRect(x - pw / 2 - 1.5 * s, gy - hgt * s - 3 * s, pw + 3 * s, 6 * s);
}

/* ============================== helpers ============================== */
const allFighters = () => [W.player, ...W.enemies];
const wx = (x) => x * V.s + V.ox;       // world -> screen
const wy = (y) => y * V.s;
const bounds = () => ({ groundY: V.ground, minX: 0, maxX: V.arenaW });
const aliveEnemies = () => W.enemies.filter((e) => e.hp > 0);
// rope height in world space (matches the sag painted in buildBackground)
const ropeY = (h, x) => { const u = clamp(x / V.arenaW, 0, 1); return V.ground - h + 18 * u * (1 - u); };

/* ============================== run lifecycle ============================== */
g.reset = (mode) => {
  W.mode = mode;
  W.t = 0; W.runT = 0;
  W.score = 0; W.kills = 0; W.combo = 0; W.comboT = 0; W.mult = 1; W.maxMult = 1; W.maxCombo = 0;
  W.wave = 0; W.phase = mode === 'play' ? 'banner' : 'attract'; W.phaseT = 0; W.queue = []; W.spawnT = 0; W.spawnGap = 1;
  W.maxAlive = 4; W.tokens = 1; W.spd = 1; W.enrage = 0;
  W.riot = 0; W.superFired = true; W.supers = 0; W.zaps = 0; W.bosses = 0; W.boss = null;
  W.waves = []; W.ropeFx = [];
  W.tipQ = []; W.tipT = 0; W.tipsShown = new Set(); W.kicked = false; W.legendDim = false;
  W.enemies = [];
  W.player = new Fighter('player', mode === 'attract' ? V.arenaW * 0.7 : V.arenaW * 0.4, V.ground);
  W.player.lo = 18; W.player.hi = V.arenaW - 18;
  W.bot = { cd: 0.5, step: 0 };
  W.buf = { atk: '', t: 0, jump: 0, src: '' };
  W.hurtFlash = 0;
  W.finisher = false;
  shell.input.latch.clear();
  hud.tip.classList.remove('show');
  hud.legend.classList.remove('dim');
  if (mode === 'play') startWave(1);
  else { for (let i = 0; i < 3; i++) spawnEnemy('grunt', V.attractMin > 100 ? 1 : (i % 2 ? 1 : -1)); }
  syncHud(true);
};

function startWave(n) {
  W.wave = n;
  const bossWave = n % 5 === 0;
  const k = Math.floor(n / 5);
  let grunts, runners = 0, shields = 0, brutes = 0;
  if (bossWave) { grunts = 2 + k; runners = k; }
  else {
    runners = n >= 2 ? Math.min(4, 1 + Math.floor((n - 2) / 2)) : 0;
    shields = n >= 4 ? Math.min(3, 1 + Math.floor((n - 4) / 3)) : 0;
    brutes = n >= 3 ? 1 + Math.floor((n - 3) / 2) : 0;
    grunts = Math.max(2, 3 + Math.floor((n - 1) * 1.6) - Math.floor((runners + shields) / 2));
  }
  const q = [];
  for (let i = 0; i < grunts; i++) q.push('grunt');
  // runners slot in anywhere; shields and brutes arrive in the back half of the wave
  for (let i = 0; i < runners; i++) q.splice(Math.floor(Math.random() * (q.length + 1)), 0, 'runner');
  const heavy = [...Array(shields).fill('shield'), ...Array(brutes).fill('brute')];
  heavy.forEach((kind, i) => q.splice(Math.floor(q.length * (0.45 + 0.4 * (i / Math.max(1, heavy.length)))) + i, 0, kind));
  if (bossWave) q.splice(1, 0, 'boss');
  W.queue = q;
  W.maxAlive = bossWave ? Math.min(3 + k, 5) : Math.min(3 + n, 8);
  W.spawnGap = Math.max(0.45, 1.1 - 0.07 * n);
  W.spd = Math.min(1.9, 1 + 0.08 * (n - 1));
  W.tokens = 2 + (n >= 3) + (n >= 5) + (n >= 7);
  W.phase = 'banner'; W.phaseT = 0; W.spawnT = 0.2; W.finisher = false;

  let sub;
  if (bossWave) sub = `${BOSS_NAME} IS HERE`;
  else if (n === 1) sub = `${grunts} CHALLENGERS`;
  else if (n === 2) sub = 'RUNNERS INCOMING';
  else if (n === 3) sub = 'A BRUTE IS COMING';
  else if (n === 4) sub = 'SHIELDS UP';
  else {
    const plural = (c, word) => c && `${c} ${word}${c > 1 ? 'S' : ''}`;
    sub = [plural(brutes, 'BRUTE'), plural(shields, 'SHIELD'), plural(runners, 'RUNNER')].filter(Boolean).join('  ·  ');
  }
  showBanner(bossWave ? 'BOSS WAVE' : `WAVE ${n}`, sub);
  shell.sfx.play(bossWave ? 'boss' : 'wave');
  if (n === 1) {
    tip('combo', 'TAP J THREE TIMES FAST. THE THIRD PUNCH IS AN UPPERCUT.', 'TAP PUNCH THREE TIMES FAST. THE THIRD HIT IS AN UPPERCUT.', 1.3);
    tip('kick', 'KICK (K) SENDS THEM FLYING INTO EACH OTHER.', 'KICK SENDS THEM FLYING INTO EACH OTHER.', 9, () => !W.kicked);
  }
  if (n === 2) tip('ropes', 'THE ROPES ARE LIVE. LAUNCH ENEMIES INTO THEM FOR A ZAP BONUS.', null, 1.3);
}

function showBanner(text, sub) {
  const b = hud.banner;
  b.replaceChildren(document.createTextNode(text));
  if (sub) { const s = document.createElement('small'); s.textContent = sub; b.append(s); }
  b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
}

function spawnEnemy(kind, side) {
  const off = kind === 'boss' ? 90 : 50;
  const e = new Fighter(kind, side < 0 ? -off : V.arenaW + off, V.ground);
  e.face = -side;
  e.entering = true; e.invuln = 99;
  e.lo = -120; e.hi = V.arenaW + 120;
  e.speedMul = W.spd * (0.9 + Math.random() * 0.25);
  if (kind === 'grunt') { e.hp = e.maxHp = 3 + Math.floor(W.wave / 4); }
  else if (kind === 'runner') { e.hp = e.maxHp = 2 + Math.floor(W.wave / 6); }
  else if (kind === 'shield') {
    e.hp = e.maxHp = 5 + Math.floor(W.wave / 5);
    tip('shield', 'SHIELDS BLOCK PUNCHES. KICK (K) TO BREAK THE GUARD.', 'SHIELDS BLOCK PUNCHES. KICK TO BREAK THE GUARD.', 0.6);
  } else if (kind === 'brute') {
    tip('brute', 'SEE A ! OVER A BRUTE? BACK OFF OR JUMP. IT HITS HARD.', null, 0.6);
  } else if (kind === 'boss') {
    e.hp = e.maxHp = 36 + 14 * (Math.max(1, Math.floor(W.wave / 5)) - 1);
    e.speedMul = 1;
    W.boss = e;
    tip('boss', `${BOSS_NAME} POUNDS THE FLOOR. JUMP OVER THE SHOCKWAVES.`, null, 0.8);
  }
  W.enemies.push(e);
  return e;
}

/* ============================== update ============================== */
g.update = (dt, sh) => {
  const playing = sh.state === 'play';
  W.t += DT;
  if (playing) W.runT += DT;
  W.enrage = clamp((W.runT - 55) / 45, 0, 1);   // late-run pressure keeps runs inside ~3 minutes
  const p = W.player;
  const wb = bounds();

  // ---- player intent
  const intent = playing && p.alive ? humanIntent() : (W.mode === 'attract' && sh.state === 'title' ? botIntent() : null);
  if (intent) playerControl(p, intent);
  if (W.mode === 'attract') { p.hp = p.maxHp; p.invuln = 0; }

  // ---- director
  directorStep(playing);

  // ---- enemy brains
  for (const e of W.enemies) if (e.alive && e.state === 'idle') enemyBrain(e);
  assignAttackers();
  separate();

  // ---- integrate everything
  for (const f of allFighters()) {
    const lo = W.mode === 'attract' ? V.attractMin : 18;
    f.lo = f === p ? lo : (f.entering ? -120 : lo);
    // The title-screen fight stays off the right edge so the attract loop reads cleanly.
    f.hi = f === p ? V.arenaW - (W.mode === 'attract' ? 150 : 18) : (f.entering ? V.arenaW + 120 : V.arenaW - 18);
    f.step(wb);
    afterStep(f);
  }

  resolveAttacks();
  bowling();

  // ---- area attacks: the player's super and the boss's ground-pound
  if (p.state === 'atk' && p.atkName === 'roar' && !W.superFired && p.t >= ATK.roar.dur * ATK.roar.a) { W.superFired = true; fireSuper(); }
  for (const e of W.enemies) {
    if (e.state === 'atk' && e.atkName === 'stomp' && !e.stompFired && e.t >= ATK.stomp.dur * ATK.stomp.a) { e.stompFired = true; stomp(e); }
  }
  stepWaves();
  for (let i = W.ropeFx.length - 1; i >= 0; i--) if ((W.ropeFx[i].t -= DT) <= 0) W.ropeFx.splice(i, 1);

  // ---- combo timer
  if (W.combo > 0) {
    W.comboT -= DT;
    if (W.comboT <= 0) { W.combo = 0; W.mult = 1; }
  }
  if (W.hurtFlash > 0) W.hurtFlash -= DT;
  if (playing) stepTips();

  // ---- cleanup bodies
  for (let i = W.enemies.length - 1; i >= 0; i--) {
    const e = W.enemies[i];
    if (e.state === 'dead' && e.deadT > 2.6) {
      e.fade = Math.max(0, 1 - (e.deadT - 2.6) / 0.9);
      if (e.fade <= 0) W.enemies.splice(i, 1);
    }
  }
};

/* ---------- intents ---------- */
function humanIntent() {
  const inp = shell.input;
  const pk = inp.pressed('punch'), kk = inp.pressed('kick');
  return {
    ax: inp.axis(),
    jump: inp.pressed('up'),
    punch: pk, kick: kk,
    sup: inp.pressed('super'),
    mouse: (pk && inp.source('punch') === 'mouse') || (kk && inp.source('kick') === 'mouse'),
  };
}

function botIntent() {
  const p = W.player, bot = W.bot;
  const it = { ax: 0, jump: false, punch: false, kick: false, mouse: false };
  let best = null, bd = 1e9;
  for (const e of W.enemies) {
    if (!e.alive || e.entering) continue;
    const d = Math.abs(e.x - p.x);
    if (d < bd) { bd = d; best = e; }
  }
  bot.cd -= DT;
  if (!best) { it.ax = clamp((V.arenaW / 2 - p.x) / 120, -0.6, 0.6); return it; }
  const dx = best.x - p.x;
  if (bd > 74) it.ax = sign(dx); else if (bd < 34) it.ax = -sign(dx) * 0.6;
  if (bd < 96 && bot.cd <= 0) {
    if (bot.step >= 3 || (bot.step === 0 && Math.random() < 0.18)) { it.kick = true; bot.step = 0; bot.cd = 0.62; }
    else { it.punch = true; bot.step++; bot.cd = 0.2 + Math.random() * 0.08; }
  }
  if (bd > 240 && Math.random() < 0.008) it.jump = true;
  return it;
}

/* ---------- player control ---------- */
function playerControl(p, it) {
  const sh = shell;
  const buf = W.buf;
  if (it.jump) buf.jump = 0.12; else buf.jump -= DT;
  if (it.punch) { buf.atk = 'p'; buf.t = 0.22; buf.mouse = it.mouse; }
  if (it.kick) { buf.atk = 'k'; buf.t = 0.22; buf.mouse = it.mouse; }
  buf.t -= DT;

  if (p.ragdolled || p.state === 'getup' || p.state === 'dead') return;

  // super: a full RIOT meter cancels anything the player is doing
  if (it.sup && W.riot >= 100 && !(p.state === 'atk' && p.atkName === 'roar')) {
    p.startAttack('roar'); p.vx = 0; p.invuln = Math.max(p.invuln, 0.9);
    W.riot = 0; W.superFired = false; W.supers++;
    buf.atk = '';
    sh.sfx.play('windup');
    sh.juice.zoomPunch(0.035, 420, wx(p.x), wy(V.ground - 70));
    return;
  }

  // movement
  if (p.state === 'idle') {
    const target = it.ax * p.k.speed * (p.onGround ? 1 : 0.92);
    p.vx += (target - p.vx) * (p.onGround ? 0.32 : 0.1);
    if (it.ax !== 0) p.face = sign(it.ax);
  }
  // jump
  if (buf.jump > 0 && p.onGround && (p.state === 'idle' || (p.state === 'atk' && p.atkName !== 'roar'))) {
    p.vy = -745; p.onGround = false; buf.jump = 0;
    if (p.state === 'atk') { p.state = 'idle'; p.atk = null; }
    sh.sfx.play('jump');
    sh.particles.dust(p.x, V.ground, 5, 20);
  }
  // attacks (buffered, chain-cancelable once the active window is over)
  if (buf.t > 0 && buf.atk) {
    const can = p.state === 'idle' || (p.state === 'atk' && p.t >= p.atk.dur * (p.atk.b + 0.03));
    if (can) {
      if (buf.mouse) {
        const aimX = (sh.input.aim.x - V.ox) / V.s;
        p.face = sign(aimX - p.x);
      } else if (it.ax !== 0) p.face = sign(it.ax);
      else {
        const t = nearestEnemy(p, 260);
        if (t) p.face = sign(t.x - p.x);
      }
      beginPlayerAttack(p, buf.atk);
      buf.atk = '';
    }
  }
}

function nearestEnemy(p, range, facingOnly = false) {
  let best = null, bd = range;
  for (const e of W.enemies) {
    if (!e.alive || e.entering || e.state === 'dead') continue;
    const dx = e.x - p.x;
    if (facingOnly && sign(dx) !== p.face) continue;
    const d = Math.abs(dx);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function beginPlayerAttack(p, kind) {
  let name = 'k';
  if (kind === 'p') {
    const chaining = (p.state === 'atk' && p.atkName[0] === 'p') || p.chainT > 0;
    const idx = chaining ? (p.lastPunch + 1) % 3 : 0;
    p.lastPunch = idx;
    name = 'p' + (idx + 1);
  } else { p.lastPunch = -1; W.kicked = true; }
  p.startAttack(name);
  // lunge toward the target so combos stick to it
  const spec = ATK[name];
  const t = nearestEnemy(p, 190, true);
  const base = spec.lunge;
  p.vx = p.face * (t ? clamp((Math.abs(t.x - p.x) - 50) * 6, 40, base * 1.7) : base * 0.55);
  shell.sfx.play('swing', spec.power);
}

/* ---------- enemies ---------- */
const attackOf = (e) => (e.kind === 'brute' ? 'smash' : e.kind === 'runner' ? 'e2' : e.kind === 'shield' && e.guard ? 'bash' : 'e1');

function enemyBrain(e) {
  const p = W.player, ai = e.ai;
  const speed = e.k.speed * e.speedMul * (e.armor && e.hp < e.maxHp * 0.5 ? 1.35 : 1);
  if (e.entering) {
    const dir = e.x < V.arenaW / 2 ? 1 : -1;
    e.face = dir; e.vx = dir * speed * 1.6;
    if (e.x > 30 && e.x < V.arenaW - 30) { e.entering = false; e.invuln = 0; }
    return;
  }
  const dxp = p.x - e.x, dist = Math.abs(dxp), dir = sign(dxp);
  const playerDown = !p.alive || p.ragdolled || p.state === 'getup';
  if (W.mode === 'play' && !p.alive) { e.vx *= 0.8; return; }
  // runners dart back out after every jab
  if (ai.retreatNext) { ai.retreatNext = false; ai.retreat = 0.55; }
  if (ai.retreat > 0) { ai.retreat -= DT; e.face = dir; e.vx += (-dir * speed * 0.9 - e.vx) * 0.3; return; }
  e.face = dir;
  if (e.armor) { bossBrain(e, dist, dir, speed, playerDown); return; }
  const reach = REACH[e.kind] ?? 68;
  if (ai.engage && !playerDown) {
    if (dist > reach) e.vx += (dir * speed - e.vx) * 0.25;
    else {
      e.vx *= 0.7;
      if (ai.cd <= 0) {
        const name = attackOf(e);
        e.startAttack(name);
        const pace = 1 / (1 + 0.1 * W.wave);
        const rest = e.kind === 'brute' ? 1.3 : e.kind === 'runner' ? 0.35 + Math.random() * 0.4
          : e.kind === 'shield' ? 0.9 + Math.random() * 0.5 : 0.6 + Math.random() * 0.7;
        ai.cd = ATK[name].dur + rest * pace * (1 - 0.4 * W.enrage);
        ai.engage = false;
        if (e.kind === 'runner') ai.retreatNext = true;
        shell.sfx.play('windup');
      }
    }
  } else {
    // circle the player at a distance and wait for a slot
    const want = ai.hover + (playerDown ? 60 : 0);
    if (dist < want - 24) e.vx += (-dir * speed * 0.7 - e.vx) * 0.2;
    else if (dist > want + 34) e.vx += (dir * speed * 0.8 - e.vx) * 0.2;
    else e.vx *= 0.8;
  }
}

// The boss ignores the attack-slot system: it stalks, smashes up close and pounds the floor from range.
function bossBrain(e, dist, dir, speed, playerDown) {
  const ai = e.ai;
  if (playerDown) {
    // give the player room to get up
    if (dist < 260) e.vx += (-dir * speed * 0.6 - e.vx) * 0.15; else e.vx *= 0.85;
    return;
  }
  if (ai.cd <= 0) {
    const stompIt = dist > 170 ? Math.random() < 0.75 : Math.random() < 0.25;
    let name = null;
    if (stompIt && dist < 620) name = 'stomp';
    else if (dist <= 150) name = 'bsmash';
    if (name) {
      e.startAttack(name); e.stompFired = false;
      if (name === 'stomp') e.vx = 0;
      ai.cd = ATK[name].dur + (e.hp < e.maxHp * 0.5 ? 0.75 : 1.25) + Math.random() * 0.5;
      shell.sfx.play('windup');
      return;
    }
  }
  if (dist > 140) e.vx += (dir * speed - e.vx) * 0.2; else e.vx *= 0.8;
}

function assignAttackers() {
  const p = W.player;
  if (!p.alive) return;
  let used = 0;
  for (const e of W.enemies) if (e.alive && !e.armor && (e.ai.engage || e.state === 'atk')) used++;
  const slots = W.tokens + (W.enrage > 0.5 ? 1 : 0);
  if (used >= slots) return;
  let best = null, bd = 1e9;
  for (const e of W.enemies) {
    if (!e.alive || e.armor || e.state !== 'idle' || e.ai.engage || e.entering || e.ai.cd > 0.25) continue;
    const d = Math.abs(e.x - p.x);
    if (d < bd) { bd = d; best = e; }
  }
  if (best) best.ai.engage = true;
}

function separate() {
  const list = W.enemies.filter((e) => e.alive && e.state !== 'rag' && e.state !== 'getup' && !e.entering);
  const p = W.player;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      const min = 30 * (a.s + b.s) * 0.5;
      const dx = b.x - a.x, d = Math.abs(dx);
      if (d < min) {
        // heavier bodies give less ground
        const push = (min - d) * 0.7 * (dx >= 0 ? 1 : -1), ia = 1 / a.mass, ib = 1 / b.mass;
        a.x -= push * ia / (ia + ib); b.x += push * ib / (ia + ib);
      }
    }
    if (p.alive && !p.ragdolled) {
      const min = 24 * a.s, dx = a.x - p.x;
      if (Math.abs(dx) < min && p.onGround && a.state === 'idle') a.x += (min - Math.abs(dx)) * 0.4 * (dx >= 0 ? 1 : -1);
    }
  }
}

/* ---------- director ---------- */
function directorStep(playing) {
  if (W.mode === 'attract') {
    W.spawnT -= DT;
    if (W.spawnT <= 0 && aliveEnemies().length < 3) {
      spawnEnemy('grunt', V.attractMin > 100 ? 1 : (Math.random() < 0.5 ? -1 : 1));
      W.spawnT = 1.2;
    }
    return;
  }
  if (!playing) return;
  W.phaseT += DT;
  if (W.phase === 'banner') {
    if (W.phaseT > 1.0) { W.phase = 'fight'; W.phaseT = 0; }
  } else if (W.phase === 'fight') {
    W.spawnT -= DT;
    if (W.queue.length && W.spawnT <= 0 && aliveEnemies().length < W.maxAlive) {
      const kind = W.queue.shift();
      spawnEnemy(kind, Math.random() < 0.5 ? -1 : 1);
      W.spawnT = W.spawnGap * (kind === 'brute' || kind === 'boss' ? 1.5 : 1);
    }
    if (!W.queue.length && aliveEnemies().length === 0) {
      W.phase = 'clear'; W.phaseT = 0; W.bannerShown = false;
      const heal = 16;
      W.player.hp = Math.min(W.player.maxHp, W.player.hp + heal);
      const bonus = 100 * W.wave;
      addScore(bonus);
      shell.sfx.play('clear');
    }
  } else if (W.phase === 'clear') {
    if (!W.bannerShown && W.phaseT > 0.55) {
      W.bannerShown = true;
      showBanner('WAVE CLEAR', `+16 HP   +${100 * W.wave} BONUS`);
    }
    if (W.phaseT > 2.4) startWave(W.wave + 1);
  }
}

function addScore(n) { W.score += n; shell.setScore(W.score); }

/* ---------- landing / wall events ---------- */
function afterStep(f) {
  const { sfx, juice, particles } = shell;
  if (f.evLand) {
    particles.dust(f.x, V.ground, 6, 24);
    if (f.team === 'p') sfx.play('thud', 0.25);
    f.evLand = 0;
  }
  if (f.evGetup) {
    f.evGetup = false;
    particles.dust(f.x, V.ground, 5, 26);
  }
  if (f.ragdolled || f.state === 'getup') {
    const r = f.rig;
    const imp = r.impact * 60;
    if (imp > 380) {
      const k = clamp((imp - 380) / 1100, 0, 1) * Math.min(1.4, f.mass * 0.8 + 0.2);
      particles.dust(r.impactX, V.ground, 3 + Math.round(k * 9), 20 + k * 24);
      if (imp > 700) particles.sparks(r.impactX, V.ground - 2, -Math.PI / 2, 1.1, Math.round(3 + k * 7), 160 + k * 240, '#d8dbe8');
      sfx.play('thud', k);
      juice.shake(1.5 + 8 * k);
      if (k > 0.55 && f.alive) juice.hitstop(28 * k);
    }
    const wall = r.wallHit * 60;
    // the ropes are live: a body thrown into them gets zapped and flung back into the ring
    if (f.ragdolled && wall > 360 && f.zapCd <= 0) zap(f, r.wallX, r.wallY);
    else if (wall > 520) {
      const k = clamp((wall - 520) / 1200, 0, 1);
      particles.dust(r.wallX, r.wallY, 6, 16);
      particles.sparks(r.wallX, r.wallY, r.wallX < V.arenaW / 2 ? 0 : Math.PI, 0.9, 6 + Math.round(8 * k), 260 + 240 * k, '#fff');
      particles.ring(r.wallX, r.wallY, 20 + 24 * k, '#fff', 0.22);
      sfx.play('thud', 0.5 + k * 0.5);
      juice.shake(3 + 8 * k);
    }
  }
}

/* ============================== combat ============================== */
function hitTest(hx, hy, r, v) {
  const rg = v.rig, s = v.s;
  // trunk segment neck -> pelvis
  const ax = rg.x[NECK], ay = rg.y[NECK], bx = rg.x[PELV], by = rg.y[PELV];
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((hx - ax) * abx + (hy - ay) * aby) / (abx * abx + aby * aby || 1), 0, 1);
  const cx = ax + abx * t, cy = ay + aby * t;
  if (Math.hypot(hx - cx, hy - cy) < r + 13 * s) return true;
  return Math.hypot(hx - rg.x[HEAD], hy - rg.y[HEAD]) < r + 11 * s;
}

function resolveAttacks() {
  for (const a of allFighters()) {
    if (a.state !== 'atk' || !a.atk || a.atk.area) continue;
    const spec = a.atk, u = a.t / spec.dur;
    if (u < spec.a || u > spec.b) continue;
    const hx = a.rig.x[spec.part], hy = a.rig.y[spec.part];
    const targets = a.team === 'p' ? W.enemies : [W.player];
    for (const v of targets) {
      if (a.atkHit.has(v) || v.state === 'dead' || v.entering) continue;
      if (v.team === 'p' && (v.invuln > 0 || v.ragdolled || v.state === 'getup' || !v.alive)) continue;
      if (!hitTest(hx, hy, spec.r, v)) continue;
      a.atkHit.add(v);
      applyHit(a, v, a.atkName, hx, hy);
    }
  }
}

function applyHit(a, v, name, hx, hy) {
  const { juice, particles, sfx } = shell;
  const spec = ATK[name];
  const byPlayer = a.team === 'p';
  const dir = a.face || sign(v.x - a.x);
  const juggling = v.ragdolled;

  // ---- shield guard: punches from the front bounce off, a kick breaks it
  if (byPlayer && v.guard && !juggling && v.state !== 'getup' && sign(a.x - v.x) === v.face) {
    if (name !== 'k') { blocked(a, v, hx, hy); return; }
    breakGuard(v, dir, false);
  }

  const dmgScale = byPlayer ? 1 : (1 + W.enrage * 0.9);
  const dmg = spec.dmg * dmgScale;
  v.hp -= dmg;
  const kill = v.hp <= 0;
  const I = clamp(spec.power * (kill ? 1.12 : 1), 0, 1.15);

  // ---- physical response
  let launch = false;
  if (v.armor && !kill) {
    // the boss soaks hits: a flinch and a nudge, never a stagger or a launch
    v.x = clamp(v.x + dir * (name === 'k' ? 12 : 4), 18, V.arenaW - 18);
  } else {
    launch = kill || spec.launch || juggling;
    if (v.kind === 'brute' && !kill && !juggling && spec.power < 0.9) launch = false;
    const m = v.mass;
    let vx = dir * spec.vx / m, vy = spec.vy / Math.pow(m, 0.7);
    if (kill) { vx *= 1.3; vy = Math.min(vy, -300 / Math.pow(m, 0.6)); }
    if (!byPlayer && !v.alive) { vx *= 1.3; vy *= 1.1; }
    if (juggling) {
      v.rig.kick(vx * 0.8, Math.min(-380, vy * 0.9));
      v.restT = 0; v.ragT = Math.min(v.ragT, 1.6);
      if (!v.alive) v.die();
    } else if (launch) {
      v.launch(vx, vy, dir * rand(2, 6) * (0.6 + I));
    } else {
      const heavy = v.kind === 'brute';
      v.stagger(dir * (spec.kb || 120) / m, heavy ? 0.14 : 0.24 + 0.08 * I);
      if (v.team === 'p') v.invuln = 0.7;
    }
  }
  if (v.team === 'e') { v.flash = 0.1; v.shakeT = 0.14; if (byPlayer && (launch || juggling)) v.bowl = true; }
  else { v.flash = 0.12; v.shakeT = 0.14; if (launch) v.invuln = 1.2; }

  // ---- juice (scaled to force)
  const hs = lerp(36, 112, clamp(I, 0, 1)) + (kill ? 46 : 0);
  juice.hitstop(hs);
  juice.shake(lerp(3, 13, clamp(I, 0, 1)) + (kill ? 5 : 0) + (byPlayer ? 0 : 3));
  const ang = dir > 0 ? 0 : Math.PI;
  particles.sparks(hx, hy, ang - 0.25, 0.75, Math.round(7 + 17 * I), 300 + 380 * I, '#ffffff');
  particles.sparks(hx, hy, ang - 0.25, 0.95, Math.round(4 + 8 * I), 240 + 260 * I, ACCENT);
  particles.ring(hx, hy, 22 + 34 * I, byPlayer ? '#ffffff' : ACCENT, 0.26);
  if (I > 0.7) {
    juice.zoomPunch(0.018 + 0.03 * I, 170, wx(hx), wy(hy));
    particles.dust(v.x, V.ground, 4, 24);
  }
  if (kill) { juice.flash(0.16 + 0.1 * I); particles.dots(hx, hy, 14, 520, ACCENT); }
  sfx.play('hit', I);
  if (kill) sfx.play('kill', I);

  // ---- bookkeeping
  if (byPlayer) {
    registerHit(v, kill, juggling, spec, hx, hy);
    if (kill) onKill(v);
  } else {
    onPlayerHit(v, dmg, launch);
  }
}

function blocked(a, v, hx, hy) {
  const { juice, particles, sfx } = shell;
  const dir = sign(v.x - a.x);
  a.vx = -dir * 220;                       // the attacker bounces off the shield
  v.x = clamp(v.x + dir * 6, 18, V.arenaW - 18);
  v.flash = 0.06;
  juice.hitstop(45); juice.shake(3);
  particles.sparks(hx, hy, dir > 0 ? Math.PI : 0, 0.9, 10, 380, '#ffffff');
  particles.ring(hx, hy, 18, '#eceef4', 0.2);
  particles.text(hx, hy - 30, 'BLOCK', '#9a9eb0', 20, 0.6);
  sfx.play('block');
  tip('blocked', 'BLOCKED. KICK THE SHIELD (K), OR HIT IT FROM BEHIND.', 'BLOCKED. KICK THE SHIELD, OR HIT IT FROM BEHIND.', 0);
}

function breakGuard(e, dir, quiet) {
  const { juice, particles, sfx } = shell;
  e.guard = false;
  const hx = e.rig.x[NECK] + e.face * 8, hy = e.rig.y[NECK] + 20;
  particles.sparks(hx, hy, dir > 0 ? 0 : Math.PI, 1.1, 16, 460, '#ffffff');
  particles.dots(hx, hy, 10, 420, '#eceef4');
  particles.text(e.x, V.ground - 150, 'GUARD BROKEN', '#ffffff', 26, 1.0);
  if (!quiet) { sfx.play('guard'); juice.shake(6); }
}

function bumpMult() {
  const prev = W.mult;
  W.mult = Math.min(10, 1 + Math.floor(W.combo / 4));
  if (W.mult > prev) {
    W.maxMult = Math.max(W.maxMult, W.mult);
    shell.particles.text(W.player.x, V.ground - 190, 'x' + W.mult + ' COMBO', ACCENT, 38, 1.0);
    shell.sfx.play('combo', W.mult);
  }
}

function chain() { W.combo++; W.comboT = 2.3; W.maxCombo = Math.max(W.maxCombo, W.combo); bumpMult(); }

function gainRiot(n) {
  if (W.mode !== 'play' || W.riot >= 100) return;
  W.riot = Math.min(100, W.riot + n);
  if (W.riot >= 100) {
    shell.sfx.play('ready');
    shell.particles.text(W.player.x, V.ground - 220, 'RIOT READY', ACCENT, 30, 1.1);
    tip('super', 'RIOT METER FULL. PRESS L TO UNLEASH IT.', 'RIOT METER FULL. TAP SUPER TO UNLEASH IT.', 0);
  }
}

function registerHit(v, kill, juggling, spec, hx, hy) {
  chain();
  let base = kill ? (v.kind === 'brute' ? 300 : v.kind === 'shield' ? 150 : 100) : spec.dmg >= 2 ? 25 : 10;
  if (juggling && !kill) base += 25;
  const pts = base * W.mult;
  if (W.mode === 'play') addScore(pts);
  shell.particles.text(hx, hy - 34, '+' + pts, kill ? '#ffffff' : '#ff9a9a', kill ? 30 : 22, 0.8);
  gainRiot(kill ? 12 : juggling ? 8 : spec.launch ? 7 : 5);
  if (spec === ATK.p3 && !kill) tip('juggle', "NICE. HIT THEM WHILE THEY'RE IN THE AIR TO JUGGLE.", null, 0.3);
}

function onKill(v) {
  const { juice, particles, sfx } = shell;
  W.kills++;
  if (v.kind === 'boss') {
    // the boss gets its own beat, even when it is the last one standing
    W.bosses++;
    if (W.boss === v) W.boss = null;
    const bonus = 1000 * Math.max(1, Math.floor(W.wave / 5));
    if (W.mode === 'play') { addScore(bonus); W.player.hp = Math.min(W.player.maxHp, W.player.hp + 30); }
    juice.slowmo(0.18, 1600); juice.zoomPunch(0.16, 1400, wx(v.x), wy(V.ground - 120));
    juice.flash(0.4); juice.shake(16);
    particles.text(v.x, V.ground - 270, 'BOSS DOWN', '#ffffff', 72, 1.6);
    particles.text(v.x, V.ground - 205, `+${bonus}   +30 HP`, ACCENT, 30, 1.6);
    particles.dots(v.x, V.ground - 120, 40, 800, ACCENT);
    sfx.play('finisher');
    return;
  }
  const left = W.enemies.filter((e) => e.hp > 0 && e !== v).length;
  if (W.mode === 'play' && W.phase === 'fight' && left === 0 && W.queue.length === 0) {
    // last enemy of the wave: slow-mo beat with a camera push on the body
    W.finisher = true;
    juice.slowmo(0.2, 1300);
    juice.zoomPunch(0.2, 1250, wx(v.x), wy(V.ground - 60));
    juice.flash(0.3);
    juice.shake(10);
    particles.text(v.x, V.ground - 160, 'K.O.', '#ffffff', 64, 1.3);
    sfx.play('finisher');
  }
}

function bowling() {
  const { juice, particles, sfx } = shell;
  for (const e of W.enemies) {
    if (!e.bowl || !e.ragdolled) continue;
    const r = e.rig;
    if (r.speed() < 430) continue;
    const px = r.x[PELV], py = r.y[PELV];
    const vx = (r.x[PELV] - r.px[PELV]) / DT, vy = (r.y[PELV] - r.py[PELV]) / DT;
    for (const t of W.enemies) {
      if (t === e || t.ragdolled || t.state === 'dead' || t.entering || !t.alive || e.bowled.has(t)) continue;
      if (Math.abs(px - t.x) > 36 * t.s || py < t.y - 120 * t.s || py > t.y + 12) continue;
      e.bowled.add(t);
      t.hp -= 2;
      const kill = t.hp <= 0;
      const dir = vx >= 0 ? 1 : -1;
      t.flash = 0.1;
      if (t.armor && !kill) {
        // bodies bounce off the boss
        t.shakeT = 0.14;
        r.scaleVelocity(-0.4);
        juice.hitstop(60); juice.shake(8);
        particles.sparks(t.x, py, dir > 0 ? Math.PI : 0, 0.9, 12, 380, '#fff');
        sfx.play('hit', 0.7);
        chain();
        const pts = 60 * W.mult;
        if (W.mode === 'play') addScore(pts);
        particles.text(t.x, py - 40, 'BONK! +' + pts, '#ffffff', 26, 1.0);
        gainRiot(6);
        break;
      }
      t.launch(clamp(vx * 0.75, -900, 900) / t.mass, Math.min(-300, vy * 0.4 - 220) / Math.pow(t.mass, 0.7), dir * rand(3, 7));
      t.bowl = true;
      r.scaleVelocity(0.55);
      juice.hitstop(kill ? 120 : 70); juice.shake(kill ? 14 : 9);
      particles.sparks(t.x, py, dir > 0 ? 0 : Math.PI, 0.9, 16, 460, '#fff');
      particles.ring(t.x, py, 40, ACCENT, 0.3);
      sfx.play('hit', 0.85);
      chain();
      const pts = (kill ? 150 : 60) * W.mult;
      if (W.mode === 'play') addScore(pts);
      particles.text(t.x, py - 40, 'STRIKE! +' + pts, '#ffffff', 26, 1.0);
      gainRiot(10);
      if (kill) { sfx.play('kill', 0.8); onKill(t); }
    }
  }
}

function onPlayerHit(p, dmg, launched) {
  const { juice, sfx } = shell;
  if (W.mode !== 'play') return;
  W.combo = 0; W.mult = 1; W.comboT = 0;
  W.hurtFlash = 0.35;
  juice.flash(0.14, ACCENT);
  sfx.play('hurt');
  if (p.hp <= 0 && W.mode === 'play') {
    p.hp = 0;
    if (p.state !== 'rag' && p.state !== 'dead') p.launch(-p.face * 520, -420, -p.face * 4);
    else p.die();
    p.state = 'dead';
    W.phase = 'dead';
    juice.slowmo(0.28, 1400); juice.hitstop(160); juice.flash(0.4, '#ffffff');
    shell.end({
      score: W.score,
      heading: 'KNOCKED OUT',
      delay: 1250,
      lines: [['WAVE', W.wave], ['KNOCKOUTS', W.kills], ['TOP MULTIPLIER', 'x' + W.maxMult], ['BEST CHAIN', W.maxCombo + ' HITS'],
        ['ROPE ZAPS', W.zaps], ['BOSSES DOWN', W.bosses]],
    });
  }
}

/* ---------- live ropes ---------- */
function zap(f, x, y) {
  const { juice, particles, sfx } = shell;
  f.zapCd = 0.8;
  const side = x < V.arenaW / 2 ? -1 : 1;
  const inward = side < 0 ? 0 : Math.PI;
  W.ropeFx.push({ side, x, y, t: 0.32 });
  f.rig.kick(-side * 520, -240);             // the ropes fling the body back into the ring
  particles.sparks(x, y, inward, 1.2, 12, 460, '#ffffff');
  if (!f.alive) return;                      // bodies still bounce off; only the living get zapped
  f.flash = 0.22; f.shakeT = 0.3;
  particles.sparks(x, y, inward, 1.2, 10, 420, ACCENT);
  particles.ring(x, y, 40, '#ffffff', 0.3);
  juice.shake(9); juice.hitstop(60); juice.flash(0.1, '#ffffff');
  sfx.play('zap');
  if (f.team === 'e') {
    f.hp -= 3;
    const kill = f.hp <= 0;
    if (kill) f.die();
    if (W.mode === 'play' && f.bowl) {
      W.zaps++;
      chain();
      const pts = (kill ? 160 : 80) * W.mult;
      addScore(pts);
      particles.text(x - side * 70, y - 78, 'ZAP! +' + pts, '#ffffff', 28, 1.0);
      gainRiot(12);
    }
    if (kill) onKill(f);
  } else if (W.mode === 'play') {
    f.hp -= 6;
    particles.text(x - side * 60, y - 30, 'ZAPPED', ACCENT, 24, 0.9);
    onPlayerHit(f, 6, true);
  }
}

/* ---------- the RIOT super ---------- */
function fireSuper() {
  const { juice, particles, sfx } = shell;
  const p = W.player;
  const cx = p.x, cy = V.ground - 60;
  juice.flash(0.5, '#ffffff'); juice.slowmo(0.3, 800); juice.shake(18); juice.hitstop(70);
  juice.zoomPunch(0.08, 600, wx(cx), wy(cy));
  particles.ring(cx, cy, 90, '#ffffff', 0.45);
  particles.ring(cx, cy, 150, ACCENT, 0.6);
  particles.ring(cx, V.ground, 220, '#ffffff', 0.7);
  particles.dots(cx, cy, 30, 700, ACCENT);
  particles.dust(cx, V.ground, 14, 60);
  particles.text(cx, cy - 120, 'RIOT!', '#ffffff', 72, 1.2);
  sfx.play('super');
  for (const e of W.enemies) {
    if (!e.alive || e.entering || e.state === 'dead') continue;
    const dx = e.x - cx, dir = dx === 0 ? (Math.random() < 0.5 ? -1 : 1) : sign(dx);
    const force = clamp(1.25 - Math.abs(dx) / 900, 0.55, 1.2);
    e.flash = 0.14; e.shakeT = 0.2;
    if (e.armor) {
      e.hp -= Math.max(4, Math.round(e.maxHp * 0.1));
      if (e.hp <= 0) e.launch(dir * 520 * force / e.mass, -400 / Math.pow(e.mass, 0.6), dir * 2);
      else e.stagger(dir * 120, 0.6);
    } else {
      if (e.guard) breakGuard(e, dir, true);
      e.hp -= 3;
      e.launch(dir * 1050 * force / e.mass, (-720 * force) / Math.pow(e.mass, 0.7), dir * rand(4, 9));
      e.bowl = true;
    }
    chain();
    const kill = e.hp <= 0;
    const pts = (kill ? (e.armor ? 0 : 120) : 50) * W.mult;
    if (W.mode === 'play' && pts) addScore(pts);
    if (kill) onKill(e);
  }
}

/* ---------- boss shockwaves ---------- */
function stomp(e) {
  const { juice, particles, sfx } = shell;
  const x0 = clamp(e.x + e.face * 34 * e.s, 0, V.arenaW);
  W.waves.push({ x: x0, dir: -1, t: 1.6, hit: false }, { x: x0, dir: 1, t: 1.6, hit: false });
  juice.shake(14); juice.hitstop(40);
  particles.dust(x0, V.ground, 16, 70);
  particles.ring(x0, V.ground, 70, '#ffffff', 0.4);
  particles.sparks(x0, V.ground - 4, -Math.PI / 2, 1.3, 18, 420, '#d8dbe8');
  sfx.play('stomp');
}

function stepWaves() {
  const p = W.player, { juice, particles, sfx } = shell;
  for (let i = W.waves.length - 1; i >= 0; i--) {
    const w = W.waves[i];
    w.x += w.dir * 560 * DT; w.t -= DT;
    if (w.t <= 0 || w.x < -60 || w.x > V.arenaW + 60) { W.waves.splice(i, 1); continue; }
    if ((W.t * 60 | 0) % 3 === 0) particles.dust(w.x, V.ground, 1, 14, '#d8dbe8');
    if (w.hit || W.mode !== 'play' || !p.alive || !p.onGround || p.ragdolled || p.state === 'getup' || p.invuln > 0) continue;
    if (Math.abs(p.x - w.x) > 26) continue;
    // jump it, or eat it
    w.hit = true;
    const dmg = ATK.stomp.dmg * (1 + W.enrage * 0.9);
    p.hp -= dmg;
    p.launch(w.dir * 320, -760, w.dir * 3);
    if (p.alive) p.invuln = 1.2;
    juice.hitstop(90); juice.shake(12);
    particles.sparks(p.x, V.ground - 8, -Math.PI / 2, 0.9, 14, 420, '#ffffff');
    particles.ring(p.x, V.ground - 20, 40, ACCENT, 0.3);
    sfx.play('hit', 0.9);
    onPlayerHit(p, dmg, true);
  }
}

/* ============================== tips ============================== */
// Short, one-time pointers that teach a mechanic the moment it matters.
function tip(id, desk, touch, delay = 0, cond = null) {
  if (W.mode !== 'play' || W.tipsShown.has(id)) return;
  const seen = shell.store.get(TIPS_KEY, {}) || {};
  if ((seen[id] || 0) >= TIP_RUNS) return;
  W.tipsShown.add(id);
  W.tipQ.push({ id, desk, touch: touch || desk, at: W.runT + delay, cond });
}

function stepTips() {
  if (W.tipT > 0) {
    W.tipT -= DT;
    if (W.tipT <= 0) hud.tip.classList.remove('show');
    return;
  }
  const i = W.tipQ.findIndex((t) => W.runT >= t.at);
  if (i < 0) return;
  const t = W.tipQ.splice(i, 1)[0];
  if (t.cond && !t.cond()) return;
  const seen = shell.store.get(TIPS_KEY, {}) || {};
  seen[t.id] = (seen[t.id] || 0) + 1;
  shell.store.set(TIPS_KEY, seen);
  const text = shell.input.touch ? t.touch : t.desk;
  hud.tip.textContent = text;
  hud.tip.classList.remove('show'); void hud.tip.offsetWidth; hud.tip.classList.add('show');
  hud.live.textContent = text;
  W.tipT = 4.2;
  shell.sfx.play('tip');
}

/* ============================== HUD (DOM, updated on change) ============================== */
function syncHud(force) {
  if (!hud) return;
  const L = hud.last, p = W.player;
  const hp = Math.max(0, Math.ceil(p.hp));
  if (force || hp !== L.hp) {
    L.hp = hp;
    hud.fill.style.transform = `scaleX(${clamp(hp / p.maxHp, 0, 1)})`;
    hud.hpn.textContent = String(hp);
    hud.hp.classList.toggle('low', hp <= 30);
  }
  if (force || W.wave !== L.wave) { L.wave = W.wave; hud.wave.firstElementChild.textContent = String(W.wave); }
  const vis = W.combo >= 2;
  if (vis !== L.vis) { L.vis = vis; hud.combo.classList.toggle('on', vis); }
  if (vis) {
    if (W.mult !== L.mult) { L.mult = W.mult; hud.mult.textContent = 'x' + W.mult; hud.combo.classList.remove('pop'); void hud.combo.offsetWidth; hud.combo.classList.add('pop'); }
    if (W.combo !== L.hits) { L.hits = W.combo; hud.hits.textContent = W.combo + ' HITS'; }
    hud.cbar.style.transform = `scaleX(${clamp(W.comboT / 2.3, 0, 1)})`;
  }
  // RIOT meter (HUD bar + the touch SUPER button ring)
  const riot = Math.floor(W.riot);
  if (force || riot !== L.riot) {
    L.riot = riot;
    hud.riotFill.style.transform = `scaleX(${riot / 100})`;
    hud.superBtn?.style.setProperty('--riot', String(riot / 100));
  }
  const full = W.riot >= 100;
  if (force || full !== L.full) { L.full = full; hud.riot.classList.toggle('full', full); hud.superBtn?.classList.toggle('full', full); }
  // boss health
  const on = !!(W.boss && W.boss.hp > 0);
  if (force || on !== L.bossOn) { L.bossOn = on; hud.boss.classList.toggle('on', on); }
  if (on) {
    const k = clamp(W.boss.hp / W.boss.maxHp, 0, 1);
    if (k !== L.boss) { L.boss = k; hud.bossFill.style.transform = `scaleX(${k})`; hud.boss.classList.toggle('mad', k < 0.5); }
  }
  // the key legend steps back once the run is underway
  if (W.mode === 'play' && !W.legendDim && W.runT > 14) { W.legendDim = true; hud.legend.classList.add('dim'); }
}

/* ============================== render ============================== */
g.render = (ctx, alpha, sh) => {
  const { juice, particles, view } = sh;
  const reduced = juice.reduced;
  const hitstopping = juice.hitstopMs > 0;

  ctx.clearRect(0, 0, view.w, view.h);

  ctx.save();
  juice.applyCamera(ctx, view.w / 2, view.h * 0.62);

  // giant wave numeral behind the action
  if (W.wave > 0 && sh.state !== 'title') {
    ctx.font = `${Math.round(V.H * 0.62 * V.s)}px ${DISPLAY}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(236,238,244,.07)';
    ctx.strokeText(String(W.wave), view.w / 2, V.ground * V.s - 24 * V.s);
  }

  ctx.translate(V.ox, 0);
  ctx.scale(V.s, V.s);

  drawRopes(ctx, reduced);
  const all = allFighters();
  for (const f of all) drawShadow(ctx, f, alpha);
  // bodies on the floor first, then the upright crowd (big ones behind), player on top
  for (const f of W.enemies) if (f.state === 'dead') drawFighter(ctx, f, alpha, reduced, hitstopping);
  for (const f of W.enemies) if (f.state === 'rag') drawFighter(ctx, f, alpha, reduced, hitstopping);
  for (const f of W.enemies) if (f.state !== 'dead' && f.state !== 'rag' && f.s > 1.3) drawFighter(ctx, f, alpha, reduced, hitstopping);
  for (const f of W.enemies) if (f.state !== 'dead' && f.state !== 'rag' && f.s <= 1.3) drawFighter(ctx, f, alpha, reduced, hitstopping);
  drawFighter(ctx, W.player, alpha, reduced, hitstopping);
  drawWaves(ctx);
  particles.draw(ctx, alpha);
  ctx.restore();

  // red edge flash when the player takes damage
  if (W.hurtFlash > 0 && !reduced) {
    const a = clamp(W.hurtFlash / 0.35, 0, 1) * 0.45;
    const gr = ctx.createRadialGradient(view.w / 2, view.h / 2, Math.min(view.w, view.h) * 0.3, view.w / 2, view.h / 2, Math.max(view.w, view.h) * 0.7);
    gr.addColorStop(0, 'rgba(255,62,62,0)'); gr.addColorStop(1, `rgba(255,62,62,${a})`);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, view.w, view.h);
  }
  syncHud(false);
};

function bolt(ctx, x1, y1, x2, y2, segs, jitter) {
  ctx.beginPath(); ctx.moveTo(x1, y1);
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    ctx.lineTo(x1 + (x2 - x1) * t + rand(-jitter, jitter), y1 + (y2 - y1) * t + rand(-jitter, jitter));
  }
  ctx.lineTo(x2, y2); ctx.stroke();
}

function drawRopes(ctx, reduced) {
  ctx.lineCap = 'round';
  // current pulses running along the live ropes
  if (!reduced) {
    for (let i = 0; i < ROPES.length; i++) {
      const h = ROPES[i], x = ((W.t * 0.38 + i * 0.37) % 1) * V.arenaW;
      ctx.strokeStyle = 'rgba(255,90,90,.85)'; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(x - 16, ropeY(h, x - 16)); ctx.lineTo(x + 16, ropeY(h, x + 16)); ctx.stroke();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(x - 6, ropeY(h, x - 6)); ctx.lineTo(x + 6, ropeY(h, x + 6)); ctx.stroke();
    }
  }
  // zaps: the ropes flare and bolts jump from the post to the body
  for (const fx of W.ropeFx) {
    const k = clamp(fx.t / 0.32, 0, 1), px = fx.side < 0 ? 0 : V.arenaW;
    ctx.globalAlpha = k;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    for (const h of ROPES) {
      ctx.beginPath(); ctx.moveTo(0, V.ground - h); ctx.quadraticCurveTo(V.arenaW / 2, V.ground - h + 9, V.arenaW, V.ground - h); ctx.stroke();
    }
    for (let b = 0; b < 3; b++) {
      ctx.strokeStyle = b === 0 ? '#ffffff' : ACCENT; ctx.lineWidth = b === 0 ? 2.6 : 1.6;
      bolt(ctx, px, V.ground - ROPES[b], fx.x, fx.y, 6, 9);
    }
  }
  ctx.globalAlpha = 1;
}

function drawWaves(ctx) {
  const gy = V.ground;
  for (const w of W.waves) {
    const a = clamp(w.t / 0.35, 0, 1), d = w.dir, x = w.x;
    ctx.globalAlpha = a * 0.5;
    ctx.fillStyle = ACCENT;
    ctx.beginPath(); ctx.moveTo(x - d * 54, gy); ctx.quadraticCurveTo(x - d * 14, gy - 40, x + d * 8, gy); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = a;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3.2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - d * 46, gy - 1); ctx.quadraticCurveTo(x - d * 10, gy - 34, x + d * 6, gy - 1); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/* ============================== test hooks (only reachable with ?debug) ============================== */
g.debug = {
  snapshot() {
    return {
      state: shell.state, phase: W.phase, wave: W.wave, score: W.score, kills: W.kills, combo: W.combo, mult: W.mult,
      runT: W.runT, queue: W.queue.length, riot: W.riot, zaps: W.zaps, bosses: W.bosses, shockwaves: W.waves.length, supers: W.supers,
      boss: W.boss ? { hp: W.boss.hp, maxHp: W.boss.maxHp, state: W.boss.state } : null,
      player: { x: W.player.x, hp: W.player.hp, state: W.player.state, face: W.player.face },
      enemies: W.enemies.map((e) => ({ kind: e.kind, x: e.x, hp: e.hp, state: e.state, dead: e.state === 'dead', guard: e.guard })),
      ragdolls: W.enemies.filter((e) => e.ragdolled).length,
    };
  },
  // spawn n enemies in the middle of the arena and launch them all (stress test)
  stress(n = 10) {
    for (let i = 0; i < n; i++) {
      const e = spawnEnemy(i % 4 === 3 ? 'brute' : 'grunt', i % 2 ? 1 : -1);
      e.entering = false; e.invuln = 0;
      e.x = V.arenaW * (0.15 + 0.7 * (i / Math.max(1, n - 1)));
      e.hp = 99;
      e.launch((Math.random() - 0.5) * 1400, -500 - Math.random() * 500, (Math.random() - 0.5) * 12);
      e.ragT = -30; // stay down for the whole measurement
      e.ai.cd = 99;
    }
  },
  riot(n = 100) { W.riot = n; },
  // jump straight to wave n (clears the ring first)
  wave(n) { W.enemies.length = 0; W.waves.length = 0; W.boss = null; startWave(n); },
  spawn(kind = 'shield') { const e = spawnEnemy(kind, 1); return e.kind; },
  // throw the first standing enemy into the right-hand ropes, credited to the player
  fling() {
    const e = W.enemies.find((f) => f.alive && !f.ragdolled && !f.armor);
    if (!e) return false;
    e.entering = false; e.invuln = 0; e.bowl = true;
    e.launch(1600, -700, 2);
    return true;
  },
  arena: () => ({ ...V }),
};

export default g;
