// The board itself: a square grid of printed digits, plus one mark per cell.
//
// Three marks, matching the three things a player can do with one tap:
//   OPEN    未涂 — undecided. Rule-wise it counts as "not shaded", so an undecided
//           board never violates anything, which is why `complete` is part of the win
//           test in rules.audit() rather than an absence of violations.
//   SHADED  涂黑 — this cell is hidden.
//   DOT     打点 — the player's *confirmed*留白. Rule-wise identical to OPEN (both are
//           unshaded); it exists purely as the player's own note-taking, and it is what
//           lets a finished board be distinguished from an abandoned one.
//
// Nothing in this file knows the rules of Hitori — it is storage plus the geometry
// (lines, neighbours, duplicate pairs) every other module reads. Pure: no DOM, no
// globals, safe to import from node --test.

export const OPEN = 0;
export const SHADED = 1;
export const DOT = 2;

export const MARK_NAMES = ['open', 'shaded', 'dot'];

// Next mark in the tap cycle: 未涂 → 涂黑 → 打点 → 未涂.
export function nextMark(m) {
  return (m + 1) % 3;
}

export function isUnshaded(m) {
  return m !== SHADED;
}

// A puzzle is { n, cells } with cells.length === n*n, values >= 1. Plain arrays only,
// because the whole shape is JSON-serialised into js/data/lots.js.
export function validatePuzzle(spec) {
  if (!spec || typeof spec !== 'object') return 'puzzle must be an object';
  const n = spec.n;
  if (!Number.isInteger(n) || n < 2 || n > 9) return `n must be an integer in 2..9, got ${spec.n}`;
  const cells = spec.cells;
  if (!Array.isArray(cells) || cells.length !== n * n) return `cells must be an array of length ${n * n}, got ${cells && cells.length}`;
  for (const v of cells) {
    if (!Number.isInteger(v) || v < 1 || v > 99) return `cell values must be integers in 1..99, got ${v}`;
  }
  return null;
}

export function size(p) {
  return p.n * p.n;
}

export function at(p, x, y) {
  return p.cells[y * p.n + x];
}

export function idxOf(p, x, y) {
  return y * p.n + x;
}

export function xyOf(p, i) {
  return { x: i % p.n, y: Math.floor(i / p.n) };
}

// Every row and every column, each as an array of cell indices. Rules 1 and the
// sandwich tactic both work line-by-line, so this is the one geometry worth caching;
// it is computed on demand and memoised in a WeakMap so a puzzle object stays
// JSON-serialisable (no hidden enumerable fields).
const lineCache = new WeakMap();

export function lines(p) {
  const hit = lineCache.get(p);
  if (hit) return hit;
  const out = [];
  for (let y = 0; y < p.n; y++) {
    const row = [];
    for (let x = 0; x < p.n; x++) row.push(y * p.n + x);
    out.push(row);
  }
  for (let x = 0; x < p.n; x++) {
    const col = [];
    for (let y = 0; y < p.n; y++) col.push(y * p.n + x);
    out.push(col);
  }
  lineCache.set(p, out);
  return out;
}

const neighCache = new WeakMap();

// Orthogonal neighbours of one cell — deliberately *not* the four diagonals. The whole
// rule set is orthogonal-only; a diagonal reading would change what the 4x4 exhaustive
// cross-check in js/core/brute.js proves, so it is stated once here and never re-derived.
export function neighbours(p, i) {
  const per = neighCache.get(p);
  if (per) {
    const hit = per[i];
    if (hit) return hit;
  }
  const n = p.n;
  const x = i % n;
  const y = Math.floor(i / n);
  const out = [];
  if (x > 0) out.push(i - 1);
  if (x < n - 1) out.push(i + 1);
  if (y > 0) out.push(i - n);
  if (y < n - 1) out.push(i + n);
  out.sort((a, b) => a - b);
  if (!per) {
    const fresh = new Array(n * n).fill(null);
    fresh[i] = out;
    neighCache.set(p, fresh);
  } else {
    per[i] = out;
  }
  return out;
}

// Pairs of equal digits that share a line. This *is* rule 1 restated as a clue list:
// every pair must end up with at least one of its two cells shaded. A board with no
// pairs has no constraint at all beyond "shade nothing", so the generator keeps a
// minimum count of them and the UI can say out loud how much of rule 1 bites.
export function duplicatePairs(p) {
  const out = [];
  for (const line of lines(p)) {
    for (let a = 0; a < line.length; a++) {
      for (let b = a + 1; b < line.length; b++) {
        if (p.cells[line[a]] === p.cells[line[b]]) out.push([line[a], line[b]]);
      }
    }
  }
  out.sort((u, v) => (u[0] - v[0]) || (u[1] - v[1]));
  return out;
}

export function blankMarks(p) {
  return new Array(size(p)).fill(OPEN);
}

export function marksFromShaded(p, shaded) {
  const m = blankMarks(p);
  for (const i of shaded) m[i] = SHADED;
  return m;
}

// Indices of shaded cells, ascending — the canonical form a solution is stored in.
export function shadedOf(marks) {
  const out = [];
  for (let i = 0; i < marks.length; i++) if (marks[i] === SHADED) out.push(i);
  return out;
}

// A board is decided when the player has an opinion about every cell (涂黑 or 打点).
export function undecidedOf(marks) {
  const out = [];
  for (let i = 0; i < marks.length; i++) if (marks[i] === OPEN) out.push(i);
  return out;
}

export function cloneMarks(marks) {
  return marks.slice();
}

// "3,1,4,1,5,..." — used for signatures, ids and the tests that hand-copy a board.
export function cellsKey(p) {
  return p.cells.join(',');
}

export function shadingKey(marks) {
  return shadedOf(marks).join('+');
}
