// Pooled particles: no allocation after construction. Updated on the fixed
// step, drawn with interpolation so they stay smooth at any refresh rate.
// Kinds: 'dot' | 'spark' | 'dust' | 'ring' | 'text'
import { rand } from './juice.js';

const FONT = '"Futura Condensed ExtraBold","Impact","Haettenschweiler","Arial Narrow Bold",sans-serif';

export class Particles {
  constructor(max = 800) {
    this.max = max;
    this.list = Array.from({ length: max }, () => ({
      on: false, kind: 'dot', x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0,
      life: 0, max: 1, size: 1, grow: 0, grav: 0, drag: 1, color: '#fff', text: '', alpha: 1,
    }));
    this.cursor = 0;
    this.count = 0;
  }

  spawn(kind, x, y, vx, vy, life, size, color, o) {
    // Round-robin slot: reuses the oldest particle when the pool is full.
    let p = null;
    for (let i = 0; i < this.max; i++) {
      const c = this.list[(this.cursor + i) % this.max];
      if (!c.on) { p = c; this.cursor = (this.cursor + i + 1) % this.max; break; }
    }
    if (!p) { p = this.list[this.cursor]; this.cursor = (this.cursor + 1) % this.max; }
    p.on = true; p.kind = kind; p.x = p.px = x; p.y = p.py = y; p.vx = vx; p.vy = vy;
    p.life = p.max = life; p.size = size; p.color = color;
    p.grow = o?.grow ?? 0; p.grav = o?.grav ?? 0; p.drag = o?.drag ?? 1; p.text = o?.text ?? ''; p.alpha = o?.alpha ?? 1;
    return p;
  }

  // Streaking sparks fanned around `angle` (radians).
  sparks(x, y, angle, spread, count, speed, color = '#fff') {
    for (let i = 0; i < count; i++) {
      const a = angle + rand(-spread, spread);
      const s = speed * rand(0.4, 1);
      this.spawn('spark', x, y, Math.cos(a) * s, Math.sin(a) * s, rand(0.18, 0.4), rand(1.6, 3.2), color, { grav: 500, drag: 0.94 });
    }
  }

  // Soft ground dust that billows out and fades.
  dust(x, y, count, spread = 30, color = '#8a8fa3') {
    for (let i = 0; i < count; i++) {
      const dir = i % 2 ? 1 : -1;
      this.spawn('dust', x + rand(-spread, spread) * 0.4, y, dir * rand(20, spread * 3), rand(-60, -10),
        rand(0.35, 0.7), rand(4, 9), color, { grow: rand(14, 26), drag: 0.9, alpha: 0.5 });
    }
  }

  dots(x, y, count, speed, color) {
    for (let i = 0; i < count; i++) {
      const a = rand(Math.PI * 2);
      const s = rand(0.3, 1) * speed;
      this.spawn('dot', x, y, Math.cos(a) * s, Math.sin(a) * s, rand(0.3, 0.7), rand(1.5, 3.5), color, { grav: 900, drag: 0.97 });
    }
  }

  ring(x, y, size, color = '#fff', life = 0.28) {
    this.spawn('ring', x, y, 0, 0, life, size * 0.2, color, { grow: size * 3.2, alpha: 0.9 });
  }

  text(x, y, str, color = '#fff', size = 22, life = 0.9) {
    this.spawn('text', x + rand(-14, 14), y + rand(-8, 8), 0, -70, life, size, color, { text: str, drag: 0.96 });
  }

  clear() { for (const p of this.list) p.on = false; this.count = 0; }

  update(dt) {
    let n = 0;
    for (const p of this.list) {
      if (!p.on) continue;
      p.life -= dt;
      if (p.life <= 0) { p.on = false; continue; }
      n++;
      p.px = p.x; p.py = p.y;
      p.vy += p.grav * dt;
      p.vx *= p.drag; p.vy *= p.drag;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.size += p.grow * dt;
    }
    this.count = n;
  }

  draw(ctx, alpha) {
    ctx.lineCap = 'round';
    for (const p of this.list) {
      if (!p.on) continue;
      const t = p.life / p.max; // 1 -> 0
      const x = p.px + (p.x - p.px) * alpha;
      const y = p.py + (p.y - p.py) * alpha;
      switch (p.kind) {
        case 'spark': {
          ctx.globalAlpha = Math.min(1, t * 1.6);
          ctx.strokeStyle = p.color; ctx.lineWidth = p.size * (0.4 + t * 0.6);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - p.vx * 0.045, y - p.vy * 0.045); ctx.stroke();
          break;
        }
        case 'dust': {
          ctx.globalAlpha = p.alpha * t * t;
          ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(x, y, p.size, 0, 6.2832); ctx.fill();
          break;
        }
        case 'ring': {
          ctx.globalAlpha = p.alpha * t;
          ctx.strokeStyle = p.color; ctx.lineWidth = 1 + 5 * t;
          ctx.beginPath(); ctx.arc(x, y, p.size, 0, 6.2832); ctx.stroke();
          break;
        }
        case 'text': {
          const k = 1 - t;
          const pop = k < 0.15 ? 0.6 + (k / 0.15) * 0.55 : 1.15 - Math.min(0.15, (k - 0.15) * 0.3);
          ctx.globalAlpha = Math.min(1, t * 2.2);
          ctx.fillStyle = p.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = `${Math.round(p.size * pop)}px ${FONT}`;
          ctx.strokeStyle = 'rgba(9,10,15,.85)'; ctx.lineWidth = 4; ctx.lineJoin = 'round';
          // Keep the whole label on screen: a hit at the arena edge shouldn't print half a word.
          const m = ctx.getTransform(), half = ctx.measureText(p.text).width / 2 + 6;
          const left = -m.e / m.a, right = (ctx.canvas.width - m.e) / m.a;
          const tx = Math.min(Math.max(x, left + half), right - half);
          ctx.strokeText(p.text, tx, y); ctx.fillText(p.text, tx, y);
          break;
        }
        default: {
          ctx.globalAlpha = Math.min(1, t * 2);
          ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(x, y, Math.max(0.3, p.size * t), 0, 6.2832); ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }
}
