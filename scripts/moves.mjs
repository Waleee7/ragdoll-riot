// Slide and GIANT power-up checks, played with real keys and real touches on desktop and a phone.
//   node scripts/moves.mjs [--out .shots]
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
const pw = (page) => dbg(page, 'power()');
const hold = async (page, ms) => { await page.waitForTimeout(ms); };
try {
  await section('desktop slide', async () => {
    const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=ring' });
    await realStart(page); await dbg(page, 'wave(1)'); await dbg(page, 'placePlayer(200)'); await hold(page, 200);
    await page.keyboard.down('KeyD'); await hold(page, 120);
    const x0 = (await pw(page)).x;
    await page.keyboard.press('KeyS');
    await hold(page, 90); await page.screenshot({ path: `${OUT}/move-slide-1440.png` });
    const a = await pw(page);
    check('S while moving starts a slide', a.state === 'atk' && a.atk === 'slide', `${a.state}/${a.atk}`);
    await hold(page, 460);
    const b = await pw(page);
    check('the slide travels faster than running', b.x - x0 > 200, `moved ${Math.round(b.x - x0)} in about 0.55 s; a run covers about 140`);
    await page.keyboard.up('KeyD'); await hold(page, 200);
    check('the slide ends and control returns', (await pw(page)).state === 'idle');
    // cooldown: mashing does not chain slides
    await page.keyboard.press('KeyS'); await hold(page, 60); await page.keyboard.press('KeyS'); await hold(page, 600);
    check('the slide cooldown stops a second slide straight away', (await pw(page)).state === 'idle');

    await ctx.close();
    check('desktop slide: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  });

  await section('trip and dodge', async () => {
    const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=pit' });
    await realStart(page); await dbg(page, 'wave(1)');
    const res = await page.evaluate(async () => {
      const g = window.__dare.game, d = g.debug;
      const tap = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); };
      const up = (code) => window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      d.god?.(false);
      await new Promise((r) => setTimeout(r, 1800));   // past the banner, enemies walk in
      const s0 = d.snapshot();
      d.placePlayer(400); if (!d.besidePlayer()) return { none: true };
      tap('KeyD'); await new Promise((r) => setTimeout(r, 50)); tap('KeyS'); up('KeyS');
      await new Promise((r) => setTimeout(r, 420)); up('KeyD');
      const s1 = d.snapshot();
      return { score0: s0.score, score1: s1.score, rag: s1.ragdolls, hp: s1.player.hp };
    });
    check('a slide reaches an enemy and trips it', !res.none && res.score1 >= res.score0 + 50 && res.rag >= 1, JSON.stringify(res));
    check('trip test: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  });

  await section('giant', async () => {
    const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=margins' });
    await realStart(page); await dbg(page, 'wave(1)'); await hold(page, 900);
    await dbg(page, 'placePlayer(200)'); await dbg(page, 'orb(420)'); await hold(page, 200);
    await page.screenshot({ path: `${OUT}/move-orb-1440.png` });
    check('the orb sits on the floor until grabbed', !!(await pw(page)).orb);
    const hp0 = (await pw(page)).s;
    await page.keyboard.down('KeyD');
    const got = await waitFor(page, () => window.__dare.game.debug.power().giant, null, 3000);
    await page.keyboard.up('KeyD');
    check('walking into the orb goes GIANT', got && !(await pw(page)).orb);
    await hold(page, 700);
    const a = await pw(page);
    check('the player grows to about 1.6x', a.s > 1.5 && a.s < 1.75 && hp0 === 1, `s=${a.s.toFixed(3)}`);
    await page.screenshot({ path: `${OUT}/move-giant-margins-1440.png` });
    check('the timer is counting down', a.giantT > 0 && a.giantT < 10, `t=${a.giantT.toFixed(2)}`);
    // real jump, real landing: the stomp launches an enemy standing close by
    const st = await page.evaluate(async () => {
      const d = window.__dare.game.debug; const p = d.power();
      const near = d.snapshot().enemies.filter((e) => !e.dead && Math.abs(e.x - p.x) < 180).length;
      return { near };
    });
    await page.keyboard.press('KeyW'); await hold(page, 900);
    check('the jump lands without errors while giant', errors.length === 0 && (await pw(page)).giant, `near=${st.near}`);
    // it wears off, cleanly
    const off = await waitFor(page, () => !window.__dare.game.debug.power().giant, null, 11000);
    await hold(page, 700);
    const b = await pw(page);
    check('GIANT wears off after its time', off && b.giantT === 0);
    check('the player springs back to exactly normal size', Math.abs(b.s - 1) < 0.01, `s=${b.s.toFixed(3)}`);
    check('giant: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  });

  await section('stomp and dodge', async () => {
    const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=ring' });
    await realStart(page); await dbg(page, 'wave(1)'); await hold(page, 1900);
    // control: standing still, the same swing lands
    const swing = (slide) => page.evaluate(async (slide) => {
      const d = window.__dare.game.debug, x = 500;
      d.placePlayer(x); const hp0 = d.power().hp;
      if (!d.swingAtPlayer()) return null;
      if (slide) { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyS', bubbles: true })); }
      const t0 = performance.now(); let saw = false;
      await new Promise((r) => { const f = () => { d.placePlayer(x); saw = saw || d.power().atk === 'slide' && d.power().state === 'atk'; if (performance.now() - t0 < 500) requestAnimationFrame(f); else r(); }; f(); });
      return { lost: hp0 - d.power().hp, saw };
    }, slide);
    const hit = await swing(false);
    check('control: an enemy swing lands on a standing player', hit && hit.lost > 0, JSON.stringify(hit));
    await hold(page, 1300);
    const dodged = await swing(true);
    check('the same swing misses a sliding player', dodged && dodged.saw && dodged.lost === 0, JSON.stringify(dodged));
    await hold(page, 900);
    await dbg(page, 'placePlayer(400)'); await dbg(page, 'orb(400)'); await hold(page, 800);
    check('stomp test: the player is giant', (await pw(page)).giant);
    await page.keyboard.press('KeyW'); await hold(page, 240);
    const placed = await dbg(page, 'besidePlayer()');
    const rag0 = (await snap(page)).ragdolls;
    await hold(page, 520);
    const rag1 = (await snap(page)).ragdolls;
    await page.screenshot({ path: `${OUT}/move-stomp-1440.png` });
    check('landing a giant jump launches an enemy beside it', placed && rag1 > rag0, `ragdolls ${rag0} to ${rag1}`);
    check('stomp and dodge: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  });

  await section('natural orb', async () => {
    const { ctx, page, errors } = await boot(1440, 900, { query: '&stage=ring' });
    await realStart(page); await dbg(page, 'wave(1)'); await hold(page, 1500);
    check('no orb before it is earned', !(await pw(page)).orb);
    await dbg(page, 'orbDue()');
    const fell = await waitFor(page, () => !!window.__dare.game.debug.power().orb, null, 3000);
    check('an earned orb drops in on its own', fell);
    const o = (await pw(page)).orb; check('the orb lands inside the arena', o && o.x > 40 && o.x < 1300, `x=${o && Math.round(o.x)}`);
    // restart mid-power clears everything
    await dbg(page, 'orb(300)'); await dbg(page, 'placePlayer(300)'); await hold(page, 250);
    await page.keyboard.press('KeyP'); await hold(page, 150);
    await page.keyboard.press('KeyR'); await hold(page, 400);
    const r = await pw(page);
    check('restart resets size, timer and orb', Math.abs(r.s - 1) < 0.01 && r.giantT === 0 && !r.orb && !r.giant, JSON.stringify({ s: r.s, t: r.giantT }));
    check('natural orb: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  });

  await section('phone', async () => {
    const { ctx, page, errors } = await boot(390, 844, { touch: true, query: '&stage=ring' });
    await page.tap('#play'); await hold(page, 300); await dbg(page, 'wave(1)'); await dbg(page, 'placePlayer(150)'); await hold(page, 300);
    // a real flick down on the virtual stick
    const cdp = await ctx.newCDPSession(page);
    const z = await page.locator('[data-stick-zone]').boundingBox();
    const X = z.x + z.width / 2, Y = z.y + z.height / 2;
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await touch('touchStart', X, Y); await hold(page, 40); await touch('touchMove', X + 40, Y + 2); await hold(page, 120);
    await touch('touchMove', X + 20, Y + 54); await hold(page, 90);
    const a = await pw(page);
    await page.screenshot({ path: `${OUT}/move-slide-390.png` });
    check('flicking the stick down slides on a phone', a.state === 'atk' && a.atk === 'slide', `${a.state}/${a.atk}`);
    await touch('touchEnd'); await hold(page, 600);
    const here = Math.round((await pw(page)).x);
    await dbg(page, `orb(${here})`); await hold(page, 150);
    check('an orb under the player is grabbed on a phone', (await pw(page)).giant);
    await hold(page, 700); await page.screenshot({ path: `${OUT}/move-giant-390.png` });
    check('phone: zero console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  });
} finally { await browser.close(); server.close(); }
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} moves checks passed`);
process.exit(passed === results.length ? 0 : 1);
