// Builds the shipped art from the owner's 2752x1536 sources.
//
//   node scripts/build-art.mjs
//
// art-src/<id>.jpg  ->  art/<id>.webp   (1920 wide, tuned under ~430 KB)
//                       art/<id>-t.webp (256 wide picker thumb)
//                       art/infinite-t.webp (picker thumb for THE RIOT SPREADS: three locations in diagonal slices)
// Per-variant crop and floor line come from js/stages.js. Two jobs beyond a resize:
//   crop     the pit art has a black band along its bottom edge; it is cut off so no viewport can ever show it
//   flatten  the margins art has a hand-drawn pencil ground line that wobbles about 1.5% of the height;
//            the line is detected per column and the page is warped so it is dead straight on the floor line,
//            which is what lets the fighters' feet sit exactly on it.
// Uses a Playwright canvas for resizing and WebP encoding (no new runtime deps; Playwright is a dev dependency).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'module';
import { VARIANTS } from '../js/stages.js';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.HOME + '/.claude/scripts/node_modules/playwright')); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'art-src'), OUT = path.join(ROOT, 'art');
fs.mkdirSync(OUT, { recursive: true });
const MAX_BYTES = 430 * 1024;

const server = http.createServer((q, r) => {
  if (q.url === '/') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><html></html>'); }
  const f = path.join(SRC, decodeURIComponent(q.url.slice(1)));
  if (!f.startsWith(SRC) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': 'image/jpeg' }); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);

await page.evaluate(() => {
  // Darkest row per column strip inside a band around the floor line (the pencil line), median-filtered.
  window.lineProfile = (cv, f, strip) => {
    const w = cv.width, h = cv.height, x = cv.getContext('2d', { willReadFrequently: true });
    const d = x.getImageData(0, 0, w, h).data;
    const lum = (px, py) => { const i = (py * w + px) * 4; return d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; };
    const y0 = Math.floor(h * (f - 0.045)), y1 = Math.ceil(h * (f + 0.045)), n = Math.floor(w / strip);
    const raw = [];
    for (let s = 0; s < n; s++) {
      const cx = Math.floor((s + 0.5) * strip);
      let best = 1e9, by = y0;
      for (let y = y0; y < y1; y++) {
        let sum = 0; for (let k = -6; k <= 6; k++) for (let j = -1; j <= 1; j++) sum += lum(Math.min(w - 1, Math.max(0, cx + k)), y + j);
        if (sum < best) { best = sum; by = y; }
      }
      raw.push(by);
    }
    const med = raw.map((_, i) => { const a = raw.slice(Math.max(0, i - 6), i + 7).sort((p, q) => p - q); return a[a.length >> 1]; });
    return med.map((_, i) => { const a = med.slice(Math.max(0, i - 3), i + 4); return a.reduce((p, q) => p + q, 0) / a.length; });
  };
});

const results = [];
async function encode(dataFn, W, H, q) { return page.evaluate(dataFn, { W, H, q }); }

for (const [id, v] of Object.entries(VARIANTS)) {
  const out = await page.evaluate(async ({ id, v, MAX }) => {
    const img = new Image(); img.src = `/${id}.jpg`; await img.decode();
    const W = 1920, srcH = img.naturalHeight * v.crop, H = Math.round(srcH * W / img.naturalWidth);
    let cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    let c = cv.getContext('2d'); c.imageSmoothingQuality = 'high';
    c.drawImage(img, 0, 0, img.naturalWidth, srcH, 0, 0, W, H);
    let before = null, after = null;
    if (v.flatten) {
      const strip = 4, prof = window.lineProfile(cv, v.floorOut, strip), target = v.floorOut * H;
      const mean = prof.reduce((a, b) => a + b, 0) / prof.length;
      before = Math.sqrt(prof.reduce((a, b) => a + (b - mean) ** 2, 0) / prof.length);
      const src = document.createElement('canvas'); src.width = W; src.height = H; src.getContext('2d').drawImage(cv, 0, 0);
      for (let s = 0; s < prof.length; s++) {
        const dy = target - prof[s];
        c.drawImage(src, s * strip, 0, strip, H, s * strip, dy, strip, H);
      }
      const p2 = window.lineProfile(cv, v.floorOut, strip);
      const m2 = p2.reduce((a, b) => a + b, 0) / p2.length;
      after = { std: Math.sqrt(p2.reduce((a, b) => a + (b - m2) ** 2, 0) / p2.length), mean: m2 / H };
    }
    let q = 0.86, blob;
    for (; q > 0.4; q -= 0.04) { blob = await new Promise((r) => cv.toBlob(r, 'image/webp', q)); if (blob.size <= MAX) break; }
    const b64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
    // thumb
    const tw = 256, th = Math.round(H * tw / W), t = document.createElement('canvas'); t.width = tw; t.height = th;
    const tc = t.getContext('2d'); tc.imageSmoothingQuality = 'high'; tc.drawImage(cv, 0, 0, tw, th);
    const tb = await new Promise((r) => t.toBlob(r, 'image/webp', 0.78));
    const tb64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(tb); });
    return { b64, tb64, W, H, size: blob.size, tsize: tb.size, q, before, after };
  }, { id, v: { crop: v.crop, flatten: !!v.flatten, floorOut: v.floorOut }, MAX: MAX_BYTES });
  fs.writeFileSync(path.join(OUT, `${id}.webp`), Buffer.from(out.b64, 'base64'));
  fs.writeFileSync(path.join(OUT, `${id}-t.webp`), Buffer.from(out.tb64, 'base64'));
  results.push({ id, W: out.W, H: out.H, kb: Math.round(out.size / 1024), thumbKb: +(out.tsize / 1024).toFixed(1), q: +out.q.toFixed(2), flatten: out.after && `line wobble ${out.before.toFixed(1)}px -> ${out.after.std.toFixed(2)}px, now at ${(out.after.mean).toFixed(4)} of height` });
}

// the infinite thumb: ring / pit / margins in three diagonal slices
const inf = await page.evaluate(async () => {
  const ids = ['ring-a', 'pit-a', 'margins-a'], W = 256, H = 144;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const c = cv.getContext('2d'); c.imageSmoothingQuality = 'high';
  const imgs = await Promise.all(ids.map(async (id) => { const i = new Image(); i.src = `/${id}.jpg`; await i.decode(); return i; }));
  const sk = 24;
  imgs.forEach((im, i) => {
    const xa = (W / 3) * i, xb = (W / 3) * (i + 1);
    c.save(); c.beginPath(); c.moveTo(xa + sk, 0); c.lineTo(xb + sk, 0); c.lineTo(xb - sk, H); c.lineTo(xa - sk, H); c.closePath(); c.clip();
    const sc = Math.max(W / im.naturalWidth, H / im.naturalHeight);
    c.drawImage(im, (W - im.naturalWidth * sc) / 2, (H - im.naturalHeight * sc) / 2, im.naturalWidth * sc, im.naturalHeight * sc);
    c.restore();
  });
  // slice seams
  c.strokeStyle = '#090a0f'; c.lineWidth = 3;
  for (let i = 1; i < 3; i++) { const x = (W / 3) * i; c.beginPath(); c.moveTo(x + sk, 0); c.lineTo(x - sk, H); c.stroke(); }
  const b = await new Promise((r) => cv.toBlob(r, 'image/webp', 0.8));
  return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r({ b64: fr.result.split(',')[1], size: b.size }); fr.readAsDataURL(b); });
});
fs.writeFileSync(path.join(OUT, 'infinite-t.webp'), Buffer.from(inf.b64, 'base64'));

await browser.close(); server.close();
console.table(results);
const over = results.filter((r) => r.kb * 1024 > MAX_BYTES + 1);
if (over.length) { console.error('over budget:', over.map((r) => r.id).join(', ')); process.exit(1); }
console.log(`infinite-t.webp ${(inf.size / 1024).toFixed(1)} KB. Wrote ${results.length} images + thumbs to art/`);
