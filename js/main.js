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
import { store } from './core/storage.js';
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
};

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
};
const errors = [];

// ---------------------------------------------------------------- localStorage, the shell's own

// The same guard js/core/storage.js uses, and for the same reason: `globalThis.localStorage` can
// *throw* on the property read (private mode, blocked storage, file://), and a throw here must
// degrade to "no resume", never to a broken board.
function rawStore() {
  try {
    const ls = globalThis.localStorage;
    if (!ls || typeof ls.getItem !== 'function' || typeof ls.setItem !== 'function') return null;
    return ls;
  } catch (err) {
    return null;
  }
}

function readResume() {
  const ls = rawStore();
  if (!ls) return null;
  try {
    const raw = ls.getItem(RESUME_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !Array.isArray(p.marks)) return null;
    return p;
  } catch (err) {
    return null;
  }
}

function writeResume(g) {
  const ls = rawStore();
  if (!ls) return false;
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
    if (g.done) ls.removeItem(RESUME_KEY);
    else ls.setItem(RESUME_KEY, JSON.stringify(payload));
    return true;
  } catch (err) {
    return false;
  }
}

function dropResume() {
  const ls = rawStore();
  if (!ls) return false;
  try {
    ls.removeItem(RESUME_KEY);
    return true;
  } catch (err) {
    return false;
  }
}

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

function elapsed() {
  return Math.floor((Date.now() - session.openedAt) / 1000);
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
  view.clearHint();
  if (mayResume) {
    const saved = readResume();
    const total = lot.n * lot.n;
    if (saved && saved.id === lot.id && saved.marks.length === total
        && saved.marks.every((m) => m === OPEN || m === SHADED || m === DOT)) {
      session.game.marks = saved.marks.slice();
      session.game.history = Array.isArray(saved.history)
        ? saved.history.filter((i) => Number.isInteger(i) && i >= 0 && i < total) : [];
      session.game.taps = Number.isInteger(saved.taps) ? saved.taps : 0;
      session.game.fixes = Number.isInteger(saved.fixes) ? saved.fixes : 0;
      session.game.done = review(session.game).done;
      session.resume = { id: lot.id, marks: saved.marks.slice(), taps: session.game.taps };
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
    ['用时', mmss(g.done ? pausedAt() : elapsed())],
    ['题库', `唯一解 · 枯竭 ${lot.guesses} · 深度 ${lot.depth} · 节点 ${lot.nodes}`],
    ['本盘纪录', rec ? `已胜 ${rec.plays} 次 · 最佳 ${rec.best} 下${rec.perfect ? ' · 满分' : ''}` : '尚未拿下'],
  ];
}

// The clock is a display, nothing more: no selection, no save key and no comparison in this
// file reads it. It stops the moment the board is won, so the win card and the readout agree.
function pausedAt() {
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
  el.tally.innerHTML = `${g.lot.id} · ${g.lot.n}×${g.lot.n} · 黑 ${shadedOf(g.marks).length} 格 ｜ 最佳 ${floor} 下 ｜ 用了 ${g.taps} 下 ｜ 修错 ${g.fixes} 次 ｜ 用时 ${mmss(pausedAt())}`;
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
  el.undo.disabled = !g.history.length;
  el.restart.disabled = !g.taps;
  el.hint.disabled = !!g.done;
}

function draw() {
  const g = session.game;
  if (!g) {
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
}

// ---------------------------------------------------------------- moves

function startClock() {
  clearInterval(session.clockTimer);
  session.clockTimer = setInterval(() => {
    if (!session.game || session.game.done || document.hidden) return;
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
  if (g.done) {
    say('这一盘已经结束了：按「重开」或「下一盘」');
    return null;
  }
  if (i === null || i === undefined || i < 0) {
    session.cursor = -1;
    draw();
    return null;
  }
  const m = tapGame(g, i);
  if (m === null) {
    say('那一格不在盘上');
    return null;
  }
  session.cursor = i;
  session.hintMsg = ''; // the answer was about the board that used to be here
  view.clearHint();
  afterChange();
  return m;
}

function undoStep() {
  const g = session.game;
  if (!g) return false;
  if (!undoGame(g)) {
    say('还没有可回退的一步');
    return false;
  }
  session.scored = false;
  session.hintMsg = '';
  afterChange();
  return true;
}

function restartNow() {
  const g = session.game;
  if (!g) return;
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

window.addEventListener('hashchange', applyRoute);
window.addEventListener('resize', draw);
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const g = session.game;
  if (ev.key === 'Escape') { location.hash = '#/'; return; }
  if (!g) return;
  const n = g.lot.n;
  const k = ev.key.toLowerCase();
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
  get state() {
    const g = session.game;
    if (!g) {
      return {
        id: null, route: session.route.kind, n: 0, marks: [], taps: 0, history: [], done: false,
        unlocked: store.unlocked, records: Object.keys(store.records).length,
        resume: !!readResume(), storageMode: store.mode, daily: session.dailyKey,
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
      stats: { ...store.stats }, elapsed: this.elapsed,
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
  wipe: () => { store.reset(); dropResume(); draw(); return Object.keys(store.records).length; },
};

// ---- 全屏开关 ----
//
// 绑到 index.html 的 HUD 里真实存在的 #btn-fullscreen。
// 只在 js 里留一串 requestFullscreen 能骗过字符串扫描，但按钮不在 DOM 里就是死代码：
// 玩家按不到，功能等于没做。所以 id 必须与 HTML 里的按钮对得上，缺失时要在控制台喊出来。
//
// 三套 API 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀，Firefox 认 moz 前缀。UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

// iOS Safari 会把非 video 元素的请求直接 reject 成 NotAllowedError。
// 这个 promise 没人接就升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
// 因此凡是可能返回 promise 的调用，返回值一律就地吞掉，绝不让拒绝逃出这一层。
function fsQuiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

// 返回 true=请求进入，false=请求退出，null=不支持（调用方据此禁用按钮）。
function toggleFullscreen(root) {
  const req = fsRequest(root);
  if (!req) return null;
  if (fsElement()) {
    // 退出侧同样要兜底：老 Edge 是 msExitFullscreen；万一三者皆无就当无事发生，不抛。
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) fsQuiet(exit.call(document));
    return false;
  }
  // 部分实现（如被 Permissions-Policy 挡住的 iframe）会同步抛，所以 catch 和 .catch 两头都要接。
  try {
    fsQuiet(req.call(root));
  } catch (err) {
    // 拒绝即降级：静默保持当前形态，不冒泡、不打断这一局的其余逻辑。
  }
  return true;
}

function bindFullscreen(btn) {
  const root = fsRoot();

  // 状态回写：Esc 和 iOS 下滑手势退出时不会经过按钮，
  // 只有 fullscreenchange 事件能把按钮的文案/字形拉回正确状态，否则它会一直假装自己在全屏里。
  const sync = () => {
    const on = !!fsElement();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = on ? "退出全屏 (F)" : "全屏 (F)";
    document.body.classList.toggle('is-fullscreen', on);
    return on;
  };

  if (!fsRequest(root)) {
    // 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }

  btn.addEventListener('click', () => {
    toggleFullscreen(root);
    sync();
  });

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 正在输入框里打字时不劫持按键，否则会打不出 f。
    if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen(root);
      sync();
    }
  });

  sync();
}

function bootFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) {
    // 按钮被谁删掉了？在控制台喊出来，别让这个坑静默地烂在下一棒手里。
    console.warn('[fullscreen] index.html 里找不到 #' + "btn-fullscreen" + '，全屏开关没有入口');
    return;
  }
  bindFullscreen(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFullscreen);
} else {
  bootFullscreen();
}
