// The generator — and the reason it can be trusted: it never claims a board is a puzzle,
// it *proves* one. Every candidate is built so that a chosen shading is legal, then the
// solver is asked how many legal shadings the printed digits admit. Only `1` ships.
//
// Construction, in order:
//   1. pick a shading S: an orthogonal independent set whose complement is still connected
//      (so rules 2 and 3 hold for S by construction);
//   2. write a Latin square of digits — row x, column y -> ((x + k*y + b) mod n) + 1 with
//      gcd(k, n) = 1. That gives every row and every column distinct digits, so rule 1 is
//      satisfied trivially and the board is *not* yet a puzzle at all;
//   3. overwrite the shaded cells with the digit of an open cell on their line. Rule 1
//      cannot see shaded cells, so S stays legal, but the pair (shaded, open) now demands
//      that at least one of the two is hidden — and only hiding the shaded one keeps S a
//      solution. This is where the clue comes from, and why step 4 is mandatory;
//   4. run js/core/solve.js. 0 solutions means step 3 over-constrained the board, >=2
//      means the planted clues do not pin S down. Either way the candidate is thrown away
//      with a counted reason, and tools/bake.mjs prints those counts.
//
// Difficulty is whatever the solver reports (`depth`, `guesses`), never a label chosen
// here: a tier's band in the shipped file is measured off the boards that actually made
// it through step 4.

import { rngFrom } from './rng.js';
import { validatePuzzle, duplicatePairs, size } from './grid.js';
import { shadingIsValid } from './rules.js';
import { solve } from './solve.js';

// Board sizes 4..6: 4x4 is the size the exhaustive 2^16 cross-check in brute.js can
// verify subset by subset, and 6x6 is as large as a uniqueness proof stays cheap enough
// to run at build time. 10x10 and up would leave the difficulty numbers unverifiable by
// anything but this same solver — which is the self-grading the series exists to avoid.
export const TIERS = [
  {
    key: 'nook', label: '一隅', n: 4, shades: [4, 8], minLoad: 0, maxLoad: 0,
    linesWithPairsMin: 4, pairsMin: 5, blurb: '4×4 · 纯推理，一次假设也不用',
  },
  {
    key: 'quiet', label: '静室', n: 4, shades: [4, 8], minLoad: 2, maxLoad: 2,
    linesWithPairsMin: 5, pairsMin: 6, blurb: '4×4 · 推理枯竭一次',
  },
  {
    key: 'study', label: '书房', n: 5, shades: [6, 12], minLoad: 4, maxLoad: 5,
    linesWithPairsMin: 7, pairsMin: 10, blurb: '5×5 · 假设要叠两层',
  },
  {
    key: 'retreat', label: '隐修', n: 6, shades: [9, 18], minLoad: 6, maxLoad: 12,
    linesWithPairsMin: 9, pairsMin: 14, blurb: '6×6 · 假设与连通性反复交织',
  },
];

export function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || null;
}

// The single number a band is sorted by. Both parts are measured by solve(), and the sum
// is printed alongside them so the split is never hidden.
export function loadOf(rating) {
  return rating.depth + rating.guesses;
}

function connectedComplement(n, blocked) {
  const total = n * n;
  let start = -1;
  let free = 0;
  for (let i = 0; i < total; i++) if (!blocked[i]) { free++; if (start < 0) start = i; }
  if (free === 0) return false;
  const seen = new Uint8Array(total);
  const stack = [start];
  seen[start] = 1;
  let reached = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % n;
    const y = (i - x) / n;
    const push = (j) => {
      if (!blocked[j] && !seen[j]) { seen[j] = 1; reached++; stack.push(j); }
    };
    if (x > 0) push(i - 1);
    if (x + 1 < n) push(i + 1);
    if (y > 0) push(i - n);
    if (y + 1 < n) push(i + n);
  }
  return reached === free;
}

// Step 1: a *maximal* independent set whose complement is still connected.
//
// Maximality is not a style preference, it is a correctness requirement, and this is the
// single most expensive thing I learned while building the generator: because rule 1 only
// ever compares digits on *unshaded* cells, shading more cells can never break it. So if
// S is a solution and A is any strictly larger shading that still satisfies rules 2 and 3,
// A satisfies rule 1 for free and is a solution too — every board would be multi-solution.
// The fix is geometric: S must be maximal independent, i.e. every unshaded cell already
// touches a shaded one, so no cell can be added without breaking rule 2. Greedy over a
// shuffled order gives exactly that (a cell is only skipped because a neighbour was taken),
// and the connectivity test afterwards is what rejects the cuts-off corners.
function neighboursOf(n, i) {
  const x = i % n;
  const y = (i - x) / n;
  const out = [];
  if (x > 0) out.push(i - 1);
  if (x + 1 < n) out.push(i + 1);
  if (y > 0) out.push(i - n);
  if (y + 1 < n) out.push(i + n);
  return out;
}

// Grow a shading until it is maximal: every remaining cell either touches a shaded cell
// (nothing to do) or is added, which is what keeps the "no superset solution" property from
// the comment above.
function extendToMaximal(n, blocked, shaded, rng) {
  const order = rng.shuffle(Array.from({ length: n * n }, (_, i) => i));
  for (const i of order) {
    if (blocked[i]) continue;
    if (neighboursOf(n, i).some((j) => blocked[j])) continue; // already dominated
    blocked[i] = 1;
    shaded.push(i);
  }
}

// Maximal by *both* geometric rules: a cell may only be added if it touches no shaded cell
// (rule 2) and the unshaded area stays connected (rule 3). Greeding until neither is
// possible yields exactly the property the superset argument needs — no strictly larger
// shading can satisfy rules 2 and 3, so no larger shading can be a second solution — while
// stopping well below half the board. A perfect dominating lattice (one shaded cell every
// three) is maximal under rule 2 alone and was tried first: it shades too densely and left
// the far corner unshaded-and-isolated, so rule 3 rejected 40 out of 40 attempts.
function growShading(p, rng, range, tries = 12) {
  const n = p.n;
  const total = n * n;
  for (let attempt = 0; attempt < tries; attempt++) {
    const blocked = new Uint8Array(total);
    const shaded = [];
    let progress = true;
    while (progress) {
      progress = false;
      const order = rng.shuffle(Array.from({ length: total }, (_, i) => i));
      for (const i of order) {
        if (blocked[i]) continue;
        if (neighboursOf(n, i).some((j) => blocked[j])) continue;
        blocked[i] = 1;
        if (connectedComplement(n, blocked)) {
          shaded.push(i);
          progress = true;
        } else {
          blocked[i] = 0;
        }
      }
    }
    if (range && (shaded.length < range[0] || shaded.length > range[1])) continue;
    return shaded.sort((a, b) => a - b);
  }
  return null;
}

// Step 2: the Latin square. k must be coprime to n and non-zero, or whole columns would
// repeat one digit and every board would be unsolvable on sight.
function latinValues(p, rng) {
  const n = p.n;
  const options = [];
  for (let k = 1; k < n; k++) if (gcd(k, n) === 1) options.push(k);
  const k = rng.pick(options);
  const b = rng.int(n);
  const cells = new Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) cells[y * n + x] = ((x + k * y + b) % n) + 1;
  }
  return cells;
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

// Step 3: plant the clues. A shaded cell copies the digit of an open cell sharing its row
// or column. Rule 1 cannot see the shaded cell, so the intended shading stays legal, but
// the new pair says "at least one of us must be hidden" — and only hiding *this* cell keeps
// the built shading a solution. That is the entire supply of clues in this game: without a
// witness a shaded cell is optional, and optional cells are what make a board multi-solution.
function plantWitness(p, i, on, rng) {
  const n = p.n;
  const row = Math.floor(i / n) * n;
  const col = i % n;
  const witnesses = [];
  for (let j = 0; j < n; j++) {
    const r = row + j;
    const c = col + j * n;
    if (r !== i && !on.has(r)) witnesses.push(r);
    if (c !== i && !on.has(c)) witnesses.push(c);
  }
  if (!witnesses.length) return false;
  p.cells[i] = p.cells[rng.pick(witnesses)];
  return true;
}

function plantAll(p, shaded, rng) {
  const on = new Set(shaded);
  let planted = 0;
  for (const i of shaded) if (plantWitness(p, i, on, rng)) planted++;
  return planted;
}

// Step 4's repair: the solver just produced a *second* shading `alt` that the digits do not
// yet rule out. Shade-of-S cell u is left open in alt, so give u the digit of a cell v that
// both shadings leave open on the same line: alt now prints two equal digits in one line and
// dies on rule 1, while the built shading is untouched: u is hidden there, so rule 1 never
// looks at its digit. That is also why the loop cannot destroy the board it is repairing —
// S stays a solution after every repair, so `no-solution` after a repair means a bug.
function repairAgainst(p, shaded, alt, rng) {
  const n = p.n;
  const aSet = new Set(alt);
  const us = shaded.filter((i) => !aSet.has(i));
  rng.shuffle(us);
  for (const u of us) {
    const row = Math.floor(u / n) * n;
    const col = u % n;
    const cands = [];
    for (let j = 0; j < n; j++) {
      const r = row + j;
      const c = col + j * n;
      if (r !== u && !aSet.has(r)) cands.push(r);
      if (c !== u && !aSet.has(c)) cands.push(c);
    }
    if (!cands.length) continue;
    p.cells[u] = p.cells[rng.pick(cands)];
    return true;
  }
  return false;
}

// Count, and if the count is not one, repair and count again — a bounded loop, because a
// shading that resists ten targeted repairs is a shading the digit planting cannot pin down
// and the candidate is cheaper to throw away than to argue with.
function rateUntilUnique(p, shaded, rng, opts) {
  const nodeLimit = opts.nodeLimit || 120000;
  const maxRepairs = opts.repairRounds === undefined ? 10 : opts.repairRounds;
  let rated = solve(p, { limit: 2, nodeLimit });
  let repairs = 0;
  for (let round = 0; ; round++) {
    if (rated.truncated) return { reason: 'truncated', rated, repairs };
    if (rated.solutionCount === 0) return { reason: 'no-solution', rated, repairs };
    if (rated.solutionCount === 1) {
      if (rated.solutions[0].join(',') !== shaded.join(',')) return { reason: 'shading-drift', rated, repairs };
      return { ok: true, rated, repairs };
    }
    if (repairs >= maxRepairs) return { reason: 'not-unique', rated, repairs };
    const mine = shaded.join(',');
    const alt = rated.solutions.find((sol) => sol.join(',') !== mine);
    if (!alt) return { reason: 'not-unique', rated, repairs };
    if (!repairAgainst(p, shaded, alt, rng)) return { reason: 'unrepairable', rated, repairs };
    repairs++;
    rated = solve(p, { limit: 2, nodeLimit });
  }
}

function pairCoverage(p) {
  const pairs = duplicatePairs(p);
  const n = p.n;
  const linesHit = new Set();
  for (const [i, j] of pairs) {
    if (Math.floor(i / n) === Math.floor(j / n)) linesHit.add(`r${Math.floor(i / n)}`);
    else linesHit.add(`c${i % n}`);
  }
  return { pairs: pairs.length, linesWithPairs: linesHit.size };
}

// makePuzzle(seed, tier) -> { ok: true, puzzle, solution, rating, tier }
//                    or   { ok: false, reason, tier }
// Deterministic in `seed`. `rating.solutionCount` is always 1 for an ok result, because
// that is what `ok` means here: the board ships only after the counter has exhausted its
// search and come back with exactly one shading.
export function makePuzzle(seed, tier, opts = {}) {
  const rng = rngFrom(`${seed}`);
  const n = tier.n;
  const base = { n, cells: new Array(n * n).fill(1) };
  if (validatePuzzle(base)) return { ok: false, reason: 'bad-shape', tier: tier.key };

  const shaded = growShading(base, rng, tier.shades);
  if (!shaded) return { ok: false, reason: 'bad-shading', tier: tier.key };

  const puzzle = { n, cells: latinValues(base, rng) };
  plantAll(puzzle, shaded, rng);
  if (validatePuzzle(puzzle)) return { ok: false, reason: 'bad-shape', tier: tier.key };

  const rated = rateUntilUnique(puzzle, shaded, rng, opts);
  if (!rated.ok) {
    return { ok: false, reason: rated.reason, tier: tier.key, solutionCount: rated.rated && rated.rated.solutionCount, repairs: rated.repairs };
  }
  if (!shadingIsValid(puzzle, shaded)) return { ok: false, reason: 'no-solution', tier: tier.key };

  const cov = pairCoverage(puzzle);
  const s = rated.rated;
  const rating = {
    solutionCount: s.solutionCount,
    depth: s.depth,
    guesses: s.guesses,
    nodes: s.nodes,
    invalid: s.invalid,
    repairs: rated.repairs,
    pairs: cov.pairs,
    linesWithPairs: cov.linesWithPairs,
    shades: shaded.length,
    load: loadOf(s),
  };
  if (cov.pairs < tier.pairsMin || cov.linesWithPairs < tier.linesWithPairsMin) {
    return { ok: false, reason: 'too-few-pairs', tier: tier.key, pairs: cov.pairs, linesWithPairs: cov.linesWithPairs };
  }
  if (rating.load < tier.minLoad) return { ok: false, reason: 'too-easy', tier: tier.key, load: rating.load };
  if (rating.load > tier.maxLoad) return { ok: false, reason: 'too-hard', tier: tier.key, load: rating.load };

  return { ok: true, puzzle, solution: shaded, rating, tier: tier.key };
}

// A board and its mirror across the main diagonal are the same puzzle seen from the other
// corner, so they must not both ship. The key is therefore the *ordered pair* of the two
// readings, joined — a board and its transpose collide, and only their transpose collides.
// (Renaming digits is deliberately not folded in: it would also fold two boards that the
// rules happen to treat differently, and the pool is small enough not to need it.)
export function signature(p) {
  const n = p.n;
  const flipped = new Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) flipped[y * n + x] = p.cells[x * n + y];
  const pair = [p.cells.join(','), flipped.join(',')].sort();
  return `${n}:${pair[0]}:${pair[1]}`;
}
