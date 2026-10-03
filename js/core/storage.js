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
// 存档格式版本号。写档带上、读档校验：将来改形状时旧档宁可整档丢弃，也不能被误读。
export const SAVE_VERSION = 1;

function blank() {
  return {
    v: SAVE_VERSION,
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

// 数字字段的归一自带一份，不依赖仓里有没有 count() —— 少一层隐式耦合。
function recordNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 存档两段式解码的第一段：整档 JSON 落到这里之后，**逐字段**归一。
// 一条记录不是"能用/不能用"二选一 —— 类型错的字段自己退成默认值，整条照样留下。
// 第二段（sanitizeRecords）在下面：它只丢掉归一后彻底没意义的记录，别的记录不受牵连。
function sanitizeRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  out.solved = !!r.solved;
  out.best = recordNum(r.best);
  out.plays = recordNum(r.plays);
  out.perfect = !!r.perfect;
  return out;
}

// 逐条隔离：坏的那条丢掉，好的那些原样留下，绝不因为一条把整份存档作废。
function sanitizeRecords(p) {
  const out = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
  for (const [id, rec] of Object.entries(p)) {
    const clean = sanitizeRecord(rec);
    if (clean) out[id] = clean;
  }
  return out;
}

function load() {
  if (cache) return cache;
  const ls = storage();
  let raw = null;
  try {
    raw = ls && globalThis.localStorage.getItem(KEY);
  } catch (err) {
    raw = null;
  }
  if (raw) {
    try {
      const p = JSON.parse(raw);
      // 版本门：只认本仓写出去的版本。将来升 v2 时，旧档宁可整档丢弃也不能被误读成新档。
      if (p && typeof p === 'object' && !Array.isArray(p)
          && (p.v === undefined || p.v === SAVE_VERSION)) {
        const base = blank();
        cache = {
          records: sanitizeRecords(p.records),
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
    globalThis.localStorage.setItem(KEY, JSON.stringify(cache));
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
