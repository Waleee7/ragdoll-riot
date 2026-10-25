// localStorage wrapper. Private mode, blocked cookies and quota errors all throw,
// so every access is wrapped and degrades to an in-memory value.
const NS = 'dare-arcade:';
const mem = new Map();

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(NS + key);
      if (raw !== null) return JSON.parse(raw);
    } catch { /* fall through to memory */ }
    return mem.has(key) ? mem.get(key) : fallback;
  },
  set(key, value) {
    mem.set(key, value);
    try {
      localStorage.setItem(NS + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};
