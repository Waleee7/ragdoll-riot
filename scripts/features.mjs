// Mechanics checks for RAGDOLL RIOT: how to play, pause flow, key legend, tips, the RIOT super,
// shield block / guard break, rope zaps and the boss's shockwaves, on desktop and on a phone.
//
//   node scripts/features.mjs [--out .shots]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.HOME + '/.claude/scripts/node_modules/playwright')); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const oi = process.argv.indexOf('--out'), OUT = path.resolve(ROOT, oi > 0 ? process.argv[oi + 1] : '.shots');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((q, r) => { let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL0 = `http://127.0.0.1:${server.address().port}/?debug`;
const browser = await chromium.launch({ headless: true });
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); };
const snap = (page) => page.evaluate(() => window.__dare.game.debug.snapshot());
const vis = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const cs = getComputedStyle(e); return !e.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; }, sel);
async function boot(w, h, touch) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: touch ? 2 : 1, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL0); await page.waitForFunction(() => window.__dare?.shell); await page.waitForTimeout(1200);
  return { ctx, page, errors };
}
try {
  // ================= desktop =================
  { const { ctx, page, errors } = await boot(1440, 900, false);
    await page.screenshot({ path: `${OUT}/d-title.png` });
    await page.keyboard.press('KeyH'); await page.waitForTimeout(400);
    check('H on title opens How to Play', await vis(page, '#howto'));
    check('still on title (H did not start a run)', (await snap(page)).state === 'title');
    await page.screenshot({ path: `${OUT}/d-howto.png` });
    await page.keyboard.press('Escape'); await page.waitForTimeout(250);
    check('Esc closes How to Play', !(await vis(page, '#howto')));
    await page.click('#howbtn'); await page.waitForTimeout(300);
    check('HOW TO PLAY button opens it', await vis(page, '#howto'));
    await page.keyboard.press('Enter'); await page.waitForTimeout(500);
    check('Enter on How to Play starts a run', (await snap(page)).state === 'play');
    check('key legend visible during play (desktop)', await vis(page, '#legend'));
    check('pause button visible during play', await vis(page, '#pausebtn'));
    await page.waitForTimeout(1600);
    check('wave-1 combo tip shows', await page.evaluate(() => document.getElementById('tip').classList.contains('show')), await page.evaluate(() => document.getElementById('tip').textContent));
    await page.screenshot({ path: `${OUT}/d-play-tip.png` });
    await page.keyboard.press('KeyH'); await page.waitForTimeout(150);
    check('H mid-run hides the legend', !(await vis(page, '#legend')));
    await page.keyboard.press('KeyH'); await page.waitForTimeout(150);
    check('H again brings it back', await vis(page, '#legend'));
    // super
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__dare.game.debug.riot(100)); await page.waitForTimeout(120);
    check('full meter lights the HUD', await page.evaluate(() => document.getElementById('rr-riot').classList.contains('full')));
    await page.screenshot({ path: `${OUT}/d-riot-full.png` });
    const before = await snap(page);
    await page.keyboard.press('KeyL'); await page.waitForTimeout(260);
    await page.screenshot({ path: `${OUT}/d-super.png` });
    await page.waitForTimeout(500);
    const after = await snap(page);
    check('L fires the super (meter spent, super counted)', after.riot === 0 && after.supers === 1, `riot ${before.riot}->${after.riot}, supers ${after.supers}`);
    check('super ragdolls the ring', after.ragdolls >= Math.min(1, before.enemies.filter((e) => !e.dead).length), `ragdolls=${after.ragdolls}`);
    // pause flow
    await page.keyboard.press('KeyP'); await page.waitForTimeout(250);
    check('P pauses and shows controls', await vis(page, '#paused') && await page.evaluate(() => !!document.querySelector('#paused .keys')));
    await page.screenshot({ path: `${OUT}/d-paused.png` });
    await page.keyboard.press('KeyH'); await page.waitForTimeout(250);
    check('H on pause opens How to Play', await vis(page, '#howto') && !(await vis(page, '#paused')));
    check('its button says RESUME', (await page.textContent('#how-play')).startsWith('RESUME'));
    await page.keyboard.press('Escape'); await page.waitForTimeout(250);
    check('Esc returns to the pause screen', await vis(page, '#paused'));
    await page.click('#resume'); await page.waitForTimeout(250);
    check('RESUME button resumes', !(await vis(page, '#paused')) && !(await page.evaluate(() => window.__dare.engine.paused)));
    // live ropes
    await page.evaluate(() => window.__dare.game.debug.wave(2)); await page.waitForTimeout(3200);
    const z0 = (await snap(page)).zaps;
    let flung = false; for (let i = 0; i < 6 && !flung; i++) { flung = await page.evaluate(() => window.__dare.game.debug.fling()); if (!flung) await page.waitForTimeout(500); }
    await page.waitForTimeout(140); await page.screenshot({ path: `${OUT}/d-zap.png` }); await page.waitForTimeout(900);
    const z1 = (await snap(page)).zaps;
    check('a body thrown into the ropes gets zapped (scored)', flung && z1 > z0, `zaps ${z0}->${z1}`);
    // shields
    await page.evaluate(() => window.__dare.game.debug.wave(4)); await page.waitForTimeout(400);
    await page.evaluate(() => window.__dare.game.debug.spawn('shield'));
    let shieldNear = false;
    for (let i = 0; i < 90 && !shieldNear; i++) {
      await page.waitForTimeout(150);
      const s = await snap(page);
      const sh = s.enemies.find((e) => e.kind === 'shield' && !e.dead && e.state !== 'rag');
      if (sh && Math.abs(sh.x - s.player.x) < 90 && sh.guard) shieldNear = true;
    }
    check('a shield guy closes in with guard up', shieldNear);
    await page.screenshot({ path: `${OUT}/d-shield.png` });
    const sBefore = (await snap(page)).enemies.find((e) => e.kind === 'shield');
    await page.keyboard.press('KeyJ'); await page.waitForTimeout(450);
    const sAfter = (await snap(page)).enemies.find((e) => e.kind === 'shield');
    check('a punch from the front is blocked (no damage, guard holds)', sAfter && sAfter.guard && sAfter.hp === sBefore.hp, `hp ${sBefore?.hp}->${sAfter?.hp} guard=${sAfter?.guard}`);
    // the kick can whiff if the shield guy is mid-bash or the player got staggered: retry a few times
    let sKick = null;
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('KeyK'); await page.waitForTimeout(550);
      sKick = (await snap(page)).enemies.find((e) => e.kind === 'shield');
      if (!sKick || !sKick.guard) break;
    }
    check('a kick breaks the guard', sKick && !sKick.guard, `guard=${sKick?.guard} hp=${sKick?.hp}`);
    // boss
    await page.evaluate(() => window.__dare.game.debug.wave(5)); await page.waitForTimeout(600);
    let bossSeen = false, stomped = false;
    for (let i = 0; i < 60 && !stomped; i++) {
      await page.waitForTimeout(200);
      const s = await snap(page);
      if (s.boss) bossSeen = true;
      if (s.shockwaves > 0) { stomped = true; await page.screenshot({ path: `${OUT}/d-boss-stomp.png` }); }
      if (s.state !== 'play') break;
    }
    check('boss wave spawns THE BOUNCER with a health bar', bossSeen && await vis(page, '#rr-boss'));
    check('the boss pounds the floor (shockwaves)', stomped);
    if (!stomped) await page.screenshot({ path: `${OUT}/d-boss.png` });
    check('desktop: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close(); }

  // ================= phone (touch) =================
  { const { ctx, page, errors } = await boot(390, 844, true);
    await page.screenshot({ path: `${OUT}/m-title.png` });
    await page.tap('#howbtn'); await page.waitForTimeout(400);
    check('phone: How to Play opens from the button', await vis(page, '#howto'));
    await page.screenshot({ path: `${OUT}/m-howto.png` });
    await page.evaluate(() => { document.getElementById('howto').scrollTop = 99999; }); await page.waitForTimeout(150);
    await page.screenshot({ path: `${OUT}/m-howto-end.png` });
    await page.tap('#how-play'); await page.waitForTimeout(600);
    check('phone: PLAY from How to Play starts', (await snap(page)).state === 'play');
    check('phone: legend hidden on touch', !(await vis(page, '#legend')));
    check('phone: SUPER button visible', await vis(page, '#touch [data-action="super"]'));
    check('phone: pause button visible', await vis(page, '#pausebtn'));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__dare.game.debug.riot(100)); await page.waitForTimeout(150);
    await page.screenshot({ path: `${OUT}/m-play.png` });
    await page.tap('#touch [data-action="super"]'); await page.waitForTimeout(700);
    check('phone: SUPER button fires the super', (await snap(page)).supers === 1);
    await page.tap('#pausebtn'); await page.waitForTimeout(300);
    check('phone: pause button pauses', await vis(page, '#paused'));
    await page.screenshot({ path: `${OUT}/m-paused.png` });
    await page.evaluate(() => window.__dare.game.debug.wave(5));
    await page.tap('#resume'); await page.waitForTimeout(4500);
    await page.screenshot({ path: `${OUT}/m-boss.png` });
    check('phone: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close(); }
} finally { await browser.close(); server.close(); }
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} mechanics checks passed`);
process.exit(passed === results.length ? 0 : 1);
