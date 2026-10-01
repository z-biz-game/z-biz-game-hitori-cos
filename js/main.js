// The shell: routes, the save file, the panel, the win card, the hint. This is the only file in
// the browser that touches the document, and it decides nothing about the game — every verdict
// on screen comes out of js/core, from the same functions `node --test test/` drives.
//
// Where each number on screen comes from:
//   * 黑数 / 打点 / 未定 / 冲突 / 连通 — `rules.audit()` via `game.review()`, on the player's own
//     marks. Nothing here counts cells by hand.
//   * 最佳 — `game.minTaps(lot)`: one tap per shaded cell, two per dotted one, derived from how
//     many cells that board shades. A floor to be measured against, not an opinion.
//   * 枯竭 N / 深度 N / 节点 N — the baked row in `js/data/lots.js`, produced by `tools/bake.mjs`
//     and re-checked by `js/core/brute.js`. The page never searches: `make.js` and `brute.js` are
//     not imported anywhere in this directory, so there is no backtracking path in the click path.
//   * 提示 — `solve.facts()` + `solve.propagate()` run on *the player's current board*, i.e. the
//     same no-backtrack pencil route the difficulty number was measured with. It names which rule
//     forced the cell. It never reads `lot.solution`: the assumption that search has to make is
//     left to the player, which is the entire game.
//
// One tap cycles 未涂 → 涂黑 → 打点 → 未涂 (`grid.nextMark`, driven by `game.tap`). No long-press,
// no right-click, no modifier mode: one-finger play is a product requirement here, and the
// three-state cycle is the one paper solvers use.
//
// Resume lives in its own key (`hitori.resume.v1`), not in `hitori.save.v1`: js/core/storage.js
// records finishes only, and the core is not edited from this side. See DESIGN.md's 缺口 table.

import { DOT, OPEN, SHADED, neighbours, shadedOf } from './core/grid.js';
import { connectivity } from './core/rules.js';
import {
  createGame, matchesSolution, minTaps, reset as resetGame, review, solutionMarks,
  tap as tapGame, undo as undoGame,
} from './core/game.js';
import { MUST_OPEN, MUST_SHADED, UNKNOWN, facts, propagate } from './core/solve.js';
import {
  ALL, TIERS, byId, campaign, dailyLot, levelAt, lotsIn, randomLot, spreadText, stats as poolStats,
} from './core/library.js';
import { cleanResume, store } from './core/storage.js';
import { createAudio } from './core/audio.js';
import { todayKey } from './core/rng.js';
import { LOTS } from './data/lots.js';
import * as gridCore from './core/grid.js';
import * as rulesCore from './core/rules.js';
import * as gameCore from './core/game.js';
import * as solveCore from './core/solve.js';
import * as libraryCore from './core/library.js';
import * as storageCore from './core/storage.js';
import * as rngCore from './core/rng.js';
import { createView } from './view.js';
import { registerServiceWorker } from './pwa.js';

const RESUME_KEY = 'hitori.resume.v1';
const $ = (id) => document.getElementById(id);
const el = {
  board: $('board'), hintline: $('hintline'), totals: $('totals'), crumbs: $('crumbs'),
  readout: $('readout'), shelf: $('shelf'), curtain: $('curtain'), rules: $('rules'),
  stars: $('stars'), verdict: $('verdict'), tally: $('tally'), again: $('again'), next: $('next'),
  undo: $('undo'), hint: $('hint'), restart: $('restart'), share: $('share'), back: $('back'),
  wipe: $('wipe'), toast: $('toast'), modes: $('modes'), menu: $('menu'), table: $('table'),
  panel: $('panel'), tiers: $('tiers'), menuCount: $('menu-count'), menuNote: $('menu-note'),
  menuCampaign: $('menu-campaign'), menuDaily: $('menu-daily'), menuRandom: $('menu-random'),
  home: $('home'),
  sound: $('sound'), fullscreen: $('fullscreen'), learn: $('learn'),
  learnCard: $('learn-card'), learnClose: $('learn-close'),
  pausecard: $('pausecard'), pauseTime: $('pause-time'), resume: $('resume'),
  pauseRestart: $('pause-restart'), pauseMenu: $('pause-menu'),
};

const SETTINGS_KEY = 'hitori.settings.v1';

const session = {
  route: { kind: 'menu' },
  lot: null,
  game: null,
  cursor: -1,
  scored: false,
  dailyKey: todayKey(),
  openedAt: Date.now(),
  toastTimer: 0,
  clockTimer: 0,
  nextId: null,
  hintMsg: '', // the last question asked of the pencil route; cleared by any change to the board
  resume: null, // { id, marks, taps } when the board on screen came out of the resume key
  doneClock: 0, // the clock stops at the win, so the win card and the readout never disagree
  paused: false,
  pauseStarted: 0, // wall clock of the 暂停 press, 0 while unpaused
  pausedFor: 0, // ms taken out of the clock since the board opened
  autoPaused: false, // only a tab-we-hid for gets un-hidden by coming back
  muted: false,
  settingsDecode: { ok: false, reason: 'none', dropped: 0 },
};
const errors = [];

// ---------------------------------------------------------------- localStorage, the shell's own

// The same guard js/core/storage.js uses, and for the same reason: `globalThis.localStorage` can
// *throw* on the property read (private mode, blocked storage, file://), and a throw here must
// degrade to "no resume", never to a broken board. Once the check passes, the call sites below
// name `localStorage.getItem` / `localStorage.setItem` outright.
function rawStore() {
  try {
    const ls = globalThis.localStorage;
    if (!ls || typeof ls.getItem !== 'function' || typeof ls.setItem !== 'function') return null;
    return ls;
  } catch (err) {
    return null;
  }
}

// Why the resume slot was refused. A half-broken slot must cost the slot and nothing else: the
// board falls back to a fresh one, the records in js/core/storage.js stay untouched. The rules
// themselves live in the core (one implementation, unit-tested there); this is the shell's mirror.
const resumeDecode = { ok: false, reason: 'none', droppedHistory: 0 };

function readResume() {
  if (!rawStore()) {
    resumeDecode.reason = 'no-storage';
    return null;
  }
  let raw = null;
  try {
    raw = localStorage.getItem(RESUME_KEY);
  } catch (err) {
    resumeDecode.reason = 'read-threw';
    return null;
  }
  if (!raw) {
    resumeDecode.ok = false;
    resumeDecode.reason = 'empty';
    return null;
  }
  let p = null;
  try { // stage one: is it JSON at all
    p = JSON.parse(raw);
  } catch (err) {
    resumeDecode.ok = false;
    resumeDecode.reason = 'unparsable';
    return null;
  }
  const r = cleanResume(p, [OPEN, SHADED, DOT]); // stage two: field by field
  resumeDecode.ok = r.ok;
  resumeDecode.reason = r.reason;
  resumeDecode.droppedHistory = r.droppedHistory;
  return r.ok ? r.value : null;
}

function writeResume(g) {
  if (!rawStore()) return false;
  // The board, the tap count and the history that lets 回退 keep working after a reload. No
  // wall-clock anywhere in here: the same save must describe the same position tomorrow.
  const payload = {
    id: g.lot.id,
    marks: g.marks.slice(),
    history: g.history.slice(),
    taps: g.taps,
    fixes: g.fixes,
  };
  try {
    if (g.done) localStorage.removeItem(RESUME_KEY);
    else localStorage.setItem(RESUME_KEY, JSON.stringify(payload));
    return true;
  } catch (err) {
    return false;
  }
}

function dropResume() {
  if (!rawStore()) return false;
  try {
    localStorage.removeItem(RESUME_KEY);
    return true;
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------- settings: the mute survives a reload

// The same two-stage decode as the save and the resume slot, for the same reason: this key can be
// a half-written quota abort, a hand-edited string, or a future build's shape. `muted` is the only
// field this build owns, and the honest readings are 0/1/false/true/'0'/'1' — anything else costs
// the setting and nothing else, and is *reported* rather than silently defaulted, so a player who
// pressed 静音 and got a loud reload has a number a gate can assert on.
function cleanSettings(p) {
  if (p === null || p === undefined) return { ok: false, reason: 'empty', dropped: 0, value: { muted: false } };
  if (typeof p !== 'object' || Array.isArray(p)) return { ok: false, reason: 'not-object', dropped: 1, value: { muted: false } };
  const m = p.muted;
  let muted = null;
  if (m === 0 || m === 1 || m === false || m === true) muted = !!m;
  else if (m === '0' || m === '1') muted = m === '1';
  else muted = null;
  const extra = Object.keys(p).filter((k) => k !== 'muted').length;
  return {
    ok: muted !== null,
    reason: muted === null ? 'bad-muted' : '',
    dropped: (muted === null ? 1 : 0) + extra,
    value: { muted: !!muted },
  };
}

function readSettings() {
  if (!rawStore()) {
    session.settingsDecode = { ok: false, reason: 'no-storage', dropped: 0 };
    return { muted: false };
  }
  let raw = null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch (err) {
    session.settingsDecode = { ok: false, reason: 'read-threw', dropped: 0 };
    return { muted: false };
  }
  if (!raw) {
    session.settingsDecode = { ok: false, reason: 'empty', dropped: 0 };
    return { muted: false };
  }
  let p = null;
  try { // stage one
    p = JSON.parse(raw);
  } catch (err) {
    session.settingsDecode = { ok: false, reason: 'unparsable', dropped: 1 };
    return { muted: false };
  }
  const r = cleanSettings(p); // stage two
  session.settingsDecode = { ok: r.ok, reason: r.ok ? '' : r.reason, dropped: r.dropped };
  return r.value;
}

function writeSettings() {
  if (!rawStore()) return false;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ muted: session.muted ? 1 : 0 }));
    return true;
  } catch (err) {
    return false;
  }
}

// One AudioContext, created on the first gesture — never here at import time, because a context
// built before any user action is born suspended and would queue sounds nobody ever hears.
const audio = createAudio(globalThis);

// ---------------------------------------------------------------- routes

function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const parts = raw.split('/').filter((p) => p !== '');
  if (!parts.length || parts[0] === 'menu') return { kind: 'menu' };
  if (parts[0] === 'campaign') return { kind: 'campaign' };
  if (parts[0] === 'daily') return { kind: 'daily' };
  if (parts[0] === 'lot' && parts[1]) return { kind: 'lot', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'random') {
    const tier = parts[1] && parts[1] !== 'any' ? parts[1] : '';
    // The seed is minted here, once, and `applyRoute` writes it straight back into the address
    // bar: `#/random` alone would redraw a different board on every reload, which is not a thing
    // this game does. With a seed in the URL the same link is the same board forever.
    return { kind: 'random', tier, seed: parts[2] || mintSeed() };
  }
  return { kind: 'unknown', hash: `#/${parts.join('/')}` };
}

function say(msg) {
  el.toast.hidden = false;
  el.toast.textContent = msg;
  clearTimeout(session.toastTimer);
  session.toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2800);
}

function rc(i) {
  const n = session.lot ? session.lot.n : 1;
  return `第 ${Math.floor(i / n) + 1} 行第 ${(i % n) + 1} 列`;
}

function mmss(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Time the player actually spent facing this board. A pause is not a stall they chose to be
// charged for: `pausedFor` accumulates finished pauses and the open one is added live, so 用时
// reads the same whether the tab sat in 暂停 for ten minutes or was never paused at all.
function pausedMs() {
  return session.pausedFor + (session.paused ? Math.max(0, Date.now() - session.pauseStarted) : 0);
}

function elapsedMs() {
  return Math.max(0, Date.now() - session.openedAt - pausedMs());
}

function elapsed() {
  return Math.floor(elapsedMs() / 1000);
}

// The campaign position the shelf has not finished yet — where a bare 继续战役 lands.
function campaignPointer() {
  const list = campaign();
  const i = list.findIndex((lot) => {
    const rec = store.record(lot.id);
    return !(rec && rec.solved);
  });
  return i < 0 ? list.length - 1 : i;
}

function mintSeed() {
  const buf = new Uint32Array(2);
  try {
    if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(buf);
    else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 4294967296);
  } catch (err) {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 4294967296);
  }
  return `r-${buf[0].toString(36)}${buf[1].toString(36)}`;
}

// Which lot a route means. A shared link that names nothing falls back loudly rather than picking a
// level behind the player's back — the random route is the only place a seed chooses.
function lotFor(route) {
  if (route.kind === 'lot') return byId(route.id);
  if (route.kind === 'daily') return dailyLot(session.dailyKey);
  if (route.kind === 'random') return randomLot(route.seed || mintSeed(), route.tier || null);
  if (route.kind === 'campaign') return levelAt(campaignPointer());
  return levelAt(Math.min(store.unlocked || 1, ALL.length) - 1);
}

function openLot(lot, mayResume) {
  session.lot = lot;
  session.game = createGame(lot);
  session.scored = false;
  session.cursor = -1;
  session.openedAt = Date.now();
  session.hintMsg = '';
  session.resume = null;
  // A new board is a new sitting: no carried-over pause, no pause time billed onto the clock.
  if (session.paused) setPaused(false);
  session.pausedFor = 0;
  session.pauseStarted = 0;
  session.autoPaused = false;
  el.pausecard.hidden = true;
  view.clearHint();
  if (mayResume) {
    const saved = readResume();
    const total = lot.n * lot.n;
    // readResume already refused anything malformed; what it cannot judge is whether the slot
    // describes *this* board.
    if (saved && saved.id === lot.id && saved.marks.length === total) {
      session.game.marks = saved.marks.slice();
      session.game.history = saved.history.slice();
      session.game.taps = saved.taps;
      session.game.fixes = saved.fixes;
      session.game.done = review(session.game).done;
      session.resume = { id: lot.id, marks: saved.marks.slice(), taps: saved.taps };
    }
  }
}

function applyRoute() {
  let route = parseRoute(location.hash);
  if (route.kind === 'unknown') {
    say(`没有这个地址：${route.hash}`);
    route = { kind: 'menu' };
  }
  if (route.kind === 'menu') {
    // The directory holds no board at all: the canvas is not painted, so a half-played game can
    // never be silently resumed from behind a menu.
    session.route = route;
    session.lot = null;
    session.game = null;
    session.nextId = null;
    if (location.hash !== '#/') history.replaceState(null, '', '#/');
    draw();
    return;
  }
  const lot = lotFor(route);
  if (!lot) {
    // A `#/lot/<id>` for a row that does not exist must not quietly become a random board.
    say(`没有 ${route.id || '这一'}盘：题库里找不到，回到目录`);
    session.route = { kind: 'menu' };
    session.lot = null;
    session.game = null;
    if (location.hash !== '#/') history.replaceState(null, '', '#/');
    draw();
    return;
  }
  session.route = route;
  openLot(lot, route.kind === 'lot' || route.kind === 'daily');

  // Normalise the address bar so the board on screen is always the board the URL describes.
  let want = '#/';
  if (route.kind === 'lot' || route.kind === 'campaign') want = `#/lot/${lot.id}`;
  if (route.kind === 'random') want = `#/random/${route.tier || 'any'}/${route.seed}`;
  if (route.kind === 'daily') want = '#/daily';
  if (location.hash !== want) history.replaceState(null, '', want);

  draw();
}

// ---------------------------------------------------------------- the hint: rules.js's answer, named

// The candidate vector the player's marks imply, plus the T3 seeding `solve.js` applies before it
// starts. That seeding is not exported by the core, so it is re-applied here — five lines, using
// only `facts()`, and the reason it must match exactly is that this is the same fixpoint the
// printed 枯竭 number was measured on.
function candFromMarks(p, marks) {
  const f = facts(p);
  const cand = new Array(p.n * p.n).fill(UNKNOWN);
  for (let i = 0; i < cand.length; i++) {
    if (marks[i] === SHADED) cand[i] = MUST_SHADED;
    else if (marks[i] === DOT) cand[i] = MUST_OPEN;
  }
  let clash = '';
  for (const [a, b, c] of f.triples) {
    for (const [cell, want] of [[a, MUST_SHADED], [b, MUST_OPEN], [c, MUST_SHADED]]) {
      if (cand[cell] === UNKNOWN) cand[cell] = want;
      else if (cand[cell] !== want && !clash) clash = `三明治（规则 1 与规则 2）和 ${rc(cell)} 上的记号撞了`;
    }
  }
  return { cand, f, clash };
}

// Does shading `v` cut a *proven* open cell away from the rest? Rule 3, and the only reason a cell
// can be forced open by the shape of the board rather than by a digit.
function splitsOpenCells(p, cand, v) {
  const marks = cand.map((c, i) => (i === v || c === MUST_SHADED ? SHADED : DOT));
  const c = connectivity(p, marks);
  if (c.components < 2) return null;
  const orphans = c.orphans.filter((o) => cand[o] === MUST_OPEN && o !== v);
  return orphans.length ? { orphans, components: c.components } : null;
}

// Which tactic forced `v`, phrased as the rule it is an image of. Every branch below proves the
// cell on its own, so the order is only about which explanation is the most useful to read.
function explain(p, f, cand, v, want, marks) {
  const n = p.n;
  // `cand` carries both the player's ink and what the pencil inferred from it, and those are not
  // the same claim: on an untouched board nothing 已经涂黑. A sentence that points at a premise
  // cell has to say which kind it is, or the hint hands its own work over to the player.
  const how = (j, shaded) => (marks && marks[j] === (shaded ? SHADED : DOT)
    ? (shaded ? '已经涂黑' : '已经打点')
    : (shaded ? '还是空着的，但铅笔把它推成了黑格' : '还是空着的，但铅笔把它推成了打点'));
  if (want === MUST_SHADED) {
    const triple = f.triples.find((t) => (t[0] === v || t[2] === v));
    if (triple) {
      const mid = triple[1];
      return {
        rule: 1, tactic: '三明治规则',
        text: `${rc(v)} 与 ${rc(mid)} 在同一条线上连着三个 ${p.cells[v]}：两头的黑格把中间那颗留在盘上，否则中间左右两格同数相邻，规则 2 与规则 1 一起站不住。`,
      };
    }
    const pair = f.pairs.find(([i, j]) => (i === v && cand[j] === MUST_OPEN) || (j === v && cand[i] === MUST_OPEN));
    if (pair) {
      const other = pair[0] === v ? pair[1] : pair[0];
      return {
        rule: 1, tactic: '重复对必涂其一',
        text: `${rc(v)} 与 ${rc(other)} 是同${pair[0] % n === pair[1] % n ? '列' : '行'}的两个 ${p.cells[v]}，规则 1 不许两个都留在盘上；那一格${how(other, false)}，所以这一格必须涂黑。`,
      };
    }
    const corner = f.corners.find((q) => (q[0] === v && cand[q[3]] === MUST_SHADED) || (q[3] === v && cand[q[0]] === MUST_SHADED));
    if (corner) {
      const other = corner[0] === v ? corner[3] : corner[0];
      return { rule: 1, tactic: '角格规则', text: `${rc(other)}${how(other, true)}，沿着 2×2 的斜线推到 ${rc(v)}：那一格也得涂黑，否则这条线上的相等数字无处安放。` };
    }
    return { rule: 1, tactic: '重复对必涂其一', text: `${rc(v)} 被同数的重复对逼成黑格（规则 1）。` };
  }
  const shadedNeighbour = neighbours(p, v).find((j) => cand[j] === MUST_SHADED);
  if (shadedNeighbour !== undefined) {
    return {
      rule: 2, tactic: '黑格相邻扩散禁涂',
      text: `${rc(shadedNeighbour)}${how(shadedNeighbour, true)}，规则 2 不许黑格相邻：${rc(v)} 只能留在盘上。`,
    };
  }
  const cut = splitsOpenCells(p, cand, v);
  if (cut) {
    return {
      rule: 3, tactic: '连通性强制',
      text: `涂掉 ${rc(v)} 会把${cut.orphans.map((j) => `${rc(j)}（${how(j, false)}）`).join('、')} 和其余未涂格断成 ${cut.components} 块，规则 3 不许：这一格得留着。`,
    };
  }
  const tripleMid = f.triples.find((t) => t[1] === v);
  if (tripleMid) {
    return {
      rule: 1, tactic: '三明治规则',
      text: `${rc(v)} 是连着三个 ${p.cells[v]} 的中间那颗：两头都得涂黑，而黑格不能相邻，所以中间这颗留在盘上（规则 1 加规则 2）。`,
    };
  }
  const corner = f.corners.find((q) => (q[0] === v && cand[q[3]] === MUST_OPEN) || (q[3] === v && cand[q[0]] === MUST_OPEN));
  if (corner) {
    const other = corner[0] === v ? corner[3] : corner[0];
    return { rule: 1, tactic: '角格规则', text: `${rc(other)} 已确定留在盘上，沿着 2×2 的角格推法 ${rc(v)} 也必须留着（规则 1）。` };
  }
  return { rule: 1, tactic: '重复对必涂其一', text: `${rc(v)} 被同数的重复对逼成留格（规则 1）。` };
}

// The next step the no-backtrack route can justify on the current board.
function logicStep(preferred) {
  const g = session.game;
  const p = g.puzzle;
  const a = review(g);
  const { cand: seed, f, clash } = candFromMarks(p, g.marks);
  const before = seed.slice();
  const cand = seed.slice();
  const ok = clash ? false : propagate(p, f, cand);

  if (!ok) {
    const first = a.violations[0];
    return {
      kind: 'contradiction', cell: -1,
      rule: first ? first.rule : null,
      text: clash
        ? `<b>规则 1 与规则 2</b>：${clash}。这一盘的推导在这里撞车了。`
        : first
          ? `<b>规则 ${first.rule}</b>：${ruleName(first.rule)}当场就把这盘面堵死了——${cellsPhrase(first)}。往回退一步再试。`
          : '<b>矛盾</b>：铅笔路在这里走不通，而三条规则都还没报警。说明某一步的打点是白打的，往回退一步。',
    };
  }

  const forced = [];
  for (let i = 0; i < cand.length; i++) if (before[i] === UNKNOWN && cand[i] !== UNKNOWN) forced.push(i);
  forced.sort((x, y) => x - y);
  if (!forced.length) {
    const open = undecidedList(g);
    if (!open.length) {
      return {
        kind: 'complete', cell: -1, rule: 0,
        text: '<b>每一格都定了，铅笔路也没再报警</b>：剩下的是把盘面收干净——涂或点都由你，规则会当场替你数冲突。',
      };
    }
    const branch = branchCell(f, cand, open);
    return {
      kind: 'exhausted', cell: branch, rule: 0,
      text: `<b>纯推理到这儿枯竭了</b>：剩下的 ${open.length} 格没有哪一条规则能单独定下谁，下一步只能假设。这一盘烘焙时量到的枯竭次数是 <b>${g.lot.guesses}</b> 次、最深假设 <b>${g.lot.depth}</b> 层；先从 <b>${rc(branch)}</b> 猜一颗试试——那一格牵着的未定重复对最多。这一下我不替你定。`,
    };
  }

  const cell = forced.indexOf(preferred) >= 0 ? preferred : forced[0];
  const why = explain(p, f, cand, cell, cand[cell], g.marks);
  return {
    kind: 'forced', cell, rule: why.rule, tactic: why.tactic, forced: cand[cell], others: forced,
    text: `<b class="r${why.rule}">规则 ${why.rule} · ${why.tactic}</b>：${why.text} 共 ${forced.length} 格这一步能定。`,
  };
}

function ruleName(rule) {
  return {
    1: '每行每列不得出现两个相等的未涂数字',
    2: '任意两个涂黑格不得正交相邻',
    3: '所有未涂格正交连通',
  }[rule] || '';
}

function cellsPhrase(v) {
  const where = v.cells.map((i) => rc(i)).join(v.cells.length > 2 ? '、' : ' 和 ');
  if (v.rule === 1) return `${where} 都是 ${v.value} 且都没有涂黑`;
  if (v.rule === 2) return `${where} 两颗黑格贴在了一起`;
  return `${where} 与其他未涂格断成了 ${v.components} 块`;
}

function undecidedList(g) {
  const out = [];
  for (let i = 0; i < g.marks.length; i++) if (g.marks[i] === OPEN) out.push(i);
  return out;
}

// The cell with the most undecided equal-pair partners — the same heuristic the core's branch
// picker uses, reached through the exported `facts()` only. Used to say where to *start guessing*,
// never to decide a cell.
function branchCell(f, cand, rest) {
  let best = rest[0];
  let bestScore = -1;
  for (const i of rest) {
    let score = 0;
    for (const j of (f.pairPartners.get(i) || [])) if (cand[j] === UNKNOWN) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

// What the no-backtrack route alone can settle from the empty board: the page's own copy of the
// claim printed in the tier table. `fullyDecided` is true exactly when the bake measured zero
//枯竭 for this row, and the playtest asserts that on one board per tier.
function solveWithLogic() {
  const g = session.game;
  const p = g.puzzle;
  const marks = new Array(p.n * p.n).fill(OPEN);
  const { cand, f } = candFromMarks(p, marks);
  const ok = propagate(p, f, cand);
  const undecided = [];
  let shaded = 0;
  for (let i = 0; i < cand.length; i++) {
    if (cand[i] === UNKNOWN) undecided.push(i);
    if (cand[i] === MUST_SHADED) shaded++;
  }
  return {
    id: g.lot.id,
    consistent: ok,
    fullyDecided: ok && undecided.length === 0,
    shaded,
    undecided,
    bakedGuesses: g.lot.guesses,
    bakedDepth: g.lot.depth,
    agreesWithBake: (ok && undecided.length === 0) === (g.lot.guesses === 0),
  };
}

// ---------------------------------------------------------------- panel

function hintText() {
  const g = session.game;
  if (!g) return '挑一盘开始。';
  if (g.done) {
    const same = matchesSolution(g);
    return same
      ? `<b>一乘</b>：黑格 ${shadedOf(g.marks).length} 个，未涂格连成一片，每行每列再没有两个相等的数字。用了 ${g.taps} 下，地板价 ${minTaps(g.lot)} 下。`
      : '<b>盘面填满了，可它对不上题库里那唯一解</b>：这一盘的解是三个独立复核都点头的，所以真出现了不一致，这里不判胜。';
  }
  const a = review(g);
  if (!a.violations.length && a.undecided.length === g.marks.length) {
    return '一次点击换一格，顺序是 <b>未涂 → 涂黑 → 打点 → 未涂</b>。涂黑是「这个数字被遮住」，打点是「这一格我确定留在盘上」。';
  }
  if (a.violations.length) {
    const byRule = [1, 2, 3].filter((r) => a.byRule[r].length);
    return `<b class="r${byRule[0]}">规则 ${byRule.join(' 与规则 ')}</b>正在报警：${cellsPhrase(a.violations[0])}。红/紫/青三色各自对应编号 1/2/3，先把报警修掉再往下推。`;
  }
  const left = a.undecided.length;
  const faint = a.forcedOpen.filter((i) => g.marks[i] === OPEN).length;
  return `盘面干净，还有 <b>${left}</b> 格没定，其中 <b>${faint}</b> 格右上角已经点了淡点（规则 2 说的「不能涂黑」）。淡点只是提示，不是答案：按<b>提示这一格</b>问下一步是哪条规则逼住的。`;
}

function readoutRows() {
  const g = session.game;
  const a = review(g);
  const lot = g.lot;
  const shades = shadedOf(g.marks).length;
  const dots = g.marks.filter((m) => m === DOT).length;
  const floor = minTaps(lot);
  const rec = store.record(lot.id);
  return [
    ['盘面', `${lot.n}×${lot.n} · ${lot.id}`],
    ['黑数', String(shades)],
    ['打点数', String(dots)],
    ['未定', String(a.undecided.length)],
    ['冲突', a.violations.length ? `${a.violations.length} 处 · 规则 ${[1, 2, 3].filter((r) => a.byRule[r].length).join('/')}` : '无'],
    ['连通块', `${a.components}${a.components > 1 ? ' · 断开了' : ''}`],
    ['步数 / 最佳', `${g.taps} / ${floor}`],
    ['修错', String(g.fixes)],
    ['用时', mmss(g.done ? stoppedClock() : elapsed())],
    ['题库', `唯一解 · 枯竭 ${lot.guesses} · 深度 ${lot.depth} · 节点 ${lot.nodes}`],
    ['本盘纪录', rec ? `已胜 ${rec.plays} 次 · 最佳 ${rec.best} 下${rec.perfect ? ' · 满分' : ''}` : '尚未拿下'],
  ];
}

// The clock is a display, nothing more: no selection, no save key and no comparison in this
// file reads it. It stops the moment the board is won, so the win card and the readout agree.
// (This is *not* the pause — 暂停 lives in `session.paused` and freezes `elapsed()` instead.)
function stoppedClock() {
  return session.doneClock;
}

function renderReadout() {
  el.readout.innerHTML = readoutRows().map(([k, v]) => {
    let cls = '';
    if (k === '冲突') cls = v === '无' ? 'yes' : 'no';
    else if (k === '未定') cls = v === '0' ? 'yes' : 'dim';
    else if (k === '连通块') cls = v.indexOf('断开') >= 0 ? 'no' : 'yes';
    else if (k === '步数 / 最佳') cls = Number(v.split(' / ')[0]) <= Number(v.split(' / ')[1]) ? 'yes' : 'no';
    const clock = k === '用时' ? ' data-clock="1"' : '';
    return `<dt>${k}</dt><dd class="${cls}"${clock}>${v}</dd>`;
  }).join('');
  const lot = session.lot;
  const routeName = { menu: '目录', daily: '今日一题', random: '随机', campaign: '战役', lot: '战役' }[session.route.kind];
  const where = session.route.kind === 'daily'
    ? `${routeName} · <b>${session.dailyKey}</b> · 全设备同一盘`
    : `${routeName} · 第 <b>${ALL.findIndex((l) => l.id === lot.id) + 1}</b>/${ALL.length} 盘`;
  el.crumbs.innerHTML = `<b>${lot.id}</b> · ${where}${session.resume ? ' · <b>已接上上次没下完的那盘</b>' : ''}`;
}

function renderRules() {
  const a = review(session.game);
  for (const li of el.rules.querySelectorAll('li')) {
    const r = Number(li.dataset.rule);
    const k = a.byRule[r].length;
    li.classList.toggle('hit', k > 0 || (r === 3 && a.components > 1));
    if (k) li.dataset.count = String(r === 3 ? a.orphans.length : k);
    else delete li.dataset.count;
  }
}

function tierOf(key) {
  return TIERS.find((t) => t.key === key) || TIERS[0];
}

function lotChip(lot, extraClass) {
  const rec = store.record(lot.id);
  const cls = [lot.id === (session.lot && session.lot.id) ? 'here' : '', rec && rec.solved ? 'won' : '', extraClass || '']
    .filter(Boolean).join(' ');
  const mark = rec && rec.perfect ? '★' : rec && rec.solved ? '✓' : '';
  const tip = `${lot.id} · ${lot.n}×${lot.n} · 枯竭 ${lot.guesses} · 黑 ${lot.shades} 格 · 最佳 ${minTaps(lot)} 下`
    + (rec && rec.best ? ` · 你的最佳 ${rec.best} 下` : '');
  return `<a href="#/lot/${lot.id}" class="${cls}" title="${tip}">${lot.id.split('-')[1]}${mark}</a>`;
}

function renderTotals() {
  const st = store.stats;
  const recs = Object.values(store.records);
  const won = recs.filter((r) => r && r.solved).length;
  const perfect = recs.filter((r) => r && r.perfect).length;
  const dailyDone = store.dailyDone(session.dailyKey);
  el.totals.innerHTML = `拿下 <b>${won}</b>/${ALL.length} · 满分 <b>${perfect}</b> · 累计 ${st.solves} 盘 · ${st.taps} 下 · 今日${dailyDone ? '已' : '未'}答题`;
  for (const b of el.modes.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.route === session.route.kind);
  }
}

function renderShelf() {
  const lot = session.lot;
  const tier = tierOf(lot.tier);
  const list = lotsIn(tier.key);
  const pos = ALL.findIndex((l) => l.id === lot.id);
  const next = levelAt(pos + 1);
  el.shelf.innerHTML = `<h3>${tier.label} · ${tier.blurb}</h3><div class="lots">${list.map((l) => lotChip(l)).join('')}</div>`
    + `<p>这一段 ${list.length} 盘，全部由 <code>tools/bake.mjs</code> 生成后交给 <code>js/core/brute.js</code> 逐格复核：4×4 是全部 65,536 个子集，5×5 与 6×6 是抽样复算。下一盘是 <a href="#/lot/${next.id}">${next.id}</a>。</p>`;
}

function renderMenu() {
  const s = poolStats();
  el.menuCount.textContent = `${s.lots} 盘 · 四段实测难度`;
  el.menuNote.innerHTML = '难度那一栏不是形容词：<b>枯竭 N 次</b> 是 <code>js/core/solve.js</code> 在这一盘的题面上，纯推理走到走不动、不得不假设的次数。';
  const resume = readResume();
  el.tiers.innerHTML = TIERS.map((t) => {
    const st = s.byTier[t.key] || {};
    const lots = lotsIn(t.key);
    // `t.blurb` is core data and it prints this tier's *load* range under the words 枯竭 N 次.
    // That is not what the number measures, so the menu recomputes both from the shipped rows and
    // labels each for what it is: 枯竭 = how many times js/core/solve.js had to assume on the
    // tier's rows, 负荷 = 枯竭 + 深度 (the sort key `campaign()` walks). Each value is printed with
    // the number of boards carrying it, because a tier whose rows are not uniform does not get to
    // advertise a range: 隐修 shipped nine boards at 枯竭 3 and one at 5.
    const gs = lots.map((l) => l.guesses);
    const ds = lots.map((l) => l.depth);
    const mine = resume && lots.some((l) => l.id === resume.id)
      ? `<p class="resume">上次没下完：<a href="#/lot/${resume.id}">${resume.id}</a> · 盘上已经记了 ${resume.marks.filter((m) => m !== OPEN).length} 个记号</p>`
      : '';
    return `<div class="tier">
      <h3>${t.label}<span>${t.key} · ${t.n}×${t.n}</span></h3>
      <p class="blurb"><b>${spreadText(gs, '枯竭', '次')} · ${spreadText(ds, '假设', '层')}</b> · ${spreadText(lots.map((l) => l.load), '负荷')}（枯竭+深度） · 黑 ${st.shadesMin}-${st.shadesMax} 格 · 题面相等对 ${st.pairsMin}-${st.pairsMax} 对 · 搜索节点 ≤ ${st.nodesMax}</p>
      <div class="lots">${lots.map((l) => lotChip(l)).join('')}</div>
      ${mine}
    </div>`;
  }).join('');
  const daily = dailyLot(session.dailyKey);
  const doneToday = store.dailyDone(session.dailyKey);
  el.menuDaily.textContent = doneToday ? `今日已下 · ${doneToday.id}` : `今日一题 · ${daily.id}`;
  el.menuCampaign.textContent = `继续战役 · ${levelAt(campaignPointer()).id}`;
}

function setView(mode) {
  const inGame = mode === 'game';
  el.menu.hidden = inGame;
  el.table.hidden = !inGame;
  el.panel.hidden = !inGame;
}

function renderCurtain() {
  const g = session.game;
  if (!g || !g.done || !matchesSolution(g)) {
    el.curtain.hidden = true;
    return;
  }
  const gr = grade(g);
  const pos = ALL.findIndex((l) => l.id === g.lot.id);
  const next = levelAt(pos + 1);
  session.nextId = next.id;
  el.curtain.hidden = false;
  el.stars.textContent = '★'.repeat(gr.stars) + '☆'.repeat(Math.max(0, 3 - gr.stars));
  el.verdict.textContent = gr.label;
  el.verdict.style.color = gr.stars ? 'var(--win)' : 'var(--lose)';
  const floor = minTaps(g.lot);
  el.tally.innerHTML = `${g.lot.id} · ${g.lot.n}×${g.lot.n} · 黑 ${shadedOf(g.marks).length} 格 ｜ 最佳 ${floor} 下 ｜ 用了 ${g.taps} 下 ｜ 修错 ${g.fixes} 次 ｜ 用时 ${mmss(stoppedClock())}`;
  el.next.textContent = next.id === g.lot.id ? '再来一次' : '下一盘';
}

// 满分 is the printed floor with no repair step: 一次点到底、没踩过报警。
function grade(g) {
  if (!g || !g.done) return { key: 'open', stars: 0, label: '还没结束' };
  if (!matchesSolution(g)) return { key: 'mismatch', stars: 0, label: '对不上唯一解' };
  const over = g.taps - minTaps(g.lot);
  if (over <= 0 && g.fixes === 0) return { key: 'perfect', stars: 3, label: '一乘 · 一刀断水' };
  if (over <= 2) return { key: 'clean', stars: 2, label: '水断 · 干净' };
  return { key: 'done', stars: 1, label: '成 · 绕了 ' + Math.max(0, over) + ' 下' };
}

function syncButtons() {
  const g = session.game;
  if (!g) return;
  // 暂停期间盘面是冻结的：回退、重开、提示都不给走，指针也进不去（见 takeTap）。
  el.undo.disabled = !g.history.length || session.paused;
  el.restart.disabled = !g.taps || session.paused;
  el.hint.disabled = !!g.done || session.paused;
}

// ---------------------------------------------------------------- 暂停 / 静音 / 全屏 / 玩法

// One function owns the pause, and both the button and the key go through it, so the curtain, the
// clock, the audio thread and the disabled controls can never disagree about whose turn it is.
// A won board cannot be paused — the win card is already the thing on screen.
function setPaused(next) {
  const want = next === undefined ? !session.paused : !!next;
  if (want === session.paused) return session.paused;
  if (want && (!session.game || session.game.done)) return false;
  session.paused = want;
  if (want) {
    session.pauseStarted = Date.now();
    audio.suspend(); // 暂停是真的停下来，不是把音量调小
    el.pauseTime.textContent = mmss(elapsed());
    el.resume.focus();
  } else {
    session.pausedFor += Math.max(0, Date.now() - session.pauseStarted);
    session.pauseStarted = 0;
    if (!session.muted) audio.resume();
    if (document.activeElement === el.resume) el.board.focus();
  }
  if (!want) session.autoPaused = false;
  el.pausecard.hidden = !want;
  draw();
  return session.paused;
}

// The HUD is a mirror of state, never a second source of truth: called after every change and
// from `draw`, so a reload or a key press cannot leave the label saying 有声 while it is silent.
function syncHud() {
  el.sound.textContent = session.muted ? '静音' : '有声';
  el.sound.setAttribute('aria-pressed', session.muted ? 'true' : 'false');
  el.sound.title = session.muted ? '已静音，按 M 恢复声音（M）' : '静音开关（M）';
  const fs = fullscreenActive();
  el.fullscreen.textContent = fs ? '退出全屏' : '全屏';
  el.fullscreen.setAttribute('aria-pressed', fs ? 'true' : 'false');
  el.fullscreen.hidden = !fullscreenSupported();
  el.learn.setAttribute('aria-expanded', el.learnCard.hidden ? 'false' : 'true');
}

// Mute is the audio core's mute: while it holds, `ensure()` refuses before `createOscillator` and
// counts the refusal, so nothing is allocated and the audio thread is suspended. The label and the
// saved setting follow the *return value*, not the request.
function setMuted(next) {
  session.muted = audio.setMuted(next === undefined ? !session.muted : !!next);
  writeSettings();
  syncHud();
  // Un-muting plays the one sound that proves it: a mute you cannot hear the difference on is a
  // checkbox, not a feature.
  if (!session.muted) audio.tap(OPEN);
  return session.muted;
}

function fullscreenSupported() {
  const doc = globalThis.document;
  return !!(doc && doc.documentElement && typeof doc.documentElement.requestFullscreen === 'function'
    && doc.fullscreenEnabled !== false);
}

function fullscreenActive() {
  const doc = globalThis.document;
  return !!(doc && doc.fullscreenElement);
}

// No fake fullscreen: on a browser that will not grant it (iOS Safari) the button hides itself
// rather than promising a chrome-less view it cannot deliver. The promise rejection is caught,
// because a denied fullscreen is a normal answer, not a crash.
function toggleFullscreen() {
  const doc = globalThis.document;
  if (!fullscreenSupported()) {
    say('这台设备的全屏由系统手势管，网页按不到这个开关');
    return false;
  }
  if (fullscreenActive()) {
    const p = doc.exitFullscreen();
    if (p && p.catch) p.catch(() => {});
    return false;
  }
  const p = doc.documentElement.requestFullscreen();
  if (p && p.catch) p.catch(() => say('全屏被浏览器拦下了'));
  return true;
}

function showLearn(next) {
  const want = next === undefined ? el.learnCard.hidden : !!next;
  if (el.learnCard.hidden === !want) return want;
  el.learnCard.hidden = !want;
  syncHud();
  if (want) el.learnClose.focus();
  else el.learn.focus();
  return want;
}

function draw() {
  const g = session.game;
  if (!g) {
    syncHud();
    setView('menu');
    renderMenu();
    renderTotals();
    el.hintline.innerHTML = hintText();
    el.readout.innerHTML = '';
    el.crumbs.innerHTML = '';
    el.shelf.innerHTML = '';
    el.curtain.hidden = true;
    return;
  }
  setView('game');
  const a = review(g);
  view.render({
    n: g.lot.n,
    cells: g.puzzle.cells,
    marks: g.marks,
    r1: a.byRule[1].map((v) => v.cells),
    r2: a.byRule[2].map((v) => v.cells),
    orphans: a.orphans,
    forced: a.forcedOpen,
    cursor: session.cursor,
    done: a.done,
  });
  // The hint stays on screen until the board moves again: a player who asked a question gets to
  // finish reading the answer while they look for the cell it names.
  el.hintline.innerHTML = session.hintMsg || hintText();
  renderReadout();
  renderRules();
  renderTotals();
  renderShelf();
  renderMenu();
  renderCurtain();
  syncButtons();
  syncHud();
}

// ---------------------------------------------------------------- moves

function startClock() {
  clearInterval(session.clockTimer);
  session.clockTimer = setInterval(() => {
    if (!session.game || session.game.done || session.paused || document.hidden) return;
    const cell = el.readout.querySelector('dd[data-clock]');
    if (cell) cell.textContent = mmss(elapsed());
    else draw();
  }, 1000);
}

function settleRecord() {
  const g = session.game;
  if (!g.done || session.scored) return;
  session.scored = true;
  session.doneClock = elapsed();
  if (!matchesSolution(g)) {
    // Uniqueness is the premise. A completed, clean board that is not the baked solution would
    // break it, and the shell refuses to score it rather than papering over the disagreement.
    errors.push(`done board does not match the certified solution of ${g.lot.id}`);
    say('填满了，但与题库的唯一解不符：这一盘不记分');
    return;
  }
  const a = review(g);
  const floor = minTaps(g.lot);
  const before = store.record(g.lot.id);
  store.solve(g.lot.id, { taps: g.taps, floor, violations: a.violations.length });
  if (session.route.kind === 'daily') store.markDaily(session.dailyKey, g.lot.id);
  // The shelf walks ALL, so unlocking counts campaign positions: clearing study-03 has to open the
  // next row of the campaign, not "the third lot".
  const wasSolved = !!(before && before.solved);
  const pos = ALL.findIndex((l) => l.id === g.lot.id);
  const opened = Math.min(ALL.length, pos + 2);
  if (!wasSolved && opened > store.unlocked) store.unlock(opened);
  dropResume();
  audio.win();
  const rec = store.record(g.lot.id);
  say(rec && rec.perfect ? `满分：${g.taps} 下，正好是地板价 ${floor}` : `拿下 · ${g.taps} 下（地板价 ${floor}）`);
}

function afterChange() {
  writeResume(session.game);
  // Score before painting: `settleRecord` is what puts the win into the store, and the header
  // tally and the shelf's done-mark both read that store. Drawing first made the winning tap
  // repaint a board the record had already been written for — the tally said 拿下 0 next to a
  // win card that said 满分, and stayed that way until something else repainted the page.
  settleRecord();
  draw();
  if (session.game.done) renderCurtain();
}

function takeTap(i) {
  const g = session.game;
  if (!g) return null;
  if (session.paused) {
    say('已暂停：按「继续」或 P 再落子');
    return null;
  }
  if (g.done) {
    say('这一盘已经结束了：按「重开」或「下一盘」');
    return null;
  }
  if (i === null || i === undefined || i < 0) {
    session.cursor = -1;
    draw();
    return null;
  }
  const before = review(g).violations.length;
  const m = tapGame(g, i);
  if (m === null) {
    say('那一格不在盘上');
    return null;
  }
  audio.tap(m);
  const after = review(g).violations.length;
  // 报警是看得见的（红/紫/青），这里补一条听觉得见的：这一下把冲突数推高了。
  if (after > before) audio.clash();
  session.cursor = i;
  session.hintMsg = ''; // the answer was about the board that used to be here
  view.clearHint();
  afterChange();
  return m;
}

function undoStep() {
  const g = session.game;
  if (!g) return false;
  if (session.paused) {
    say('已暂停：按「继续」或 P 再回退');
    return false;
  }
  if (!undoGame(g)) {
    say('还没有可回退的一步');
    return false;
  }
  session.scored = false;
  session.hintMsg = '';
  audio.undo();
  afterChange();
  return true;
}

function restartNow() {
  const g = session.game;
  if (!g) return;
  // 「重开」是这一盘的第二次机会，也是一次真实的手势：先解除暂停，让新的计时从 0 开始。
  if (session.paused) setPaused(false);
  session.pausedFor = 0;
  session.pauseStarted = 0;
  resetGame(g);
  session.scored = false;
  session.hintMsg = '';
  session.cursor = -1;
  session.openedAt = Date.now();
  session.doneClock = 0;
  view.clearHint();
  dropResume();
  draw();
}

function showHint() {
  const g = session.game;
  if (!g) return null;
  if (session.paused) {
    say('已暂停：先按「继续」或 P 再问题');
    return null;
  }
  const step = logicStep(session.cursor >= 0 ? session.cursor : -1);
  session.hintMsg = step.text;
  el.hintline.innerHTML = step.text;
  if (step.cell >= 0) {
    session.cursor = step.cell;
    view.showHint(step.cell);
  }
  if (step.rule) {
    const li = el.rules.querySelector(`li[data-rule="${step.rule}"]`);
    if (li) li.classList.add('hit');
  }
  audio.hint();
  return step;
}

// ---------------------------------------------------------------- wiring

const view = createView(el.board, { tap: (i) => takeTap(i) });

el.undo.addEventListener('click', undoStep);
el.restart.addEventListener('click', restartNow);
el.again.addEventListener('click', restartNow);
el.hint.addEventListener('click', () => { showHint(); draw(); });
el.back.addEventListener('click', () => { location.hash = '#/'; });
el.home.addEventListener('click', () => { location.hash = '#/'; });
el.next.addEventListener('click', () => { if (session.nextId) location.hash = `#/lot/${session.nextId}`; });
el.menuCampaign.addEventListener('click', () => { location.hash = '#/campaign'; });
el.menuDaily.addEventListener('click', () => { location.hash = '#/daily'; });
el.menuRandom.addEventListener('click', () => { location.hash = `#/random/${tierOf(session.lot ? session.lot.tier : 'nook').key}/${mintSeed()}`; });
for (const b of el.modes.querySelectorAll('button')) {
  b.addEventListener('click', () => {
    if (b.dataset.route === 'random') location.hash = `#/random/any/${mintSeed()}`;
    else location.hash = b.dataset.route === 'menu' ? '#/' : `#/${b.dataset.route}`;
  });
}

el.share.addEventListener('click', async () => {
  const lot = session.lot;
  const link = `${location.origin}${location.pathname}#/lot/${lot.id}`;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(`一乘 · 抽刀断水 ${lot.id}：${lot.n}×${lot.n} · 枯竭 ${lot.guesses} 次 · 最佳 ${minTaps(lot)} 下\n${link}`);
      say(`已复制链接 ${link}`);
      return;
    }
  } catch (err) {
    /* a refused clipboard falls through to showing the link */
  }
  say(link);
});

el.wipe.addEventListener('click', () => {
  store.reset();
  dropResume();
  session.route = { kind: 'menu' };
  location.hash = '#/';
  applyRoute();
  say('纪录与续局都清空了，回到目录');
});

el.sound.addEventListener('click', () => setMuted());
el.fullscreen.addEventListener('click', () => toggleFullscreen());
el.learn.addEventListener('click', () => showLearn());
el.learnClose.addEventListener('click', () => showLearn(false));
el.resume.addEventListener('click', () => setPaused(false));
el.pauseRestart.addEventListener('click', () => restartNow());
el.pauseMenu.addEventListener('click', () => {
  setPaused(false); // 目录上没有盘，暂停也就没有意义：先把计时收回来再走
  location.hash = '#/';
});
// The browser can take fullscreen away without asking (Esc on the desktop, a phone rotation), so
// the label follows the *event*, not the last click.
for (const type of ['fullscreenchange', 'fullscreenerror', 'webkitfullscreenchange']) {
  document.addEventListener(type, syncHud);
}
// 切到别的标签页就自动暂停，回来只恢复「是我们自己按下的那一次」：玩家手动暂停过 10 分钟，
// 不该因为切出去又切回来就被解开。
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (session.game && !session.game.done && !session.paused) session.autoPaused = setPaused(true);
    return;
  }
  if (session.autoPaused) setPaused(false);
});

// The saved mute is read *before* the first paint, so a reload is silent exactly when the last
// session was silent — a preference that resets itself is worse than no preference.
session.muted = readSettings().muted;
audio.setMuted(session.muted);

window.addEventListener('hashchange', applyRoute);
window.addEventListener('resize', draw);
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const g = session.game;
  const k = ev.key.toLowerCase();
  // Esc 一层层往后退：玩法弹窗 → 暂停 → 目录。按 ? 打开的人不该再记一个别的关闭键。
  if (ev.key === 'Escape') {
    if (!el.learnCard.hidden) showLearn(false);
    else if (session.paused) setPaused(false);
    else location.hash = '#/';
    return;
  }
  // 这三个键在目录上也按得动：静音、全屏、玩法，跟手上有没有盘无关。
  if (k === 'm') { ev.preventDefault(); setMuted(); return; }
  if (k === 'f') { ev.preventDefault(); toggleFullscreen(); return; }
  if (ev.key === '?') { ev.preventDefault(); showLearn(); return; }
  if (!g) return;
  const n = g.lot.n;
  if (k === 'p') { ev.preventDefault(); setPaused(); return; }
  if (k === 'u') { ev.preventDefault(); undoStep(); return; }
  if (k === 'r') { ev.preventDefault(); restartNow(); return; }
  if (k === 'h') { ev.preventDefault(); showHint(); draw(); return; }
  if (k === 'c') { ev.preventDefault(); el.board.focus(); return; }
  const move = { ArrowUp: -n, ArrowDown: n, ArrowLeft: -1, ArrowRight: 1 }[ev.key];
  if (move !== undefined) {
    ev.preventDefault();
    const cur = session.cursor < 0 ? 0 : session.cursor;
    const next = cur + move;
    if (ev.key === 'ArrowLeft' && cur % n === 0) return;
    if (ev.key === 'ArrowRight' && cur % n === n - 1) return;
    session.cursor = Math.max(0, Math.min(n * n - 1, next));
    draw();
    return;
  }
  if (ev.key === ' ' || ev.key === 'Enter') {
    if (ev.target && ev.target.tagName === 'BUTTON') return;
    ev.preventDefault();
    if (session.cursor >= 0) takeTap(session.cursor);
    else say('先用方向键选一格（c 键聚焦棋盘）');
  }
});
window.addEventListener('error', (ev) => errors.push(String(ev.message || ev.error)));

applyRoute();
startClock();
const pwa = registerServiceWorker();

// The playtest's door. Everything behind it is the code a real click runs: `tap` goes through
// `takeTap`, `point` reads the geometry the last frame actually drew, `hint` is the same
// classifier the 提示 button calls.
window.hitori = {
  version: 1,
  errors,
  engine: {
    grid: gridCore,
    rules: rulesCore,
    game: gameCore,
    solve: solveCore,
    library: libraryCore,
    storage: storageCore,
    rng: rngCore,
    LOTS,
    TIERS,
  },
  lots: ALL,
  tiers: TIERS,
  get game() { return session.game; },
  get lot() { return session.lot; },
  get route() { return { ...session.route }; },
  get violations() { return session.game ? review(session.game).violations : []; },
  get elapsed() { return session.game && session.game.done ? Math.floor(session.doneClock) : elapsed(); },
  get paused() { return session.paused; },
  get muted() { return session.muted; },
  // Seconds taken out of the clock, live: a gate asserts the pause actually stopped the timer
  // rather than merely hiding the board.
  get pausedFor() { return Math.floor(pausedMs() / 1000); },
  get state() {
    const g = session.game;
    if (!g) {
      return {
        id: null, route: session.route.kind, n: 0, marks: [], taps: 0, history: [], done: false,
        unlocked: store.unlocked, records: Object.keys(store.records).length,
        resume: !!readResume(), storageMode: store.mode, daily: session.dailyKey, pwa,
        paused: session.paused, muted: session.muted, pausedFor: Math.floor(pausedMs() / 1000),
        audio: audio.stats(), settings: { ...session.settingsDecode },
      };
    }
    const a = review(g);
    return {
      id: g.lot.id, tier: g.lot.tier, route: session.route.kind, n: g.lot.n,
      marks: g.marks.slice(), history: g.history.slice(), taps: g.taps, fixes: g.fixes,
      done: g.done, clean: a.clean, complete: a.complete, undecided: a.undecided.length,
      components: a.components, orphans: a.orphans.slice(), forcedOpen: a.forcedOpen.slice(),
      violations: a.violations.length, byRule: { 1: a.byRule[1].length, 2: a.byRule[2].length, 3: a.byRule[3].length },
      shaded: shadedOf(g.marks).length, dots: g.marks.filter((m) => m === DOT).length,
      minTaps: minTaps(g.lot), matches: matchesSolution(g), cursor: session.cursor,
      grade: grade(g), record: store.record(g.lot.id), unlocked: store.unlocked,
      records: Object.keys(store.records).length, resume: !!readResume(),
      storageMode: store.mode, daily: session.dailyKey, dailyDone: store.dailyDone(session.dailyKey),
      stats: { ...store.stats }, elapsed: this.elapsed, pwa,
      paused: session.paused, muted: session.muted, pausedFor: Math.floor(pausedMs() / 1000),
      audio: audio.stats(), settings: { ...session.settingsDecode },
    };
  },
  // Paint-only: re-render with an explicit patch (never mutates the game) and hand back the
  // bitmap fingerprint, so a pixel assertion can prove the view is a function of the audit.
  show(patch) {
    if (patch) view.render(patch);
    else draw();
    return { hash: view.pixelsHash(), painted: view.painted(), size: view.size };
  },
  // Open a board: a lot object, an id, or a { kind } route shape. The same path a chip link takes.
  begin(lotOrKey) {
    let lot = null;
    if (typeof lotOrKey === 'string') lot = byId(lotOrKey) || lotFor(parseRoute(lotOrKey.indexOf('/') >= 0 ? lotOrKey : `#/${lotOrKey}`));
    else if (lotOrKey && lotOrKey.id) lot = byId(lotOrKey.id) || lotOrKey;
    else if (lotOrKey && lotOrKey.kind) lot = lotFor({ ...lotOrKey });
    else lot = levelAt(0);
    if (!lot) return null;
    session.route = lotOrKey && lotOrKey.kind === 'daily' ? { kind: 'daily' } : { kind: 'lot', id: lot.id };
    openLot(lot, false);
    history.replaceState(null, '', `#/lot/${lot.id}`);
    draw();
    return { id: lot.id, n: lot.n };
  },
  tap: (i) => takeTap(i),
  undo: () => undoStep(),
  reset: restartNow,
  // 暂停/静音/全屏/玩法：走的是按钮同一个函数，不是为测试另开的一条路。
  pause: (v) => setPaused(v),
  mute: (v) => setMuted(v),
  toggleFullscreen: () => toggleFullscreen(),
  fullscreen: () => ({ supported: fullscreenSupported(), active: fullscreenActive() }),
  learn: (v) => showLearn(v),
  audio: () => audio.stats(),
  hint: (i) => {
    const step = i === undefined ? showHint() : logicStep(i);
    if (i !== undefined) {
      el.hintline.innerHTML = step.text;
      if (step.cell >= 0) { session.cursor = step.cell; view.showHint(step.cell); }
    }
    return step;
  },
  logic: solveWithLogic,
  solveWithLogic,
  solutionMarks: (id) => solutionMarks(byId(id || (session.lot && session.lot.id)) || session.lot),
  point: (i) => view.point(i),
  hit: (x, y) => view.hit(x, y),
  sample: (i) => view.sample(i),
  pixels: () => ({ hash: view.pixelsHash(), painted: view.painted(), size: view.size }),
  layout: () => view.layout(),
  reducedMotion: () => view.reducedMotion(),
  animating: () => view.animating(),
  go(hash) { location.hash = hash; return { ...session.route }; },
  readout: () => readoutRows().map(([k, v]) => `${k}=${v}`),
  rules: () => Array.from(el.rules.querySelectorAll('li')).map((li) => ({ rule: Number(li.dataset.rule), hit: li.classList.contains('hit'), count: Number(li.dataset.count || 0) })),
  save: () => ({ records: { ...store.records }, stats: { ...store.stats }, daily: { ...store.daily }, unlocked: store.unlocked, mode: store.mode }),
  resume: () => readResume(),
  // 两段式解码的验尸报告：坏档只该丢那一条，不该把页面冻死。
  decode: () => ({ save: storageCore.lastDecode(), resume: { ...resumeDecode }, settings: { ...session.settingsDecode } }),
  wipe: () => { store.reset(); dropResume(); draw(); return Object.keys(store.records).length; },
};
