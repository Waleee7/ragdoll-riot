// Everything that makes a location more than a picture, drawn live on the main canvas:
// per-stage colour palettes, ambient life (cheap, stateless, bounded), the timed stage hazard, wall-hit effects.
// Nothing here allocates per frame or keeps state: positions come from time and a hash, so there is nothing to leak.
import { VARIANTS } from './stages.js';
import { clamp, ease } from './juice.js';

const TAU = Math.PI * 2;
const hash = (i, j = 0) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };

/* ============================== palettes ============================== */
// Ring and Pit keep the house look (white player, red enemies). The Margins is dark ink on paper, so
// everything that is white elsewhere (fighter, sparks, rings, popups, flash, shadows, dust) is ink there.
const BASE = {
  paper: false, acc: '#ff3e3e', w: '#ffffff', soft: '#eceef4', mid: '#d8dbe8', grey: '#9a9eb0', pink: '#ff9a9a', dust: '#8a8fa3',
  stroke: 'rgba(9,10,15,.85)', flash: '#ffffff', num: 'rgba(236,238,244,.07)', shadow: '#000', shadowA: 0.38,
  pMain: '#f4f5f9', pBack: '#b3b7c8', eMain: null, eBack: null, bossMain: '#ff3e3e', bossBack: '#8f1d28', plate: '#c8283a', tail: '#ffd0d0',
  flashP: '#ffffff', flashE: '#ffffff', scarf: '#ff3e3e', eye: '#090a0f', shieldFill: 'rgba(16,18,26,.94)', shieldStroke: '#eceef4',
  bang: '#ffffff', bangStroke: '#090a0f', deco: null,
};
export const PAL = {
  ring: { ...BASE },
  pit: { ...BASE, bossMain: '#e8742a', bossBack: '#8a3a14', plate: '#5b2a12', deco: 'helm' },
  margins: { pGiant: '#c96f00', pGiantB: '#8f4e00',
    ...BASE, paper: true, acc: '#d1202b', w: '#1b1c24', soft: '#2a2b35', mid: '#4a4c58', grey: '#55525a', pink: '#c4636b', dust: '#6d6a62',
    stroke: 'rgba(244,239,227,.92)', flash: '#1b1c24', num: 'rgba(30,30,40,.08)', shadow: '#2a2a33', shadowA: 0.3,
    pMain: '#17181f', pBack: '#5a5c68', eMain: '#d1202b', eBack: '#8a1220', bossMain: '#b3121f', bossBack: '#6b0a14', plate: '#4b0910', tail: '#7a1a22',
    flashP: '#d1202b', flashE: '#17181f', scarf: '#d1202b', eye: '#f4efe3', shieldFill: 'rgba(244,239,227,.97)', shieldStroke: '#17181f',
    bang: '#ffd400', bangStroke: '#17181f', deco: 'scribble',
  },
};

/* ============================== ambient life ============================== */
// A = { stage, vid, F, view, V, t, reduced, thin, crowd, hype, alpha }
//   F: fit of the painted art ({ k, ox, oy, iw, ih, shown }); crowd: 0..1 "the crowd is going off" (decays in game.js)
export function drawAmbient(ctx, A) {
  if (A.alpha <= 0.01) return;
  const t = A.reduced ? 0 : A.t;
  ctx.save();
  ctx.globalAlpha = A.alpha;
  if (A.stage === 'ring' && A.F.shown) ring(ctx, A, t);
  else if (A.stage === 'pit' && A.F.shown) pit(ctx, A, t);
  else if (A.stage === 'margins') margins(ctx, A, t);
  ctx.restore();
}

// src fraction -> screen px
const sx = (A, fx) => A.F.ox + fx * A.F.iw * A.F.k;
const sy = (A, fy) => A.F.oy + (fy / VARIANTS[A.vid].crop) * A.F.ih * A.F.k;

function ring(ctx, A, t) {
  const v = VARIANTS[A.vid], sc = (A.F.ih * A.F.k) / 1072, w = A.view.w;
  // phone flashes twinkling in the crowd
  ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineCap = 'round';
  const step = A.thin ? 2 : 1;
  for (let i = 0; i < v.flashes.length; i += step) {
    const tw = Math.sin(t * (2.1 + (i % 5) * 0.43) + i * 5.1);
    if (tw < 0.45) continue;
    const k = (tw - 0.45) / 0.55, r = (7 + 12 * k) * sc;
    const x = sx(A, v.flashes[i][0]), y = sy(A, v.flashes[i][1]);
    ctx.globalAlpha = A.alpha * (0.35 + 0.65 * k); ctx.lineWidth = 1.5 * sc;
    ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r * 1.1); ctx.lineTo(x, y + r * 1.1); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 2.2 * sc, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = A.alpha;
  // a row of near-silhouette heads along the front of the crowd, bobbing; they jump on strikes and the super
  const base = sy(A, v.crowdY), r = 15 * sc, sp = r * (A.thin ? 3.4 : 2.5), jump = A.reduced ? 0 : A.crowd;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, w, base); ctx.clip();
  ctx.fillStyle = '#06070a';
  ctx.beginPath();
  for (let i = -1, n = Math.ceil(w / sp) + 1; i <= n; i++) {
    const h0 = hash(i, 3), x = i * sp + h0 * sp * 0.5;
    const bob = Math.sin(t * 3.1 + i * 1.9) * 2.2 * sc + jump * Math.abs(Math.sin(t * 9 + i * 2.3)) * (10 + 12 * h0) * sc;
    const y = base - bob - r * (0.2 + h0 * 0.35);
    ctx.moveTo(x + r * 1.7, y + r * 0.2); ctx.ellipse(x, y + r * 0.2, r * 1.7, r * 1.25, 0, 0, TAU);
    ctx.moveTo(x + r * 0.75, y - r * 1.15); ctx.arc(x, y - r * 1.15, r * 0.75, 0, TAU);
  }
  ctx.fill();
  ctx.restore();
}

function pit(ctx, A, t) {
  const v = VARIANTS[A.vid], sc = (A.F.ih * A.F.k) / 1072;
  const reduced = A.reduced;
  // hooded figures swaying (behind the flames)
  ctx.fillStyle = 'rgba(4,3,4,.93)';
  for (let i = 0; i < v.hoods.length; i += A.thin ? 2 : 1) {
    const [fx, fy, m] = v.hoods[i], x = sx(A, fx), y = sy(A, fy), s = sc * m * 1.25;
    const sw = Math.sin(t * 1.3 + i * 2.1) * 3 * s;
    ctx.beginPath();
    ctx.moveTo(x - 16 * s, y); ctx.quadraticCurveTo(x - 11 * s + sw * 0.4, y - 34 * s, x - 6 * s + sw, y - 41 * s);
    ctx.arc(x + sw * 1.1, y - 49 * s, 8.5 * s, Math.PI * 0.85, Math.PI * 0.15, false);
    ctx.quadraticCurveTo(x + 11 * s + sw * 0.4, y - 34 * s, x + 16 * s, y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,150,70,.5)'; ctx.fillRect(x + sw * 1.1 - 3.2 * s, y - 49 * s, 6.4 * s, 1.6 * s); ctx.fillStyle = 'rgba(4,3,4,.93)';
  }
  // flames flickering over the painted bowls + rising embers (additive)
  ctx.globalCompositeOperation = 'lighter';
  const emb = A.thin ? 1 : 3;
  for (let i = 0; i < v.bowls.length; i++) {
    const [fx, fy, m] = v.bowls[i], x = sx(A, fx), y = sy(A, fy), s = sc * m;
    const f1 = Math.sin(t * 9 + i * 3.1), f2 = Math.sin(t * 13.7 + i * 1.3), f3 = Math.sin(t * 6.3 + i * 0.7);
    const H = (62 + 12 * f1 + 6 * f3) * s, W = (24 + 3 * f2) * s, lean = f2 * 6 * s;
    ctx.fillStyle = 'rgba(255,110,24,.30)';
    ctx.beginPath(); ctx.moveTo(x - W, y); ctx.quadraticCurveTo(x - W * 0.9, y - H * 0.55, x + lean, y - H); ctx.quadraticCurveTo(x + W * 0.9, y - H * 0.55, x + W, y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,190,70,.34)';
    ctx.beginPath(); ctx.moveTo(x - W * 0.55, y); ctx.quadraticCurveTo(x - W * 0.5, y - H * 0.5, x + lean * 0.7, y - H * 0.72); ctx.quadraticCurveTo(x + W * 0.5, y - H * 0.5, x + W * 0.55, y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,240,190,.38)';
    ctx.beginPath(); ctx.ellipse(x + lean * 0.2, y - H * 0.18, W * 0.22, H * 0.2, 0, 0, TAU); ctx.fill();
    for (let j = 0; j < emb; j++) {
      const ph = reduced ? hash(i, j) : (t * (0.2 + 0.06 * j) + hash(i, j)) % 1;
      const ex = x + Math.sin(ph * 6 + hash(i, j + 5) * 9) * 20 * s, ey = y - 26 * s - ph * 170 * s;
      ctx.fillStyle = `rgba(255,${150 + 70 * ph | 0},60,${(1 - ph) * 0.85})`;
      const z = (1.7 - ph) * s * 1.5; ctx.fillRect(ex - z / 2, ey - z / 2, z, z);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

// Margins: tiny doodled stick spectators cheering on the ground line; the ink "boils" (re-wobbles ~8 times a second).
// Drawn in WORLD space (the caller has applied the arena transform).
function margins(ctx, A, t) {
  const V = A.V, gy = V.ground;
  const xs = [14, V.arenaW - 14, 38, V.arenaW - 38, 62, V.arenaW - 62];
  const n = A.thin ? 4 : 6, boil = Math.floor(t * 8);
  ctx.save();
  ctx.translate(V.ox, 0); ctx.scale(V.s, V.s);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const jit = (i, k) => (hash(i * 7 + k, boil) - 0.5) * 1.6;
  for (let q = 0; q < n; q++) {
    const x0 = xs[q];
    const h0 = hash(q, 11), ph = t * (5 + h0 * 3) + q * 1.7;
    const hype = A.reduced ? 0 : A.crowd;
    const hop = Math.abs(Math.sin(ph)) * (3 + hype * 14) * (0.4 + h0);
    const x = x0, y = gy - 1 - hop, s = 0.52 + h0 * 0.1;
    const arm = Math.sin(ph * 1.3) * 0.5 + 0.5;
    ctx.strokeStyle = q % 3 === 2 ? '#b3121f' : '#1b1c24'; ctx.lineWidth = 2.1;
    const hy = y - 56 * s, nk = y - 46 * s, pv = y - 24 * s;
    ctx.beginPath();
    ctx.moveTo(x + jit(q, 0), nk); ctx.lineTo(x + jit(q, 1), pv);                                  // body
    ctx.moveTo(x + jit(q, 2), pv); ctx.lineTo(x - 9 * s + jit(q, 3), y); ctx.moveTo(x, pv); ctx.lineTo(x + 9 * s + jit(q, 4), y);   // legs
    ctx.moveTo(x, nk + 3); ctx.lineTo(x - 11 * s + jit(q, 5), nk - (6 + 26 * arm) * s);            // arms up, cheering
    ctx.moveTo(x, nk + 3); ctx.lineTo(x + 11 * s + jit(q, 6), nk - (6 + 26 * (1 - arm)) * s);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(x + jit(q, 7), hy, 6.4 * s, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(x - 2 * s, hy - 1, 0.9, 0, TAU); ctx.arc(x + 2.4 * s, hy - 1, 0.9, 0, TAU); ctx.fillStyle = ctx.strokeStyle; ctx.fill();
    ctx.beginPath(); ctx.arc(x + 0.2 * s, hy + 1.8 * s, 2.2 * s, 0.1, Math.PI - 0.1); ctx.stroke();   // open-mouth grin
  }
  ctx.restore();
}

/* ============================== timed stage hazard ============================== */
// hz = { kind, phase: 'warn' | 'live' | 'cool', t, x, w }   (world space; the caller has applied the arena transform)
export const HZ = {
  ring: { warn: 1.25, live: 0.7, cool: 0.4, w: 190 },
  pit: { warn: 1.15, live: 0.75, cool: 0.4, w: 70 },
  margins: { warn: 1.3, live: 0.95, cool: 0.45, w: 200 },
};

export function drawHazard(ctx, hz, V, t, reduced) {
  const cfg = HZ[hz.kind], gy = V.ground, x = hz.x, w = hz.w;
  const warnP = hz.phase === 'warn' ? hz.t / cfg.warn : 1;
  const blink = hz.phase === 'warn' && warnP > 0.62 ? (Math.floor(hz.t / 0.07) % 2 ? 1 : 0.35) : 1;
  const fade = hz.phase === 'cool' ? clamp(1 - hz.t / cfg.cool, 0, 1) : 1;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (hz.kind === 'ring') ringHz(ctx, hz, gy, x, w, warnP, blink, fade);
  else if (hz.kind === 'pit') pitHz(ctx, hz, gy, x, w, warnP, blink, fade, t);
  else marginsHz(ctx, hz, gy, x, w, warnP, blink, fade, t, V);
  ctx.restore();
}

function ringHz(ctx, hz, gy, x, w, p, blink, fade) {
  const live = hz.phase === 'live', top = -30;
  // the rig: a lamp hanging off the top of the screen, beam locked on the floor
  ctx.globalAlpha = fade;
  ctx.fillStyle = '#0c0d12'; ctx.strokeStyle = '#eceef4'; ctx.lineWidth = 2;
  ctx.fillRect(x - 24, top - 4, 48, 34); ctx.strokeRect(x - 24, top - 4, 48, 34);
  ctx.fillStyle = live ? '#fff' : `rgba(255,${200 + 55 * p | 0},150,${0.5 + 0.5 * blink})`; ctx.fillRect(x - 17, top + 20, 34, 6);
  const bg = ctx.createLinearGradient(0, top + 26, 0, gy);
  const a = live ? 0.5 : 0.1 + 0.2 * p * blink;
  bg.addColorStop(0, `rgba(255,255,255,${a})`); bg.addColorStop(1, `rgba(255,${live ? 90 : 220},${live ? 90 : 160},${a * 0.8})`);
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.moveTo(x - 12, top + 26); ctx.lineTo(x + 12, top + 26); ctx.lineTo(x + w / 2, gy + 2); ctx.lineTo(x - w / 2, gy + 2); ctx.closePath(); ctx.fill();
  // floor patch
  const ry = 15;
  ctx.globalAlpha = fade * (live ? 0.9 : 0.35 + 0.4 * p);
  ctx.fillStyle = live ? 'rgba(255,255,255,.7)' : `rgba(255,${210 - 120 * p | 0},${150 - 90 * p | 0},.5)`;
  ctx.beginPath(); ctx.ellipse(x, gy + 3, w / 2, ry, 0, 0, TAU); ctx.fill();
  ctx.globalAlpha = fade * blink; ctx.strokeStyle = live ? '#ff3e3e' : '#ffffff'; ctx.lineWidth = 3; ctx.setLineDash(live ? [] : [14, 10]);
  ctx.beginPath(); ctx.ellipse(x, gy + 3, w / 2, ry, 0, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  if (!live) { ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(x, gy + 3, (w / 2) * p, ry * p, 0, 0, TAU); ctx.stroke(); }
  if (live) {
    // electrified: bolts from the lamp and arcs jumping off the floor
    ctx.globalAlpha = fade;
    for (let b = 0; b < 3; b++) {
      ctx.strokeStyle = b ? '#ff3e3e' : '#ffffff'; ctx.lineWidth = b ? 1.6 : 2.6;
      ctx.beginPath(); ctx.moveTo(x, top + 26);
      const tx = x + (Math.random() - 0.5) * w * 0.8;
      for (let i = 1; i < 7; i++) { const k = i / 7; ctx.lineTo(x + (tx - x) * k + (Math.random() - 0.5) * 22, top + 26 + (gy - top - 26) * k + (Math.random() - 0.5) * 10); }
      ctx.lineTo(tx, gy + 2); ctx.stroke();
    }
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    for (let b = 0; b < 4; b++) {
      const bx = x + (Math.random() - 0.5) * w * 0.9;
      ctx.beginPath(); ctx.moveTo(bx, gy); ctx.lineTo(bx + (Math.random() - 0.5) * 18, gy - 24 - Math.random() * 20); ctx.lineTo(bx + (Math.random() - 0.5) * 24, gy - 52 - Math.random() * 30); ctx.stroke();
    }
  }
}

function pitHz(ctx, hz, gy, x, w, p, blink, fade, t) {
  const live = hz.phase === 'live', hw = w / 2;
  ctx.globalCompositeOperation = 'lighter';
  // the seam: a crack in the stone that glows hotter until it blows
  ctx.globalAlpha = fade * (live ? 1 : 0.4 + 0.6 * p) * blink;
  ctx.strokeStyle = `rgb(255,${140 + 90 * p | 0},${40 + 40 * p | 0})`; ctx.lineWidth = 3.2;
  ctx.beginPath();
  const pts = [-1, -0.62, -0.3, 0.05, 0.38, 0.7, 1];
  pts.forEach((u, i) => { const px = x + u * hw * 1.15, py = gy + 4 + (i % 2 ? 5 : -2); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
  ctx.stroke();
  ctx.lineWidth = 8; ctx.globalAlpha *= 0.3; ctx.stroke();
  if (!live) {
    // the footprint of the jet, loud enough for a phone screen: a glowing floor patch and a dashed column that rises as it nears
    ctx.globalAlpha = fade * (0.25 + 0.5 * p) * blink; ctx.fillStyle = 'rgb(255,110,24)';
    ctx.beginPath(); ctx.ellipse(x, gy + 4, hw * 1.3, 13, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = fade * (0.55 + 0.45 * blink); ctx.strokeStyle = 'rgb(255,226,150)'; ctx.lineWidth = 3.6; ctx.setLineDash([9, 7]); ctx.lineDashOffset = -t * 30;
    ctx.beginPath(); ctx.moveTo(x - hw, gy); ctx.lineTo(x - hw, gy - 190 * p); ctx.moveTo(x + hw, gy); ctx.lineTo(x + hw, gy - 190 * p);
    ctx.ellipse(x, gy + 4, hw * 1.3, 13, 0, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  }
  // heat rising off it
  ctx.globalAlpha = fade * (live ? 0 : 0.5 * p);
  ctx.strokeStyle = 'rgba(255,160,70,.8)'; ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) { const hx = x + (i - 1.5) * (w / 4); ctx.beginPath(); ctx.moveTo(hx, gy); ctx.lineTo(hx + Math.sin(t * 6 + i) * 3, gy - 20 - 70 * p); ctx.stroke(); }
  if (live) {
    const u = clamp(hz.t / 0.12, 0, 1), H = 175 * ease.outCubic(u) * fade;
    for (let k = 0; k < 4; k++) {
      const ww = hw * (1 - k * 0.2), hh = H * (1 - k * 0.14) * (0.92 + 0.08 * Math.sin(t * 30 + k * 2));
      const lean = Math.sin(t * 17 + k * 1.9) * 7;
      ctx.globalAlpha = fade * [0.5, 0.55, 0.6, 0.7][k];
      ctx.fillStyle = ['rgb(230,70,10)', 'rgb(255,130,30)', 'rgb(255,200,80)', 'rgb(255,248,210)'][k];
      ctx.beginPath(); ctx.moveTo(x - ww, gy + 3); ctx.quadraticCurveTo(x - ww * 0.95 + lean * 0.4, gy - hh * 0.55, x + lean, gy - hh);
      ctx.quadraticCurveTo(x + ww * 0.95 + lean * 0.4, gy - hh * 0.55, x + ww, gy + 3); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = fade * 0.25; ctx.fillStyle = 'rgb(255,120,30)'; ctx.beginPath(); ctx.arc(x, gy - H * 0.4, hw * 2.2, 0, TAU); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function marginsHz(ctx, hz, gy, x, w, p, blink, fade, t, V) {
  const live = hz.phase === 'live', hw = w / 2;
  const ink = '#17181f';
  // the warning sketch: a dotted patch marked on the ground line, redrawn as a wobbly box
  ctx.globalAlpha = fade * (live ? 0.9 : blink);
  ctx.strokeStyle = '#d1202b'; ctx.lineWidth = 2.4; ctx.setLineDash(live ? [] : [7, 6]); ctx.lineDashOffset = -t * 14;
  const wob = (i) => (hash(i, Math.floor(t * 8)) - 0.5) * 2.2;
  ctx.beginPath();
  ctx.moveTo(x - hw + wob(0), gy - 30 + wob(1)); ctx.lineTo(x + hw + wob(2), gy - 30 + wob(3)); ctx.lineTo(x + hw + wob(4), gy + 14 + wob(5)); ctx.lineTo(x - hw + wob(6), gy + 14 + wob(7)); ctx.closePath(); ctx.stroke();
  ctx.setLineDash([]);
  if (!live) {
    // "!" scrawl
    ctx.fillStyle = '#d1202b'; ctx.font = '40px "Futura Condensed ExtraBold","Impact",sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('!', x, gy - 40 - 4 * Math.sin(t * 14));
    // the hand lowers in, faint, while the sketch draws
    drawHand(ctx, x - hw * 0.8, gy - 8, 160 - 120 * ease.outCubic(p), 0.25 + 0.3 * p, 1);
  } else {
    // scribble: zig-zags accumulate across the patch as the pencil sweeps
    const dur = HZ.margins.live, q = clamp(hz.t / dur, 0, 1), n = Math.floor(q * 22);
    ctx.strokeStyle = ink; ctx.lineWidth = 3.4; ctx.globalAlpha = fade;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const u = i / 22, px = x - hw + u * w, py = gy - 14 + (i % 2 ? -17 : 17) + wob(i + 9);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.stroke();
    const tipX = x - hw + q * w + Math.sin(t * 30) * 5;
    drawHand(ctx, tipX, gy - 6 + Math.sin(t * 36) * 9, 0, 1, 1);
  }
}

// A giant stylised hand holding a pencil, tip at (tx, ty). lift raises it (world units). Mitten fingers, ink outline.
function drawHand(ctx, tx, ty, lift, a, s) {
  ctx.save();
  ctx.globalAlpha *= a; ctx.translate(tx, ty - lift); ctx.scale(s, s);
  ctx.lineWidth = 2.6; ctx.strokeStyle = '#17181f'; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // pencil (leaning right, tip at origin)
  ctx.save(); ctx.rotate(0.38);
  ctx.fillStyle = '#e8c9a0'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-7, -26); ctx.lineTo(7, -26); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#17181f'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-2.4, -9); ctx.lineTo(2.4, -9); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#f2c230'; ctx.fillRect(-7, -150, 14, 124); ctx.strokeRect(-7, -150, 14, 124);
  ctx.fillStyle = '#c99a1c'; ctx.fillRect(-7, -150, 4, 124);
  ctx.fillStyle = '#c9ccd4'; ctx.fillRect(-7, -162, 14, 12); ctx.strokeRect(-7, -162, 14, 12);
  ctx.fillStyle = '#f08aa3'; ctx.beginPath(); ctx.roundRect(-7, -176, 14, 14, [5, 5, 0, 0]); ctx.fill(); ctx.stroke();
  // hand wrapped around the upper pencil: palm + four fingers + thumb, then the forearm going off the top
  ctx.fillStyle = '#f6e6d4';
  ctx.beginPath(); ctx.roundRect(-30, -150, 60, 46, 18); ctx.fill(); ctx.stroke();
  for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.roundRect(-34 + i * 17, -118, 17, 38, 8); ctx.fill(); ctx.stroke(); }
  ctx.beginPath(); ctx.roundRect(-44, -140, 20, 40, 9); ctx.fill(); ctx.stroke();
  ctx.fillRect(-26, -2200, 52, 2050); ctx.strokeRect(-26, -2200, 52, 2050);   // the forearm runs off the top of the screen
  ctx.beginPath(); ctx.moveTo(-14, -128); ctx.lineTo(-14, -140); ctx.moveTo(0, -128); ctx.lineTo(0, -140); ctx.moveTo(14, -128); ctx.lineTo(14, -140); ctx.stroke();
  ctx.restore();
  ctx.restore();
}

/* ============================== wall-hit effects ============================== */
// fx = { stage, side, x, y, t, max, seed }
export function drawWallFx(ctx, fx, V, t) {
  const k = clamp(fx.t / fx.max, 0, 1);            // 1 -> 0
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (fx.stage === 'pit') {
    // flames burst out of the rack on impact
    ctx.globalCompositeOperation = 'lighter';
    const age = 1 - k;
    for (let i = 0; i < 5; i++) {
      const hx = fx.x - fx.side * (4 + i * 7) + (hash(fx.seed, i) - 0.5) * 18, H = (70 + 60 * hash(fx.seed, i + 3)) * Math.sin(Math.min(1, age * 2.2) * Math.PI * 0.5) * (0.4 + 0.6 * k) , W = 13 - i;
      ctx.globalAlpha = clamp(k * 1.6, 0, 1) * 0.65;
      ctx.fillStyle = i % 2 ? 'rgb(255,190,70)' : 'rgb(255,100,20)';
      const lean = fx.side * -8 + Math.sin(t * 20 + i) * 5;
      ctx.beginPath(); ctx.moveTo(hx - W, fx.y + 14); ctx.quadraticCurveTo(hx - W * 0.8, fx.y - H * 0.4, hx + lean, fx.y - H); ctx.quadraticCurveTo(hx + W * 0.8, fx.y - H * 0.4, hx + W, fx.y + 14); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = k * 0.3; ctx.fillStyle = 'rgb(255,130,30)'; ctx.beginPath(); ctx.arc(fx.x, fx.y, 60, 0, TAU); ctx.fill();
  } else if (fx.stage === 'margins') {
    // eraser rub: a grey smudge on the page and pink crumbs falling out
    const age = 1 - k;
    ctx.globalAlpha = k * 0.5; ctx.strokeStyle = '#6d6a62'; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(fx.x - fx.side * 4, fx.y - 22); ctx.lineTo(fx.x - fx.side * 40, fx.y - 8); ctx.moveTo(fx.x - fx.side * 4, fx.y + 8); ctx.lineTo(fx.x - fx.side * 44, fx.y + 20); ctx.stroke();
    ctx.globalAlpha = k * 0.22; ctx.fillStyle = '#6d6a62'; ctx.beginPath(); ctx.ellipse(fx.x - fx.side * 26, fx.y, 34, 18, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f08aa3'; ctx.strokeStyle = '#1d1b22'; ctx.lineWidth = 1.2;
    for (let i = 0; i < 9; i++) {
      const vx = -fx.side * (30 + 150 * hash(fx.seed, i)), vy = -180 * hash(fx.seed, i + 4) - 40;
      const cx = fx.x + vx * age * 0.9, cy = Math.min(V.ground - 2, fx.y + vy * age + 640 * age * age);
      ctx.globalAlpha = clamp(k * 1.8, 0, 1);
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(age * 9 * (i % 2 ? 1 : -1)); ctx.fillRect(-4, -3, 8, 6); ctx.strokeRect(-4, -3, 8, 6); ctx.restore();
    }
  }
  ctx.restore();
}
