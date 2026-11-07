// The arcade shell: everything that is not the game itself.
// canvas + resize, fixed-step engine, input, juice, audio, particles, and the
// title -> play -> game over -> instant restart flow, plus HUD, mute, share, pause.
//
// A game is a plain object (see game.js):
//   { slug, name, setup(shell), resize(view), reset(mode), update(dt), render(ctx, alpha) }
// and ends a run by calling shell.end({ score, heading, lines }).
import { Engine } from './engine.js';
import { Input } from './input.js';
import { Juice } from './juice.js';
import { Particles } from './particles.js';
import { Sfx } from './audio.js';
import { store } from './storage.js';

const $ = (id) => document.getElementById(id);
const NON_START = /^(Shift|Control|Alt|Meta|Tab|CapsLock|F\d+|Escape|Arrow(Up|Down|Left|Right)?$)/;

export function createShell({ canvas, game }) {
  const body = document.body;
  // Optional static backdrop layer (<canvas id="bg">): painted once per resize by the game, so the
  // main canvas can stay transparent and never re-blits a full-screen background every frame.
  const bgCanvas = $('bg');
  const ctx = canvas.getContext('2d', { alpha: !!bgCanvas });
  const debug = new URLSearchParams(location.search).has('debug');

  const juice = new Juice();
  const particles = new Particles(900);
  const sfx = new Sfx(store, game.slug);
  const input = new Input({ canvas, touchRoot: $('touch'), keys: game.keys });

  const el = {
    title: $('title'), over: $('over'), paused: $('paused'), toast: $('toast'), hud: $('hud'),
    score: $('hud-score'), best: $('hud-best'), mute: $('mute'), live: $('sr-live'),
    bestTitle: $('best-title'), overScore: $('over-score'), overHeading: $('over-heading'),
    overBest: $('over-best'), overLines: $('over-lines'), overTag: $('over-tag'), again: $('again'),
    howto: $('howto'), howPlay: $('how-play'), howBack: $('how-back'), howBtn: $('howbtn'),
    pauseBtn: $('pausebtn'), pauseHow: $('pause-how'),
  };

  const view = { w: 1, h: 1, dpr: 1, bgDpr: 1 };
  const shell = {
    canvas, bgCanvas, ctx, view, juice, particles, sfx, input, store, game, debug,
    state: 'title', score: 0, best: 0, mode: 'infinite',
    hud: { root: el.hud },
  };

  /* ---------- location / mode: stored per mode, deep-linkable ---------- */
  // Best score is kept per mode. The one pre-modes best belongs to the ring.
  const bestKey = (m = shell.mode) => `${game.slug}:best:${m}`;
  // A stored score is only trusted if it is a finite, non-negative number (corrupt storage must not print Infinity or -50).
const cleanScore = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
if (store.get(bestKey('ring'), null) === null) { const old = cleanScore(store.get(`${game.slug}:best`, 0)); if (old) store.set(bestKey('ring'), old); }
  const modes = game.modes || [];
  const validMode = (m) => modes.some((x) => x.id === m);
  const MODE_KEY = `${game.slug}:mode`;
  const startMode = () => {
    const q = new URLSearchParams(location.search).get('stage');
    if (q && validMode(q)) return q;                        // ?stage=ring|pit|margins|infinite
    const saved = store.get(MODE_KEY, null);
    return validMode(saved) ? saved : modes[0]?.id;         // a bad stored value falls back to the default
  };

  /* ---------- sizing: crisp at devicePixelRatio ---------- */
  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const bdpr = Math.min(dpr, 2);     // the backdrop layer: the art has no detail past 2x, and 3x costs 2.25x the pixels
    if (bgCanvas) { bgCanvas.width = Math.round(w * bdpr); bgCanvas.height = Math.round(h * bdpr); }
    view.w = w; view.h = h; view.dpr = dpr; view.bgDpr = bdpr;
    game.resize?.(view, shell);
  }
  new ResizeObserver(resize).observe(canvas);

  /* ---------- HUD / toast ---------- */
  let lastScoreShown = -1;
  shell.setScore = (n) => {
    shell.score = n;
    if (n !== lastScoreShown) { lastScoreShown = n; el.score.textContent = String(n); }
  };
  const showBest = () => {
    el.best.textContent = String(shell.best);
    el.bestTitle.textContent = String(shell.best);
  };
  const loadBest = () => { shell.best = cleanScore(store.get(bestKey(), 0)); showBest(); };
  loadBest();

  let toastTimer = 0;
  shell.toast = (msg) => {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1600);
  };

  /* ---------- mute / share ---------- */
  const syncMute = () => {
    el.mute.setAttribute('aria-pressed', String(sfx.muted));
    el.mute.setAttribute('aria-label', sfx.muted ? 'Unmute sound' : 'Mute sound');
    el.mute.dataset.muted = sfx.muted ? '1' : '0';
  };
  const toggleMute = () => { sfx.setMuted(!sfx.muted); syncMute(); sfx.play('ui'); };
  el.mute.addEventListener('click', () => { sfx.unlock(); toggleMute(); });
  syncMute();

  async function share() {
    const url = location.origin + location.pathname + (shell.mode ? `?stage=${shell.mode}` : '');
    let ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch { /* fall back below */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = url; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select();
        ok = document.execCommand('copy'); ta.remove();
      } catch { ok = false; }
    }
    shell.toast(ok ? 'LINK COPIED' : url);
    sfx.play('ui');
  }
  document.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', share));

  /* ---------- controls list + key legend ---------- */
  // One controls list (the title's), copied onto the pause and how-to screens.
  const keysSrc = el.title.querySelector('.keys');
  document.querySelectorAll('[data-keys-slot]').forEach((slot) => slot.replaceWith(keysSrc.cloneNode(true)));
  // The in-run key legend; H hides or shows it, and the choice sticks.
  shell.legendOn = store.get(`${game.slug}:legend`, true) !== false;
  const syncLegend = () => { body.dataset.legend = shell.legendOn ? '1' : '0'; };
  syncLegend();

  /* ---------- location picker (title screen) ---------- */
  const cardsEl = $('cards'), pickName = $('pick-name'), pickBlurb = $('pick-blurb');
  const cards = modes.map((m) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'card'; b.dataset.mode = m.id; b.setAttribute('aria-pressed', 'false');
    const th = document.createElement('span'); th.className = 'thumb';
    const img = new Image(); img.alt = ''; img.width = 256; img.height = 144; img.decoding = 'async'; img.draggable = false;
    img.addEventListener('error', () => { img.remove(); b.classList.add('nothumb'); });   // a thumb that fails to load: a plain styled card, never a broken-image icon
    img.src = m.thumb;
    th.append(img);
    const name = document.createElement('b'); name.textContent = m.name;
    const tag = document.createElement('small'); tag.textContent = m.tag;
    b.append(th, name, tag);
    cardsEl.append(b);
    return b;
  });
  const syncPicker = () => {
    for (const c of cards) c.setAttribute('aria-pressed', String(c.dataset.mode === shell.mode));
    const m = modes.find((x) => x.id === shell.mode) || modes[0];
    pickName.textContent = m.name; pickBlurb.textContent = m.blurb;
  };
  // Choosing a location live-previews it behind the title. It never starts a run; PLAY (or any key) does.
  shell.setMode = (id, { persist = true, instant = false, prefer = false } = {}) => {
    if (!validMode(id)) id = modes[0].id;
    shell.mode = id;
    if (persist) store.set(MODE_KEY, id);
    syncPicker(); loadBest();
    game.setMode?.(id, { instant, prefer });
  };
  const stepMode = (d) => {
    const i = Math.max(0, modes.findIndex((m) => m.id === shell.mode));
    shell.setMode(modes[(i + d + modes.length) % modes.length].id);
    cards.find((c) => c.dataset.mode === shell.mode)?.focus({ preventScroll: true });   // focus travels with the selection
    sfx.play('ui');
  };
  cards.forEach((c) => c.addEventListener('click', (e) => {
    if (shell.state !== 'title') return;
    shell.setMode(c.dataset.mode); sfx.play('ui');
    if (e.detail !== 0) c.blur();        // a mouse/touch pick: the next key press starts the run. A keyboard pick keeps focus.
  }));

  /* ---------- flow: title -> play -> over -> instant restart ---------- */
  let lastStart = 0, overPending = null, overReadyAt = 0;
  let howFrom = null;   // 'title' | 'paused' while the how-to screen is open
  const setState = (s) => { shell.state = s; body.dataset.state = s; };

  shell.start = () => {
    const now = performance.now();
    if (now - lastStart < 220) return;
    lastStart = now;
    sfx.unlock();
    document.activeElement?.blur?.();
    el.title.hidden = el.over.hidden = el.paused.hidden = el.howto.hidden = true;
    howFrom = null;
    overPending = null;
    juice.reset(); particles.clear();
    if (engine.paused) engine.resume();
    setState('play');
    shell.setScore(0);
    game.reset('play');
    sfx.play('start');
  };

  // Back to the title and its picker from a game-over or pause screen: the run is dropped, the attract fight runs again,
  // and the selected card has focus so the picker is reachable by keyboard.
  shell.toTitle = () => {
    overPending = null; howFrom = null;
    el.over.hidden = el.paused.hidden = el.howto.hidden = true;
    juice.reset(); particles.clear();
    if (engine.paused) engine.resume();
    setState('title');
    el.title.hidden = false;
    shell.setScore(0);
    shell.setMode(shell.mode, { persist: false, instant: true, prefer: true });   // a fresh first location for the next run, painted at once under the panel
    game.reset('attract');
    el.title.scrollTop = 0;
    (cards.find((c) => c.dataset.mode === shell.mode) || el.again).focus({ preventScroll: true });
    sfx.play('ui');
  };
  document.querySelectorAll('[data-change]').forEach((b) => b.addEventListener('click', () => shell.toTitle()));

  shell.end = ({ score, heading = 'GAME OVER', lines = [], delay = 900 }) => {
    if (shell.state !== 'play') return;
    setState('over');
    shell.setScore(score);
    const isBest = score > shell.best;
    if (isBest) { shell.best = score; store.set(bestKey(), score); showBest(); }
    overPending = { score, heading, lines, isBest, wait: delay };
  };

  function showOver(o) {
    el.overHeading.textContent = o.heading;
    el.overBest.textContent = String(shell.best);
    el.overTag.hidden = !o.isBest;
    el.overLines.replaceChildren(...o.lines.map(([k, v]) => {
      const row = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = String(v);
      row.append(dt, dd);
      return row;
    }));
    el.over.hidden = false;
    el.live.textContent = `${o.heading}. Score ${o.score}. Best ${shell.best}.`;
    // count-up (instant when the user prefers reduced motion)
    if (juice.reduced || o.score < 20) el.overScore.textContent = String(o.score);
    else {
      const t0 = performance.now();
      const tick = (t) => {
        const k = Math.min(1, (t - t0) / 700);
        el.overScore.textContent = String(Math.round(o.score * (1 - Math.pow(1 - k, 3))));
        if (k < 1 && shell.state === 'over') requestAnimationFrame(tick);
        else el.overScore.textContent = String(o.score);
      };
      requestAnimationFrame(tick);
    }
    overReadyAt = performance.now() + 350;
    sfx.play('over');
    el.again.focus({ preventScroll: true });
  }

  /* ---------- pause on focus loss ---------- */
  shell.pause = () => engine.pause();
  const onPause = () => { if (shell.state === 'play') el.paused.hidden = false; };
  const onResume = () => { el.paused.hidden = true; };
  addEventListener('focus', () => { if (engine.paused && shell.state !== 'play') engine.resume(); });
  el.paused.addEventListener('click', (e) => {
    if (e.target.closest('[data-change]')) return;
    if (e.target.closest('#restart')) shell.start();
    else if (!e.target.closest('#pause-how')) engine.resume();
  });
  el.pauseBtn.addEventListener('click', () => { if (shell.state === 'play' && !engine.paused) engine.pause(); });

  /* ---------- how to play ---------- */
  const openHow = (from) => {
    howFrom = from;
    el.howPlay.firstChild.textContent = from === 'paused' ? 'RESUME ' : 'PLAY ';
    el.paused.hidden = true;
    el.howto.hidden = false;
    el.howto.scrollTop = 0;
    el.howPlay.focus({ preventScroll: true });
    sfx.play('ui');
  };
  const closeHow = () => {
    if (!howFrom) return;
    el.howto.hidden = true;
    if (howFrom === 'paused' && engine.paused) el.paused.hidden = false;
    howFrom = null;
  };
  const howGo = () => {
    const from = howFrom;
    closeHow();
    if (from === 'paused') engine.resume(); else shell.start();
  };
  el.howBtn.addEventListener('click', () => { sfx.unlock(); openHow('title'); });
  el.pauseHow.addEventListener('click', () => openHow('paused'));
  el.howBack.addEventListener('click', closeHow);
  el.howPlay.addEventListener('click', howGo);

  /* ---------- keys / taps for menu flow ---------- */
  input.onGesture = () => sfx.unlock();
  input.onTouch = () => document.documentElement.setAttribute('data-touch', '1');
  if (input.touch) input.onTouch();

  // Enter/Space on a focused button or link belongs to that control (COPY LINK, HOW TO PLAY, CHANGE LOCATION, mute, ...), not to "any key starts".
  // Space is also the jump key, so input.js has already cancelled its default: click the control ourselves, once.
  const onControl = (c, ...roots) => {
    if (c !== 'Enter' && c !== 'Space') return false;
    const a = document.activeElement;
    return !!a?.closest?.('button, a[href], input, select, textarea, [role="button"]') && roots.some((r) => r.contains(a));
  };
  let swallowUp = false;
  const activate = (e) => { e.preventDefault(); if (e.repeat) return; swallowUp = true; document.activeElement.click(); };
  addEventListener('keyup', (e) => { if (swallowUp && (e.code === 'Space' || e.code === 'Enter')) { swallowUp = false; e.preventDefault(); } }, true);

  input.onKey = (e) => {
    const c = e.code;
    if (c === 'KeyM' && !e.repeat) { toggleMute(); return; }
    if (howFrom) {
      if (e.repeat) return;
      if (c === 'Escape' || c === 'KeyH' || c === 'Backspace') { e.preventDefault(); closeHow(); }
      else if (c === 'Enter' || c === 'Space') { e.preventDefault(); howGo(); }
      return;
    }
    if (engine.paused) {
      if (shell.state === 'play' && !e.repeat) {
        if (onControl(c, el.paused)) return activate(e);
        if (c === 'KeyR') { e.preventDefault(); shell.start(); }
        else if (c === 'KeyH') { e.preventDefault(); openHow('paused'); }
        else if (!NON_START.test(c)) { e.preventDefault(); engine.resume(); }
      }
      return;
    }
    if (shell.state === 'title') {
      const onCard = document.activeElement?.classList?.contains('card');
      if (!onCard && onControl(c, el.title, el.mute.parentElement)) return activate(e);       // the focused control gets Enter/Space, not "any key starts"
      if (c === 'ArrowLeft' || c === 'ArrowRight') { e.preventDefault(); if (!e.repeat) stepMode(c === 'ArrowLeft' ? -1 : 1); return; }
      if (onCard && (c === 'Enter' || c === 'Space')) { e.preventDefault(); if (!e.repeat) document.activeElement.click(); return; }
      if (c === 'KeyH' && !e.repeat) { e.preventDefault(); openHow('title'); }
      else if (!NON_START.test(c) && !e.repeat) { e.preventDefault(); shell.start(); }
    } else if (shell.state === 'over') {
      const ready = performance.now() >= overReadyAt && !overPending;
      if (onControl(c, el.over, el.mute.parentElement) && document.activeElement !== el.again) return activate(e);
      if (c === 'KeyR' || (ready && (c === 'Space' || c === 'Enter'))) { e.preventDefault(); shell.start(); }
    } else if (shell.state === 'play') {
      if (c === 'KeyR' && !e.repeat) shell.start();
      else if ((c === 'Escape' || c === 'KeyP') && !e.repeat) engine.pause();
      else if (c === 'KeyH' && !e.repeat) {
        shell.legendOn = !shell.legendOn;
        store.set(`${game.slug}:legend`, shell.legendOn);
        syncLegend();
      }
    }
  };
  const tapFlow = (e) => {
    if (e.target.closest('button, a, .picker')) return;
    if (shell.state === 'over' && (performance.now() < overReadyAt || overPending)) return;
    shell.start();
  };
  // a mouse/touch click leaves no focus behind on a button: the next key press is "any key" again, not a second press of that button
  document.addEventListener('click', (e) => { const b = e.detail !== 0 && e.target.closest?.('button'); if (b && document.activeElement === b) b.blur(); });
  el.title.addEventListener('click', tapFlow);
  el.over.addEventListener('click', tapFlow);
  $('play').addEventListener('click', () => shell.start());
  el.again.addEventListener('click', () => { if (performance.now() >= overReadyAt) shell.start(); });

  /* ---------- engine ---------- */
  let lastDpr = window.devicePixelRatio;
  const engine = new Engine({
    hz: 60,
    onPause, onResume,
    beforeFrame(dt) {
      if (window.devicePixelRatio !== lastDpr) { lastDpr = window.devicePixelRatio; resize(); }
      if (overPending) {
        overPending.wait -= dt * 1000;
        if (overPending.wait <= 0) { const o = overPending; overPending = null; showOver(o); }
      }
      return juice.update(dt);
    },
    update(dt) {
      game.update(dt, shell);
      particles.update(dt);
      input.endStep();
    },
    render(alpha, dt) {
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      game.render(ctx, alpha, shell, engine.paused ? 0 : dt);
      juice.drawFlash(ctx, view.w, view.h);
      if (shell.debug) drawDebug();
    },
  });
  shell.engine = engine;

  function drawDebug() {
    const s = engine.stats;
    ctx.save();
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(8, view.h - 58, 250, 50);
    ctx.fillStyle = '#00ff66';
    ctx.fillText(`fps ${s.fps.toFixed(1)}  frame ${s.frameMs.toFixed(1)}ms  work ${s.workMs.toFixed(2)}ms`, 14, view.h - 40);
    ctx.fillText(`steps ${engine.stepsLast}  dropped ${s.dropped}  particles ${particles.count}`, 14, view.h - 26);
    ctx.fillText(`dpr ${view.dpr}  ${view.w}x${view.h}  ${shell.state}`, 14, view.h - 12);
    ctx.restore();
  }

  /* ---------- boot ---------- */
  game.setup?.(shell);
  shell.setMode(startMode(), { persist: false, instant: true });
  resize();
  setState('title');
  game.reset('attract');
  engine.start();
  if (debug) window.__dare = { shell, game, engine };
  return shell;
}
