// Locations + THE RIOT SPREADS checks, in a real browser (same harness style as features.mjs).
//   node scripts/stages.mjs [--out .shots]
// Covers: every stage + variant fits at desktop/ultrawide/phone/tablet viewports, the picker (keyboard, touch, persistence,
// deep link, bad stored value, no-scroll fit), each wall hazard word, the timed hazards (telegraph + hit), the finisher, the
// infinite transition across all seven locations (HP/score persist, enemies valid), every mid-transition edge case,
// the failed-image fallback, frame budget under stress in each stage (plus a CPU/4 phone measurement), a 66-wave forced soak,
// and a soak that clears waves through the real director with key events through the real Input listeners.
// Runs start with a real key or tap; scripts/real-play.mjs covers the remaining intended behaviour.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.HOME + '/.claude/scripts/node_modules/playwright')); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const oi = process.argv.indexOf('--out'), OUT = path.resolve(ROOT, oi > 0 ? process.argv[oi + 1] : '.shots');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
const server = http.createServer((q, r) => { let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const VARIANTS = ['ring-a', 'ring-b', 'ring-c', 'pit-a', 'pit-b', 'margins-a', 'margins-b'];
const STAGES = ['ring', 'pit', 'margins'];
const stageOf = (v) => v.split('-')[0];
const noise = (e) => /Failed to load resource|ERR_FAILED|net::/.test(e);   // aborted image requests are expected in the fallback tests

const TOUCH = new WeakMap();
async function boot(w, h, { touch = false, dpr, query = '', init, route, filterNet = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr ?? (touch ? 2 : 1), hasTouch: touch, isMobile: touch });
  if (init) await ctx.addInitScript(init);
  if (route) await route(ctx);
  ctx.setDefaultTimeout(10000);
  const page = await ctx.newPage(); const errors = []; TOUCH.set(page, touch);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !(filterNet && noise(m.text())) && errors.push(m.text()));
  await page.goto(`${BASE}/?debug${query}`); await page.waitForFunction(() => window.__dare?.shell); await page.waitForTimeout(900);
  return { ctx, page, errors };
}
// dbg: call a ?debug-only hook; the strings are fixed literals written in this file, never external input
const dbg = (page, call) => page.evaluate(`window.__dare.game.debug.${call}`);
const snap = (page) => dbg(page, 'snapshot()');
const loc = (page) => dbg(page, 'loc()');
// A run starts the way a player starts it: a real tap on PLAY on touch, a real key on the title, R anywhere else.
const startRun = async (page) => {
  const st = await page.evaluate(() => window.__dare.shell.state);
  if (st !== 'title') await page.keyboard.press('KeyR');
  else if (TOUCH.get(page)) await page.tap('#play');
  else await page.keyboard.press('KeyX');
  await page.waitForTimeout(300);
};
// Sections that only read layout and pixels run a few pages at a time, to keep the whole suite near 8 minutes.
const pool = async (items, n, fn) => { const q = items.slice(); await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); };
const rectOf = async (page, sel) => { const r = await page.locator(sel).first().boundingBox(); return [r.x + r.width / 2, r.y + r.height / 2]; };
const waitFor = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout, polling: 50 }).then(() => true, () => false);
const finite = (o) => Object.values(o).every((v) => typeof v !== 'number' || Number.isFinite(v));
const vis = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const cs = getComputedStyle(e); return !e.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; }, sel);

// Budgets for the CPU/4 measurement: the values measured on this machine plus a margin (see section 7b).
// Measured 2026-11-06 (M3, 4 runs): avg 8.5-21.6ms, p95 10-43ms, work 0.5-1.4ms, first frame of a break 8-10ms, worst frame in a wipe 17-24ms with one 135ms hitch.
// The first-frame limit fails the old unprepared break, which cost 82-99ms here.
const THROTTLE_LIMITS = { avg: 30, p95: 60, work: 3, breakFirst: 40, breakWorst: 60, breakHitch: 220 };
const SOAK_TO_WAVE = 25, SOAK_STUCK_S = 150;
// The real-director soak, run inside the page: the same stepping as engine._tick (faster than real time, except during a wipe), plus a bot that only sends key events.
const REAL_SOAK = `
window.__soak = (opts) => import('/js/stages.js').then(({ STAGES }) => {
  const { shell: sh, game: g } = window.__dare, d = g.debug, STEP = 1 / 60, tipEl = document.getElementById('tip');
  const send = (code, on) => window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, bubbles: true }));
  const down = new Set(), K = (code, on) => { if (on === down.has(code)) return; on ? down.add(code) : down.delete(code); send(code, on); };
  const tap = (code) => { send(code, true); send(code, false); };
  const foreign = {}; for (const st of Object.values(STAGES)) foreign[st.id] = Object.values(STAGES).filter((o) => o !== st).flatMap((o) => [o.wallTip, o.hazardTip, o.boss]);
  let n = 0, acc = 0, tSim = 0, waveAt = 0, last = d.snapshot(), sawClear = false, clearMult = null, cur = null;
  const R = { waves: [], breaks: [], stale: {}, peak: { enemies: 0, particles: 0, waves: 0, ropeFx: 0, wallFx: 0, tipQ: 0, locQueue: 0, cache: 0, ok: 0 }, nan: 0, scoreDrops: 0, badAdvance: 0, crossSteps: 0, stuck: null, tSim: 0, realMs: 0, end: null };
  const newWave = (w) => ({ wave: w, sec: 0, startEnemies: d.sizes().enemies, peak: { waves: 0, ropeFx: 0, wallFx: 0, tipQ: 0, locQueue: 0, cache: 0 } });
  cur = newWave(last.wave);
  function bot(s) {
    n++; const p = s.player; let best = null, bd = 1e9;
    for (const e of s.enemies) { if (e.hp <= 0 || e.dead || e.entering) continue; const dd = Math.abs(e.x - p.x); if (dd < bd) { bd = dd; best = e; } }
    if (s.riot >= 100) tap('KeyL');
    if (!best) { K('KeyA', false); K('KeyD', false); return; }
    const dx = best.x - p.x;
    K('KeyD', bd > 60 && dx > 0); K('KeyA', bd > 60 && dx < 0);
    if (bd < 95 && n % 9 === 0) tap(n % 36 === 0 || best.guard ? 'KeyK' : 'KeyJ');
    if (s.shockwaves && n % 20 === 0) tap('KeyW');
  }
  function observe() {
    const s = d.snapshot(), z = d.sizes(), L = d.loc();
    tSim += STEP;
    if (s.score < last.score) R.scoreDrops++;
    if (![s.score, s.player.x, s.player.hp, s.riot, s.mult, ...s.enemies.flatMap((e) => [e.x, e.y, e.hp])].every(Number.isFinite)) R.nan++;
    for (const k of Object.keys(R.peak)) if (k in z) R.peak[k] = Math.max(R.peak[k], z[k]);
    R.peak.ok = Math.max(R.peak.ok, L.cache.length);
    for (const k of Object.keys(cur.peak)) cur.peak[k] = Math.max(cur.peak[k], z[k]);
    if (s.crossed - last.crossed > 1 || s.crossed < last.crossed) R.crossSteps++;
    if (s.phase === 'clear' && last.phase !== 'clear') { sawClear = true; clearMult = s.mult; if (s.breakDue) R.breaks.push({ wave: s.wave, clear: s.mult, next: null, hit: false }); }
    { const b = R.breaks[R.breaks.length - 1]; if (b && b.next === null && (s.hazard || s.shockwaves || !['idle', 'atk'].includes(s.player.state))) b.hit = true; }   // a hit resets the multiplier by design
    if (s.wave !== last.wave) {
      if (s.wave !== last.wave + 1 || !sawClear) R.badAdvance++;
      cur.sec = tSim - waveAt; R.waves.push(cur); waveAt = tSim; sawClear = false; cur = newWave(s.wave);
      const b = R.breaks[R.breaks.length - 1]; if (b && b.wave === last.wave && b.next === null) b.next = s.mult;
    }
    if (tipEl.classList.contains('show') && s.state === 'play') for (const w of foreign[s.stage]) if (tipEl.textContent.includes(w)) { const k = s.stage + ': ' + tipEl.textContent.slice(0, 40); R.stale[k] = (R.stale[k] || 0) + 1; }
    if (tSim - waveAt > opts.stuckS) R.stuck = { wave: s.wave, phase: s.phase, queue: s.queue, alive: s.enemies.filter((e) => e.hp > 0).map((e) => [e.kind, Math.round(e.x), +e.hp.toFixed(1), e.state, e.entering]).slice(0, 8) };
    last = s;
  }
  const T0 = performance.now();
  return new Promise((res) => {
    (function tick() {
      const t0 = performance.now();
      while (performance.now() - t0 < 12) {
        if (last.state !== 'play' || last.wave >= opts.toWave || R.stuck) {
          for (const c of [...down]) K(c, false);
          const f = d.snapshot(); R.tSim = tSim; R.realMs = performance.now() - T0;
          R.end = { state: f.state, wave: f.wave, crossed: f.crossed, kills: f.kills, bosses: f.bosses, score: f.score };
          return res(R);
        }
        // a wipe runs on real frames, so while one is up the engine drives the sim and the bot plays at normal speed
        if (last.transition) { bot(last); observe(); requestAnimationFrame(tick); return; }
        acc += STEP * sh.juice.update(STEP);
        let k = 0;
        while (acc >= STEP && k < 5) { bot(last); g.update(STEP, sh); sh.particles.update(STEP); sh.input.endStep(); observe(); acc -= STEP; k++; }
      }
      requestAnimationFrame(tick);
    })();
  });
});
`;

// wait until a variant is decoded, then (re)paint it
async function show(page, vid) {
  await dbg(page, `setVariant('${vid}')`);
  const ok = await waitFor(page, (v) => window.__dare.game.debug.loc().cache.includes(v), vid, 6000);
  await dbg(page, `setVariant('${vid}')`); await page.waitForTimeout(60);
  return ok;
}
// luminance profile of the painted background around the ground line (column-averaged), for the pencil line
const floorLine = (page) => page.evaluate(() => {
  const bg = document.getElementById('bg'), c = bg.getContext('2d', { willReadFrequently: true }), dpr = bg.width / innerWidth;
  const f = window.__dare.game.debug.fit(), gy = f.gy;
  const y0 = Math.max(0, Math.floor((gy - 40) * dpr)), y1 = Math.min(bg.height - 1, Math.ceil((gy + 40) * dpr)), x0 = Math.floor(bg.width * 0.3), x1 = Math.floor(bg.width * 0.7);
  const d = c.getImageData(x0, y0, x1 - x0, y1 - y0 + 1).data, w = x1 - x0;
  let best = 1e9, by = y0;
  for (let y = 0; y <= y1 - y0; y++) { let s = 0; for (let x = 0; x < w; x += 3) { const i = (y * w + x) * 4; s += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; } s /= Math.ceil(w / 3); if (s < best) { best = s; by = y + y0; } }
  return { line: by / dpr, gy };
});
const bottomLum = (page) => page.evaluate(() => {
  const bg = document.getElementById('bg'), c = bg.getContext('2d', { willReadFrequently: true });
  const d = c.getImageData(0, bg.height - 2, bg.width, 1).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
  return s / (d.length / 4);
});

try {
  // ================= 1. every stage + variant loads and fits, at every viewport =================
  const VIEWPORTS = [[1440, 900, false, 'desktop 1440x900'], [2560, 1080, false, 'ultrawide 2560x1080'], [390, 844, true, 'phone portrait 390x844'],
    [844, 390, true, 'phone landscape 844x390'], [360, 640, true, 'small phone 360x640'], [820, 1180, true, 'tablet 820x1180']];
  await pool(VIEWPORTS, 3, async ([w, h, touch, label]) => {
    const { ctx, page, errors } = await boot(w, h, { touch, query: '&stage=infinite' });
    let bad = [], gaps = [], pix = [];
    for (const vid of VARIANTS) {
      const loaded = await show(page, vid);
      const f = await dbg(page, 'fit()');
      if (!loaded || !f.shown || f.cur !== vid) { bad.push(`${vid}: not shown`); continue; }
      const floorErr = Math.abs(f.oy + f.floor * f.ih * f.k - f.gy);
      if (floorErr > 0.5) bad.push(`${vid}: floor off by ${floorErr.toFixed(2)}px`);
      if (f.ox > 0.5 || f.oy > 0.5 || f.ox + f.iw * f.k < w - 0.5 || f.oy + f.ih * f.k < h - 0.5) gaps.push(`${vid}: ox=${f.ox.toFixed(1)} oy=${f.oy.toFixed(1)} right=${(f.ox + f.iw * f.k - w).toFixed(1)} bottom=${(f.oy + f.ih * f.k - h).toFixed(1)}`);
      if (vid.startsWith('margins')) {   // real pixels: the painted pencil line is where the fighters' feet are
        const fl = await floorLine(page);
        if (Math.abs(fl.line - fl.gy) > 3) pix.push(`${vid}: pencil line at ${fl.line.toFixed(1)} vs feet ${fl.gy.toFixed(1)}`);
      }
      if (vid.startsWith('pit') || vid.startsWith('margins')) { const bl = await bottomLum(page); if (bl < 6) pix.push(`${vid}: dark band at the bottom edge (lum ${bl.toFixed(1)})`); }
    }
    check(`${label}: all 7 variants load, and the floor line lands on the feet line`, bad.length === 0, bad.join(' | '));
    check(`${label}: no gaps at any edge (image covers the viewport)`, gaps.length === 0, gaps.join(' | '));
    check(`${label}: pencil line sits on the feet line (pixel sample) and no black band at the bottom`, pix.length === 0, pix.join(' | '));
    check(`${label}: zero console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  });

  // ================= 2. the picker =================
  { const { ctx, page, errors } = await boot(1440, 900, {});
    const cards = await page.$$eval('#cards .card', (els) => els.map((e) => ({ tag: e.tagName, type: e.type, mode: e.dataset.mode, pressed: e.getAttribute('aria-pressed'), name: e.querySelector('b').textContent, img: !!e.querySelector('img') })));
    check('picker: 4 real buttons with thumbs, THE RIOT SPREADS pressed by default', cards.length === 4 && cards.every((c) => c.tag === 'BUTTON' && c.type === 'button' && c.img)
      && cards.map((c) => c.mode).join() === 'infinite,ring,pit,margins' && cards[0].pressed === 'true' && cards.slice(1).every((c) => c.pressed === 'false'), JSON.stringify(cards.map((c) => c.name)));
    check('picker: thumbs actually decode', await page.$$eval('#cards img', (is) => is.every((i) => i.complete && i.naturalWidth > 0)));
    await page.click('.card[data-mode="margins"]'); await page.waitForTimeout(900);
    let l = await loc(page);
    check('picker: clicking a card selects it and does NOT start a run', (await snap(page)).state === 'title' && await page.getAttribute('.card[data-mode="margins"]', 'aria-pressed') === 'true' && l.mode === 'margins');
    check('picker: live preview crossfades to the chosen location (paper palette, margins art)', l.stage === 'margins' && l.pal === 'paper' && l.shown && l.body.paper === '1', JSON.stringify({ cur: l.cur, pal: l.pal }));
    await page.screenshot({ path: `${OUT}/picker-margins-1440.png` });
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(150);
    check('picker: ArrowRight wraps to the first card and does not start a run', (await loc(page)).mode === 'infinite' && (await snap(page)).state === 'title');
    await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(150);
    check('picker: ArrowLeft goes back', (await loc(page)).mode === 'margins');
    check('picker: selection persists in storage', await page.evaluate(() => localStorage.getItem('dare-arcade:ragdoll-riot:mode')) === '"margins"');
    await page.reload(); await page.waitForFunction(() => window.__dare?.shell); await page.waitForTimeout(700);
    check('picker: the choice survives a reload (and previews immediately)', (await loc(page)).mode === 'margins' && await page.getAttribute('.card[data-mode="margins"]', 'aria-pressed') === 'true' && (await loc(page)).stage === 'margins');
    await page.focus('.card[data-mode="pit"]'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    check('picker: a focused card is selected by Enter (keyboard), run not started', (await loc(page)).mode === 'pit' && (await snap(page)).state === 'title');
    const fr = await page.evaluate(() => { const e = document.querySelector('.card[data-mode="pit"]'); e.focus(); return { fv: e.matches(':focus-visible'), os: getComputedStyle(e).outlineStyle, w: parseFloat(getComputedStyle(e).outlineWidth) }; });
    check('picker: cards show a visible focus outline', fr.fv && fr.os === 'solid' && fr.w >= 2, JSON.stringify(fr));
    // COPY LINK shares the chosen location
    await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } }, configurable: true }); });
    await page.click('#title [data-share]'); await page.waitForTimeout(200);
    const copied = await page.evaluate(() => window.__copied);
    check('picker: COPY LINK carries the chosen location', /\?stage=pit$/.test(copied || ''), String(copied));
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('Enter'); await page.waitForTimeout(500);
    check('picker: any key still starts a run (and it is the chosen location)', (await snap(page)).state === 'play' && (await snap(page)).mode === 'pit');
    check('picker: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close(); }
  { // focused buttons on the title do their own job: Enter and Space never start a run instead
    const { ctx, page, errors } = await boot(1440, 900, {});
    const STUB = () => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } }, configurable: true }); };
    const TARGETS = [
      ['COPY LINK', '#title [data-share]', async () => /\?stage=/.test(await page.evaluate(() => window.__copied) || '') && /COPIED/.test(await page.textContent('#toast'))],
      ['HOW TO PLAY', '#howbtn', () => page.evaluate(() => !document.getElementById('howto').hidden)],
      ['mute', '#mute', null],
    ];
    for (const [name, sel, did] of TARGETS) for (const key of ['Enter', 'Space']) {
      await page.reload(); await page.waitForFunction(() => window.__dare?.shell); await page.waitForTimeout(400);
      await page.evaluate(STUB);
      const muted0 = await page.getAttribute('#mute', 'aria-pressed');
      let found = false; for (let i = 0; i < 24 && !found; i++) { await page.keyboard.press('Tab'); found = await page.evaluate((s) => document.activeElement === document.querySelector(s), sel); }
      await page.keyboard.press(key); await page.waitForTimeout(250);
      const st = (await snap(page)).state, acted = did ? await did() : (await page.getAttribute('#mute', 'aria-pressed')) !== muted0;
      check(`title keyboard: Tab to ${name}, ${key}: no run starts and the action happens`, found && st === 'title' && acted, `reached=${found} state=${st} acted=${acted}`);
    }
    await page.reload(); await page.waitForFunction(() => window.__dare?.shell); await page.waitForTimeout(400);
    let onPlay = false; for (let i = 0; i < 24 && !onPlay; i++) { await page.keyboard.press('Tab'); onPlay = await page.evaluate(() => document.activeElement?.id === 'play'); }
    await page.keyboard.press('Enter'); await page.waitForTimeout(300);
    check('title keyboard: Tab to PLAY, Enter starts the run', onPlay && (await snap(page)).state === 'play');
    check('title keyboard: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close(); }
  { // the first run of a session starts from real input, nothing else
    for (const key of ['KeyX', 'Enter', 'Space']) {
      const { ctx, page, errors } = await boot(1440, 900, {});
      await page.keyboard.press(key); await page.waitForTimeout(300);
      const s = await snap(page);
      await page.keyboard.down('KeyD'); await page.waitForTimeout(250); const x1 = (await snap(page)).player.x; await page.keyboard.up('KeyD');
      check(`real start: ${key} on the title starts a run and the player responds`, s.state === 'play' && s.wave === 1 && x1 !== s.player.x && errors.length === 0, `state=${s.state} x ${s.player.x} -> ${x1}`);
      await ctx.close();
    }
    const { ctx, page, errors } = await boot(390, 844, { touch: true });
    await page.tap('#play'); await page.waitForTimeout(300);
    const s = await snap(page);
    const sx = await page.locator('.stick-zone').boundingBox(), cdp = await ctx.newCDPSession(page);
    const a = sx.x + 70, b = sx.y + sx.height - 90;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a, y: b, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a + 54, y: b, id: 1 }] });
    await page.waitForTimeout(350); const x1 = (await snap(page)).player.x;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check('real start: a tap on PLAY starts a run and the stick moves the player', s.state === 'play' && s.wave === 1 && x1 > s.player.x + 5 && errors.length === 0, `state=${s.state} x ${s.player.x} -> ${x1}`);
    await ctx.close(); }
  { // deep link, bad stored value, per-mode best + migration
    const a = await boot(1440, 900, { query: '&stage=ring' });
    check('deep link ?stage=ring selects THE LIVE RING', (await loc(a.page)).mode === 'ring' && await a.page.getAttribute('.card[data-mode="ring"]', 'aria-pressed') === 'true');
    await a.ctx.close();
    for (const s of ['pit', 'margins', 'infinite']) { const c = await boot(800, 600, { query: `&stage=${s}` }); check(`deep link ?stage=${s}`, (await loc(c.page)).mode === s); await c.ctx.close(); }
    const bogus = await boot(1440, 900, { query: '&stage=bogus', init: () => { if (!localStorage.getItem('__seeded')) { localStorage.setItem('__seeded', '1'); localStorage.setItem('dare-arcade:ragdoll-riot:mode', '"pit"'); } } });
    check('deep link with a bad value falls back to the stored choice', (await loc(bogus.page)).mode === 'pit');
    await bogus.ctx.close();
    const bad = await boot(1440, 900, { init: () => localStorage.setItem('dare-arcade:ragdoll-riot:mode', '"nonsense"') });
    check('bad stored value falls back to THE RIOT SPREADS', (await loc(bad.page)).mode === 'infinite' && await bad.page.getAttribute('.card[data-mode="infinite"]', 'aria-pressed') === 'true' && bad.errors.length === 0, bad.errors.join('|'));
    await bad.ctx.close();
    const mig = await boot(1440, 900, { init: () => { if (!localStorage.getItem('__seeded')) { localStorage.setItem('__seeded', '1'); localStorage.setItem('dare-arcade:ragdoll-riot:best', '777'); } } });
    const bestOf = (p) => p.textContent('#best-title');
    check('best score: the old single best migrates to THE LIVE RING only', await bestOf(mig.page) === '0'
      && (await (async () => { await mig.page.click('.card[data-mode="ring"]'); return bestOf(mig.page); })()) === '777'
      && (await (async () => { await mig.page.click('.card[data-mode="pit"]'); return bestOf(mig.page); })()) === '0');
    await mig.ctx.close(); }
  // fits without scrolling problems
  for (const [w, h, touch, label] of [[390, 844, true, 'phone 390x844'], [360, 640, true, 'phone 360x640'], [844, 390, true, 'landscape 844x390'], [1440, 900, false, 'desktop 1440x900']]) {
    const { ctx, page, errors } = await boot(w, h, { touch });
    const m = await page.evaluate(() => {
      const t = document.getElementById('title'), r = (s) => document.querySelector(s).getBoundingClientRect(), play = r('#play'), cards = [...document.querySelectorAll('#cards .card')].map((c) => c.getBoundingClientRect());
      return { sh: t.scrollHeight, ch: t.clientHeight, playBottom: play.bottom, playTop: play.top, vh: innerHeight, vw: innerWidth,
        cardsIn: cards.every((c) => c.left >= -0.5 && c.right <= innerWidth + 0.5 && c.top >= 0 && c.bottom <= innerHeight + 0.5), minH: Math.min(...cards.map((c) => c.height)), minW: Math.min(...cards.map((c) => c.width)),
        overlap: cards.some((a, i) => cards.some((b, j) => i < j && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)) };
    });
    check(`picker fits on ${label}: PLAY and all cards in view, no scroll needed, no overlaps`, m.sh <= m.ch + 1 && m.playBottom <= m.vh && m.cardsIn && !m.overlap, JSON.stringify(m));
    if (touch) check(`picker on ${label}: card tap targets at least 44px`, m.minH >= 44 && m.minW >= 44, `min ${m.minW.toFixed(0)}x${m.minH.toFixed(0)}`);
    await page.screenshot({ path: `${OUT}/title-picker-${w}x${h}.png` });
    if (touch) {
      await page.tap('.card[data-mode="pit"]'); await page.waitForTimeout(500);
      check(`phone ${label}: tapping a card selects it and does not start a run`, (await snap(page)).state === 'title' && (await loc(page)).mode === 'pit');
      await page.tap('#play'); await page.waitForTimeout(400);
      check(`phone ${label}: tapping PLAY starts that location`, (await snap(page)).state === 'play' && (await snap(page)).mode === 'pit');
    }
    check(`picker ${label}: zero console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ================= 3. wall hazards, the timed hazards, the finisher, tips, bosses =================
  const WALL = { ring: 'ZAP', pit: 'SPIKED', margins: 'ERASED' };
  const FIN = { ring: 'LIGHTS OUT', pit: 'SENTENCED', margins: 'SCRATCHED OUT' };
  const BOSS = { ring: 'THE BOUNCER', pit: 'THE WARDEN', margins: 'THE SCRIBBLE' };
  const texts = (page, ms) => page.evaluate((ms) => new Promise((res) => { const seen = new Set(); const t0 = performance.now(); (function f() { window.__dare.game.debug.texts().forEach((t) => seen.add(t)); if (performance.now() - t0 < ms) requestAnimationFrame(f); else res([...seen]); })(); }), ms);
  for (const st of STAGES) {
    const { ctx, page, errors } = await boot(1440, 900, { query: `&stage=${st}` });
    await startRun(page);
    check(`${st}: HUD location + boss label follow the stage`, (await page.textContent('#rr-loc')).length > 3 && (await page.textContent('#rr-boss-name')) === BOSS[st], `${await page.textContent('#rr-loc')} / ${await page.textContent('#rr-boss-name')}`);
    // tips: the ropes tip is ring-only
    await dbg(page, 'wave(2)');
    let ropesSeen = false, wallTipSeen = false;
    for (let i = 0; i < 40; i++) { const t = await page.textContent('#tip'); if (/ROPES ARE LIVE/.test(t)) ropesSeen = true; if (/EDGES|SPIKES LINE|ROPES ARE LIVE/.test(t) && (await page.evaluate(() => document.getElementById('tip').classList.contains('show')))) wallTipSeen = true; await page.waitForTimeout(150); }
    check(`${st}: ${st === 'ring' ? 'the ROPES ARE LIVE tip shows' : 'the ROPES ARE LIVE tip does NOT show'}`, ropesSeen === (st === 'ring'));
    check(`${st}: a stage-specific wall tip shows on wave 2`, wallTipSeen);
    // margins: enemies are drawn on inside the arena
    if (st === 'margins') {
      await dbg(page, 'wave(1)');
      let drawn = false; for (let i = 0; i < 60 && !drawn; i++) { const s = await snap(page); drawn = s.enemies.some((e) => e.drawT > 0 && e.x > 30 && e.x < 970); await page.waitForTimeout(50); }
      check('margins: enemies are drawn on (pencil reveal) inside the arena, not walked in from off screen', drawn);
    }
    // wall word
    await dbg(page, 'wave(2)');
    let flung = false; for (let i = 0; i < 40 && !flung; i++) { flung = await dbg(page, 'fling()'); if (!flung) await page.waitForTimeout(250); }
    const words = flung ? await texts(page, 1500) : [];
    check(`${st}: a body thrown into the wall hazard scores "${WALL[st]}!"`, flung && words.some((t) => t.startsWith(WALL[st] + '!')), words.join(',') + (flung ? '' : ' (no enemy to fling)'));
    // finisher
    await dbg(page, 'wave(2)'); await page.waitForTimeout(300);
    const sc0 = (await snap(page)).score;
    await dbg(page, 'lastOne()'); await dbg(page, 'fling()');
    const fw = await texts(page, 1800); const s2 = await snap(page);
    check(`${st}: last enemy into the wall = finisher "${FIN[st]}" with a bonus`, fw.includes(FIN[st]) && s2.wallFinishers === 1 && s2.score - sc0 >= 500, `texts=${fw.join(',')} fin=${s2.wallFinishers} +${s2.score - sc0}`);
    await page.screenshot({ path: `${OUT}/finisher-${st}.png` });
    // timed hazard: never before wave 2, then telegraph -> fire, hurts both sides, scored on enemies
    await startRun(page);
    await page.waitForTimeout(100);
    let early = false; await dbg(page, 'auto(true,true)'); for (let i = 0; i < 24; i++) { await dbg(page, 'fast(0.25)'); if ((await snap(page)).hazard && (await snap(page)).wave === 1) early = true; }
    check(`${st}: no timed hazard during wave 1`, !early);
    await dbg(page, 'auto(false,false)');
    let natural = false; await dbg(page, 'auto(true,true)'); await dbg(page, 'wave(2)');
    for (let i = 0; i < 160 && !natural; i++) { await dbg(page, 'fast(0.25)'); if ((await snap(page)).hazard) natural = true; }
    check(`${st}: the timed hazard starts on its own from wave 2`, natural);
    await dbg(page, 'auto(false,false)');
    await startRun(page); await dbg(page, 'wave(2)');
    const px = (x) => page.evaluate((x) => { const V = window.__dare.game.debug.arena(); return (x * V.s + V.ox); }, x);
    const hx = 520, cx = await px(hx), fgy = (await dbg(page, 'fit()')).gy;
    const covered = () => page.evaluate(([cx, gy]) => { const c = document.getElementById('c'), x = c.getContext('2d', { willReadFrequently: true }), dpr = c.width / innerWidth;
      const d = x.getImageData(Math.max(0, (cx - 60) * dpr), Math.max(0, (gy - 160) * dpr), 120 * dpr, 190 * dpr).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n; }, [cx, fgy]);
    await dbg(page, 'placePlayer(120)');
    const before = await covered();
    await dbg(page, `hazard(${hx})`); const t0 = Date.now();
    await page.waitForTimeout(400);
    const during = await covered(); const mid = (await snap(page)).hazard;
    check(`${st}: the hazard is telegraphed on screen before it fires (pixels appear in the warning zone)`, mid && mid.phase === 'warn' && during > before + 150, `phase=${mid?.phase} pixels ${before}->${during}`);
    await waitFor(page, () => window.__dare.game.debug.snapshot().hazard?.phase === 'live', null, 4000);
    const warnMs = Date.now() - t0;
    check(`${st}: the warning lasts at least 1.0 s (fair)`, warnMs >= 1000, `${warnMs}ms`);
    await waitFor(page, () => !window.__dare.game.debug.snapshot().hazard, null, 4000);
    // hit both sides: an enemy and the player standing in the zone
    await startRun(page); await dbg(page, 'wave(2)'); await dbg(page, `placeEnemy(${hx})`); await dbg(page, `placePlayer(${hx + 10})`);
    const placed = await snap(page), h0 = placed.player.hp, s0 = placed.score, eIdx = placed.enemies.findIndex((e) => e.kind === 'grunt' && Math.abs(e.x - hx) < 30), e0 = placed.enemies[eIdx]?.hp;
    await dbg(page, `hazard(${hx}, 0.5)`);
    await waitFor(page, () => window.__dare.game.debug.snapshot().hazard?.phase === 'live', null, 3000); await page.waitForTimeout(250);
    const a = await snap(page);
    const e1 = a.enemies[eIdx]?.hp;
    const dropped = Number.isFinite(e0) && Number.isFinite(e1) && e1 < e0;    // the same enemy, found on both sides of the hit
    check(`${st}: when it fires it hurts the player`, a.player.hp < h0, `hp ${h0}->${a.player.hp}`);
    check(`${st}: it hurts enemies too, and that is scored`, a.hzHits >= 1 && a.score > s0 && dropped, `hits=${a.hzHits} score +${a.score - s0} enemy hp ${e0}->${e1}`);
    await page.screenshot({ path: `${OUT}/hazard-${st}.png` });
    // boss: name changes
    await dbg(page, 'wave(5)'); await waitFor(page, () => !!window.__dare.game.debug.snapshot().boss, null, 8000); await page.waitForTimeout(500);
    check(`${st}: the boss is ${BOSS[st]} (HUD label + banner)`, (await page.textContent('#rr-boss-name')) === BOSS[st] && (await dbg(page, 'banner()')).includes(BOSS[st]) && await vis(page, '#rr-boss'), await dbg(page, 'banner()'));
    // paper palette
    const pal = await dbg(page, 'palette()');
    const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11); };
    if (st === 'margins') {
      check('margins: everything white is recoloured (player ink, enemies red pen, sparks/popups/flash/shadow ink)', pal.paper && lum(pal.pMain) < 60 && lum(pal.w) < 80 && lum(pal.flash) < 80 && lum(pal.soft) < 90 && lum(pal.mid) < 110 && lum(pal.shadow) < 90 && /^#[cdb]/.test(pal.eMain), JSON.stringify({ p: pal.pMain, w: pal.w, e: pal.eMain }));
      const plates = await page.evaluate(() => ['.rr-hp', '.hud-score', '.rr-riot', '.rr-wave', '.rr-boss', '.legend', '.tip'].map((s) => { const bg = getComputedStyle(document.querySelector(s)).backgroundColor; const m = bg.match(/[\d.]+/g); return +(m[3] ?? 1); }));
      check('margins: HUD, tips and legend sit on dark plates over the paper', plates.every((a) => a >= 0.8), plates.join(','));
    } else check(`${st}: dark palette keeps the white fighter`, !pal.paper && lum(pal.pMain) > 200);
    check(`${st}: zero console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ================= 4. THE RIOT SPREADS =================
  { const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=infinite' });
    // the run order, as a pure function
    const order = await page.evaluate(async () => {
      const m = await import('/js/stages.js'); const bad = [];
      let last = null;
      for (let i = 0; i < 60; i++) { const c = m.nextCycle(last);
        if (new Set(c).size !== 7) bad.push('cycle not a permutation');
        for (let j = 1; j < 7; j++) if (m.VARIANTS[c[j]].stage === m.VARIANTS[c[j - 1]].stage) bad.push('same stage twice in a row');
        if (last && m.VARIANTS[c[0]].stage === m.VARIANTS[last].stage) bad.push('same stage across the seam');
        last = c[6]; }
      return bad;
    });
    check('order: 60 cycles each hit all 7 variants once, never the same stage back to back (even across the seam)', order.length === 0, order.slice(0, 2).join(','));
    await startRun(page);
    await dbg(page, 'wave(3)'); await dbg(page, 'riot(55)');
    // let the wave spawn a bit so the hp/score are non-trivial, then clear it with the last enemy flung right
    await page.waitForTimeout(2200);
    await dbg(page, 'lastOne()'); await dbg(page, 'fling()');
    const before = await snap(page); const l0 = await loc(page);
    // measure the transition in real time
    const trans = await page.evaluate(() => new Promise((res) => { let t0 = null, dir = null, kind = null, committedAt = null; const t = performance.now();
      (function f() { const s = window.__dare.game.debug.snapshot();
        if (s.transition && t0 === null) { t0 = performance.now(); dir = s.transition.dir; kind = s.transition.kind; }
        if (s.transition?.committed && committedAt === null) committedAt = performance.now();
        if (t0 !== null && !s.transition) return res({ ms: performance.now() - t0, dir, kind, commitMs: committedAt - t0 });
        if (performance.now() - t > 12000) return res(null); requestAnimationFrame(f); })(); }));
    check('infinite: clearing wave 3 triggers the break-through into the planned next location', !!trans && (await snap(page)).crossed === 1 && (await loc(page)).cur === l0.next, JSON.stringify(trans));
    check('infinite: the wipe travels from the side the last body flew (it was thrown right)', trans?.dir === 1 && trans?.kind === 'wipe');
    check('infinite: the transition takes under 0.9 s', trans && trans.ms < 900, `${trans?.ms?.toFixed(0)}ms`);
    const after = await snap(page); const banner = await dbg(page, 'banner()');
    check('infinite: banner names the new location with the next wave number', banner.includes((await loc(page)).stage === 'ring' ? 'LIVE RING' : (await loc(page)).stage === 'pit' ? 'PIT' : 'MARGINS') && /WAVE 4/.test(banner), banner);
    check('infinite: HP, score and RIOT persist across the break (no reset)', after.player.hp >= before.player.hp - 0.01 && after.score >= before.score && after.riot >= before.riot - 0.01 && after.riot > 0, `hp ${before.player.hp}->${after.player.hp} score ${before.score}->${after.score} riot ${before.riot}->${after.riot}`);
    await waitFor(page, () => window.__dare.game.debug.snapshot().wave === 4, null, 6000);
    await page.waitForTimeout(2500);
    const s4 = await snap(page);
    check('infinite: wave 4 carries on in the new location, enemies valid and the player still responds', s4.wave === 4 && s4.state === 'play' && s4.enemies.every((e) => finite({ x: e.x, y: e.y, hp: e.hp })) && s4.enemies.length >= 1 && finite(s4.player));
    await page.keyboard.down('KeyD'); await page.waitForTimeout(250); const x1 = (await snap(page)).player.x; await page.waitForTimeout(250); const x2 = (await snap(page)).player.x; await page.keyboard.up('KeyD');
    check('infinite: no input drop after the break (movement keys still move the player)', x2 !== x1);
    // all seven locations in sequence, forced, with enemies on the field
    const seen = []; let hpOk = true, enemiesOk = true, cacheOk = true, stateOk = true;
    await dbg(page, 'auto(false,true)'); await dbg(page, 'wave(20)');
    for (let i = 0; i < 14; i++) {
      await page.waitForTimeout(350); await dbg(page, 'stress(3)');
      const b = await snap(page), aliveB = b.enemies.filter((e) => e.hp > 0).length;
      await dbg(page, 'forceBreak()');
      await waitFor(page, (n) => window.__dare.game.debug.snapshot().crossed > n && !window.__dare.game.debug.snapshot().transition, b.crossed + 0 + (i >= 0 ? 0 : 0), 4000);
      const a = await snap(page), L = await loc(page);
      seen.push(L.cur);
      if (!(a.crossed > b.crossed) || a.score < b.score) stateOk = false;
      if (!(a.player.hp > 0) || a.state !== 'play') hpOk = false;   // (HP persistence across a break is checked exactly above; here it only has to stay alive)
      if (aliveB < 1 || a.enemies.filter((e) => e.hp > 0).length < aliveB) enemiesOk = false;   // nobody on the field dies or vanishes because the picture changed
      if (!a.enemies.every((e) => finite({ x: e.x, y: e.y, hp: e.hp }))) enemiesOk = false;
      if (L.cache.length > 2 || L.body.stage !== L.stage || (L.pal === 'paper') !== (L.stage === 'margins')) cacheOk = false;
    }
    check('infinite: 14 forced break-throughs: score persists, player alive, enemies valid, palette follows, at most current+next decoded', stateOk && hpOk && enemiesOk && cacheOk, JSON.stringify({ stateOk, hpOk, enemiesOk, cacheOk, seen: seen.join() }));
    const full = [l0.cur, l0.next, ...seen], w1 = full.slice(0, 7), w2 = full.slice(7, 14);
    check('infinite: the run order cycles through all 7 variants before repeating, never the same stage twice running',
      new Set(w1).size === 7 && new Set(w2).size === 7 && full.every((v, i) => i === 0 || stageOf(v) !== stageOf(full[i - 1])), full.join());
    await page.waitForTimeout(1200);
    const lNow = await loc(page);
    check('infinite: the next location is already decoded in advance (no load hitch when due)', lNow.cache.includes(lNow.next) && lNow.cache.includes(lNow.cur) && lNow.cache.length === 2, JSON.stringify(lNow.cache));
    check('infinite: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close(); }
  // boss wave coinciding with a break (wave 15) and the single-location rules
  { const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=infinite' });
    await startRun(page); await dbg(page, 'auto(false,true)'); await dbg(page, 'wave(15)');
    await waitFor(page, () => !!window.__dare.game.debug.snapshot().boss, null, 9000);
    await dbg(page, 'slay()');
    const ok = await waitFor(page, () => window.__dare.game.debug.snapshot().crossed === 1, null, 9000);
    await waitFor(page, () => window.__dare.game.debug.snapshot().wave === 16, null, 7000);
    const s = await snap(page);
    check('infinite: a boss wave that is also a break wave (15) still breaks through, then wave 16 starts', ok && s.bosses === 1 && s.wave === 16 && s.state === 'play', `crossed=${s.crossed} bosses=${s.bosses} wave=${s.wave}`);
    check('infinite: zero console errors (boss + break)', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close(); }
  { const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=ring' });
    await startRun(page); await dbg(page, 'auto(false,true)');
    const v0 = (await loc(page)).cur;
    await dbg(page, 'wave(3)'); await page.waitForTimeout(500); await dbg(page, 'slay()'); await page.waitForTimeout(4500);
    check('single location: waves 1-4 stay in the same picture (no break every 3 waves)', (await snap(page)).crossed === 0 && (await loc(page)).cur === v0);
    await dbg(page, 'wave(5)'); await waitFor(page, () => !!window.__dare.game.debug.snapshot().boss, null, 9000); await dbg(page, 'slay()');
    await waitFor(page, () => window.__dare.game.debug.snapshot().crossed === 1, null, 9000); await page.waitForTimeout(900);
    const l = await loc(page);
    check('single location: the variant changes after each boss, same stage', l.cur !== v0 && l.stage === 'ring' && (await snap(page)).crossed === 1, `${v0} -> ${l.cur}`);
    check('single location: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close(); }

  // input during the wipe, not after it: real keys on desktop, real touches on a phone, during a break the director started
  for (const [w, h, touch, label] of [[1440, 900, false, 'desktop'], [390, 844, true, 'phone']]) {
    const { ctx, page, errors } = await boot(w, h, { touch, query: '&stage=infinite' });
    await startRun(page); await dbg(page, 'auto(false,true)'); await dbg(page, 'wave(3)'); await dbg(page, 'fast(1.05)');
    await dbg(page, `placePlayer(${(await dbg(page, 'arena()')).arenaW * 0.2})`);
    await page.evaluate(() => { const d = window.__dare.game.debug, rec = window.__rec = []; window.__stopRec = false;
      (function f() { const s = d.snapshot(); rec.push({ t: performance.now(), p: s.transition ? s.transition.p : null, x: s.player.x, st: s.player.state }); if (!window.__stopRec) requestAnimationFrame(f); })(); });
    await dbg(page, 'slay()');
    const started = await page.waitForFunction(() => !!window.__dare.game.debug.snapshot().transition, null, { timeout: 8000, polling: 'raf' }).then(() => true, () => false);
    const mark = () => page.evaluate(() => performance.now());
    const t0 = await mark(); let t1, cdp;
    if (touch) {
      cdp = await ctx.newCDPSession(page);
      const z = await page.locator('.stick-zone').boundingBox(), a = z.x + 70, b = z.y + z.height - 90, [px, py] = await rectOf(page, '.tbtn-a');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a, y: b, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a + 54, y: b, id: 1 }] });
      await page.waitForTimeout(170); t1 = await mark();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a + 54, y: b, id: 1 }, { x: px, y: py, id: 2 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: a + 54, y: b, id: 1 }] });
    } else {
      await page.keyboard.down('KeyD'); await page.waitForTimeout(170); t1 = await mark(); await page.keyboard.press('KeyJ');
    }
    await waitFor(page, () => !window.__dare.game.debug.snapshot().transition, null, 4000);
    if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); else await page.keyboard.up('KeyD');
    const rec = await page.evaluate(() => { window.__stopRec = true; return window.__rec; });
    const during = rec.filter((r) => r.p !== null && r.t >= t0), moving = during.filter((r) => r.t <= t1), afterPunch = during.filter((r) => r.t > t1);
    const moved = moving.length ? moving[moving.length - 1].x - moving[0].x : 0;
    check(`${label}: movement input works DURING the wipe (not just after it)`, started && moving.length >= 3 && moved > 5, `frames=${moving.length} moved=${moved.toFixed(1)}px at p ${moving[0]?.p?.toFixed(2)}..${moving[moving.length - 1]?.p?.toFixed(2)}`);
    check(`${label}: an attack pressed DURING the wipe swings during the wipe`, started && afterPunch.some((r) => r.st === 'atk'), `frames=${afterPunch.length} states=${[...new Set(afterPunch.map((r) => r.st))]}`);
    check(`${label}: zero console errors (input during the wipe)`, errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ================= 5. mid-transition edge cases =================
  for (const [w, h, touch, label] of [[1440, 900, false, 'desktop'], [390, 844, true, 'phone']]) {
    const { ctx, page, errors } = await boot(w, h, { touch, query: '&stage=infinite' });
    await startRun(page); await dbg(page, 'auto(false,true)'); await dbg(page, 'wave(5)'); await page.waitForTimeout(900); await dbg(page, 'stress(4)');
    const nextOf = async () => (await loc(page)).next;
    // pause
    await dbg(page, `forceBreak('${await nextOf()}', -1)`); await page.waitForTimeout(160);
    await page.evaluate(() => window.__dare.engine.pause()); await page.waitForTimeout(120);
    const p1 = (await snap(page)).transition?.p; await page.waitForTimeout(500); const p2 = (await snap(page)).transition?.p;
    check(`${label}: pausing mid-transition freezes it (and the picture does not corrupt)`, p1 !== undefined && p1 === p2 && p1 > 0 && p1 < 1, `${p1} -> ${p2}`);
    await page.screenshot({ path: `${OUT}/transition-paused-${w}.png` });
    await page.evaluate(() => window.__dare.engine.resume());
    check(`${label}: resuming finishes it`, await waitFor(page, () => !window.__dare.game.debug.snapshot().transition, null, 3000));
    // resize
    await page.waitForTimeout(300); await dbg(page, `forceBreak('${await nextOf()}', 1)`); await page.waitForTimeout(220);
    await page.setViewportSize(touch ? { width: 844, height: 390 } : { width: 1000, height: 700 }); await page.waitForTimeout(400);
    const rs = await snap(page); const f = await dbg(page, 'fit()'); const L = await loc(page);
    check(`${label}: resizing mid-transition finishes it cleanly and re-fits to the new size`, !rs.transition && L.shown && Math.abs(f.oy + f.floor * f.ih * f.k - f.gy) < 0.5 && f.ox <= 0.5 && f.oy <= 0.5 && f.ox + f.iw * f.k >= f.view.w - 0.5 && f.oy + f.ih * f.k >= f.view.h - 0.5 && L.body.stage === L.stage, JSON.stringify({ t: rs.transition, shown: L.shown }));
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(300);
    // restart
    await dbg(page, `forceBreak('${await nextOf()}', 1)`); await page.waitForTimeout(200);
    await page.keyboard.press('KeyR'); await page.waitForTimeout(500);
    const rr = await snap(page), Lr = await loc(page);
    check(`${label}: restarting mid-transition drops it: fresh run, no transition, palette and picture agree`, rr.state === 'play' && !rr.transition && rr.wave === 1 && rr.crossed === 0 && Lr.body.stage === Lr.stage && (Lr.pal === 'paper') === (Lr.stage === 'margins') && Lr.shown, JSON.stringify({ s: rr.state, w: rr.wave, c: rr.crossed, t: rr.transition }));
    await page.waitForTimeout(600); const fr = await dbg(page, 'fit()');
    check(`${label}: after the restart the layer shows the run's own location (fit matches)`, fr.cur === (await loc(page)).cur);
    // die
    await dbg(page, 'auto(false,false)'); await dbg(page, 'wave(3)'); await page.waitForTimeout(500); await dbg(page, 'stress(2)');
    await dbg(page, `forceBreak('${await nextOf()}', 1)`); await page.waitForTimeout(150); await dbg(page, 'hurt(999)');
    await waitFor(page, () => window.__dare.game.debug.snapshot().state === 'over' && !window.__dare.game.debug.snapshot().transition, null, 4000);
    await page.waitForTimeout(1800);
    const od = await snap(page); const lines = await page.$$eval('#over-lines dt', (e) => e.map((x) => x.textContent));
    check(`${label}: dying mid-transition ends it cleanly and the game-over panel shows MODE and LOCATIONS CROSSED`, od.state === 'over' && !od.transition && lines.includes('MODE') && lines.includes('LOCATIONS CROSSED') && await vis(page, '#over'), lines.join(','));
    await page.screenshot({ path: `${OUT}/gameover-${w}.png` });
    await page.keyboard.press('KeyR'); await page.waitForTimeout(500);
    check(`${label}: instant restart after that works`, (await snap(page)).state === 'play');
    check(`${label}: zero console errors (edge cases)`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ================= 5b. every panel button can really be reached, on every screen and size =================
  const reach = (page, root) => page.evaluate((root) => {
    const R = document.querySelector(root); if (!R || R.hidden) return { bad: [`${root} is not open`], n: 0 };
    const btns = [...R.querySelectorAll('button')].filter((b) => { const c = getComputedStyle(b); return c.display !== 'none' && c.visibility !== 'hidden' && b.getClientRects().length; });
    const vw = innerWidth, vh = innerHeight, bad = [];
    const reachable = (b) => { const r = b.getBoundingClientRect(), inV = r.left >= -0.5 && r.right <= vw + 0.5 && r.top >= -0.5 && r.bottom <= vh + 0.5;
      if (!inV) return false; const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && (e === b || b.contains(e)); };
    for (const b of btns) {
      const name = (b.textContent.trim() || b.dataset.mode || b.id).replace(/\s+/g, ' ').slice(0, 24);
      if (reachable(b)) continue;
      let sc = b.parentElement; while (sc && !(/auto|scroll/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight + 1)) sc = sc.parentElement;
      if (!sc) { const r = b.getBoundingClientRect(); bad.push(`${name}: [${[r.left, r.top, r.right, r.bottom].map(Math.round)}] outside ${vw}x${vh} and nothing scrolls`); continue; }
      for (let e = b; e; e = e.parentElement) if (getComputedStyle(e).touchAction === 'none') { bad.push(`${name}: scroller exists but touch-action:none blocks it`); break; }
      const top = sc.scrollTop; b.scrollIntoView({ block: 'center', inline: 'nearest' });
      if (!reachable(b)) { const r = b.getBoundingClientRect(); bad.push(`${name}: still blocked or clipped after scrolling [${[r.left, r.top, r.right, r.bottom].map(Math.round)}]`); }
      sc.scrollTop = top;
    }
    return { bad, n: btns.length };
  }, root);
  await pool([[844, 390, true], [667, 375, true], [1024, 600, true], [360, 640, true], [390, 844, true], [1440, 900, false]], 3, async ([w, h, touch]) => {
    const { ctx, page, errors } = await boot(w, h, { touch, query: '&stage=infinite' });
    const report = async (screen, root, extra = true, more = '') => { const m = await reach(page, root); check(`buttons in reach ${w}x${h}: ${screen} (${m.n} buttons)`, m.n > 0 && m.bad.length === 0 && extra, [...m.bad, more].filter(Boolean).join(' | ')); };
    await report('title', '#title');
    await page.keyboard.press('KeyH'); await page.waitForTimeout(150);
    await report('How to Play', '#howto');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    await startRun(page); await page.keyboard.press('KeyP'); await page.waitForTimeout(150);
    await report('pause', '#paused');
    await page.keyboard.press('KeyX'); await page.waitForTimeout(150);
    await dbg(page, 'auto(false,false)'); await dbg(page, 'hurt(999)');
    await waitFor(page, () => !document.getElementById('over').hidden, null, 4000); await page.waitForTimeout(450);
    const again = await page.evaluate(() => !!document.querySelector('#over #again'));
    await report('game over (AGAIN and the rest)', '#over', again);
    await page.locator('#again').scrollIntoViewIfNeeded().catch(() => {});
    if (touch) await page.locator('#again').tap().catch(() => {}); else await page.locator('#again').click().catch(() => {});
    await page.waitForTimeout(250);
    check(`AGAIN works from a real ${touch ? 'tap' : 'click'} at ${w}x${h}`, (await snap(page)).state === 'play' && errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  });

  // ================= 6. image not ready / failed =================
  { // slow images: the picture after next is slow to arrive; keep fighting here until it is decoded
    let armed = false;
    const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=infinite', route: (c) => c.route(/\/art\/(ring|pit|margins)-[abc]\.webp$/, async (r) => { if (armed) await wait(6500); r.continue(); }) });
    await startRun(page); await dbg(page, 'auto(false,true)');
    armed = true;
    await dbg(page, 'forceBreak()'); await waitFor(page, () => window.__dare.game.debug.snapshot().crossed === 1 && !window.__dare.game.debug.snapshot().transition, null, 4000);
    const l0 = await loc(page);
    check('slow art: after a break the next picture is still downloading (not decoded yet)', !l0.cache.includes(l0.next) && (await snap(page)).state === 'play', JSON.stringify(l0.cache));
    await dbg(page, 'wave(3)'); await page.waitForTimeout(500); await dbg(page, 'slay()');
    await page.waitForTimeout(3600);
    const s = await snap(page);
    check('slow art: when the break is due but the next image is not decoded, the fight carries on in this location', s.crossed === 1 && s.wave >= 4 && s.state === 'play' && s.breakDue, JSON.stringify({ c: s.crossed, w: s.wave, due: s.breakDue }));
    await waitFor(page, () => window.__dare.game.debug.loc().cache.includes(window.__dare.game.debug.loc().next), null, 9000);
    await dbg(page, `wave(${s.wave})`); await page.waitForTimeout(500); await dbg(page, 'slay()');
    const crossed = await waitFor(page, () => window.__dare.game.debug.snapshot().crossed === 2, null, 9000);
    check('slow art: once it is ready the break-through happens at the next clear', crossed);
    check('slow art: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close(); }
  { // failed images: route abort
    const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=margins', filterNet: true, route: (c) => c.route(/\/art\/(ring|pit|margins)-[abc]\.webp$/, (r) => r.abort()) });
    const l = await loc(page);
    check('failed art: falls back to the procedural background (paper for The Margins), not a blank screen', !l.shown && l.pal === 'paper' && await page.evaluate(() => { const d = document.getElementById('bg').getContext('2d').getImageData(300, 300, 1, 1).data; return d[3] === 255 && d[0] > 200; }));
    await startRun(page); await dbg(page, 'wave(2)'); await dbg(page, 'auto(true,true)');
    let sawHz = false, sawEnemy = false, s = await snap(page);
    for (let i = 0; i < 160 && !(sawHz && sawEnemy && s.kills >= 1); i++) { await dbg(page, 'fast(0.25)'); s = await snap(page); sawHz ||= !!s.hazard; sawEnemy ||= s.enemies.length > 0; }
    check('failed art: the run plays on (waves, enemies, hazards) with the fallback', s.state === 'play' && sawEnemy && sawHz && s.kills >= 1 && s.score > 0, `state=${s.state} enemies=${sawEnemy} hazard=${sawHz} kills=${s.kills} score=${s.score}`);
    await dbg(page, 'auto(false,true)');
    await dbg(page, 'forceBreak(\'ring-a\')'); await waitFor(page, () => !window.__dare.game.debug.snapshot().transition, null, 3000);
    const l2 = await loc(page);
    check('failed art: a break-through into a location whose art failed still works (procedural ring, palette flips)', l2.stage === 'ring' && l2.pal === 'dark' && !l2.shown && await page.evaluate(() => document.getElementById('bg').getContext('2d').getImageData(700, 300, 1, 1).data[3]) === 255);
    await page.screenshot({ path: `${OUT}/fallback-ring-1440.png` });
    check('failed art: zero console errors (apart from the aborted requests)', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close(); }

  // ================= 7. frame budget under stress, in each stage =================
  for (const st of STAGES) {
    for (const [w, h, touch, dpr] of [[1440, 900, false, 2], [390, 844, true, 2]]) {
      const { ctx, page, errors } = await boot(w, h, { touch, dpr, query: `&stage=${st}` });
      await startRun(page); await dbg(page, 'wave(3)'); await dbg(page, 'stress(12)'); await dbg(page, 'hazard()'); await page.waitForTimeout(500);
      const m = await page.evaluate(() => new Promise((resolve) => {
        const d = []; let last = performance.now(), n = 0, maxRag = 0, amb = 0;
        const f = (t) => { d.push(t - last); last = t; n++; maxRag = Math.max(maxRag, window.__dare.game.debug.snapshot().ragdolls); amb = Math.max(amb, window.__dare.game.debug.perf().amb);
          if (n < 420) requestAnimationFrame(f); else { const b = d.slice(5).sort((x, y) => x - y); resolve({ avg: b.reduce((x, y) => x + y, 0) / b.length, p95: b[Math.floor(b.length * 0.95)], maxRag, amb, work: window.__dare.engine.stats.workMs }); } };
        requestAnimationFrame(f); }));
      console.log(`      ${st} ${w}x${h} dpr${dpr}: avg=${m.avg.toFixed(2)}ms p95=${m.p95.toFixed(2)}ms ragdolls=${m.maxRag} ambient=${m.amb.toFixed(3)}ms work=${m.work.toFixed(2)}ms`);
      check(`${st} ${w}x${h}@${dpr}x under stress: holds 60 fps (avg <= 16.7ms, p95 <= 17.5ms), 8+ ragdolls`, m.avg <= 16.7 && m.p95 <= 17.5 && m.maxRag >= 8, `avg ${m.avg.toFixed(2)} p95 ${m.p95.toFixed(2)} rag ${m.maxRag}`);
      check(`${st} ${w}x${h}@${dpr}x: ambient life costs under 1 ms a frame`, m.amb < 1, `${m.amb.toFixed(3)}ms`);
      check(`${st} ${w}x${h}@${dpr}x: zero console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }
  }

  // ================= 7b. CPU/4 at 390x844@2x: the unthrottled M3 numbers above say little about a phone =================
  // Limits are the numbers measured on 2026-11-06 plus a margin for noise (see LIMITS). They exist to catch a regression.
  { const LIMITS = THROTTLE_LIMITS;
    const frames = (page, n) => page.evaluate((n) => new Promise((res) => { const d = []; let last = performance.now(), i = 0, rag = 0;
      const f = (t) => { d.push(t - last); last = t; rag = Math.max(rag, window.__dare.game.debug.snapshot().ragdolls); if (++i < n) requestAnimationFrame(f); else { const b = d.slice(5).sort((x, y) => x - y); res({ avg: b.reduce((x, y) => x + y, 0) / b.length, p95: b[Math.floor(b.length * 0.95)], rag, work: window.__dare.engine.stats.workMs }); } };
      requestAnimationFrame(f); }), n);
    for (const st of STAGES) {
      const { ctx, page, errors } = await boot(390, 844, { touch: true, dpr: 2, query: `&stage=${st}` });
      const cdp = await ctx.newCDPSession(page);
      await startRun(page); await dbg(page, 'auto(true,true)'); await dbg(page, 'wave(3)'); await page.waitForTimeout(400); await dbg(page, 'stress(12)'); await dbg(page, 'hazard()');
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); await page.waitForTimeout(300);
      const m = await frames(page, 150);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      console.log(`      CPU/4 ${st} 390x844@2: avg=${m.avg.toFixed(2)}ms p95=${m.p95.toFixed(2)}ms work=${m.work.toFixed(2)}ms ragdolls=${m.rag} (limits avg<=${LIMITS.avg} p95<=${LIMITS.p95} work<=${LIMITS.work})`);
      check(`CPU/4 ${st} 390x844@2x under stress: frame time within the measured budget`, m.avg <= LIMITS.avg && m.p95 <= LIMITS.p95 && m.work <= LIMITS.work && m.rag >= 8 && errors.length === 0, `avg ${m.avg.toFixed(2)} p95 ${m.p95.toFixed(2)} work ${m.work.toFixed(2)} rag ${m.rag}`);
      await ctx.close();
    }
    const { ctx, page, errors } = await boot(390, 844, { touch: true, dpr: 2, query: '&stage=infinite' });
    const cdp = await ctx.newCDPSession(page);
    await startRun(page); await dbg(page, 'auto(false,true)');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const breaks = [];
    for (let i = 0; i < 4; i++) {
      await dbg(page, 'wave(3)'); await dbg(page, 'fast(1.1)'); await waitFor(page, () => { const L = window.__dare.game.debug.loc(); return L.cache.includes(L.next); }, null, 5000); await dbg(page, 'slay()');
      const r = await page.evaluate(() => new Promise((res) => { const d = window.__dare.game.debug, T0 = performance.now(); let seen = null, last = T0; const all = [], pre = [];
        const tick = (now) => { const dt = now - last; last = now; const s = d.snapshot();
          if (s.transition && seen === null) { seen = now; all.push(pre[pre.length - 1] || 0, dt); } else if (seen !== null) all.push(dt); else pre.push(dt);
          if (seen !== null && !s.transition) return res({ first: Math.max(...all.slice(0, 4)), worst: Math.max(...all), ms: now - seen, frames: all.length });
          if (now - T0 > 15000) return res(null); requestAnimationFrame(tick); };
        requestAnimationFrame(tick); }));
      if (r) breaks.push(r);
      await waitFor(page, () => window.__dare.game.debug.snapshot().wave === 4, null, 8000); await dbg(page, 'calm()');   // the break is only over when the next wave starts
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const firsts = breaks.map((b) => b.first).sort((a, b) => a - b), worsts = breaks.map((b) => b.worst).sort((a, b) => a - b), medFirst = firsts[Math.floor(firsts.length / 2)] ?? Infinity, medWorst = worsts[Math.floor(worsts.length / 2)] ?? Infinity;
    console.log(`      CPU/4 first frame of a break 390x844@2: ${firsts.map((v) => v.toFixed(1)).join(', ')}ms, worst frame in the wipe ${worsts.map((v) => v.toFixed(1)).join(', ')}ms (limits median first<=${LIMITS.breakFirst} median worst<=${LIMITS.breakWorst} single hitch<=${LIMITS.breakHitch})`);
    check('CPU/4 390x844@2x: the first frame of a break stays within the measured budget', breaks.length === 4 && medFirst <= LIMITS.breakFirst && medWorst <= LIMITS.breakWorst && Math.max(...worsts) <= LIMITS.breakHitch && errors.length === 0, `median first ${medFirst.toFixed(1)}ms median worst ${medWorst.toFixed(1)}ms peak ${Math.max(...worsts).toFixed(1)}ms breaks=${breaks.length}`);
    await ctx.close(); }

  // ================= 8. soak: 66 forced waves, all locations =================
  { const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=infinite' });
    await startRun(page); await dbg(page, 'auto(true,true)');
    const trace = await page.evaluate(async () => {
      const d = window.__dare.game.debug, out = []; let nan = 0, maxQueue = 0, maxOk = 0;
      for (let n = 1; n <= 66; n++) {
        d.wave(n); d.fast(2.4);
        if (n % 3 === 0) { d.forceBreak(); d.fast(1.2); }
        await new Promise((r) => setTimeout(r, 25));        // let images decode, like a real session
        const s = d.snapshot(), z = d.sizes();
        if (![s.score, s.wave, s.player.hp, s.player.x, s.riot, s.mult, ...s.enemies.flatMap((e) => [e.x, e.y, e.hp])].every(Number.isFinite)) nan++;
        maxQueue = Math.max(maxQueue, s.queue); maxOk = Math.max(maxOk, d.loc().cache.length);
        out.push({ n, ...z, state: s.state, crossed: s.crossed, wave: s.wave });
      }
      return { out, nan, maxQueue, maxOk };
    });
    const T = trace.out, third = (a, k) => a.slice(Math.floor(T.length * k / 3), Math.floor(T.length * (k + 1) / 3));
    const mx = (a, key) => Math.max(...a.map((r) => r[key]));
    const growth = ['enemies', 'waves', 'ropeFx', 'wallFx', 'tipQ', 'locQueue'].filter((k) => mx(third(T, 2), k) > mx(third(T, 0), k) + 4);
    const last = T[T.length - 1];
    check('soak: 66 forced waves, still playing, 20+ locations crossed', last.state === 'play' && last.wave === 66 && last.crossed >= 20, `state=${last.state} wave=${last.wave} crossed=${last.crossed}`);
    check('soak: no NaN anywhere (score, HP, positions) through wave 66', trace.nan === 0, `nan frames ${trace.nan}`);
    check('soak: no unbounded growth (enemies, waves, fx, tips, location queue, image cache)', growth.length === 0 && mx(T, 'enemies') <= 40 && mx(T, 'locQueue') <= 9 && trace.maxOk <= 2 && trace.maxQueue <= 45 && mx(T, 'particles') <= 900,
      `growth=[${growth}] enemies<=${mx(T, 'enemies')} locQueue<=${mx(T, 'locQueue')} decoded<=${trace.maxOk} queue<=${trace.maxQueue} particles<=${mx(T, 'particles')}`);
    const hard = await page.evaluate(() => { const d = window.__dare.game.debug; d.wave(60); d.fast(1); const a = d.snapshot(); d.wave(30); d.fast(1); return { q60: a.queue }; });
    check('soak: the wave queue stays capped past wave 50', hard.q60 <= 45, `queue@60=${hard.q60}`);
    check('soak: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close(); }
  { // difficulty really climbs: enemy HP, enemy damage, enemy speed and spawn pressure, measured from what the game does
    const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=ring' });
    await startRun(page);
    // fresh run per sample, so the time-based enrage stays at zero and only the wave number differs
    const fresh = async (n) => { await page.waitForTimeout(240); await page.keyboard.press('KeyR'); await page.waitForTimeout(30); await dbg(page, 'auto(false,false)'); await dbg(page, `wave(${n})`); };
    const hazardDmg = async (n) => { await fresh(n); return page.evaluate(() => { const d = window.__dare.game.debug, x = d.arena().arenaW * 0.4; d.placePlayer(x); const h = d.snapshot().player.hp; d.hazard(x, 0.01); for (let i = 0; i < 12 && d.snapshot().player.hp === h; i++) d.fast(1 / 60); return h - d.snapshot().player.hp; }); };
    const meleeDmg = async (n) => { await fresh(n); return page.evaluate(() => { const d = window.__dare.game.debug, x = d.arena().arenaW * 0.4; d.lastOne('grunt'); d.placePlayer(x); const h = d.snapshot().player.hp; for (let i = 0; i < 900 && d.snapshot().player.hp === h; i++) d.fast(1 / 60); return h - d.snapshot().player.hp; }); };
    const body = async (n) => { await fresh(n); return page.evaluate(() => { const d = window.__dare.game.debug, s0 = d.snapshot(), q = s0.queue; const hp = (kind) => { d.spawn(kind); const es = d.snapshot().enemies; return es[es.length - 1].hp; };
      const grunt = hp('grunt'), boss = hp('boss'); return { q, grunt, boss }; }); };
    // entry speed: px/s of grunts walking in, averaged because each one has a little random spread
    const entry = async (n) => { await fresh(n); return page.evaluate(() => { const d = window.__dare.game.debug; d.auto(false, true); const before = d.snapshot().enemies.length; for (let i = 0; i < 12; i++) d.spawn('grunt'); d.fast(1 / 60); const a = d.snapshot().enemies.slice(before).map((e) => e.x); d.fast(4 / 60); const b = d.snapshot().enemies.slice(before).map((e) => e.x); return a.reduce((t, x, i) => t + Math.abs(b[i] - x), 0) / a.length / (4 / 60); }); };
    // spawn pressure: enemies on the field after 6 sim seconds of an undisturbed wave
    const pressure = async (n) => { await fresh(n); return page.evaluate(() => { const d = window.__dare.game.debug; d.auto(false, true); d.placePlayer(-1e4); d.fast(6); return d.snapshot().enemies.length; }); };
    const D = {}; for (const n of [1, 12, 41, 61, 101]) D[n] = { ...(await body(n)), hz: await hazardDmg(n), melee: await meleeDmg(n), entry: await entry(n), press: await pressure(n) };
    const row = (k) => [1, 12, 41, 61, 101].map((n) => (typeof D[n][k] === 'number' ? +D[n][k].toFixed(1) : D[n][k])).join(' > ');
    console.log(`      difficulty at waves 1/12/41/61/101: grunt HP ${row('grunt')}; boss HP ${row('boss')}; hazard dmg ${row('hz')}; melee dmg ${row('melee')}; entry px/s ${row('entry')}; on field after 6s ${row('press')}; queue ${row('q')}`);
    check('difficulty climbs: enemy HP keeps rising (grunts and the boss), including past wave 50', D[12].grunt > D[1].grunt && D[41].grunt > D[12].grunt && D[61].grunt > D[41].grunt && D[101].grunt > D[61].grunt && D[12].boss > D[1].boss && D[41].boss > D[12].boss && D[61].boss > D[41].boss && D[101].boss > D[61].boss, `grunt ${row('grunt')} boss ${row('boss')}`);
    check('difficulty climbs: enemy damage keeps rising past wave 12 (hazard and melee), including past wave 50', D[1].hz > 0 && D[41].hz > D[12].hz * 1.1 && D[61].hz > D[41].hz && D[101].hz > D[61].hz && D[1].melee > 0 && D[41].melee > D[12].melee * 1.1 && D[61].melee > D[41].melee && D[101].melee > D[61].melee, `hazard ${row('hz')} melee ${row('melee')}`);
    check('difficulty climbs: enemies move faster by wave 12', D[12].entry > D[1].entry * 1.3, `entry ${row('entry')}`);
    check('difficulty climbs: spawn pressure rises (more on the field after 6 s, longer queue)', D[12].press > D[1].press && D[12].q > D[1].q, `field ${row('press')} queue ${row('q')}`);
    check('difficulty climbs: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close(); }

  // ================= 8b. soak: waves cleared by play, through the real director =================
  // No wave(), fast() or forceBreak(): the only thing driving the run is key events through the real Input listeners
  // (god mode keeps the bot alive). Sizes are read every sim step, so nothing is hidden by wave() emptying the arrays.
  { const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=infinite' });
    const cdp = await ctx.newCDPSession(page);
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize / 1e6; };
    await page.keyboard.press('KeyX'); await page.waitForTimeout(250); await dbg(page, 'auto(false,true)');
    await page.evaluate(REAL_SOAK);
    const h0 = await page.evaluate((o) => window.__soak(o), { toWave: 10, stuckS: SOAK_STUCK_S }).then(async (r) => ({ r, mb: await heap() }));
    const h1 = await page.evaluate((o) => window.__soak(o), { toWave: SOAK_TO_WAVE, stuckS: SOAK_STUCK_S }).then(async (r) => ({ r, mb: await heap() }));
    const R = h1.r, W = [...h0.r.waves, ...R.waves], E = R.end;   // two legs, with the heap read in between
    for (const k of ['badAdvance', 'crossSteps', 'nan', 'scoreDrops', 'tSim', 'realMs']) R[k] += h0.r[k];
    for (const k of Object.keys(R.peak)) R.peak[k] = Math.max(R.peak[k], h0.r.peak[k]);
    Object.assign(R.stale, h0.r.stale); R.stuck ||= h0.r.stuck;
    console.log(`      real soak: reached wave ${E.wave}, crossed ${E.crossed}, kills ${E.kills}, bosses ${E.bosses}, sim ${R.tSim.toFixed(0)}s in ${(R.realMs / 1000).toFixed(0)}s, longest wave ${Math.max(0, ...W.map((w) => w.sec)).toFixed(0)}s, peak enemies ${R.peak.enemies}, particles ${R.peak.particles}, heap ${h0.mb.toFixed(1)} -> ${h1.mb.toFixed(1)}MB${R.stuck ? ', STUCK ' + JSON.stringify(R.stuck) : ''}`);
    check(`real soak: waves cleared by play through the director up to wave ${SOAK_TO_WAVE}, still playing`, E.state === 'play' && E.wave >= SOAK_TO_WAVE && !R.stuck, `state=${E.state} wave=${E.wave}${R.stuck ? ' stuck=' + JSON.stringify(R.stuck) : ''}`);
    check('real soak: the wave number only ever advances by 1, and only after a clear', R.badAdvance === 0 && W.length >= E.wave - 1 && W.every((w, i) => w.wave === i + 1), `badAdvance=${R.badAdvance} waves=${W.map((w) => w.wave).join()}`.slice(0, 200));
    check('real soak: real kills, bosses and break-throughs happened along the way', E.kills > 50 && E.bosses >= Math.floor((SOAK_TO_WAVE - 1) / 5) && E.crossed >= Math.floor((SOAK_TO_WAVE - 1) / 3) - 1 && R.crossSteps === 0, `kills=${E.kills} bosses=${E.bosses} crossed=${E.crossed} badCrossSteps=${R.crossSteps}`);
    check('real soak: no NaN and the score never goes down', R.nan === 0 && R.scoreDrops === 0, `nan=${R.nan} drops=${R.scoreDrops}`);
    const mxW = (a, k) => Math.max(0, ...a.map((w) => w.peak[k])), mid = W.filter((w) => w.wave > W.length / 3 && w.wave <= 2 * W.length / 3), lateW = W.filter((w) => w.wave > 2 * W.length / 3);
    const growth = ['waves', 'ropeFx', 'wallFx', 'tipQ', 'locQueue', 'cache'].filter((k) => mxW(lateW, k) > mxW(mid, k) + 4);
    const startGrowth = lateW.length && mid.length && Math.max(...lateW.map((w) => w.startEnemies)) > Math.max(...mid.map((w) => w.startEnemies)) + 8;
    check('real soak: no unbounded growth, sampled every sim step (arrays are not emptied between waves here)', growth.length === 0 && !startGrowth && R.peak.enemies <= 40 && R.peak.particles <= 900 && R.peak.wallFx <= 12 && R.peak.tipQ <= 16 && R.peak.locQueue <= 9 && R.peak.cache <= 3 && R.peak.ok <= 2,
      `growth=[${growth}] startGrowth=${startGrowth} peak=${JSON.stringify(R.peak)}`);
    check('real soak: the heap is flat from wave 10 on (after GC)', h1.mb <= h0.mb + 4, `${h0.mb.toFixed(1)} -> ${h1.mb.toFixed(1)}MB`);
    const mults = R.breaks.concat(h0.r.breaks).filter((b) => b.next !== null && !b.hit);
    check('real soak: the multiplier survives every natural break the player was not hit in (at least one sample above x1)', mults.length >= 3 && mults.some((b) => b.clear >= 2) && mults.every((b) => b.next === b.clear), JSON.stringify(mults.map((b) => `w${b.wave} x${b.clear}->x${b.next}`)));
    check('real soak: tips never name another location after a break', Object.keys(R.stale).length === 0, JSON.stringify(R.stale).slice(0, 240));
    check('real soak: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close(); }

  // ================= 9. screenshots: every location, both sizes, mid-fight, plus a mid-transition frame =================
  for (const [w, h, touch, tag] of [[1440, 900, false, '1440'], [390, 844, true, '390']]) {
    const { ctx, page, errors } = await boot(w, h, { touch, query: '&stage=infinite' });
    await startRun(page); await dbg(page, 'auto(true,true)');
    for (const vid of VARIANTS) {
      await show(page, vid); await dbg(page, 'wave(4)'); await dbg(page, 'fast(5)'); await dbg(page, 'riot(60)');
      await page.waitForTimeout(450);
      await page.screenshot({ path: `${OUT}/fight-${vid}-${tag}.png` });
    }
    await show(page, 'ring-a'); await dbg(page, 'wave(4)'); await dbg(page, 'fast(3)');
    await dbg(page, 'calm()'); await dbg(page, "forceBreak('pit-a', 1)"); await page.waitForTimeout(230);
    check(`screenshot: a mid-transition frame was captured at ${tag}`, !!(await snap(page)).transition);
    await page.screenshot({ path: `${OUT}/transition-mid-${tag}.png` });
    await waitFor(page, () => !window.__dare.game.debug.snapshot().transition, null, 3000);
    check(`screenshots at ${tag}: zero console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} stage checks passed`);
process.exit(passed === results.length ? 0 : 1);
