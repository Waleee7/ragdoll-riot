// RAGDOLL RIOT: a stickman ragdoll arena brawler.
// Punch, kick and launch waves of stickmen. Hits are Verlet ragdolls with real
// weight; every impact gets hit-stop, shake scaled to force, sparks and dust, and
// the last enemy of each wave gets a slow-mo beat.
// Waves mix grunts, runners, shields and brutes, and every 5th wave brings the boss.
// The walls are live: bodies launched into them get zapped (ropes), spiked (pit) or erased (margins).
// Hits fill the RIOT meter, and a full meter unleashes a super that blasts the whole ring.
// Locations (js/stages.js): three stages, seven pictures. THE RIOT SPREADS keeps one run going while the
// fight breaks through into a new location every 3 waves; the single-location modes change picture after each boss.
import { clamp, lerp, ease, rand, sign } from './juice.js';
import { Fighter, ATK, drawFighter, drawShadow } from './fighter.js';
import { DT, HEAD, NECK, PELV } from './rig.js';
import { STAGES, VARIANTS, MODES, DEFAULT_MODE, isMode, modeOf, nextCycle, stageOfVariant, fitCover } from './stages.js';
import * as art from './art.js';
import { Backdrop } from './backdrop.js';
import { ROPES } from './paint.js';
import { PAL, HZ, drawAmbient, drawHazard, drawWallFx } from './scenery.js';

const BG = '#090a0f';
const DISPLAY = '"Futura Condensed ExtraBold","Impact","Haettenschweiler","Arial Narrow Bold",sans-serif';
const REACH = { grunt: 68, runner: 60, shield: 76, brute: 96 };
const GIANT = { dur: 10, scale: 1.6, every: 9, orbLife: 9 };   // the GIANT power-up: size, seconds, knockouts between orbs
const TIPS_KEY = 'ragdoll-riot:tips';
const TIP_RUNS = 3;                     // a tip shows on the first few runs that reach it
const BREAK_EVERY = 3;                  // THE RIOT SPREADS: a new location every 3 waves
const COMBO_S = 2.3;                    // combo window (s)
const WIPE_S = 0.7, FADE_S = 0.4;       // transition lengths (sim seconds; slow-mo has ended before one starts)

const V = { attractMin: 18, s: 1, ox: 0, arenaW: 1000, H: 620, ground: 500, w: 1, h: 1, touch: false };
const W = {};          // world state, rebuilt by reset()
let shell = null;
let hud = null;
let backdrop = null;
let C = PAL.ring;      // palette of the location on screen (ink on paper in The Margins)

// Location state. cur = what is committed on screen; startVid + queue = the plan for the next/current run.
const S = { mode: DEFAULT_MODE, cur: null, stage: STAGES.ring, startVid: null, queue: [], fresh: false, want: null, runBreak: false };
const perf = { amb: 0 };
const AMB = { stage: 'ring', vid: null, F: null, view: null, V, t: 0, reduced: false, thin: false, crowd: 0, alpha: 1 };

const g = { slug: 'ragdoll-riot', name: 'RAGDOLL RIOT', modes: MODES };

/* ============================== setup / layout ============================== */
g.setup = (sh) => {
  shell = sh;
  g.shell = sh;
  const $ = (id) => document.getElementById(id);
  hud = {
    hp: $('rr-hp'), fill: $('rr-hp-fill'), hpn: $('rr-hp-n'),
    wave: $('rr-wave'), loc: $('rr-loc'), combo: $('rr-combo'),
    mult: $('rr-mult'), hits: $('rr-hits'), cbar: $('rr-cbar'),
    riot: $('rr-riot'), riotFill: $('rr-riot-fill'),
    boss: $('rr-boss'), bossFill: $('rr-boss-fill'), bossName: $('rr-boss-name'),
    tip: $('tip'), legend: $('legend'), live: $('sr-live'),
    superBtn: document.querySelector('#touch [data-action="super"]'),
    banner: $('banner'), score: document.querySelector('.hud-score'),
    last: { hp: -1, wave: -1, mult: -1, hits: -1, vis: null, riot: -1, full: null, boss: -1, bossOn: null },
  };
  backdrop = new Backdrop(sh.bgCanvas);
  backdrop.onCommit = onCommit;
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
  if (hud) placeTip(hud.boss.classList.contains('on'));
  backdrop.paint(view, V);                              // (a transition in flight is finished first, so a resize mid-wipe stays correct)
  if (W.player) {
    // keep fighters on the new floor / inside the new walls
    for (const f of allFighters()) { f.groundY = V.ground; if (f.onGround && !f.ragdolled) f.y = V.ground; }
  }
};

/* ============================== locations ============================== */
const stageOf = (vid) => STAGES[VARIANTS[vid].stage];
const nextVariant = () => {
  if (S.mode === 'infinite') return S.queue[0] || null;
  const list = S.stage.variants, i = list.indexOf(S.cur);
  return list[(i + 1) % list.length];
};
// The first location of a run. prefer: a restart picks among pictures that are already decoded (the one on screen, the one
// planned next), so the run opens on art instead of flashing the procedural background while a random one loads.
const pickStart = (mode, prefer = false) => {
  if (mode === 'infinite') {
    const first = prefer ? [S.queue[0], S.cur].find((v) => v && art.peek(v)) : null;
    const q = nextCycle(null, Math.random, first);
    return { vid: q.shift(), queue: q };
  }
  let list = STAGES[mode].variants;
  if (prefer) { const ok = list.filter((v) => art.peek(v)); if (ok.length) list = ok; }
  return { vid: list[Math.floor(Math.random() * list.length)], queue: [] };
};
const topUpQueue = () => { if (S.mode === 'infinite' && S.queue.length < 3) S.queue.push(...nextCycle(S.queue[S.queue.length - 1] || S.cur)); };

// Decode only what is needed: the picture on screen and the one it is about to become.
function preload() {
  const T = backdrop?.T, target = S.want?.vid ?? (T && !T.committed ? T.vid : null) ?? nextVariant();
  const keep = [S.cur, target].filter(Boolean);
  art.keep(keep);
  for (const id of keep) art.load(id);
}

// The swap becomes real (palette, hazards, HUD labels). Runs mid-transition, or immediately when no picture is moving.
function applyStage(vid, force = false) {
  const changed = force || S.stage !== stageOf(vid);
  const was = C;
  S.cur = vid; S.stage = stageOf(vid); C = PAL[S.stage.id];
  if (shell) {
    if (was !== C) recolorLive(was, C);
    shell.particles.stroke = C.stroke; shell.particles.dustColor = C.dust; shell.juice.flashDefault = C.flash;
    document.body.dataset.stage = S.stage.id; document.body.dataset.paper = C.paper ? '1' : '0';
    hud.bossName.textContent = S.stage.boss; hud.loc.textContent = S.stage.name;
  }
  if (W.wallFx && changed) { W.wallFx.length = 0; W.hz = null; W.hzT = 3; }   // a late-art fade into the same place must not wipe a live hazard
}

// Popups and sparks already in the air keep the colours they were spawned with (white on dark art). When the palette swaps,
// swap them too, so "SPIKED! +320" does not stay white on The Margins' paper. Matches each colour back to its palette slot.
function recolorLive(from, to) {
  const slot = {};
  for (const k of Object.keys(from)) if (typeof from[k] === 'string' && !(from[k] in slot) && typeof to[k] === 'string') slot[from[k]] = to[k];
  for (const p of shell.particles.list) if (p.on && slot[p.color]) p.color = slot[p.color];
}

// T.tag says whose transition this is: only the run's own break-through advances the plan (a late-art fade never does).
function onCommit(vid, T) {
  const brk = T?.tag === 'break';
  applyStage(vid, brk);
  dropStaleTips();
  if (brk) {
    S.runBreak = false;
    if (S.mode === 'infinite') { const i = S.queue.indexOf(vid); if (i >= 0) S.queue.splice(i, 1); }   // the place we arrived at leaves the plan, whichever way we got there
    topUpQueue();
    W.crossed++; W.breakDue = false;
    if (shell.state === 'play') {
      W.hudNext = true;                                    // the HUD chip and the banner name the same wave
      showBanner(S.stage.name, `WAVE ${W.wave + 1}`);
      stageTips();
    }
    const { sfx, juice, particles } = shell;
    sfx.play('thud', 1); sfx.play('rip');
    juice.shake(14); juice.hitstop(60);
    if (!juice.reduced) {
      const dir = W.lastDir || 1, x = dir > 0 ? V.arenaW * 0.78 : V.arenaW * 0.22;
      particles.dust(x, V.ground, 12, 120); particles.dots(x, V.ground - 40, 18, 520, C.w);
    }
  }
  preload();
}

// Ask for a picture change. Waits (without blocking the game) until the image is ready; a failed image counts as ready.
function wantBackdrop(vid, kind = 'fade', dir = 1) { S.want = { vid, kind, dir }; preload(); }

function pump() {
  if (backdrop.active || !backdrop.view) return;
  if (!S.want && backdrop.cur && backdrop.F && !backdrop.F.shown && art.peek(backdrop.cur)) S.want = { vid: backdrop.cur, kind: 'fade', dir: 1 };   // late image: fade the art in over the fallback
  const w = S.want; if (!w) return;
  if (!art.ready(w.vid)) { art.load(w.vid); return; }
  S.want = null;
  backdrop.start(w.vid, 'fade', w.dir, FADE_S, 0.5);
}

// Selecting a location (title screen). instant: no fade (boot, deep link before first paint).
g.setMode = (id, o = {}) => {
  if (!isMode(id)) id = DEFAULT_MODE;
  S.mode = id; S.fresh = true;
  const { vid, queue } = pickStart(id, !!o.prefer);
  S.startVid = vid; S.queue = queue;
  if (!backdrop.view || o.instant) { S.want = null; backdrop.cancel(); applyStage(vid); backdrop.cur = vid; if (backdrop.view) backdrop.setCurrent(vid); preload(); }
  else if (vid !== (backdrop.T ? backdrop.T.vid : backdrop.cur)) wantBackdrop(vid, 'fade');
  else { S.want = null; preload(); }       // already what is (or is about to be) on screen: an older, slower pick must not land on top of it
};
g.getMode = () => S.mode;

function beginRun(play) {
  if (play && !S.fresh) { const { vid, queue } = pickStart(S.mode, true); S.startVid = vid; S.queue = queue; }
  if (play) S.fresh = false;     // the title preview belongs to the first run: the attract reset must not spend it
  S.want = null; S.runBreak = false;
  const was = backdrop.active;
  if (was) backdrop.cancel();      // restart mid-transition: drop it, show the run's first location
  if (was || S.cur !== S.startVid || backdrop.cur !== S.startVid) { applyStage(S.startVid); backdrop.setCurrent(S.startVid); }
  topUpQueue(); preload();
}

// The break-through: slow-mo has played out; the new picture wipes in from the side the last body flew.
function startBreak(vid) {
  const { juice, sfx } = shell;
  backdrop.start(vid, juice.reduced ? 'fade' : 'wipe', W.lastDir || 1, juice.reduced ? FADE_S : WIPE_S, 0.5, 'break');
  S.runBreak = true; W.breaking = true;       // (after start(): it finishes any fade still running, whose commit is not ours)
  sfx.play('rip');
  shell.particles.fadeText();                 // the old place's finisher word and popups are gone before the new place (and its banner) arrive
  hideTip();                                  // no old-place tip drifts over the wipe or the new banner
  if (!juice.reduced) juice.shake(10);
  preload();
}

// While a break-through is coming (the last enemies of a break wave, or the clear phase), paint the incoming layer a band
// per frame so the wipe's first frame only composites. Throttled by wall time: one band per ~12 ms, never several in one frame.
let prepAt = 0;
function prepBreak() {
  const coming = W.mode === 'play' && shell.state === 'play' && W.phase !== 'dead' && !W.breaking && !backdrop.active &&
    (W.breakDue || ((S.mode === 'infinite' ? W.wave % BREAK_EVERY === 0 : W.wave % 5 === 0) && W.queue.length === 0));
  if (!coming) { backdrop.drop(); return; }
  const nxt = nextVariant(), now = performance.now();
  if (!nxt || !art.ready(nxt) || now - prepAt < 12) return;
  prepAt = now; backdrop.prep(nxt);
}

// The run ended during a break-through: a wipe that has not committed is dropped and the old picture repainted (it must not
// move on behind the game-over panel, and the stats must match what is on screen); a committed one just finishes.
function settleBreak() {
  const T = backdrop.T;
  if (T && !T.committed) { backdrop.cancel(); backdrop.paint(backdrop.view, V); }
  if (!backdrop.T) { S.runBreak = false; W.breaking = false; }
  W.breakDue = false; backdrop.drop();
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
  beginRun(mode === 'play');
  W.mode = mode;
  W.t = 0; W.runT = 0;
  W.score = 0; W.kills = 0; W.combo = 0; W.comboT = 0; W.mult = 1; W.maxMult = 1; W.maxCombo = 0;
  W.wave = 0; W.hudNext = false; W.phase = mode === 'play' ? 'banner' : 'attract'; W.phaseT = 0; W.queue = []; W.spawnT = 0; W.spawnGap = 1;
  W.maxAlive = 4; W.tokens = 1; W.spd = 1; W.enrage = 0;
  W.riot = 0; W.superFired = true; W.supers = 0; W.zaps = 0; W.bosses = 0; W.boss = null; W.auto = false; W.god = false;
  W.orb = null; W.nextOrb = GIANT.every; W.giantT = 0; W.gv = 0; W.slideCd = 0; W.giants = 0;
  W.waves = []; W.ropeFx = []; W.wallFx = []; W.hz = null; W.hzT = 3.5; W.hzHits = 0;
  W.crossed = 0; W.breakDue = false; W.breaking = false; W.lastDir = 1; W.crowd = 0; W.hard = 0; W.wallFinishers = 0;
  W.tipQ = []; W.tipT = 0; W.tipStage = null; W.carry = false; W.tipsShown = new Set(); W.kicked = false; W.legendDim = false;
  W.enemies = [];
  W.player = new Fighter('player', mode === 'attract' ? V.arenaW * 0.7 : V.arenaW * 0.4, V.ground);
  W.player.lo = 18; W.player.hi = V.arenaW - 18;
  W.bot = { cd: 0.5, step: 0 };
  W.buf = { atk: '', t: 0, jump: 0, src: '' };
  W.hurtFlash = 0;
  W.finisher = false;
  shell.input.latch.clear();
  hud.tip.classList.remove('show');
  hud.banner.classList.remove('show');
  hud.legend.classList.remove('dim');
  if (mode === 'play') startWave(1);
  else { for (let i = 0; i < 3; i++) spawnEnemy('grunt', V.attractMin > 100 ? 1 : (i % 2 ? 1 : -1)); }
  syncHud(true);
};

function startWave(n) {
  W.wave = n; W.hudNext = false;
  const bossWave = n % 5 === 0;
  const k = Math.floor(n / 5);
  let grunts, runners = 0, shields = 0, brutes = 0;
  if (bossWave) { grunts = Math.min(30, 2 + k); runners = Math.min(8, k); }
  else {
    runners = n >= 2 ? Math.min(4, 1 + Math.floor((n - 2) / 2)) : 0;
    shields = n >= 4 ? Math.min(3, 1 + Math.floor((n - 4) / 3)) : 0;
    brutes = n >= 3 ? Math.min(8, 1 + Math.floor((n - 3) / 2)) : 0;
    grunts = Math.min(30, Math.max(2, 3 + Math.floor((n - 1) * 1.6) - Math.floor((runners + shields) / 2)));   // capped: the climb past wave 50 is HP, damage and pace, not an ever-longer queue
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
  W.hard = clamp((n - 12) / 38, 0, 2.5);   // keeps climbing past wave 50 (enemy damage), bounded
  W.phase = 'banner'; W.phaseT = 0; W.spawnT = 0.2; W.finisher = false;

  let sub;
  if (bossWave) sub = `${S.stage.boss} IS HERE`;
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
    tip('slide', 'PRESS S WHILE MOVING TO SLIDE UNDER SWINGS AND TRIP ENEMIES.', 'FLICK THE STICK DOWN TO SLIDE UNDER SWINGS AND TRIP ENEMIES.', 18);
    tip('kick', 'KICK (K) SENDS THEM FLYING INTO EACH OTHER.', 'KICK SENDS THEM FLYING INTO EACH OTHER.', 9, () => !W.kicked);
  }
  if (n >= 2) stageTips();
}

// What the walls and the timed hazard of the location we are standing in do (never the ropes tip in The Pit).
function stageTips() {
  const st = S.stage;
  tip(st.id === 'ring' ? 'ropes' : `wall-${st.id}`, () => S.stage.wallTip, null, 1.3, null, st.id);
  if (W.hz) tip(`hz-${st.id}`, () => S.stage.hazardTip, null, 0, null, st.id);
}

function showBanner(text, sub) {
  const b = hud.banner;
  shell.particles.fadeText();                 // big words from the last fight never sit under a banner
  b.replaceChildren(document.createTextNode(text));
  if (sub) { const s = document.createElement('small'); s.textContent = sub; b.append(s); }
  placeBanner(text);
  b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  // The tip (touch, portrait) sits under the banner: wherever this banner ends, one-line or wrapped, plate or not.
  hud.tip.style.setProperty('--banner-b', Math.ceil(b.getBoundingClientRect().bottom) + 'px');
}

// Phones: the banner lives in the free space the HUD leaves. Portrait: under the whole HUD stack (and the boss bar on a boss wave).
// Short landscape: between the left stack and the score. Elsewhere it stays centred.
function placeBanner(text) {
  const b = hud.banner, vw = innerWidth, vh = innerHeight, r = (el) => el.getBoundingClientRect();
  const bossSpace = hud.boss.classList.contains('on') || /^BOSS/.test(text);
  const pad = document.body.dataset.paper === '1' ? 14 : 4;     // a lit combo on paper wears a plate
  const left = [hud.hp, hud.riot, hud.wave, hud.combo].map(r);
  if (vw <= vh) {
    let bot = Math.max(r(hud.score).bottom, ...left.map((q) => q.bottom + pad), bossSpace ? r(hud.boss).bottom : 0);
    b.style.setProperty('--ban-t', Math.ceil(bot + 12) + 'px');
  } else {
    b.style.setProperty('--ban-l', Math.ceil(Math.max(...left.map((q) => q.right)) + 14) + 'px');
    b.style.setProperty('--ban-r', Math.ceil(vw - r(hud.score).left + 14) + 'px');
  }
}

// Screen rects that big popups keep clear of (HUD plates, touch buttons, top-bar buttons); refreshed a few times a second.
let avoidAt = 0;
function refreshAvoid() {
  const now = performance.now();
  if (now - avoidAt < 200) return;
  avoidAt = now;
  const els = [hud.score, hud.hp, hud.riot, hud.wave, hud.combo, hud.boss.classList.contains('on') && hud.boss,
    ...document.querySelectorAll('#pausebtn, #mute, .bar .daytag, #touch .tbtn, #touch .stick')];
  shell.particles.avoid = els.filter(Boolean).map((el) => el.getBoundingClientRect()).filter((q) => q.width > 0 && q.height > 0)
    .map((q) => ({ x: q.x, y: q.y, r: q.right, b: q.bottom }));
}

// The boss bar and the tip share the top of a portrait phone: the tip is pinned under the bar while a boss is up.
function placeTip(on) {
  hud.tip.classList.toggle('after-boss', on);
  if (on) hud.tip.style.setProperty('--boss-b', Math.ceil(hud.boss.getBoundingClientRect().bottom) + 'px');
}

function spawnEnemy(kind, side) {
  const off = kind === 'boss' ? 90 : 50;
  const inked = S.stage.id === 'margins';       // The Margins: enemies are drawn on at the edge, not walked in
  const e = new Fighter(kind, inked ? (side < 0 ? 60 : V.arenaW - 60) : (side < 0 ? -off : V.arenaW + off), V.ground);
  e.face = -side;
  e.entering = true; e.invuln = 99;
  if (inked) e.drawT = 0.5;
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
    tip('boss', () => `${S.stage.boss} POUNDS THE FLOOR. JUMP OVER THE SHOCKWAVES.`, null, 0.8, null, S.stage.id);
  }
  W.enemies.push(e);
  return e;
}

/* ============================== update ============================== */
g.update = (dt, sh) => {
  const playing = sh.state === 'play';
  pump(); prepBreak();       // (the transition itself runs on real time: see g.render)
  if (backdrop.active) wipeDebris();
  W.t += DT;
  if (playing) W.runT += DT;
  W.enrage = clamp((W.runT - 55) / 45, 0, 1);   // late-run pressure keeps runs inside ~3 minutes
  const p = W.player;
  const wb = bounds();

  // ---- player intent
  const intent = playing && p.alive ? (W.auto ? botIntent() : humanIntent()) : (W.mode === 'attract' && sh.state === 'title' ? botIntent() : null);
  if (intent) playerControl(p, intent);
  if (W.mode === 'attract' || W.god) { p.hp = p.maxHp; if (W.mode === 'attract') p.invuln = 0; }

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
  stepHazard(playing);
  stepPower(playing);
  for (let i = W.ropeFx.length - 1; i >= 0; i--) if ((W.ropeFx[i].t -= DT) <= 0) W.ropeFx.splice(i, 1);
  for (let i = W.wallFx.length - 1; i >= 0; i--) if ((W.wallFx[i].t -= DT) <= 0) W.wallFx.splice(i, 1);
  if (W.crowd > 0) W.crowd = Math.max(0, W.crowd - DT * 1.3);

  // ---- combo timer. It waits through a break-through (clear, wipe, the new banner) until the first hit in the new place, so the multiplier really carries over.
  if (W.combo > 0 && !W.carry && !backdrop.active) {
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
    jump: inp.pressed('up'), slide: inp.pressed('down'),
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
    const target = it.ax * p.k.speed * p.speedMul * (p.onGround ? 1 : 0.92);
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
  // slide: feet first under the swings, tripping whoever it reaches (a jump cancels it)
  buf.slide = it.slide ? 0.2 : (buf.slide || 0) - DT;
  if (buf.slide > 0 && p.onGround && W.slideCd <= 0
    && (p.state === 'idle' || (p.state === 'atk' && p.atk.a > 0 && p.atkName !== 'roar' && p.t >= p.atk.dur * (p.atk.b + 0.03)))) {
    if (it.ax !== 0) p.face = sign(it.ax);
    p.startAttack('slide'); p.vx = p.face * 680 * p.speedMul;
    W.slideCd = 0.75; buf.slide = 0; buf.atk = '';
    sh.sfx.play('slide');
    sh.particles.dust(p.x, V.ground, 6, 26);
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
  if (e.drawT > 0 && !e.entering) e.drawT = 0;
  const p = W.player, ai = e.ai;
  const speed = e.k.speed * e.speedMul * (e.armor && e.hp < e.maxHp * 0.5 ? 1.35 : 1);
  if (e.entering && e.drawT > 0) { e.drawT -= DT; e.vx = 0; e.face = e.x < V.arenaW / 2 ? 1 : -1; if (e.drawT <= 0) { e.drawT = 0; e.entering = false; e.invuln = 0; } return; }
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
      // a location change is due: every 3rd wave in THE RIOT SPREADS, after each boss in a single location
      if (S.mode === 'infinite' ? W.wave % BREAK_EVERY === 0 : W.wave % 5 === 0) W.breakDue = true;
      if (W.breakDue) { W.carry = true; W.bannerShown = true; shell.particles.text(W.player.x, V.ground - 170, `+16 HP   +${bonus}`, C.acc, 26, 1.3); }   // the location banner replaces WAVE CLEAR
    }
  } else if (W.phase === 'clear') {
    const brk = W.breakDue && !W.breaking, nxt = brk ? nextVariant() : null, jc = shell.juice;
    if (!W.bannerShown && W.phaseT > 0.55) {
      W.bannerShown = true;
      showBanner('WAVE CLEAR', `+16 HP   +${100 * W.wave} BONUS`);
    }
    // the picture swaps once the finisher slow-mo has played out; if the next image is not decoded yet, keep fighting here until it is
    // (and once the incoming layer is painted, so the wipe's first frame is cheap; a stalled prep falls back to painting it on the spot)
    if (brk && nxt && W.phaseT > 0.3 && !backdrop.active && art.ready(nxt) && jc.slowMs <= 0 && jc.hitstopMs <= 0 && (backdrop.prepared(nxt) || W.phaseT > 1.2)) startBreak(nxt);
    if (W.phaseT > 2.4 && !backdrop.active) { W.breaking = false; startWave(W.wave + 1); }
  }
}

function addScore(n) { W.score += n; shell.setScore(W.score); }

/* ---------- landing / wall events ---------- */
/* ---------- the GIANT power-up: a gold orb drops every few knockouts ---------- */
function stepPower(playing) {
  const p = W.player, { particles, sfx, juice } = shell;
  if (W.slideCd > 0) W.slideCd -= DT;
  if (p.state === 'atk' && p.atkName === 'slide' && p.onGround && Math.floor(W.t * 60) % 3 === 0) particles.dust(p.x + p.face * 26 * p.s, V.ground, 1, 14);

  if (playing && W.mode === 'play' && !W.orb && W.giantT <= 0 && W.kills >= W.nextOrb && W.phase === 'fight' && p.alive) spawnOrb();
  const o = W.orb;
  if (o) {
    o.t += DT; o.vy += 1500 * DT; o.y += o.vy * DT;
    const rest = V.ground - 42;
    if (o.y > rest) { o.y = rest; if (o.vy > 120) { particles.dust(o.x, V.ground, 3, 16); o.vy *= -0.45; } else { o.vy = 0; o.landed = true; } }
    if (o.landed) o.life -= DT;
    if (o.life <= 0) { W.orb = null; W.nextOrb = W.kills + GIANT.every; }
    else if (p.alive && !p.ragdolled && p.state !== 'getup' && Math.abs(p.x - o.x) < 42 * p.s && p.y - o.y < 150) goGiant(p, o);
  }

  // size follows a spring, so growing overshoots and settles; the last 2 s pulse as a warning
  if (W.giantT > 0 && p.alive) {
    W.giantT -= DT;
    if (W.giantT <= 0) {
      W.giantT = 0; p.giant = false; p.giantGlow = false; p.speedMul = 1;
      sfx.play('shrink'); particles.ring(p.x, V.ground - 60, 90, C.acc, 0.3);
    }
  }
  const warn = W.giantT > 0 && W.giantT < 2;
  const blink = warn && Math.floor(W.giantT * 6) % 2 === 0;
  if (p.giant) p.giantGlow = !blink;
  const want = W.giantT > 0 ? (blink ? GIANT.scale - 0.14 : GIANT.scale) : 1;
  if (Math.abs(want - p.s) > 0.002 || Math.abs(W.gv) > 0.01) {
    W.gv = (W.gv + (want - p.s) * 200 * DT) * 0.86;
    p.setScale(clamp(p.s + W.gv * DT * 6, 0.9, 1.85));
  } else if (p.s !== want) { p.setScale(want); W.gv = 0; }
  if (p.giant && p.onGround && Math.abs(p.vx) > 60 && Math.floor(W.t * 60) % 14 === 0) { particles.dust(p.x, V.ground, 2, 22); juice.shake(1.2); }
}

function spawnOrb() {
  const p = W.player, lo = 90, hi = V.arenaW - 90;
  let x = rand(lo, hi);
  if (Math.abs(x - p.x) < 200) x = p.x < V.arenaW / 2 ? Math.min(hi, p.x + rand(200, 340)) : Math.max(lo, p.x - rand(200, 340));
  W.orb = { x, y: -40, vy: 0, t: 0, life: GIANT.orbLife, landed: false };
  shell.sfx.play('orb');
  tip('giant', 'GRAB THE GOLD ORB TO GO GIANT: DOUBLE DAMAGE, AND A JUMP LANDS AS A SHOCKWAVE.', 'GRAB THE GOLD ORB TO GO GIANT: DOUBLE DAMAGE, AND A JUMP LANDS AS A SHOCKWAVE.', 0);
}

function goGiant(p, o) {
  const { particles, sfx, juice } = shell;
  W.orb = null; W.giants++;
  W.giantT = GIANT.dur; W.nextOrb = W.kills + GIANT.every;
  p.giant = true; p.giantGlow = true; p.speedMul = 1.14; W.gv = 0;
  sfx.play('grow');
  juice.flash(0.22); juice.shake(9); juice.zoomPunch(0.05, 320, wx(p.x), wy(V.ground - 80));
  particles.ring(o.x, o.y, 120, '#ffc23a', 0.45);
  particles.ring(o.x, o.y, 70, C.w, 0.3);
  particles.dots(o.x, o.y, 26, 620, '#ffc23a');
  particles.dust(p.x, V.ground, 10, 60);
  particles.text(p.x, V.ground - 210, 'GIANT!', C.pGiant ?? '#ffc23a', 54, 1.1);
  W.crowd = Math.max(W.crowd, 1);
}

// landing a jump while GIANT: the floor jumps, and everyone near it goes up
function giantStomp(p) {
  const { particles, juice, sfx } = shell;
  juice.shake(10); sfx.play('thud', 1);
  particles.dust(p.x, V.ground, 12, 70);
  particles.ring(p.x, V.ground - 6, 170, '#ffc23a', 0.32);
  for (const e of W.enemies) {
    if (!e.alive || e.entering || e.ragdolled || !e.onGround || Math.abs(e.x - p.x) > 180) continue;
    applyHit(p, e, 'gstomp', e.x, V.ground - 50 * e.s);
  }
}

function drawOrb(ctx, reduced) {
  const o = W.orb;
  if (o.landed && o.life < 2.5 && !reduced && Math.floor(o.life * 8) % 2 === 0) return;
  const bob = o.landed && !reduced ? Math.sin(W.t * 4) * 5 : 0, y = o.y + bob, pu = reduced ? 1 : 1 + Math.sin(W.t * 7) * 0.08;
  const gr = ctx.createRadialGradient(o.x, y, 4, o.x, y, 62 * pu);
  gr.addColorStop(0, 'rgba(255,194,58,.6)'); gr.addColorStop(1, 'rgba(255,194,58,0)');
  ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(o.x, y, 62 * pu, 0, 6.2832); ctx.fill();
  ctx.fillStyle = '#ffc23a'; ctx.strokeStyle = '#3a2500'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(o.x, y, 19, 0, 6.2832); ctx.fill(); ctx.stroke();
  // a little up arrow, because it makes you bigger
  ctx.strokeStyle = '#3a2500'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(o.x, y + 10); ctx.lineTo(o.x, y - 9); ctx.moveTo(o.x - 8, y - 2); ctx.lineTo(o.x, y - 10); ctx.lineTo(o.x + 8, y - 2); ctx.stroke();
  const a = W.t * 2.4;
  ctx.strokeStyle = '#ffc23a'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(o.x, y, 29 * pu, a, a + 1.9); ctx.stroke();
  ctx.beginPath(); ctx.arc(o.x, y, 29 * pu, a + 3.14, a + 5.04); ctx.stroke();
}

function drawGiantAura(ctx, alpha, reduced) {
  const p = W.player, r = p.rig;
  const x = r.px[PELV] + (r.x[PELV] - r.px[PELV]) * alpha, y = r.py[PELV] + (r.y[PELV] - r.py[PELV]) * alpha;
  const R = 92 * p.s * (reduced ? 1 : 1 + Math.sin(W.t * 9) * 0.05);
  const gr = ctx.createRadialGradient(x, y, 8, x, y, R);
  gr.addColorStop(0, 'rgba(255,194,58,.34)'); gr.addColorStop(1, 'rgba(255,194,58,0)');
  ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, R, 0, 6.2832); ctx.fill();
}

// the time left, as a ring over the head: it travels with the player and fits every screen size
function drawGiantTimer(ctx, alpha) {
  const p = W.player, r = p.rig;
  const x = r.px[HEAD] + (r.x[HEAD] - r.px[HEAD]) * alpha, y = (r.py[HEAD] + (r.y[HEAD] - r.py[HEAD]) * alpha) - 38 * p.s;
  const R = 15, k = clamp(W.giantT / GIANT.dur, 0, 1);
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(9,10,15,.65)'; ctx.lineWidth = 7; ctx.beginPath(); ctx.arc(x, y, R, 0, 6.2832); ctx.stroke();
  ctx.strokeStyle = W.giantT < 2 ? C.acc : '#ffc23a'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(x, y, R, -Math.PI / 2, -Math.PI / 2 + 6.2832 * k); ctx.stroke();
}

function afterStep(f) {
  const { sfx, juice, particles } = shell;
  if (f.evLand) {
    particles.dust(f.x, V.ground, 6, 24);
    if (f.giant) giantStomp(f);
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
      if (imp > 700) particles.sparks(r.impactX, V.ground - 2, -Math.PI / 2, 1.1, Math.round(3 + k * 7), 160 + k * 240, C.mid);
      sfx.play('thud', k);
      juice.shake(1.5 + 8 * k);
      if (k > 0.55 && f.alive) juice.hitstop(28 * k);
    }
    const wall = r.wallHit * 60;
    // the walls are live: a body thrown into them is zapped / spiked / erased and flung back into the ring
    if (f.ragdolled && wall > 360 && f.zapCd <= 0) wallHit(f, r.wallX, r.wallY);
    else if (wall > 520) {
      const k = clamp((wall - 520) / 1200, 0, 1);
      particles.dust(r.wallX, r.wallY, 6, 16);
      particles.sparks(r.wallX, r.wallY, r.wallX < V.arenaW / 2 ? 0 : Math.PI, 0.9, 6 + Math.round(8 * k), 260 + 240 * k, C.w);
      particles.ring(r.wallX, r.wallY, 20 + 24 * k, C.w, 0.22);
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
      if (v.team === 'p' && (v.invuln > 0 || v.ragdolled || v.state === 'getup' || !v.alive || v.atkName === 'slide' && v.state === 'atk')) continue;
      if (!hitTest(hx, hy, spec.r * (a.giant ? a.s : 1), v)) continue;
      a.atkHit.add(v);
      applyHit(a, v, a.atkName, hx, hy);
    }
  }
}

function applyHit(a, v, name, hx, hy) {
  const { juice, particles, sfx } = shell;
  const spec = ATK[name];
  const byPlayer = a.team === 'p';
  const dir = name === 'gstomp' ? (sign(v.x - a.x) || 1) : a.face || sign(v.x - a.x);
  const juggling = v.ragdolled;

  // ---- shield guard: punches from the front bounce off, a kick breaks it
  if (byPlayer && v.guard && !juggling && v.state !== 'getup' && sign(a.x - v.x) === v.face) {
    if (name !== 'k' && name !== 'slide' && name !== 'gstomp') { blocked(a, v, hx, hy); return; }
    breakGuard(v, dir, false);
  }

  const dmgScale = byPlayer ? 1 : (1 + W.enrage * 0.9 + W.hard * 0.35);
  const dmg = spec.dmg * dmgScale * (a.giant ? 2 : 1) * (v.giant ? 0.5 : 1);   // GIANT hits twice as hard and takes half
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
    if (v.giant && !kill) launch = false;
    const m = v.mass;
    let vx = dir * spec.vx * (a.giant ? 1.25 : 1) / m, vy = spec.vy / Math.pow(m, 0.7);
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
  particles.sparks(hx, hy, ang - 0.25, 0.75, Math.round(7 + 17 * I), 300 + 380 * I, C.w);
  particles.sparks(hx, hy, ang - 0.25, 0.95, Math.round(4 + 8 * I), 240 + 260 * I, C.acc);
  particles.ring(hx, hy, 22 + 34 * I, byPlayer ? C.w : C.acc, 0.26);
  if (I > 0.7) {
    juice.zoomPunch(0.018 + 0.03 * I, 170, wx(hx), wy(hy));
    particles.dust(v.x, V.ground, 4, 24);
  }
  if (kill) { juice.flash(0.16 + 0.1 * I); particles.dots(hx, hy, 14, 520, C.acc); }
  if (byPlayer && I > 0.7) W.crowd = Math.max(W.crowd, 0.5 + 0.4 * I);
  sfx.play('hit', I);
  if (kill) sfx.play('kill', I);

  // ---- bookkeeping
  if (byPlayer && name === 'slide') { addScore(50); shell.particles.text(v.x, V.ground - 120 * v.s, 'TACKLE! +50', C.acc, 24); }
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
  particles.sparks(hx, hy, dir > 0 ? Math.PI : 0, 0.9, 10, 380, C.w);
  particles.ring(hx, hy, 18, C.soft, 0.2);
  particles.text(hx, hy - 30, 'BLOCK', C.grey, 20, 0.6);
  sfx.play('block');
  tip('blocked', 'BLOCKED. KICK THE SHIELD (K), OR HIT IT FROM BEHIND.', 'BLOCKED. KICK THE SHIELD, OR HIT IT FROM BEHIND.', 0);
}

function breakGuard(e, dir, quiet) {
  const { juice, particles, sfx } = shell;
  e.guard = false;
  const hx = e.rig.x[NECK] + e.face * 8, hy = e.rig.y[NECK] + 20;
  particles.sparks(hx, hy, dir > 0 ? 0 : Math.PI, 1.1, 16, 460, C.w);
  particles.dots(hx, hy, 10, 420, C.soft);
  particles.text(e.x, V.ground - 150, 'GUARD BROKEN', C.w, 26, 1.0);
  if (!quiet) { sfx.play('guard'); juice.shake(6); }
}

function bumpMult() {
  const prev = W.mult;
  W.mult = Math.min(10, 1 + Math.floor(W.combo / 4));
  if (W.mult > prev) {
    W.maxMult = Math.max(W.maxMult, W.mult);
    shell.particles.text(W.player.x, V.ground - 190, 'x' + W.mult + ' COMBO', C.acc, 38, 1.0);
    shell.sfx.play('combo', W.mult);
  }
}

function chain() { if (W.phase === 'fight') W.carry = false; W.combo++; W.comboT = COMBO_S; W.maxCombo = Math.max(W.maxCombo, W.combo); bumpMult(); }

function gainRiot(n) {
  if (W.mode !== 'play' || W.riot >= 100) return;
  W.riot = Math.min(100, W.riot + n);
  if (W.riot >= 100) {
    shell.sfx.play('ready');
    shell.particles.text(W.player.x, V.ground - 220, 'RIOT READY', C.acc, 30, 1.1);
    tip('super', 'RIOT METER FULL. PRESS L TO UNLEASH IT.', 'RIOT METER FULL. TAP SUPER TO UNLEASH IT.', 0);
  }
}

function registerHit(v, kill, juggling, spec, hx, hy) {
  chain();
  let base = kill ? (v.kind === 'brute' ? 300 : v.kind === 'shield' ? 150 : 100) : spec.dmg >= 2 ? 25 : 10;
  if (juggling && !kill) base += 25;
  const pts = base * W.mult;
  if (W.mode === 'play') addScore(pts);
  shell.particles.text(hx, hy - 34, '+' + pts, kill ? C.w : C.pink, kill ? 30 : 22, 0.8);
  gainRiot(kill ? 12 : juggling ? 8 : spec.launch ? 7 : 5);
  if (spec === ATK.p3 && !kill) tip('juggle', "NICE. HIT THEM WHILE THEY'RE IN THE AIR TO JUGGLE.", null, 0.3);
}

function onKill(v, via) {
  const { juice, particles, sfx } = shell;
  W.kills++;
  {   // which side the body flew: the next location wipes in from there
    const vx = v.rig.x[PELV] - v.rig.px[PELV];
    W.lastDir = via === 'wall' || Math.abs(vx) < 0.4 ? (v.x < V.arenaW / 2 ? -1 : 1) : sign(vx);
  }
  if (v.kind === 'boss') {
    // the boss gets its own beat, even when it is the last one standing
    W.bosses++;
    if (W.boss === v) W.boss = null;
    const bonus = 1000 * Math.max(1, Math.floor(W.wave / 5));
    if (W.mode === 'play') { addScore(bonus); W.player.hp = Math.min(W.player.maxHp, W.player.hp + 30); }
    juice.slowmo(0.18, 1600); juice.zoomPunch(0.16, 1400, wx(v.x), wy(V.ground - 120));
    juice.flash(0.4); juice.shake(16);
    particles.text(v.x, V.ground - 270, 'BOSS DOWN', C.w, 72, 1.6);
    particles.text(v.x, V.ground - 205, `+${bonus}   +30 HP`, C.acc, 30, 1.6);
    particles.dots(v.x, V.ground - 120, 40, 800, C.acc);
    sfx.play('finisher');
    return;
  }
  const left = W.enemies.filter((e) => e.hp > 0 && e !== v).length;
  if (W.mode === 'play' && W.phase === 'fight' && left === 0 && W.queue.length === 0) {
    // last enemy of the wave: slow-mo beat with a camera push on the body
    W.finisher = true;
    hideTip();                                // the finisher word is the payoff: nothing sits over it
    if (via === 'wall') {
      // launched into the wall hazard: longer slow-mo, the stage's big word and a bonus
      W.wallFinishers++;
      const bonus = 500;
      addScore(bonus);
      juice.slowmo(0.1, 2200);
      juice.zoomPunch(0.26, 2000, wx(v.x), wy(V.ground - 80));
      juice.flash(0.45);
      juice.shake(16);
      particles.text(v.x, V.ground - 190, S.stage.finisher, C.w, 70, 2.0);
      particles.text(v.x, V.ground - 130, `+${bonus}`, C.acc, 34, 2.0);
      sfx.play('finisher'); sfx.play('thud', 1);
      return;
    }
    juice.slowmo(0.2, 1300);
    juice.zoomPunch(0.2, 1250, wx(v.x), wy(V.ground - 60));
    juice.flash(0.3);
    juice.shake(10);
    particles.text(v.x, V.ground - 160, 'K.O.', C.w, 64, 1.3);
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
        particles.sparks(t.x, py, dir > 0 ? Math.PI : 0, 0.9, 12, 380, C.w);
        sfx.play('hit', 0.7);
        chain();
        const pts = 60 * W.mult;
        if (W.mode === 'play') addScore(pts);
        particles.text(t.x, py - 40, 'BONK! +' + pts, C.w, 26, 1.0);
        gainRiot(6);
        break;
      }
      t.launch(clamp(vx * 0.75, -900, 900) / t.mass, Math.min(-300, vy * 0.4 - 220) / Math.pow(t.mass, 0.7), dir * rand(3, 7));
      t.bowl = true;
      r.scaleVelocity(0.55);
      juice.hitstop(kill ? 120 : 70); juice.shake(kill ? 14 : 9);
      particles.sparks(t.x, py, dir > 0 ? 0 : Math.PI, 0.9, 16, 460, C.w);
      particles.ring(t.x, py, 40, C.acc, 0.3);
      sfx.play('hit', 0.85);
      chain();
      const pts = (kill ? 150 : 60) * W.mult;
      if (W.mode === 'play') addScore(pts);
      particles.text(t.x, py - 40, 'STRIKE! +' + pts, C.w, 26, 1.0);
      W.crowd = 1;
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
  juice.flash(0.14, C.acc);
  sfx.play('hurt');
  if (p.hp <= 0 && W.mode === 'play') {
    p.hp = 0;
    if (p.state !== 'rag' && p.state !== 'dead') p.launch(-p.face * 520, -420, -p.face * 4);
    else p.die();
    p.state = 'dead';
    W.phase = 'dead';
    settleBreak();
    juice.slowmo(0.28, 1400); juice.hitstop(160); juice.flash(0.4, C.w);
    shell.end({
      score: W.score,
      heading: 'KNOCKED OUT',
      delay: 1250,
      lines: [['WAVE', W.wave], ['KNOCKOUTS', W.kills], ['TOP MULTIPLIER', 'x' + W.maxMult], ['BEST CHAIN', W.maxCombo + ' HITS'],
        [S.mode === 'infinite' ? 'WALL HITS' : S.stage.stat, W.zaps], ['BOSSES DOWN', W.bosses], ['MODE', modeOf(S.mode).name],
        ...(S.mode === 'infinite' ? [['LOCATIONS CROSSED', W.crossed]] : [])],
    });
  }
}

/* ---------- live walls: ropes (ring), spike racks (pit), erasers (margins) ---------- */
function wallHit(f, x, y) {
  const { juice, particles, sfx } = shell;
  const st = S.stage, id = st.id;
  f.zapCd = 0.8;
  const side = x < V.arenaW / 2 ? -1 : 1;
  const inward = side < 0 ? 0 : Math.PI;
  if (id === 'ring') W.ropeFx.push({ side, x, y, t: 0.32 });
  else {
    if (W.wallFx.length >= 10) W.wallFx.shift();      // bounded
    W.wallFx.push({ stage: id, side, x: side < 0 ? 16 : V.arenaW - 16, y, t: 0.55, max: 0.55, seed: Math.random() * 100 });
  }
  f.rig.kick(-side * 520, -240);             // the wall flings the body back into the ring
  particles.sparks(x, y, inward, 1.2, 12, 460, C.w);
  if (!f.alive) return;                      // bodies still bounce off; only the living get hurt
  f.flash = 0.22; f.shakeT = 0.3;
  if (id === 'pit') { particles.sparks(x, y, inward, 1.2, 14, 480, '#ffb347'); particles.dots(x, y, 12, 420, '#ff7a1a'); }
  else if (id === 'margins') particles.dots(x, y, 10, 300, '#f08aa3');
  else particles.sparks(x, y, inward, 1.2, 10, 420, C.acc);
  particles.ring(x, y, 40, id === 'pit' ? '#ffb347' : C.w, 0.3);
  juice.shake(9); juice.hitstop(60); juice.flash(0.1, id === 'pit' ? '#ff9a3a' : C.w);
  sfx.play(id === 'pit' ? 'flame' : id === 'margins' ? 'erase' : 'zap');
  W.crowd = Math.max(W.crowd, 0.7);
  if (f.team === 'e') {
    f.hp -= 3;
    const kill = f.hp <= 0;
    if (kill) f.die();
    const credited = W.mode === 'play' && f.bowl;
    if (credited) {
      W.zaps++;
      chain();
      const pts = (kill ? 160 : 80) * W.mult;
      addScore(pts);
      particles.text(x - side * 70, y - 78, `${st.wall}! +${pts}`, C.w, 28, 1.0);
      gainRiot(12);
    }
    if (kill) onKill(f, credited ? 'wall' : null);
  } else if (W.mode === 'play') {
    f.hp -= 6;
    particles.text(x - side * 60, y - 30, id === 'ring' ? 'ZAPPED' : st.wall, C.acc, 24, 0.9);
    onPlayerHit(f, 6, true);
  }
}

/* ---------- the timed stage hazard (wave 2+): a clear warning, then it fires; it hurts both sides ---------- */
function spawnHazard(x, warnScale = 1) {
  const id = S.stage.id, cfg = HZ[id], p = W.player;
  if (x === undefined) {
    // between the player and the nearest enemy, so it is a threat to both
    const near = nearestEnemy(p, 1e9);
    const a = near ? lerp(p.x, near.x, 0.3 + Math.random() * 0.6) : rand(110, V.arenaW - 110);
    x = clamp(a, cfg.w * 0.5 + 40, V.arenaW - cfg.w * 0.5 - 40);
  }
  W.hz = { kind: id, phase: 'warn', t: 0, x, w: cfg.w, hit: new Set(), warn: cfg.warn * warnScale };
  shell.sfx.play('warn');
  tip(`hz-${id}`, () => S.stage.hazardTip, null, 0, null, id);
}

function stepHazard(playing) {
  let hz = W.hz;
  if (!hz) {
    if (W.mode === 'play' && playing && W.phase === 'fight' && W.wave >= 2 && !backdrop.active) {
      W.hzT -= DT;
      if (W.hzT <= 0) spawnHazard();
    }
    return;
  }
  const cfg = HZ[hz.kind], { sfx, juice } = shell;
  hz.t += DT;
  if (hz.phase === 'warn') {
    if (hz.t >= hz.warn) {
      hz.phase = 'live'; hz.t = 0;
      sfx.play(hz.kind === 'pit' ? 'flame' : hz.kind === 'margins' ? 'erase' : 'zap');
      juice.shake(hz.kind === 'pit' ? 7 : 5);
    }
  } else if (hz.phase === 'live') {
    hazardHits(hz);
    if (hz.t >= cfg.live) { hz.phase = 'cool'; hz.t = 0; }
  } else if (hz.t >= cfg.cool) {
    W.hz = null;
    W.hzT = Math.max(3, 7.5 - 0.12 * W.wave) + Math.random() * 2.5;
  }
}

function hazardHits(hz) {
  const jet = hz.kind === 'pit';
  for (const f of allFighters()) {
    if (hz.hit.has(f) || !f.alive || f.state === 'dead' || f.entering) continue;
    if (f.team === 'p' && (W.mode !== 'play' || f.invuln > 0 || f.state === 'getup')) continue;
    if (Math.abs(f.x - hz.x) > hz.w / 2) continue;
    const grounded = f.ragdolled ? f.rig.grounded : f.onGround;
    if (!jet && !grounded) continue;                   // hop over the floor patches; the jet is a column
    if (jet && f.rig.y[PELV] < V.ground - 190) continue;
    hz.hit.add(f);
    hazardHit(f, hz);
  }
}

function hazardHit(f, hz) {
  const { juice, particles, sfx } = shell, st = S.stage, word = st.hazardWord;
  const dir = sign(f.x - hz.x);
  W.crowd = Math.max(W.crowd, 0.6);
  if (hz.kind === 'pit') { particles.sparks(f.x, V.ground - 30, -Math.PI / 2, 0.9, 14, 420, '#ffb347'); particles.dots(f.x, V.ground - 40, 10, 380, '#ff7a1a'); }
  else particles.sparks(f.x, V.ground - 20, -Math.PI / 2, 1.1, 12, 380, hz.kind === 'margins' ? C.w : C.acc);
  juice.shake(10); juice.hitstop(70);
  if (f.team === 'p') {
    const dmg = 8 * (1 + W.enrage * 0.9 + W.hard * 0.35);
    f.hp -= dmg;
    f.launch(dir * 300, -520, dir * 3);
    if (f.alive) f.invuln = 1.2;
    f.flash = 0.2;
    particles.text(f.x, V.ground - 140, word, C.acc, 26, 0.9);
    sfx.play('hurt');
    onPlayerHit(f, dmg, true);
    return;
  }
  f.hp -= 3; f.flash = 0.2; f.shakeT = 0.3;
  const kill = f.hp <= 0;
  if (!f.armor || kill) f.launch(dir * 380 / f.mass, -560 / Math.pow(f.mass, 0.7), dir * rand(3, 6));
  if (W.mode === 'play') {
    W.hzHits++;
    chain();
    const pts = (kill ? 160 : 70) * W.mult;
    addScore(pts);
    particles.text(f.x, V.ground - 150, `${word}! +${pts}`, C.w, 26, 1.0);
    gainRiot(8);
  }
  sfx.play('hit', 0.7);
  if (kill) { sfx.play('kill', 0.7); onKill(f, null); }
}

// Debris and dust along the front of the wipe, so the picture reads as tearing through.
function wipeDebris() {
  const T = backdrop.T;
  if (!T || T.kind !== 'wipe' || (W.t * 60 | 0) % 2) return;
  const x = (T.front / (shell.view.bgDpr || shell.view.dpr) - V.ox) / V.s;
  if (x < -40 || x > V.arenaW + 40) return;
  shell.particles.dust(x, V.ground, 2, 50);
  shell.particles.dots(x, rand(V.ground * 0.25, V.ground), 2, 420, C.w);
}

/* ---------- the RIOT super ---------- */
function fireSuper() {
  const { juice, particles, sfx } = shell;
  const p = W.player;
  const cx = p.x, cy = V.ground - 60;
  juice.flash(0.5, C.w); juice.slowmo(0.3, 800); juice.shake(18); juice.hitstop(70);
  juice.zoomPunch(0.08, 600, wx(cx), wy(cy));
  particles.ring(cx, cy, 90, C.w, 0.45);
  particles.ring(cx, cy, 150, C.acc, 0.6);
  particles.ring(cx, V.ground, 220, C.w, 0.7);
  particles.dots(cx, cy, 30, 700, C.acc);
  particles.dust(cx, V.ground, 14, 60);
  particles.text(cx, cy - 120, 'RIOT!', C.w, 72, 1.2);
  sfx.play('super');
  W.crowd = 1;
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
  particles.ring(x0, V.ground, 70, C.w, 0.4);
  particles.sparks(x0, V.ground - 4, -Math.PI / 2, 1.3, 18, 420, C.mid);
  sfx.play('stomp');
}

function stepWaves() {
  const p = W.player, { juice, particles, sfx } = shell;
  for (let i = W.waves.length - 1; i >= 0; i--) {
    const w = W.waves[i];
    w.x += w.dir * 560 * DT; w.t -= DT;
    if (w.t <= 0 || w.x < -60 || w.x > V.arenaW + 60) { W.waves.splice(i, 1); continue; }
    if ((W.t * 60 | 0) % 3 === 0) particles.dust(w.x, V.ground, 1, 14, C.mid);
    if (w.hit || W.mode !== 'play' || !p.alive || !p.onGround || p.ragdolled || p.state === 'getup' || p.invuln > 0) continue;
    if (Math.abs(p.x - w.x) > 26) continue;
    // jump it, or eat it
    w.hit = true;
    const dmg = ATK.stomp.dmg * (1 + W.enrage * 0.9);
    p.hp -= dmg;
    p.launch(w.dir * 320, -760, w.dir * 3);
    if (p.alive) p.invuln = 1.2;
    juice.hitstop(90); juice.shake(12);
    particles.sparks(p.x, V.ground - 8, -Math.PI / 2, 0.9, 14, 420, C.w);
    particles.ring(p.x, V.ground - 20, 40, C.acc, 0.3);
    sfx.play('hit', 0.9);
    onPlayerHit(p, dmg, true);
  }
}

/* ============================== tips ============================== */
// Short, one-time pointers that teach a mechanic the moment it matters.
// A tip about a location (walls, hazard, boss) carries that location's id and builds its text when it is SHOWN, from the
// stage we are standing in; one that is still queued when the picture changes is dropped, so no tip names the wrong place.
const readSeen = () => {      // the per-tip run counts; a corrupt stored value (not a plain object) counts as nothing seen
  const raw = shell.store.get(TIPS_KEY, {});
  const seen = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) if (Number.isFinite(v) && v > 0) seen[k] = Math.floor(v);
  return seen;
};

function tip(id, desk, touch, delay = 0, cond = null, stage = null) {
  if (W.mode !== 'play' || W.tipsShown.has(id)) return;
  if ((readSeen()[id] || 0) >= TIP_RUNS) return;
  W.tipsShown.add(id);
  W.tipQ.push({ id, desk, touch: touch || desk, at: W.runT + delay, cond, stage });
}

// The picture changed: forget queued tips about the old place (they may be asked for again where they belong), hide one on screen.
function dropStaleTips() {
  if (!W.tipQ) return;
  W.tipQ = W.tipQ.filter((t) => { const stale = t.stage && t.stage !== S.stage.id; if (stale) W.tipsShown.delete(t.id); return !stale; });
  if (W.tipStage && W.tipStage !== S.stage.id && W.tipT > 0) hideTip();
}

// Gone at once (no fade-out): a fading card would still be on screen over what comes next.
function hideTip() {
  W.tipT = 0;
  const el = hud?.tip; if (!el) return;
  el.style.transition = 'none'; el.classList.remove('show'); void el.offsetWidth; el.style.transition = '';
}

function stepTips() {
  if (W.tipT > 0) {
    W.tipT -= DT;
    if (W.tipT <= 0) hud.tip.classList.remove('show');
    return;
  }
  if (W.breaking || backdrop.T?.tag === 'break') return;     // tips wait out the wipe; they are shown once the new place is in
  if (W.phase === 'banner' || W.phase === 'clear' || W.finisher) return;   // a tip never lands over the wave banner or a finisher
  const i = W.tipQ.findIndex((t) => W.runT >= t.at);
  if (i < 0) return;
  const t = W.tipQ.splice(i, 1)[0];
  if (t.stage && t.stage !== S.stage.id) { W.tipsShown.delete(t.id); return; }
  if (t.cond && !t.cond()) return;
  const seen = readSeen();
  seen[t.id] = (seen[t.id] || 0) + 1;
  shell.store.set(TIPS_KEY, seen);
  const pick = shell.input.touch ? t.touch : t.desk;
  const text = typeof pick === 'function' ? pick() : pick;
  hud.tip.textContent = text;
  hud.tip.classList.remove('show'); void hud.tip.offsetWidth; hud.tip.classList.add('show');
  hud.live.textContent = text;
  placeTip(hud.boss.classList.contains('on'));
  W.tipT = 4.2; W.tipStage = t.stage;
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
  const wv = W.wave + (W.hudNext ? 1 : 0);
  if (force || wv !== L.wave) { L.wave = wv; hud.wave.firstElementChild.textContent = String(wv); }
  const vis = W.combo >= 2;
  if (vis !== L.vis) { L.vis = vis; hud.combo.classList.toggle('on', vis); }
  if (vis) {
    if (W.mult !== L.mult) { L.mult = W.mult; hud.mult.textContent = 'x' + W.mult; hud.combo.classList.remove('pop'); void hud.combo.offsetWidth; hud.combo.classList.add('pop'); }
    if (W.combo !== L.hits) { L.hits = W.combo; hud.hits.textContent = W.combo + ' HITS'; }
    hud.cbar.style.transform = `scaleX(${clamp(W.comboT / COMBO_S, 0, 1)})`;
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
  if (force || on !== L.bossOn) { L.bossOn = on; hud.boss.classList.toggle('on', on); placeTip(on); }
  if (on) {
    const k = clamp(W.boss.hp / W.boss.maxHp, 0, 1);
    if (k !== L.boss) { L.boss = k; hud.bossFill.style.transform = `scaleX(${k})`; hud.boss.classList.toggle('mad', k < 0.5); }
  }
  // the key legend steps back once the run is underway
  if (W.mode === 'play' && !W.legendDim && W.runT > 14) { W.legendDim = true; hud.legend.classList.add('dim'); }
}

/* ============================== render ============================== */
g.render = (ctx, alpha, sh, dt = 0) => {
  const { juice, particles, view } = sh;
  const reduced = juice.reduced;
  const hitstopping = juice.hitstopMs > 0;

  backdrop.step(dt);                       // real time (0 while paused): hit-stop and slow-mo never stretch a wipe
  backdrop.render();                       // only does work while a location transition is running
  ctx.clearRect(0, 0, view.w, view.h);

  // ambient life: behind everything, locked to the painted picture (so it ignores camera shake and zoom, like the picture)
  if (backdrop.F) {
    const t0 = performance.now(), T = backdrop.T;
    AMB.stage = stageOfVariant(backdrop.cur).id; AMB.vid = backdrop.cur; AMB.F = backdrop.F; AMB.view = view;
    AMB.t = W.t + alpha * DT; AMB.reduced = reduced; AMB.thin = view.w < 700 || V.touch; AMB.crowd = W.crowd;
    AMB.alpha = T ? Math.abs(2 * T.p - 1) : 1;
    drawAmbient(ctx, AMB);
    perf.amb += (performance.now() - t0 - perf.amb) * 0.05;
  }

  ctx.save();
  juice.applyCamera(ctx, view.w / 2, view.h * 0.62);

  // giant wave numeral behind the action
  if (W.wave > 0 && sh.state !== 'title') {
    ctx.font = `${Math.round(V.H * 0.62 * V.s)}px ${DISPLAY}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 2; ctx.strokeStyle = C.num;
    ctx.strokeText(String(W.wave + (W.hudNext ? 1 : 0)), view.w / 2, V.ground * V.s - 24 * V.s);
  }

  ctx.translate(V.ox, 0);
  ctx.scale(V.s, V.s);

  if (S.stage.id === 'ring') drawRopes(ctx, reduced);
  else for (const fx of W.wallFx) drawWallFx(ctx, fx, V, W.t);
  if (W.hz) drawHazard(ctx, W.hz, V, W.t, reduced);
  const all = allFighters();
  for (const f of all) drawShadow(ctx, f, alpha, C);
  // bodies on the floor first, then the upright crowd (big ones behind), player on top
  for (const f of W.enemies) if (f.state === 'dead') drawFighter(ctx, f, alpha, reduced, hitstopping, C);
  for (const f of W.enemies) if (f.state === 'rag') drawFighter(ctx, f, alpha, reduced, hitstopping, C);
  for (const f of W.enemies) if (f.state !== 'dead' && f.state !== 'rag' && f.s > 1.3) drawFighter(ctx, f, alpha, reduced, hitstopping, C);
  for (const f of W.enemies) if (f.state !== 'dead' && f.state !== 'rag' && f.s <= 1.3) drawFighter(ctx, f, alpha, reduced, hitstopping, C);
  if (W.orb) drawOrb(ctx, reduced);
  if (W.giantT > 0) drawGiantAura(ctx, alpha, reduced);
  drawFighter(ctx, W.player, alpha, reduced, hitstopping, C);
  if (W.giantT > 0) drawGiantTimer(ctx, alpha);
  drawWaves(ctx);
  refreshAvoid();
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
      ctx.strokeStyle = C.w; ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(x - 6, ropeY(h, x - 6)); ctx.lineTo(x + 6, ropeY(h, x + 6)); ctx.stroke();
    }
  }
  // zaps: the ropes flare and bolts jump from the post to the body
  for (const fx of W.ropeFx) {
    const k = clamp(fx.t / 0.32, 0, 1), px = fx.side < 0 ? 0 : V.arenaW;
    ctx.globalAlpha = k;
    ctx.strokeStyle = C.w; ctx.lineWidth = 2;
    for (const h of ROPES) {
      ctx.beginPath(); ctx.moveTo(0, V.ground - h); ctx.quadraticCurveTo(V.arenaW / 2, V.ground - h + 9, V.arenaW, V.ground - h); ctx.stroke();
    }
    for (let b = 0; b < 3; b++) {
      ctx.strokeStyle = b === 0 ? C.w : C.acc; ctx.lineWidth = b === 0 ? 2.6 : 1.6;
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
    ctx.fillStyle = C.acc;
    ctx.beginPath(); ctx.moveTo(x - d * 54, gy); ctx.quadraticCurveTo(x - d * 14, gy - 40, x + d * 8, gy); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = a;
    ctx.strokeStyle = C.w; ctx.lineWidth = 3.2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - d * 46, gy - 1); ctx.quadraticCurveTo(x - d * 10, gy - 34, x + d * 6, gy - 1); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/* ============================== test hooks (only reachable with ?debug) ============================== */
g.debug = {
  snapshot() {
    const T = backdrop.T;
    return {
      state: shell.state, phase: W.phase, wave: W.wave, score: W.score, kills: W.kills, combo: W.combo, mult: W.mult,
      runT: W.runT, queue: W.queue.length, riot: W.riot, zaps: W.zaps, bosses: W.bosses, shockwaves: W.waves.length, supers: W.supers,
      mode: S.mode, stage: S.stage.id, variant: S.cur, crossed: W.crossed, breakDue: W.breakDue, hazard: W.hz ? { kind: W.hz.kind, phase: W.hz.phase, x: W.hz.x, w: W.hz.w, t: W.hz.t } : null,
      hzHits: W.hzHits, wallFinishers: W.wallFinishers, finisher: W.finisher,
      transition: T ? { kind: T.kind, p: T.p, committed: T.committed, to: T.vid, dir: T.dir } : null,
      boss: W.boss ? { hp: W.boss.hp, maxHp: W.boss.maxHp, state: W.boss.state } : null,
      player: { x: W.player.x, hp: W.player.hp, state: W.player.state, face: W.player.face },
      enemies: W.enemies.map((e) => ({ kind: e.kind, x: e.x, y: e.y, hp: e.hp, state: e.state, dead: e.state === 'dead', guard: e.guard, entering: e.entering, drawT: e.drawT })),
      ragdolls: W.enemies.filter((e) => e.ragdolled).length,
    };
  },
  // spawn n enemies in the middle of the arena and launch them all (stress test)
  stress(n = 10) {
    for (let i = 0; i < n; i++) {
      const e = spawnEnemy(i % 4 === 3 ? 'brute' : 'grunt', i % 2 ? 1 : -1);
      e.entering = false; e.invuln = 0; e.drawT = 0;
      e.x = V.arenaW * (0.15 + 0.7 * (i / Math.max(1, n - 1)));
      e.hp = 99;
      e.launch((Math.random() - 0.5) * 1400, -500 - Math.random() * 500, (Math.random() - 0.5) * 12);
      e.ragT = -30; // stay down for the whole measurement
      e.ai.cd = 99;
    }
  },
  riot(n = 100) { W.riot = n; },
  combo(n = 8) { W.combo = n; W.comboT = COMBO_S; W.mult = Math.min(10, 1 + Math.floor(n / 4)); W.maxMult = Math.max(W.maxMult, W.mult); },
  // jump straight to wave n (clears the ring first)
  wave(n) { W.enemies.length = 0; W.waves.length = 0; W.boss = null; W.hz = null; W.breaking = false; startWave(n); },
  spawn(kind = 'shield') { const e = spawnEnemy(kind, 1); return e.kind; },
  // throw the first standing enemy into the right-hand wall, credited to the player
  fling(side = 1) {
    const e = W.enemies.find((f) => f.alive && !f.ragdolled && !f.armor);
    if (!e) return false;
    e.entering = false; e.invuln = 0; e.bowl = true; e.drawT = 0;
    e.launch(side * 1600, -700, 2 * side);
    return true;
  },
  // a wave down to its last standing enemy (1 HP, mid-arena, credited), ready to be flung
  lastOne(kind = 'grunt') {
    W.enemies.length = 0; W.queue.length = 0; W.waves.length = 0; W.hz = null;
    W.phase = 'fight';
    const e = spawnEnemy(kind, 1);
    e.entering = false; e.invuln = 0; e.drawT = 0; e.hp = 1; e.x = V.arenaW * 0.6; e.zapCd = 0;
    return true;
  },
  // put a standing enemy at x (hazard tests)
  placeEnemy(x, kind = 'grunt') { const e = spawnEnemy(kind, 1); e.entering = false; e.invuln = 0; e.drawT = 0; e.x = x; e.ai.cd = 99; e.speedMul = 0; return true; },
  power() { const p = W.player; return { s: p.s, giant: p.giant, giantT: W.giantT, orb: W.orb && { ...W.orb }, nextOrb: W.nextOrb, kills: W.kills, giants: W.giants, state: p.state, atk: p.atkName, x: p.x, face: p.face, hp: p.hp, slideCd: W.slideCd }; },
  orb(x) { W.nextOrb = 1e9; W.orb = { x, y: V.ground - 42, vy: 0, t: 0, life: GIANT.orbLife, landed: true }; },
  orbDue() { W.nextOrb = W.kills; },
  // put a live enemy right next to the player, mid-swing, for the dodge tests
  swingAtPlayer() { const p = W.player, e = W.enemies.find((f) => f.alive && !f.ragdolled); if (!e) return false; e.entering = false; e.invuln = 0; e.x = p.x + 40; e.face = -1; e.state = 'idle'; e.startAttack('e1'); return true; },
  // a grunt standing beside the player, for the stomp test
  besidePlayer() { const p = W.player, e = W.enemies.find((f) => f.alive && !f.ragdolled); if (!e) return false; e.entering = false; e.x = p.x + 90; e.y = V.ground; e.onGround = true; e.state = 'idle'; return true; },
  placePlayer(x) { W.player.x = x; W.player.vx = 0; },
  hazard(x, warnScale = 1) { W.phase = W.phase === 'banner' ? 'fight' : W.phase; spawnHazard(x, warnScale); return W.hz.x; },
  // kill everything standing (and empty the queue) through the normal kill path
  slay() { W.queue.length = 0; for (const e of W.enemies) if (e.alive) { e.entering = false; e.hp = 0; e.launch(260, -420, 2); onKill(e, null); } return true; },
  hurt(n = 999) { const p = W.player; p.hp -= n; onPlayerHit(p, n, true); },
  palette() { return { ...C }; },
  calm() { shell.juice.reset(); },   // clear banked hit-stop / slow-mo (fast() banks it without frames to burn it)
  auto(on = true, god = true) { W.auto = on; W.god = god; },
  // run the simulation n seconds in one go (the soak tests): the same update() the engine calls
  fast(secs) { const n = Math.round(secs * 60); for (let i = 0; i < n; i++) { g.update(DT, shell); backdrop.step(DT); shell.particles.update(DT); shell.input.endStep(); } },
  // force a location break-through now (to `vid`, or the planned next one)
  forceBreak(vid, dir = 1) { W.lastDir = dir; startBreak(vid || nextVariant()); },
  setVariant(vid) { if (S.mode === 'infinite' || stageOfVariant(vid).id === S.mode) { applyStage(vid); backdrop.cancel(); backdrop.setCurrent(vid); preload(); } },
  fit() { return { ...backdrop.F, gy: V.ground * V.s, view: { w: V.w, h: V.h }, cur: backdrop.cur }; },
  loc() {
    const T = backdrop.T;
    return { mode: S.mode, stage: S.stage.id, cur: S.cur, next: nextVariant(), queue: [...S.queue], crossed: W.crossed, pal: C.paper ? 'paper' : 'dark', shown: !!backdrop.F?.shown,
      want: S.want?.vid || null, prep: backdrop.P ? { vid: backdrop.P.vid, done: backdrop.P.done, i: backdrop.P.i, n: backdrop.P.n } : null, tipq: (W.tipQ || []).map((t) => t.id),
      cache: art.keys().filter((k) => art.status(k) === 'ok'), cacheAll: art.keys(), t: T ? { kind: T.kind, p: T.p, committed: T.committed, to: T.vid } : null, wallFx: W.wallFx.length,
      body: { stage: document.body.dataset.stage, paper: document.body.dataset.paper } };
  },
  sizes() {
    return { enemies: W.enemies.length, waves: W.waves.length, ropeFx: W.ropeFx.length, wallFx: W.wallFx.length, tipQ: W.tipQ.length, queue: W.queue.length,
      locQueue: S.queue.length, particles: shell.particles.count, tipsShown: W.tipsShown.size, cache: art.keys().length };
  },
  perf() { return { amb: perf.amb, work: shell.engine.stats.workMs, bd: { ...backdrop.m } }; },
  texts() { return shell.particles.list.filter((p) => p.on && p.kind === 'text').map((p) => p.text); },
  banner() { return hud.banner.textContent; },
  arena: () => ({ ...V }),
};

export default g;
