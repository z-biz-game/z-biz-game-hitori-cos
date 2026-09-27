// The three rules, each in its own exported function so each can be hit by its own
// negative test. Rule wording is frozen (see DESIGN.md) — every other module in the repo
// assumes it, and the exhaustive 4x4 cross-check in brute.js is only meaningful while
// "orthogonal" means orthogonal.
//
//   1. 每行每列不得出现两个相等的未涂数字。
//   2. 任意两个涂黑格不得正交相邻。
//   3. 所有未涂格正交连通。
//
// Rule 3 is the one a naive implementation drops, and dropping it turns a large share of
// boards multi-solution, which would silently void the "solutionCount === 1" claim this
// game is built on. So it has its own checker here and a second, independent one (flood
// fill) in brute.js.
//
// Connectivity here is a union-find, written once and reused by the solver's connectivity
// tactic as well as by the UI highlight.

import { lines, neighbours, size, SHADED, DOT, isUnshaded, undecidedOf } from './grid.js';

export class UnionFind {
  constructor(n) {
    this.parent = new Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
    this.rank = new Array(n).fill(0);
    this.count = n;
  }

  find(a) {
    const p = this.parent;
    let x = a;
    while (p[x] !== x) {
      p[x] = p[p[x]]; // path halving: keeps chains flat without recursion
      x = p[x];
    }
    return x;
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
    this.count--;
    return true;
  }

  connected(a, b) {
    return this.find(a) === this.find(b);
  }
}

// Rule 1. Every pair of equal digits sharing a line that is *both* still on the board.
// This is the strict reading, and it is what a finished board is judged by — `audit` counts
// on it agreeing with openConflicts, which it is whenever no cell is left 未涂.
export function duplicateViolations(p, marks) {
  const out = [];
  for (const line of lines(p)) {
    for (let a = 0; a < line.length; a++) {
      const i = line[a];
      if (!isUnshaded(marks[i])) continue;
      for (let b = a + 1; b < line.length; b++) {
        const j = line[b];
        if (!isUnshaded(marks[j])) continue;
        if (p.cells[i] === p.cells[j]) out.push({ rule: 1, cells: [i, j], value: p.cells[i] });
      }
    }
  }
  return out;
}

// The same rule read off a half-played board, and the reading `audit` uses. An 未涂 cell is not
// an assertion, so a pair of equal digits where one side is still undecided is not a mistake
// yet — it is just an undecided pair. Only two *dotted* cells are a conflict the player has
// actually claimed, which is what the highlight should paint. On a completed board every
// unshaded cell is dotted, so this returns exactly what duplicateViolations returns: `done`,
// `isSolution` and the solver are the same as they were, and only `clean` on a half-played
// board changes — which is the whole point.
export function openConflicts(p, marks) {
  return duplicateViolations(p, marks).filter((v) => marks[v.cells[0]] === DOT && marks[v.cells[1]] === DOT);
}

// Rule 2. Only right/down is checked so a pair is reported once.
export function adjacencyViolations(p, marks) {
  const n = p.n;
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    if (marks[i] !== SHADED) continue;
    const x = i % n;
    const y = Math.floor(i / n);
    if (x + 1 < n && marks[i + 1] === SHADED) out.push({ rule: 2, cells: [i, i + 1] });
    if (y + 1 < n && marks[i + n] === SHADED) out.push({ rule: 2, cells: [i, i + n] });
  }
  return out;
}

// Rule 3 via union-find: merge every pair of orthogonally adjacent unshaded cells, then
// everything with the same root as the lowest-index unshaded cell is reachable and the
// rest are the orphans.
export function connectivity(p, marks) {
  const total = size(p);
  const uf = new UnionFind(total);
  let unshaded = 0;
  let first = -1;
  for (let i = 0; i < total; i++) {
    if (!isUnshaded(marks[i])) continue;
    unshaded++;
    if (first < 0) first = i;
    for (const j of neighbours(p, i)) if (j > i && isUnshaded(marks[j])) uf.union(i, j);
  }
  if (unshaded === 0) return { components: 0, unshaded, orphans: [], roots: new Set() };
  const roots = new Set();
  const orphans = [];
  const home = uf.find(first);
  for (let i = 0; i < total; i++) {
    if (!isUnshaded(marks[i])) continue;
    roots.add(uf.find(i));
    if (uf.find(i) !== home) orphans.push(i);
  }
  return { components: roots.size, unshaded, orphans, roots };
}

// Cells the player may not shade because an already-shaded neighbour forbids it (rule 2).
// The UI paints these as faint dots: a hint about what the rules already decided, never
// an answer written in for the player.
export function forcedOpen(p, marks) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < marks.length; i++) {
    if (marks[i] !== SHADED) continue;
    for (const j of neighbours(p, i)) {
      if (isUnshaded(marks[j]) && !seen.has(j)) {
        seen.add(j);
        out.push(j);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

// One stop shop for the shell and the win test. `done` is stricter than "no violations":
// an undecided board cannot be finished, because rule 3 is only decidable once every
// cell is either black or dotted.
export function audit(p, marks) {
  const r1 = openConflicts(p, marks);
  const r2 = adjacencyViolations(p, marks);
  const c = connectivity(p, marks);
  const r3 = c.components > 1
    ? [{ rule: 3, cells: c.orphans.slice(), components: c.components }]
    : [];
  const undecided = undecidedOf(marks);
  const violations = r1.concat(r2, r3);
  return {
    violations,
    byRule: { 1: r1, 2: r2, 3: r3 },
    components: c.components,
    orphans: c.orphans,
    undecided,
    complete: undecided.length === 0,
    forcedOpen: forcedOpen(p, marks),
    clean: violations.length === 0,
    done: violations.length === 0 && undecided.length === 0,
  };
}

// True exactly when `marks` is a completed, legal board. This is the definition the
// solver's solutions and brute.js's enumeration are both measured against.
export function isSolution(p, marks) {
  const a = audit(p, marks);
  return a.done;
}

// A solution expressed the way the data file stores it: the set of shaded indices.
export function shadingIsValid(p, shaded) {
  const marks = new Array(size(p)).fill(2); // DOT everywhere, then punch the shades
  for (const i of shaded) marks[i] = SHADED;
  return isSolution(p, marks);
}
