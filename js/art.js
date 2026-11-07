// Backdrop image cache: loads and DECODES an image off the main path, keeps at most the current and the
// next one, and never throws. A failed or slow image just means the procedural background stays up.
import { VARIANTS } from './stages.js';

const cache = new Map();   // id -> { st: 'loading' | 'ok' | 'fail', img, p }
let wanted = new Set();

export function load(id) {
  const v = VARIANTS[id];
  if (!v) return Promise.resolve(null);
  wanted.add(id);
  let e = cache.get(id);
  if (e && e.st === 'fail' && performance.now() - e.failedAt > 8000) { cache.delete(id); e = null; }   // flaky network: retry, but never in a tight loop
  if (e) return e.p;
  const img = new Image();
  img.decoding = 'async';
  e = { st: 'loading', img: null, p: null };
  e.p = new Promise((resolve) => {
    img.onerror = () => { done('fail'); };
    img.src = v.src;
    (img.decode ? img.decode() : new Promise((r, j) => { img.onload = r; img.onerror = j; }))
      .then(() => done('ok'), () => done('fail'));
    function done(st) {
      if (e.st !== 'loading') return;
      e.st = st;
      if (st === 'ok') e.img = img;
      // dropped while loading: forget it (a failed one is forgotten too, so a later request can retry)
      if (!wanted.has(id) && cache.get(id) === e) cache.delete(id);
      else if (st === 'fail') e.failedAt = performance.now();
      resolve(st === 'ok' ? img : null);
    }
  });
  cache.set(id, e);
  return e.p;
}

export const peek = (id) => { const e = cache.get(id); return e && e.st === 'ok' ? e.img : null; };
export const status = (id) => cache.get(id)?.st || 'none';
// ready = resolved one way or the other (a failure means "use the fallback", not "wait forever")
export const ready = (id) => { const s = status(id); return s === 'ok' || s === 'fail'; };
export const keys = () => [...cache.keys()];

// Keep only these (current + next). Anything else is released for garbage collection.
export function keep(ids) {
  wanted = new Set(ids);
  for (const id of [...cache.keys()]) if (!wanted.has(id)) { const e = cache.get(id); if (e.st !== 'loading') cache.delete(id); }
}
