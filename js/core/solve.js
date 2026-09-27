// The reasoner. Two jobs, deliberately kept apart from js/core/rules.js:
//
//   * enumerate the shading(s) of a board (up to a cap, default 2) so the generator can
//     say "this board has exactly one solution" — which is the whole premise of the game;
//   * measure how much guessing that proof cost: `depth` (deepest assumption stack) and
//     `guesses` (times pure deduction ran dry and an assumption had to be made).
//
// Structure: unit-propagate a small tactic set to a fixpoint; if cells are still
// undecided, branch on one (shaded first, then open) and recurse. Nothing in the
// propagation step may use the uniqueness of the solution as a reason to cut a branch —
// that would make the counter under-report and the generator would ship multi-solution
// boards. Every tactic below is sound for *every* solution of the board, which is what
// makes "count === 1" a proof rather than an opinion.
//
// Tactics, named after the human ones they imitate (see DESIGN.md for the proofs):
//   T1 重复对必涂其一   an equal pair sharing a line, one side confirmed open -> shade the other
//   T2 黑格相邻扩散禁涂  a shaded cell makes all four orthogonal neighbours confirmed open
//   T3 三明治规则       three consecutive equal digits in a line: both ends shaded, middle open
//   T4 角格规则         a 2x2 block whose L-shaped triple is equal: corner open -> far corner open
//   T5 连通性强制       shading this cell would cut two confirmed-open cells apart -> leave it open
//
// T5 runs only after T1-T4 reach a fixpoint, which is both cheaper and a closer match to
// how a human uses rule 3: the thing you check when the number clues stop working.
//
// This module imports the *rules*, never the player's mark vocabulary, except when it
// hands a finished board to rules.audit() for an independent double-check.

import {
  lines, neighbours, duplicatePairs, size, shadedOf, SHADED, DOT,
} from './grid.js';
import { audit } from './rules.js';

// Candidate state per cell. Distinct from the player's three marks on purpose: a solver
// never "dots" a cell, it proves it stays unshaded.
export const UNKNOWN = 0;
export const MUST_OPEN = 1;
export const MUST_SHADED = 2;

// Facts about a board that do not depend on what has been deduced yet.
export function facts(p) {
  const n = p.n;
  const pairs = duplicatePairs(p);
  const pairPartners = new Map();
  for (const [i, j] of pairs) {
    if (!pairPartners.has(i)) pairPartners.set(i, []);
    if (!pairPartners.has(j)) pairPartners.set(j, []);
    pairPartners.get(j).push(i);
    pairPartners.get(i).push(j);
  }
  const triples = [];
  for (const line of lines(p)) {
    for (let k = 0; k + 2 < line.length; k++) {
      const a = line[k];
      const b = line[k + 1];
      const c = line[k + 2];
      if (p.cells[a] === p.cells[b] && p.cells[b] === p.cells[c]) triples.push([a, b, c]);
    }
  }
  const corners = [];
  for (let y = 0; y + 1 < n; y++) {
    for (let x = 0; x + 1 < n; x++) {
      const tl = y * n + x;
      const tr = tl + 1;
      const bl = tl + n;
      const br = bl + 1;
      const quads = [[tl, tr, bl, br], [tr, tl, br, bl], [bl, tl, br, tr], [br, tr, bl, tl]];
      for (const [c, a, b, d] of quads) {
        if (p.cells[c] === p.cells[a] && p.cells[a] === p.cells[b]) corners.push([c, a, b, d]);
      }
    }
  }
  const adj = [];
  for (let i = 0; i < size(p); i++) adj.push(neighbours(p, i));
  return { n, pairs, pairPartners, triples, corners, adj };
}

// Returns false on contradiction. Mutates `cand`; the caller owns it and passes a copy.
export function propagate(p, f, cand) {
  const total = size(p);
  let rounds = 0;
  for (;;) {
    if (++rounds > total + 4) throw new Error('propagate: no fixpoint, a tactic is looping');
    let changed = false;

    for (;;) {
      let moved = false;

      // T2 first, because shade-neighbourhood is what feeds the pair clauses.
      for (let i = 0; i < total; i++) {
        if (cand[i] !== MUST_SHADED) continue;
        for (const j of f.adj[i]) {
          if (cand[j] === MUST_SHADED) return false;          // rule 2
          if (cand[j] === UNKNOWN) { cand[j] = MUST_OPEN; moved = true; }
        }
      }
      // T1: a pair of equal digits on one line cannot both stay on the board.
      for (const [i, j] of f.pairs) {
        const a = cand[i];
        const b = cand[j];
        if (a === MUST_OPEN && b === MUST_OPEN) return false; // rule 1
        if (a === MUST_OPEN && b === UNKNOWN) { cand[j] = MUST_SHADED; moved = true; }
        else if (b === MUST_OPEN && a === UNKNOWN) { cand[i] = MUST_SHADED; moved = true; }
      }
      // T3: three consecutive equal digits. At least two of the three must be hidden, and
      // two hidden cells may not touch, so the only option is both ends.
      for (const [a, b, c] of f.triples) {
        for (const pair of [[a, MUST_SHADED], [b, MUST_OPEN], [c, MUST_SHADED]]) {
          if (cand[pair[0]] === UNKNOWN) { cand[pair[0]] = pair[1]; moved = true; }
          else if (cand[pair[0]] !== pair[1]) return false;
        }
      }
      // T4: the 2x2 corner block.
      for (const q of f.corners) {
        const c = q[0];
        const d = q[3];
        if (cand[c] === MUST_OPEN && cand[d] === UNKNOWN) { cand[d] = MUST_OPEN; moved = true; }
        else if (cand[d] === MUST_SHADED && cand[c] === UNKNOWN) { cand[c] = MUST_SHADED; moved = true; }
      }
      if (!moved) break;
      changed = true;
    }

    // T5: rule 3 as a forcing.
    const forced = cutVertex(p, f, cand);
    if (forced >= 0) {
      cand[forced] = MUST_OPEN;
      changed = true;
    }
    if (!changed) return true;
  }
}

// An unknown cell whose removal separates the confirmed-open cells, or -1. Sound because
// every real solution's open set is a subset of the optimistic set (unknown + open), so
// if no route survives without v, no solution can shade v.
function cutVertex(p, f, cand) {
  const total = size(p);
  let openCount = 0;
  let firstOpen = -1;
  const optimistic = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (cand[i] === MUST_OPEN) {
      openCount++;
      if (firstOpen < 0) firstOpen = i;
    }
    if (cand[i] !== MUST_SHADED) optimistic[i] = 1;
  }
  if (openCount < 2) return -1;
  const seen = new Uint8Array(total);
  for (let v = 0; v < total; v++) {
    if (cand[v] !== UNKNOWN) continue;
    optimistic[v] = 0;
    seen.fill(0);
    const stack = [firstOpen];
    seen[firstOpen] = 1;
    let reached = 0;
    while (stack.length) {
      const i = stack.pop();
      if (cand[i] === MUST_OPEN) reached++;
      for (const j of f.adj[i]) if (optimistic[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
    }
    optimistic[v] = 1;
    if (reached < openCount) return v;
  }
  return -1;
}

function undecidedCells(cand) {
  const out = [];
  for (let i = 0; i < cand.length; i++) if (cand[i] === UNKNOWN) out.push(i);
  return out;
}

// Branch cell: the unknown with the most undecided equal-pair partners — that is where
// two constraints still have to meet. Lowest index on ties, so the measurement is
// reproducible bit for bit.
function pickBranch(f, cand, rest) {
  let best = rest[0];
  let bestScore = -1;
  for (const i of rest) {
    const partners = f.pairPartners.get(i) || [];
    let score = 0;
    for (const j of partners) if (cand[j] === UNKNOWN) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

function initialCand(p, f) {
  const cand = new Array(size(p)).fill(UNKNOWN);
  // T3 fires unconditionally, so seed it here; a clash between two overlapping triples
  // (four equal digits in a row) is caught by propagate on the first pass.
  for (const t of f.triples) {
    cand[t[0]] = MUST_SHADED;
    cand[t[1]] = MUST_OPEN;
    cand[t[2]] = MUST_SHADED;
  }
  return cand;
}

function marksOf(cand) {
  const out = new Array(cand.length);
  // A proven-open cell becomes DOT, not OPEN: OPEN means "the player has no opinion yet",
  // which would leave the board undecided and rules.audit() would refuse its own solution.
  for (let i = 0; i < cand.length; i++) out[i] = cand[i] === MUST_SHADED ? SHADED : DOT;
  return out;
}

// solve(puzzle, { limit = 2, nodeLimit = 200000 }) ->
//   { solutionCount, solutions, unique, depth, guesses, nodes, invalid, truncated, capped }
// `solutions` are ascending arrays of shaded cell indices, at most `limit` of them.
//
// `unique` is only ever true when the search ran to exhaustion: `limit` exists to stop a
// count as soon as a second solution proves a board is unusable, and a search that stopped
// because it was told to has proven nothing about what else is out there. So a caller asking
// for `limit: 1` gets `capped: true` and `unique: false` — which is why the generator asks
// for 2 and never fewer.
//
// `depth` is the deepest assumption stack reached while proving the count, `guesses` the
// number of times deduction ran dry and the search had to branch. Both are measured from
// the board, and both are reproducible from the serialised file by re-running this.
export function solve(puzzle, opts = {}) {
  const limit = opts.limit || 2;
  const nodeLimit = opts.nodeLimit || 200000;
  const f = opts.facts || facts(puzzle);
  const ctx = { solutions: [], nodes: 0, truncated: false, capped: false, depth: 0, guesses: 0, invalid: 0 };

  const walk = (cand, depth) => {
    if (ctx.truncated || ctx.capped) return;
    ctx.nodes++;
    if (ctx.nodes > nodeLimit) { ctx.truncated = true; return; }
    if (!propagate(puzzle, f, cand)) return;
    const rest = undecidedCells(cand);
    if (!rest.length) {
      const marks = marksOf(cand);
      // rules.audit() is the referee here, not the tactics: a leaf only counts as a
      // solution if the independent three-rule checker agrees.
      if (audit(puzzle, marks).done) ctx.solutions.push(shadedOf(marks));
      else ctx.invalid++;
      return;
    }
    if (ctx.solutions.length >= limit) { ctx.capped = true; return; }
    // Deduction ran dry exactly once here, however many branches are then tried: that is
    // what `guesses` counts. `depth` is how deep that had to nest.
    const v = pickBranch(f, cand, rest);
    ctx.guesses++;
    if (depth + 1 > ctx.depth) ctx.depth = depth + 1;
    for (const trial of [MUST_SHADED, MUST_OPEN]) {
      const next = cand.slice();
      next[v] = trial;
      walk(next, depth + 1);
      if (ctx.truncated) return;
      if (ctx.solutions.length >= limit) { ctx.capped = true; return; }
    }
  };

  walk(initialCand(puzzle, f), 0);
  return {
    solutionCount: ctx.solutions.length,
    solutions: ctx.solutions,
    unique: !ctx.truncated && !ctx.capped && ctx.solutions.length === 1,
    depth: ctx.depth,
    guesses: ctx.guesses,
    nodes: ctx.nodes,
    invalid: ctx.invalid,
    truncated: ctx.truncated,
    capped: ctx.capped,
  };
}
