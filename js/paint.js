// Static backdrop painting: runs once per resize (and once per location change), never per frame.
// `c` is a 2D context already scaled to CSS pixels. V is the arena layout from game.js.

export const ROPES = [48, 92, 136];   // rope heights above the floor, world units

/* ---------- the owner's art, fitted ---------- */
export function paintImage(c, img, F, view) {
  c.fillStyle = '#090a0f'; c.fillRect(0, 0, view.w, view.h);
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.drawImage(img, F.ox, F.oy, F.iw * F.k, F.ih * F.k);
}

/* ---------- procedural fallbacks (an image that failed or has not loaded yet) ---------- */
export function paintProcedural(c, view, V, accent = '#ff3e3e') {
  const w = view.w, h = view.h, s = V.s, gy = V.ground * s;
  const [r, g, b] = accent === '#ff3e3e' ? [255, 62, 62] : [255, 138, 42];
  c.fillStyle = '#090a0f'; c.fillRect(0, 0, w, h);
  let grd = c.createLinearGradient(0, 0, 0, gy);
  grd.addColorStop(0, '#0b0c13'); grd.addColorStop(1, '#12141d');
  c.fillStyle = grd; c.fillRect(0, 0, w, gy);
  c.strokeStyle = 'rgba(255,255,255,.035)'; c.lineWidth = 1;
  const step = 150 * s;
  for (let x = V.ox % step; x < w; x += step) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, gy); c.stroke(); }
  [0.18, 0.5, 0.82].forEach((k, i) => {
    const cx = V.ox + V.arenaW * s * k, topW = 10 * s, botW = 230 * s;
    const cg = c.createLinearGradient(0, 0, 0, gy);
    cg.addColorStop(0, i === 1 ? `rgba(${r},${g},${b},.16)` : 'rgba(236,238,244,.10)');
    cg.addColorStop(1, 'rgba(236,238,244,0)');
    c.fillStyle = cg;
    c.beginPath(); c.moveTo(cx - topW, 0); c.lineTo(cx + topW, 0); c.lineTo(cx + botW, gy); c.lineTo(cx - botW, gy); c.closePath(); c.fill();
  });
  const bandY = gy - 170 * s;
  const bg2 = c.createLinearGradient(0, bandY - 14, 0, bandY + 14);
  bg2.addColorStop(0, `rgba(${r},${g},${b},0)`); bg2.addColorStop(0.5, `rgba(${r},${g},${b},.20)`); bg2.addColorStop(1, `rgba(${r},${g},${b},0)`);
  c.fillStyle = bg2; c.fillRect(0, bandY - 14, w, 28);
  c.fillStyle = `rgba(${r},${g},${b},.55)`; c.fillRect(0, bandY - 1, w, 2);
  grd = c.createLinearGradient(0, gy, 0, h);
  grd.addColorStop(0, '#171a26'); grd.addColorStop(1, '#090a0f');
  c.fillStyle = grd; c.fillRect(0, gy, w, h - gy);
  c.save();
  c.beginPath(); c.rect(0, gy, w, h - gy); c.clip();
  c.strokeStyle = 'rgba(236,238,244,.06)';
  const vx = w / 2;
  for (let i = -16; i <= 16; i++) { c.beginPath(); c.moveTo(vx + i * 22 * s, gy); c.lineTo(vx + i * 150 * s, h + 20); c.stroke(); }
  for (let k = 1; k < 9; k++) { const y = gy + Math.pow(k / 8, 1.8) * (h - gy); c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); c.stroke(); }
  c.restore();
  const eg = c.createLinearGradient(0, gy - 46, 0, gy);
  eg.addColorStop(0, `rgba(${r},${g},${b},0)`); eg.addColorStop(1, `rgba(${r},${g},${b},.22)`);
  c.fillStyle = eg; c.fillRect(0, gy - 46, w, 46);
  c.fillStyle = accent; c.fillRect(0, gy - 1, w, 2);
  if (V.ox > 2) { c.fillStyle = 'rgba(9,10,15,.62)'; c.fillRect(0, 0, V.ox, h); c.fillRect(w - V.ox, 0, V.ox, h); }
}

// Lined notebook paper, pencil ground line and hatched floor: the margins fallback.
export function paintPaper(c, view, V) {
  const w = view.w, h = view.h, s = V.s, gy = V.ground * s;
  c.fillStyle = '#efe7d3'; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(110,160,200,.42)'; c.lineWidth = 1;
  const step = 26 * s;
  for (let y = step * 0.6; y < h; y += step) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); c.stroke(); }
  c.strokeStyle = 'rgba(210,70,70,.6)'; c.beginPath(); c.moveTo(V.ox + 46 * s, 0); c.lineTo(V.ox + 46 * s, h); c.stroke();
  c.strokeStyle = 'rgba(40,40,48,.35)'; c.lineWidth = Math.max(1, 1.2 * s);
  for (let x = -h; x < w; x += 9 * s) { c.beginPath(); c.moveTo(x, h); c.lineTo(x + (h - gy) * 0.9, gy); c.stroke(); }
  c.fillStyle = '#2b2b33'; c.fillRect(0, gy - 1.4 * s, w, 2.8 * s);
}

export function vignette(c, view, a) {
  if (a <= 0) return;
  const w = view.w, h = view.h;
  const vg = c.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.35, w / 2, h * 0.55, Math.max(w, h) * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${a})`);
  c.fillStyle = vg; c.fillRect(0, 0, w, h);
}

/* ---------- wall hazards (static part; the hit effects are drawn live) ---------- */
export function paintWalls(c, stage, view, V) {
  const s = V.s, gy = V.ground * s, L = V.ox, R = V.ox + V.arenaW * s;
  if (stage === 'ring') {
    c.lineCap = 'round';
    for (const hgt of ROPES) {
      const y = gy - hgt * s;
      c.strokeStyle = 'rgba(0,0,0,.5)'; c.lineWidth = 5 * s; ropePath(c, L, R, y + 2.5 * s, s); c.stroke();
      c.strokeStyle = '#2a2e3e'; c.lineWidth = 3.4 * s; ropePath(c, L, R, y, s); c.stroke();
      c.strokeStyle = 'rgba(255,62,62,.5)'; c.lineWidth = 1.2 * s; ropePath(c, L, R, y, s); c.stroke();
    }
    for (const x of [L, R]) post(c, x, gy, s);
  } else if (stage === 'pit') {
    spikeRack(c, L, gy, s, 1); spikeRack(c, R, gy, s, -1);
  } else if (stage === 'margins') {
    eraser(c, L, gy, s, 1); eraser(c, R, gy, s, -1);
  }
}

function ropePath(c, L, R, y, s) { c.beginPath(); c.moveTo(L, y); c.quadraticCurveTo((L + R) / 2, y + 9 * s, R, y); }

function post(c, x, gy, s) {
  const pw = 13 * s, top = gy - 162 * s;
  c.fillStyle = '#141722'; c.fillRect(x - pw / 2, top, pw, gy - top);
  c.fillStyle = 'rgba(255,255,255,.07)'; c.fillRect(x - pw / 2, top, 2 * s, gy - top);
  c.fillStyle = 'rgba(255,62,62,.8)'; c.fillRect(x - s, top + 8 * s, 2 * s, gy - top - 16 * s);
  c.fillStyle = '#eceef4';
  c.fillRect(x - pw / 2 - 2 * s, top - 5 * s, pw + 4 * s, 6 * s);
  for (const hgt of ROPES) c.fillRect(x - pw / 2 - 1.5 * s, gy - hgt * s - 3 * s, pw + 3 * s, 6 * s);
}

// Iron spike rack: a stout post at the arena edge with rows of spikes pointing into the ring.
function spikeRack(c, x, gy, s, d) {
  const top = gy - 176 * s;
  c.save(); c.lineJoin = 'round';
  // backing plate (mostly off-arena)
  c.fillStyle = '#17110f'; c.fillRect(d > 0 ? x - 46 * s : x, top, 46 * s, gy - top);
  c.fillStyle = 'rgba(0,0,0,.45)'; c.fillRect(d > 0 ? x : x - 14 * s, top, 14 * s, gy - top);   // inner shadow
  // cross bars
  c.fillStyle = '#2a211c';
  for (const hh of [10, 70, 130, 172]) c.fillRect(d > 0 ? x - 46 * s : x, gy - hh * s - 3 * s, 46 * s, 6 * s);
  // spikes
  for (let i = 0; i < 8; i++) {
    const y = gy - (14 + i * 22) * s, len = (i % 2 ? 30 : 38) * s, hw = 5.4 * s, bx = x + d * 4 * s;
    c.fillStyle = '#524a43'; c.strokeStyle = '#0b0706'; c.lineWidth = 1.6 * s;
    c.beginPath(); c.moveTo(bx, y - hw); c.lineTo(bx + d * len, y); c.lineTo(bx, y + hw); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = 'rgba(255,214,170,.55)';
    c.beginPath(); c.moveTo(bx, y - hw); c.lineTo(bx + d * len, y); c.lineTo(bx + d * len * 0.35, y - hw * 0.25); c.closePath(); c.fill();
    c.fillStyle = 'rgba(140,60,30,.7)'; c.fillRect(d > 0 ? bx : bx - 7 * s, y - hw, 7 * s, hw * 2);
  }
  // hot glow at the base so the rack reads against the dark pit
  const gg = c.createLinearGradient(0, gy - 30 * s, 0, gy);
  gg.addColorStop(0, 'rgba(255,120,40,0)'); gg.addColorStop(1, 'rgba(255,120,40,.22)');
  c.fillStyle = gg; c.fillRect(d > 0 ? x - 46 * s : x, gy - 30 * s, 46 * s, 30 * s);
  c.restore();
}

// Giant pink eraser block at each edge: hand-inked outline, worn rounded end, paper sleeve.
function eraser(c, x, gy, s, d) {
  const w = 96 * s, h = 112 * s, tip = 22 * s;     // tip: how far it pokes into the arena
  const x0 = d > 0 ? x - w + tip : x - tip;
  c.save(); c.lineJoin = 'round'; c.lineCap = 'round';
  c.translate(x0 + w / 2, gy); c.rotate(d * -0.045); c.translate(-(x0 + w / 2), -gy);
  // smudge on the paper under it
  c.fillStyle = 'rgba(60,55,60,.18)'; c.beginPath(); c.ellipse(x0 + w / 2, gy + 3 * s, w * 0.6, 7 * s, 0, 0, 6.3); c.fill();
  // body
  const g = c.createLinearGradient(0, gy - h, 0, gy);
  g.addColorStop(0, '#f6b3c4'); g.addColorStop(1, '#e8869f');
  c.fillStyle = g;
  c.beginPath(); c.roundRect(x0, gy - h, w, h, [8 * s, 8 * s, 2 * s, 2 * s]); c.fill();
  // paper sleeve on the outer half
  const sx = d > 0 ? x0 : x0 + w * 0.45, sw = w * 0.55;
  c.fillStyle = '#2b4aa8'; c.fillRect(sx, gy - h, sw, h);
  c.fillStyle = '#f4efe3'; c.fillRect(sx, gy - h * 0.7, sw, h * 0.3);
  c.fillStyle = '#2b4aa8';
  for (let i = 0; i < 3; i++) c.fillRect(sx + sw * 0.12, gy - h * 0.64 + i * 7 * s, sw * (0.76 - i * 0.2), 2.4 * s);
  // worn end, dark crumbs of graphite
  c.fillStyle = 'rgba(70,60,70,.35)';
  const ex = d > 0 ? x0 + w - 18 * s : x0;
  c.beginPath(); c.roundRect(ex, gy - h, 18 * s, h, 6 * s); c.fill();
  c.strokeStyle = 'rgba(60,50,60,.5)'; c.lineWidth = 1.4 * s;
  for (let i = 0; i < 5; i++) { const yy = gy - h * (0.15 + i * 0.17); c.beginPath(); c.moveTo(ex + 2 * s, yy); c.lineTo(ex + 14 * s, yy + 3 * s); c.stroke(); }
  // ink outline, drawn twice with a wobble for the hand-drawn look
  c.strokeStyle = '#1d1b22';
  for (let k = 0; k < 2; k++) {
    c.lineWidth = (k ? 1.4 : 2.6) * s;
    c.beginPath(); c.roundRect(x0 + k * 1.2 * s, gy - h + k * 1.2 * s, w, h, [8 * s, 8 * s, 2 * s, 2 * s]); c.stroke();
  }
  c.restore();
}
