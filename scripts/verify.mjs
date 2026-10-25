#!/usr/bin/env node
// Headless-browser verification for RAGDOLL RIOT.
//
//   node scripts/verify.mjs [--out .shots] [--idle-secs 150]
//
// Serves the repo with a tiny built-in static server, then checks:
//   - the game loads with zero console errors / failed requests
//   - touch controls are hidden on desktop and visible only on touch devices
//   - title -> play -> game over -> instant restart (R) works
//   - frame time with a heavy scene (uses game.debug.stress(n) if the game exposes it)
//   - screenshots: title, mid-fight, game over at 1440x900 and 390x844
// Exit code 1 on any failure. Needs Playwright (not a dependency of the site): it is
// resolved from the normal module path, then from ~/.claude/scripts/node_modules.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = path.resolve(ROOT, flag('--out', '.shots'));
const IDLE_SECS = Number(flag('--idle-secs', 150));
fs.mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* fall through */ }
  const p = path.join(os.homedir(), '.claude/scripts/node_modules/playwright/index.mjs');
  return import(pathToFileURL(p).href);
}
const { chromium } = await loadPlaywright();

// ---- static server
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

const browser = await chromium.launch({ headless: true });
async function newPage({ w, h, touch = false, dpr = 1 }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => errors.push('requestfailed ' + r.url()));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()} ${r.url()}`); });
  return { ctx, page, errors };
}

try {
  // ============ game ============
  const url = `${BASE}/?debug`;
  const state = (page) => page.evaluate(() => window.__dare.shell.state);
  const boot = async (opts) => {
    const c = await newPage(opts);
    await c.page.goto(url, { waitUntil: 'load' });
    await c.page.waitForFunction(() => window.__dare?.shell, null, { timeout: 8000 });
    await c.page.waitForTimeout(1500);
    return c;
  };
  const start = async (page, touch) => { if (touch) await page.tap('#play'); else await page.keyboard.press('Enter'); await page.waitForTimeout(500); };

  for (const [w, h, tag, touch] of [[1440, 900, '1440', false], [390, 844, '390', true]]) {
    // ---- 1. title, play, touch visibility, heavy scene screenshot
    {
      const { ctx, page, errors } = await boot({ w, h, touch, dpr: touch ? 2 : 1 });
      const touchDisplay = () => page.evaluate(() => getComputedStyle(document.getElementById('touch')).display);
      check(`game ${tag}: touch controls hidden on title`, (await touchDisplay()) === 'none');
      await page.screenshot({ path: path.join(OUT, `title-${tag}.png`) });
      await start(page, touch);
      check(`game ${tag}: PLAY starts a run`, (await state(page)) === 'play');
      const td = await touchDisplay();
      check(`game ${tag}: touch controls ${touch ? 'visible' : 'hidden'} during play`, touch ? td !== 'none' : td === 'none');
      if (await page.evaluate(() => !!window.__dare.game.debug?.stress)) await page.evaluate(() => window.__dare.game.debug.stress(10));
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(OUT, `fight-${tag}.png`) });
      check(`game ${tag}: zero console errors (title + fight)`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ---- 2. frame pacing with a heavy scene at the real retina pixel ratio
    if (!touch) {
      const { ctx, page, errors } = await boot({ w, h, dpr: 2 });
      await start(page, false);
      await page.evaluate(() => window.__dare.game.debug?.stress?.(12));
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => new Promise((resolve) => {
        const d = []; let last = performance.now(); let n = 0; let maxRag = 0;
        const f = (t) => {
          d.push(t - last); last = t; n++;
          maxRag = Math.max(maxRag, window.__dare.game.debug.snapshot?.().ragdolls ?? 0);
          if (n < 480) requestAnimationFrame(f); else {
            const body = d.slice(5).sort((a, b) => a - b);
            resolve({ avg: body.reduce((a, b) => a + b, 0) / body.length, p95: body[Math.floor(body.length * 0.95)], max: body[body.length - 1], maxRag, slow: body.filter((x) => x > 17.5).length, frames: body.length, work: window.__dare.engine.stats.workMs });
          }
        };
        requestAnimationFrame(f);
      }));
      console.log(`      ${m.frames} frames @ ${w}x${h} dpr2: avg=${m.avg.toFixed(2)}ms p95=${m.p95.toFixed(2)}ms max=${m.max.toFixed(1)}ms ragdolls=${m.maxRag} frames>17.5ms=${m.slow} scriptWork=${m.work.toFixed(2)}ms`);
      check('game 1440@2x: holds 60fps (avg <= 16.7ms, p95 <= 17.5ms)', m.avg <= 16.7 && m.p95 <= 17.5);
      check('game 1440@2x: 8+ ragdolls on screen during the measurement', m.maxRag >= 8, `ragdolls=${m.maxRag}`);
      check('game 1440@2x: zero console errors', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // ---- 3. idle until game over, then instant restart
    {
      const { ctx, page, errors } = await boot({ w, h, touch, dpr: touch ? 2 : 1 });
      await start(page, touch);
      const t0 = Date.now();
      while (Date.now() - t0 < IDLE_SECS * 1000 && (await state(page)) === 'play') await page.waitForTimeout(500);
      check(`game ${tag}: idle player reaches game over`, (await state(page)) === 'over', `${((Date.now() - t0) / 1000).toFixed(1)}s`);
      await page.waitForTimeout(2200);
      await page.screenshot({ path: path.join(OUT, `over-${tag}.png`) });
      if (touch) await page.tap('#again'); else await page.keyboard.press('KeyR');
      await page.waitForTimeout(400);
      check(`game ${tag}: instant restart returns to play`, (await state(page)) === 'play');
      check(`game ${tag}: zero console errors (game over + restart)`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
