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
let decodeReport = { droppedRecords: 0, droppedDaily: 0, droppedStats: 0, clampedUnlocked: false };

// `globalThis.localStorage` is read inside a try because the *property access* can throw
// (Safari private mode, blocked third-party storage, file://). Once that check says the object is
// there and shaped right, the call sites below use `localStorage.getItem` / `localStorage.setItem`
// by name — grepping the save path should show the API it uses, and node never reaches these lines
// because the check fails first.
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
  if (!storage()) {
    lastMode = 'memory';
    return lastMode;
  }
  try {
    localStorage.setItem(`${KEY}.probe`, '1');
    localStorage.removeItem(`${KEY}.probe`);
    lastMode = 'localStorage';
  } catch (err) {
    lastMode = 'memory'; // quota / SecurityError on write, which getItem would not have shown
  }
  return lastMode;
}

// One record, or null for "throw this one away". The shape a good save writes is
// { solved, best, plays, perfect }; anything else — null, a string, a number, a record whose
// `best` is not a count — is dropped by the caller, which keeps every *other* record.
function cleanRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.solved !== true) return null;
  const best = Number(raw.best);
  const plays = Number(raw.plays);
  if (!Number.isFinite(best) || best < 0 || best > 1e7) return null;
  if (!Number.isFinite(plays) || plays < 1 || plays > 1e7) return null;
  return { solved: true, best: Math.floor(best), plays: Math.floor(plays), perfect: raw.perfect === true };
}

function cleanRecords(raw) {
  const out = {};
  let dropped = 0;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const id of Object.keys(raw)) {
      if (typeof id !== 'string' || !id || id.length > 64) { dropped += 1; continue; }
      const rec = cleanRecord(raw[id]);
      if (rec) out[id] = rec;
      else dropped += 1;
    }
  } else if (raw != null) {
    dropped += 1; // `records: []` or `records: "x"` is one bad blob, not zero bad records
  }
  return { out, dropped };
}

function cleanDaily(raw) {
  const out = {};
  let dropped = 0;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const day of Object.keys(raw)) {
      const entry = raw[day];
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) {
        dropped += 1;
        continue;
      }
      const at = Number(entry.at);
      out[day] = { id: entry.id.slice(0, 64), at: Number.isFinite(at) && at >= 0 ? Math.floor(at) : 0 };
    }
  } else if (raw != null) {
    dropped += 1;
  }
  return { out, dropped };
}

function cleanStats(raw) {
  const base = blank().stats;
  const out = { ...base };
  let dropped = 0;
  if (!raw) return { out, dropped };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { out, dropped: 1 };
  for (const k of Object.keys(base)) {
    const n = Number(raw[k]);
    if (Number.isFinite(n) && n >= 0 && n <= 1e9) out[k] = Math.floor(n);
    else dropped += 1;
  }
  return { out, dropped };
}

// Stage one: JSON.parse (a throw here means there is no save at all). Stage two: the per-field
// cleaners above. A save that decodes into nothing is treated as no save, and never as an error —
// the pool lives in js/data/lots.js, so a wiped record cannot hide a level from anyone.
//
// 这套解码机件（cleanRecord / cleanRecords / cleanDaily / cleanStats / decode）**是验收认的那一份**：
// test/storage.test.mjs 的"一条坏记录只准丢那一条"就断在它上面。并线时它被换成了一套
// "错值一律退成默认值"的实现（recordNum / sanitizeRecord / sanitizeRecords），那份实现
// 坏记录一条也丢不掉，与闸的口径正好相反 —— 现在换回来。
function decode(raw) {
  let p = null;
  try {
    p = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  // 版本门：只认本仓写出去的版本。将来升 v2 时，旧档宁可整档丢弃也不能被误读成新档。
  // 缺 `v` 的老档照读（那是本仓写这个键之前的老形状）。
  if (p.v !== undefined && p.v !== SAVE_VERSION) return null;
  const records = cleanRecords(p.records);
  const daily = cleanDaily(p.daily);
  const stats = cleanStats(p.stats);
  const unlockedRaw = Number(p.unlocked);
  const unlocked = Number.isFinite(unlockedRaw) && unlockedRaw >= 1 && unlockedRaw <= 1e5
    ? Math.floor(unlockedRaw)
    : blank().unlocked;
  decodeReport = {
    droppedRecords: records.dropped,
    droppedDaily: daily.dropped,
    droppedStats: stats.dropped,
    clampedUnlocked: !(Number.isFinite(unlockedRaw) && unlockedRaw >= 1),
  };
  return { records: records.out, daily: daily.out, unlocked, stats: stats.out };
}

function load() {
  if (cache) return cache;
  let raw = null;
  try {
    // 注意这里没有 `ls`：并线时留下的是 `ls && …`，而 `ls` 在这个作用域里**根本没有定义**
    // ⇒ 每次读档都先抛一次 ReferenceError，又被这行 try/catch 吞掉 ⇒ raw 恒为 null
    // ⇒ 每次读档都当成空档 ⇒ 玩家存的纪录被一次又一次清空。
    raw = storage() ? localStorage.getItem(KEY) : null;
  } catch (err) {
    raw = null;
  }
  const decoded = raw ? decode(raw) : null;
  cache = decoded || blank();
  return cache;
}

// What the last decode threw away. Tests and the browser gate assert on this: "the save survived"
// is not the same claim as "the save survived intact", and a corrupt record has to cost exactly
// one record.
export function lastDecode() {
  return { ...decodeReport };
}

// The in-progress board (the shell's own key, same two-stage rule). `legalMarks` is a parameter
// because this file must not import grid.js: the core stays free of the view's constants.
// A bad field costs the slot, never the page — hence a report instead of an exception.
export function cleanResume(p, legalMarks = [0, 1, 2]) {
  const fail = (reason) => ({ ok: false, reason, value: null, droppedHistory: 0 });
  if (!p || typeof p !== 'object' || Array.isArray(p)) return fail('not-an-object');
  if (typeof p.id !== 'string' || !p.id || p.id.length > 64) return fail('bad-id');
  if (!Array.isArray(p.marks) || !p.marks.length || p.marks.length > 4096) return fail('bad-marks');
  for (const m of p.marks) {
    if (legalMarks.indexOf(m) < 0) return fail('illegal-mark');
  }
  const total = p.marks.length;
  const rawHistory = Array.isArray(p.history) ? p.history : [];
  const history = rawHistory.filter((i) => Number.isInteger(i) && i >= 0 && i < total);
  const taps = Number(p.taps);
  const fixes = Number(p.fixes);
  if (Number.isFinite(taps) && taps < 0) return fail('negative-taps');
  return {
    ok: true,
    reason: '',
    droppedHistory: rawHistory.length - history.length,
    value: {
      id: p.id,
      marks: p.marks.slice(),
      history,
      taps: Number.isFinite(taps) && taps >= 0 ? Math.floor(taps) : 0,
      fixes: Number.isFinite(fixes) && fixes >= 0 ? Math.floor(fixes) : 0,
    },
  };
}

function persist() {
  if (!storage()) return false;
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
