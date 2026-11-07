// Intended-behaviour checks that only mean something when the game is played the way a player plays it:
// the multiplier across a natural break, reduced motion, CHANGE LOCATION, quick picks and late art, corrupt storage,
// stale tips, the game-over panel per mode, and the picture after a restart.
//   node scripts/real-play.mjs [--out .shots]
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
const results = []; const check = (n, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ART = /\/art\/(ring|pit|margins)-[abc]\.webp$/;
const KEY = 'dare-arcade:ragdoll-riot:';

async function boot(w, h, { touch = false, dpr, query = '', init, route, reduced = false, settle = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr ?? (touch ? 2 : 1), hasTouch: touch, isMobile: touch, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  ctx.setDefaultTimeout(6000);
  if (init) await ctx.addInitScript(init);
  if (route) await route(ctx);
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${BASE}/?debug${query}`, { waitUntil: 'commit' }); await page.waitForFunction(() => window.__dare?.shell); await page.waitForTimeout(settle);
  return { ctx, page, errors };
}
// dbg: call a ?debug-only hook; the strings are fixed literals written in this file, never external input
const dbg = (page, call) => page.evaluate(`window.__dare.game.debug.${call}`);
const snap = (page) => dbg(page, 'snapshot()');
const loc = (page) => dbg(page, 'loc()');
const waitFor = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout, polling: 'raf' }).then(() => true, () => false);
const realStart = async (page) => { await page.keyboard.press('KeyX'); await page.waitForTimeout(280); };
const nextDecoded = (page) => waitFor(page, () => { const L = window.__dare.game.debug.loc(); return L.cache.includes(L.next); }, null, 6000);
const showVariant = async (page, vid) => { await dbg(page, `setVariant('${vid}')`); await waitFor(page, (v) => window.__dare.game.debug.loc().cache.includes(v), vid, 6000); await dbg(page, `setVariant('${vid}')`); await page.waitForTimeout(60); };
// A broken section reports a failure and the rest of the suite still runs.
const section = async (name, fn) => { try { await fn(); } catch (e) { check(`${name}: finished without throwing`, false, String(e).split('\n')[0]); } };
const pool = async (items, n, fn) => { const q = items.slice(); await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); };
const tapKey = `const tap = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); };`;

try {
  // ================= 1. the multiplier survives a natural break =================
  await section('multiplier', async () => {
    const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=infinite' });
    await realStart(page); await dbg(page, 'auto(false,true)');
    // real J presses through the real Input listeners on passive targets, until the combo earns a multiplier; then the wave ends
    let built = 0;
    for (let i = 0; i < 4 && built < 2; i++) {
      await nextDecoded(page);
      built = await page.evaluate(`(() => { ${tapKey} const d = window.__dare.game.debug; d.wave(3); d.fast(1.05); const x = d.arena().arenaW * 0.4; d.placePlayer(x); for (let k = 0; k < 5; k++) d.placeEnemy(x + 40 + k * 8);
        for (let k = 0; k < 40 && d.snapshot().mult < 2; k++) { tap(k % 5 === 4 ? 'KeyK' : 'KeyJ'); d.fast(0.2); }
        const m = d.snapshot().mult; if (m >= 2) d.slay(); return m; })()`);
      if (built < 2) { await page.waitForTimeout(240); await page.keyboard.press('KeyR'); await page.waitForTimeout(40); await dbg(page, 'auto(false,true)'); }
    }
    const r = await page.evaluate(() => new Promise((res) => { const d = window.__dare.game.debug, T0 = performance.now(); let atClear = null, wipe = null;
      (function f() { const s = d.snapshot();
        if (s.phase === 'clear' && atClear === null) atClear = s.mult;
        if (s.transition && wipe === null) wipe = s.mult;
        if (s.wave === 4) return res({ atClear, wipe, at4: s.mult, crossed: s.crossed });
        if (performance.now() - T0 > 12000) return res({ atClear, wipe, at4: null, crossed: s.crossed }); requestAnimationFrame(f); })(); }));
    check('multiplier: earned by real hits before the last enemy falls (x2 or better)', built >= 2, `x${built}`);
    check('multiplier: the mult at the start of wave 4 equals the mult before the clear', built >= 2 && r.crossed === 1 && r.atClear === built && r.at4 === built, JSON.stringify({ before: built, ...r }));
    check('multiplier: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  });

  // ================= 2. reduced motion =================
  await section('reduced motion', async () => {
    // changed pixels on the main canvas while world time advances, outside the idle player and the debug overlay
    const ambientMotion = (page) => page.evaluate(async () => {
      const { engine, game: g } = window.__dare, d = g.debug, c = document.getElementById('c'), x = c.getContext('2d', { willReadFrequently: true });
      const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      d.wave(1); d.calm(); engine.pause();          // updates stop, the engine still renders; only d.fast() moves time now
      await raf();
      const read = () => x.getImageData(0, 0, c.width, c.height).data, V = d.arena(), px = d.snapshot().player.x * V.s + V.ox, gy = V.ground * V.s, dpr = c.width / innerWidth;
      const masked = (X, Y) => (X > px - 170 * V.s && X < px + 170 * V.s && Y > gy - 240 * V.s && Y < gy + 50 * V.s) || (X < 270 && Y > innerHeight - 66);
      let moved = 0, prev = read();
      for (let i = 0; i < 2; i++) { d.fast(0.3); await raf(); const cur = read();
        for (let Y = 0; Y < c.height; Y += 2) for (let X = 0; X < c.width; X += 2) { if (masked(X / dpr, Y / dpr)) continue; const k = (Y * c.width + X) * 4; if (Math.abs(cur[k] - prev[k]) > 8 || Math.abs(cur[k + 1] - prev[k + 1]) > 8 || Math.abs(cur[k + 2] - prev[k + 2]) > 8 || Math.abs(cur[k + 3] - prev[k + 3]) > 8) moved++; }
        prev = cur; }
      return moved;
    });
    const rows = await Promise.all([['ring', 'ring-a'], ['pit', 'pit-a'], ['margins', 'margins-a']].flatMap(([st, vid]) => [true, false].map(async (reduced) => {
      const { ctx, page, errors } = await boot(1440, 900, { query: `&stage=${st}`, reduced });
      await realStart(page); await dbg(page, 'auto(false,true)'); await showVariant(page, vid);
      const moved = await ambientMotion(page); await ctx.close();
      return { st, reduced, moved, errors };
    })));
    for (const st of ['ring', 'pit', 'margins']) {
      const r = rows.find((x) => x.st === st && x.reduced), n = rows.find((x) => x.st === st && !x.reduced);
      check(`reduced motion: ${st} ambient pixels are frozen (and the same measure sees them move without the setting)`, r.moved === 0 && n.moved > 20 && r.errors.length === 0, `reduced ${r.moved}px, normal ${n.moved}px ${r.errors.slice(0, 1)}`);
    }
    const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=infinite', reduced: true });
    await realStart(page); await dbg(page, 'auto(false,true)'); await nextDecoded(page);
    await dbg(page, 'wave(3)'); await dbg(page, 'fast(1.05)'); await dbg(page, `placePlayer(${(await dbg(page, 'arena()')).arenaW * 0.2})`); await dbg(page, 'slay()');
    await waitFor(page, () => !!window.__dare.game.debug.snapshot().transition);
    const t0 = await snap(page); await page.keyboard.down('KeyD');
    const tr = await page.evaluate(() => new Promise((res) => { const d = window.__dare.game.debug, xs = []; let amp = 0; (function f() { const s = d.snapshot(); if (!s.transition) return res({ xs, amp }); xs.push(s.player.x); amp = Math.max(amp, window.__dare.shell.juice.amp); requestAnimationFrame(f); })(); }));
    await page.keyboard.up('KeyD');
    check('reduced motion: a natural break fades instead of wiping', t0.transition?.kind === 'fade' && (await snap(page)).crossed === 1, `kind=${t0.transition?.kind}`);
    check('reduced motion: the screen shake at the break stays small', tr.amp <= 6, `peak ${tr.amp.toFixed(1)}px`);
    check('reduced motion: movement input still works during the fade', tr.xs.length >= 3 && tr.xs[tr.xs.length - 1] - tr.xs[0] > 3, `frames=${tr.xs.length} moved=${((tr.xs[tr.xs.length - 1] ?? 0) - (tr.xs[0] ?? 0)).toFixed(1)}`);
    check('reduced motion: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  });

  // ================= 3. CHANGE LOCATION =================
  for (const from of ['game over', 'pause']) await section(`CHANGE LOCATION (${from})`, async () => {
    const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=ring' });
    await realStart(page);
    const root = from === 'pause' ? '#paused' : '#over';
    if (from === 'pause') { await page.keyboard.press('KeyP'); await page.waitForTimeout(150); }
    else { await dbg(page, 'auto(false,false)'); await dbg(page, 'hurt(999)'); await waitFor(page, () => !document.getElementById('over').hidden, null, 4000); await page.waitForTimeout(450); }
    const btn = page.locator(`${root} button:visible`, { hasText: 'CHANGE LOCATION' });
    const found = await btn.count() === 1;
    check(`${from}: a visible CHANGE LOCATION button exists`, found);
    if (!found) { await ctx.close(); return; }
    await btn.click(); await page.waitForTimeout(250);
    const m = await page.evaluate(() => ({ state: document.body.dataset.state, title: !document.getElementById('title').hidden, over: document.getElementById('over').hidden, paused: document.getElementById('paused').hidden, enginePaused: window.__dare.engine.paused, cards: [...document.querySelectorAll('#cards .card')].filter((c) => c.getClientRects().length).length }));
    check(`${from}: CHANGE LOCATION returns to the title with the picker, nothing paused`, m.state === 'title' && m.title && m.over && m.paused && !m.enginePaused && m.cards === 4, JSON.stringify(m));
    await page.click('.card[data-mode="pit"]'); await page.waitForTimeout(150);
    await page.keyboard.press('KeyX'); await page.waitForTimeout(300);
    const s = await snap(page);
    check(`${from}: a new location picked there starts a fresh run in it`, s.state === 'play' && s.mode === 'pit' && s.wave === 1 && s.score === 0 && errors.length === 0, `state=${s.state} mode=${s.mode} wave=${s.wave} score=${s.score} ${errors.slice(0, 1)}`);
    await ctx.close();
  });

  // ================= 4. the latest quick card pick wins, whatever order the art arrives in =================
  await section('quick picks', async () => {
    const delay = { ring: 0, pit: 0, margins: 0 };
    const route = (c) => c.route(ART, async (r) => { const st = new URL(r.request().url()).pathname.match(/art\/([a-z]+)-/)[1]; if (delay[st]) await wait(delay[st]); r.continue().catch(() => {}); });
    const settled = (page) => page.evaluate(() => { const L = window.__dare.game.debug.loc(), F = window.__dare.game.debug.fit(); return { mode: L.mode, stage: L.stage, cur: L.cur, fit: F.cur, want: L.t?.to ?? null, body: L.body.stage, pressed: document.querySelector('.card[aria-pressed="true"]')?.dataset.mode }; });
    const watch = (page) => page.evaluate(() => { window.__stages = new Set(); const d = window.__dare.game.debug; window.__iv = setInterval(() => window.__stages.add(d.loc().stage), 16); });
    const agrees = (m, id) => m.mode === id && m.stage === id && m.body === id && m.pressed === id && m.fit === m.cur && m.fit?.startsWith(id);
    for (const [first, last] of [['pit', 'margins'], ['margins', 'pit']]) for (const late of [first, last]) {
      delay.pit = delay.margins = 0;
      const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=ring', route });   // a fresh page per case: no earlier picture is still decoded
      delay[first] = late === first ? 1300 : 80; delay[last] = late === last ? 1300 : 80;
      await watch(page);
      await page.click(`.card[data-mode="${first}"]`); await page.click(`.card[data-mode="${last}"]`);
      await waitFor(page, (id) => window.__dare.game.debug.loc().stage === id, last, 6000); await page.waitForTimeout(700);   // and it stays there
      const m = await settled(page), saw = await page.evaluate(() => { clearInterval(window.__iv); return [...window.__stages]; });
      // when the first pick's art is the quick one it may fade in first: it was chosen and its art was there. The last pick must still win.
      check(`quick picks: ${first} then ${last} with the ${late} art late: ${last} wins${late === first ? ` and ${first} never shows` : ''}`, agrees(m, last) && (late !== first || !saw.includes(first)) && errors.length === 0, JSON.stringify({ ...m, saw }));
      await ctx.close();
    }
    { // going back to the picture already on screen must also cancel the pending change
      delay.pit = 900; delay.margins = 0;
      const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=ring', route });
      await page.click('.card[data-mode="pit"]');
      await page.evaluate(async () => { const m = await import('/js/stages.js'), L = window.__dare.game.debug.loc(), list = m.STAGES.ring.variants; window.__realRandom = Math.random; const v = (list.indexOf(L.cur) + 0.5) / list.length; Math.random = () => v; });
      await page.click('.card[data-mode="ring"]');
      await page.evaluate(() => { Math.random = window.__realRandom; });
      await page.waitForTimeout(1700);
      const m = await settled(page);
      check('quick picks: pit then back to the ring picture on screen: the ring stays', agrees(m, 'ring'), JSON.stringify(m));
      await realStart(page); const s = await snap(page);
      check('quick picks: the run starts in the last pick', s.state === 'play' && s.mode === 'ring' && s.stage === 'ring' && errors.length === 0, `mode=${s.mode} stage=${s.stage}`);
      await ctx.close(); }
  });

  // ================= 5. crossed counts each break exactly once, however late the art is =================
  await section('late art', async () => {
    const logCrossed = (page) => page.evaluate(() => { const d = window.__dare.game.debug; window.__cx = []; let last = d.snapshot().crossed; window.__cxIv = setInterval(() => { const c = d.snapshot().crossed; if (c !== last) { window.__cx.push(c - last); last = c; } }, 4); });
    const untilSlowLeft = (page, ms) => waitFor(page, (ms) => { const j = window.__dare.shell.juice; return j.slowMs > 0 && j.slowMs <= ms; }, ms, 5000);
    // the picture on screen arrives just before the break starts: its fade-in overlaps the wipe
    for (const left of [300, 120]) {
      let held = null, first = true;
      const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=infinite', route: (c) => c.route(ART, (r) => { if (first) { first = false; held = r; return; } r.continue().catch(() => {}); }) });
      await realStart(page); await dbg(page, 'auto(false,true)'); await nextDecoded(page);
      const L0 = await loc(page); await logCrossed(page);
      await dbg(page, 'wave(3)'); await dbg(page, 'fast(1.3)'); await dbg(page, 'slay()');   // 1.3 s: the first enemy is on the field, so the last kill gets its slow-mo beat
      const timed = await untilSlowLeft(page, left); await held?.continue().catch(() => {});
      await waitFor(page, () => window.__dare.game.debug.snapshot().wave === 4, null, 9000); await page.waitForTimeout(300);
      const s = await snap(page), L = await loc(page), steps = await page.evaluate(() => window.__cx);
      check(`late art: picture on screen arrives ${left}ms before the break: crossed goes up once and the plan stays right`, timed && (s.crossed === 1 ? steps.join() === '1' && L.cur === L0.next : s.crossed === 0 && s.breakDue && steps.length === 0) && L.next !== L.cur && L.queue[0] !== L.cur && errors.length === 0, JSON.stringify({ crossed: s.crossed, steps, planned: L0.next, cur: L.cur, next: L.next }));
      await ctx.close();
    }
    { // the next picture arrives just in time for the second of two natural breaks
      let armed = false; const held = [];
      const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=infinite', route: (c) => c.route(ART, (r) => { if (armed) held.push(r); else r.continue().catch(() => {}); }) });
      await realStart(page); await dbg(page, 'auto(false,true)'); await nextDecoded(page);
      armed = true; await logCrossed(page);
      let w = 0;
      for (let i = 0; i < 3 && (await snap(page)).crossed === 0; i++) {   // a break may be owed to the next clear, so keep clearing until the first one lands
        w += 3; await dbg(page, `wave(${w})`); await dbg(page, 'fast(1.3)'); await dbg(page, 'slay()');
        await waitFor(page, (n) => window.__dare.game.debug.snapshot().wave === n, w + 1, 9000);
      }
      const heldCount = held.length;
      w += 3; await dbg(page, `wave(${w})`); await dbg(page, 'fast(1.3)'); await dbg(page, 'slay()');
      const timed = await untilSlowLeft(page, 100); armed = false; for (const r of held.splice(0)) await r.continue().catch(() => {});
      await waitFor(page, (n) => window.__dare.game.debug.snapshot().wave === n, w + 1, 9000); await page.waitForTimeout(300);
      const s = await snap(page), L = await loc(page), steps = await page.evaluate(() => window.__cx);
      check('late art: next picture arrives just in time: each break counts once, no skipped or doubled step', timed && heldCount > 0 && s.crossed === 2 && steps.join() === '1,1' && L.next !== L.cur && errors.length === 0, JSON.stringify({ heldCount, crossed: s.crossed, steps, cur: L.cur, next: L.next }));
      await ctx.close(); }
  });

  // ================= 6. corrupt storage =================
  await section('corrupt storage', async () => {
    const BAD = [['{bad', '{bad'], ['"str"', '"str"'], ['5', '-5'], ['[]', '1e999'], ['null', 'null'], ['{"ropes":"x"}', '[1]'], ['true', '{"a":1}'], ['{"combo":1e999,"kick":-4}', '-1e999']];
    const numeric = (t) => /^\d+$/.test(String(t).trim());
    await pool(BAD.flatMap(([tips, best]) => ['infinite', 'ring'].map((mode) => [tips, best, mode])), 4, async ([tips, best, mode]) => {
      const label = `tips=${tips} best=${best} ${mode}`;
      const init = `if (!localStorage.getItem('__seeded')) { localStorage.setItem('__seeded', '1'); for (const k of ['best', 'best:infinite', 'best:ring', 'best:pit', 'best:margins']) localStorage.setItem('${KEY}' + k, ${JSON.stringify(best)}); localStorage.setItem('${KEY}tips', ${JSON.stringify(tips)}); }`;
      const { ctx, page, errors } = await boot(1000, 700, { query: `&stage=${mode}`, init: { content: init } });
      const title = await page.textContent('#best-title');
      await realStart(page); await dbg(page, 'auto(true,true)');
      let thrown = '';
      await page.evaluate(() => { const d = window.__dare.game.debug; d.fast(3); d.wave(2); d.fast(3); d.wave(5); d.fast(3); }).catch((e) => { thrown = String(e).split('\n')[0]; });   // tips fire on these waves
      const tipShown = await page.textContent('#tip');
      await dbg(page, 'auto(false,false)'); await dbg(page, 'hurt(999)');
      await waitFor(page, () => !document.getElementById('over').hidden, null, 4000);
      const hud = await page.textContent('#hud-best'), over = await page.textContent('#over-best');
      check(`corrupt storage (${label}): no errors, best is a plain non-negative number everywhere`, !thrown && errors.length === 0 && numeric(title) && numeric(hud) && numeric(over) && tipShown.length > 0, `title=${title} hud=${hud} over=${over} tip=${tipShown.length > 0} ${thrown} ${errors.slice(0, 1)}`);
      await ctx.close();
    });
  });

  // ================= 7. tips never name another location after a break =================
  await section('stale tips', async () => {
    const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=infinite' });
    await realStart(page);
    const CASES = [
      ['a queued wall tip', 'ring-a', 'pit-a', 'd.wave(2);'],
      ['a wall tip already on screen', 'pit-a', 'margins-a', 'd.wave(2); d.fast(1.5);'],
      ['a queued boss tip', 'margins-a', 'ring-a', 'd.wave(5); d.fast(2.2); d.spawn("boss");'],
      ['a queued hazard tip', 'ring-a', 'margins-a', 'd.wave(2); d.hazard();'],
    ];
    for (const [what, from, to, prep] of CASES) {
      await page.evaluate((k) => localStorage.removeItem(k + 'tips'), KEY);
      await page.waitForTimeout(240); await page.keyboard.press('KeyR'); await page.waitForTimeout(40); await dbg(page, 'auto(false,true)');
      await showVariant(page, from);
      const r = await page.evaluate(`import('/js/stages.js').then(({ STAGES }) => { const d = window.__dare.game.debug, tip = document.getElementById('tip'), bad = new Set(); ${prep}
        const before = tip.classList.contains('show') ? tip.textContent : ''; d.forceBreak(${JSON.stringify(to)}, 1); for (let i = 0; i < 120 && d.snapshot().transition; i++) d.fast(1 / 60);
        const stage = d.snapshot().stage, foreign = Object.values(STAGES).filter((o) => o.id !== stage).flatMap((o) => [o.wallTip, o.hazardTip, o.boss]);
        for (let i = 0; i < 420; i++) { if (tip.classList.contains('show') && foreign.some((w) => tip.textContent.includes(w))) bad.add(tip.textContent); d.fast(1 / 60); }
        return { stage, before, bad: [...bad] }; })`);
      check(`stale tips: ${what} from ${from} never shows after breaking into ${to}`, r.stage === to.split('-')[0] && r.bad.length === 0, JSON.stringify(r.bad));
    }
    check('stale tips: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  });

  // ================= 8. the game-over panel per mode =================
  await section('game-over panel', async () => {
    await Promise.all(['infinite', 'ring', 'pit', 'margins'].map(async (mode) => {
      const { ctx, page, errors } = await boot(1000, 700, { query: `&stage=${mode}` });
      await realStart(page); await dbg(page, 'auto(false,false)'); await dbg(page, 'hurt(999)');
      await waitFor(page, () => !document.getElementById('over').hidden, null, 4000);
      const lines = await page.$$eval('#over-lines dt', (e) => e.map((x) => x.textContent));
      const shown = lines.includes('LOCATIONS CROSSED');
      check(`game-over panel: LOCATIONS CROSSED ${mode === 'infinite' ? 'shows' : 'does not show'} in ${mode}`, lines.length > 0 && shown === (mode === 'infinite') && errors.length === 0, lines.join(','));
      await ctx.close();
    }));
  });

  // ================= 9. restarting never drops to the fallback when a decoded picture exists =================
  await section('restart picture', async () => {
    const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=infinite' });
    await realStart(page); await dbg(page, 'auto(false,true)');
    const rows = [];
    for (let i = 0; i < 6; i++) {
      await nextDecoded(page); await page.waitForTimeout(260);
      rows.push(await page.evaluate(`(() => { ${tapKey} const d = window.__dare.game.debug, b = d.loc(); tap('KeyR'); const a = d.loc(); return { decoded: b.cache.length, shown: a.shown, cur: a.cur, wave: d.snapshot().wave }; })()`));
    }
    const bad = rows.filter((r) => r.decoded > 0 && !r.shown);
    check('restart in THE RIOT SPREADS: the new run opens on a decoded picture, not the fallback', rows.every((r) => r.wave === 1) && rows.every((r) => r.decoded > 0) && bad.length === 0, `${bad.length}/${rows.length} restarts fell back: ${bad.map((r) => r.cur).join()}`);
    check('restart picture: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  });
} finally { await browser.close(); server.close(); }
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} real-play checks passed`);
process.exit(passed === results.length ? 0 : 1);
