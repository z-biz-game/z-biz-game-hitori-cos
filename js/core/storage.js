// Save file. One localStorage key, plain JSON, versioned shape.
//
// The guard here is not decoration: `globalThis.localStorage` can *throw* rather than
// return null — private mode in Safari, blocked third-party storage, and any file:// page.
// So every access, including the property read itself, is inside a try, and a throwing
// storage degrades to a memory-only session for the rest of the run. `node --test` has no
// localStorage at all, which is how the pure core stays importable.
//
// Nothing in this game is *required* from the save: the puzzle pool is in js/data/lots.js,
// so a wiped record never hides a level from anyone who has the link.

const KEY = 'hitori.save.v1';

function blank() {
  return {
    records: {},
    daily: {},
    unlocked: 1,
    stats: { solves: 0, perfect: 0, taps: 0, violations: 0 },
  };
}

let cache = null;
let lastMode = null;

function storage() {
  try {
    const ls = globalThis.localStorage;
    if (!ls || typeof ls.getItem !== 'function' || typeof ls.setItem !== 'function') return null;
    return ls;
  } catch (err) {
    return null; // a throwing getter: memory-only, and never retried per access
  }
}

export function storageMode() {
  if (lastMode) return lastMode;
  const ls = storage();
  if (!ls) {
    lastMode = 'memory';
    return lastMode;
  }
  try {
    ls.setItem(`${KEY}.probe`, '1');
    ls.removeItem(`${KEY}.probe`);
    lastMode = 'localStorage';
  } catch (err) {
    lastMode = 'memory'; // quota / SecurityError on write, which getItem would not have shown
  }
  return lastMode;
}

function load() {
  if (cache) return cache;
  const ls = storage();
  let raw = null;
  try {
    raw = ls && ls.getItem(KEY);
  } catch (err) {
    raw = null;
  }
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        const base = blank();
        cache = {
          records: p.records && typeof p.records === 'object' ? p.records : base.records,
          daily: p.daily && typeof p.daily === 'object' ? p.daily : base.daily,
          unlocked: Number(p.unlocked) > 0 ? Number(p.unlocked) : base.unlocked,
          stats: { ...base.stats, ...(p.stats || {}) },
        };
        return cache;
      }
    } catch (err) {
      /* a corrupt save is not worth keeping */
    }
  }
  cache = blank();
  return cache;
}

function persist() {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.setItem(KEY, JSON.stringify(cache));
    return true;
  } catch (err) {
    return false;
  }
}

export const store = {
  get records() { return load().records; },
  get stats() { return load().stats; },
  get daily() { return load().daily; },
  get unlocked() { return load().unlocked; },
  get mode() { return storageMode(); },
  key: KEY,

  record(id) {
    return load().records[id] || null;
  },

  // Monotone upwards: re-solving an early lot must never hide a later one.
  unlock(n) {
    const s = load();
    if (n > s.unlocked) s.unlocked = n;
    persist();
    return s.unlocked;
  },

  markDaily(dateKey, id) {
    const s = load();
    s.daily[dateKey] = { id, at: Date.now() };
    persist();
    return s.daily[dateKey];
  },

  dailyDone(dateKey) {
    return load().daily[dateKey] || null;
  },

  // `taps` is compared against game.minTaps(lot) by the shell; the record only keeps the
  // fewest taps ever spent, so it can go down and never up.
  solve(id, { taps, floor, violations }) {
    const s = load();
    const prev = s.records[id];
    const cur = {
      solved: true,
      best: !prev || !prev.best || taps < prev.best ? taps : prev.best,
      plays: (prev && prev.plays ? prev.plays : 0) + 1,
      perfect: (taps <= floor) || !!(prev && prev.perfect),
    };
    s.records[id] = cur;
    s.stats.solves += 1;
    s.stats.taps += taps;
    s.stats.violations += violations || 0;
    if (taps <= floor) s.stats.perfect += 1;
    persist();
    return cur;
  },

  reset() {
    cache = blank();
    const ls = storage();
    if (!ls) return false;
    try {
      ls.removeItem(KEY);
      return true;
    } catch (err) {
      return false;
    }
  },
};

// Tests call this to get a clean slate between cases: the memory cache is module state,
// and node has no localStorage, so a throwing-storage case cannot be reproduced by
// monkey-patching a global and expecting the old reads to be forgotten.
export function forgetCache() {
  cache = null;
  lastMode = null;
}
