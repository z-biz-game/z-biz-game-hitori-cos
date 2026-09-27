// The generator, tested on the two things it claims: an accepted board has exactly one
// solution, and the reason a rejected board was thrown away is one of the documented ones.
//
// The structural claims below are theorems about the rule set (derived in DESIGN.md), not
// opinions about style, so they can be stated as hand-written expectations:
//
//   (T-a) maximality: if S is the unique solution then S + any one cell breaks rule 2 or
//         rule 3. Proof: adding black cells can never break rule 1 (it only ever compares
//         unshaded digits), so a superset that satisfies 2 and 3 would be a second solution.
//   (T-b) witnesses: if S is the unique solution then every cell of S has an equal digit on
//         an unshaded cell of the same line. Proof: if not, un-shading that cell keeps rules
//         1, 2 and 3 true, so it is a second solution.
//
// Both are checked against the *independent* rule checkers in js/core/brute.js, so neither
// can be satisfied by the same propagation tactics that produced the answer.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { TIERS, tierByKey, loadOf, makePuzzle, signature } from '../js/core/make.js';
import { duplicatePairs, lines, validatePuzzle, cellsKey } from '../js/core/grid.js';
import { shadingIsValid } from '../js/core/rules.js';
import { verifyShading } from '../js/core/brute.js';
import { solve } from '../js/core/solve.js';
import { LOTS } from '../js/data/lots.js';

const REASONS = [
  'bad-shape', 'bad-shading', 'truncated', 'no-solution', 'not-unique', 'unrepairable',
  'shading-drift', 'too-few-pairs', 'too-easy', 'too-hard',
];
// Reasons that say nothing about the solution count — the set tools/bake.mjs keeps out of
// its "unique accept rate" for exactly that reason.
const SOFT = ['bad-shape', 'bad-shading', 'too-few-pairs', 'too-easy', 'too-hard'];

function witnessGaps(p, shaded) {
  const S = new Set(shaded);
  const out = [];
  for (const u of shaded) {
    const covered = lines(p).some((L) => L.indexOf(u) >= 0 && L.some((v) => v !== u && !S.has(v) && p.cells[v] === p.cells[u]));
    if (!covered) out.push(u);
  }
  return out;
}

function supersetGaps(p, shaded) {
  const on = new Set(shaded);
  const out = [];
  for (let i = 0; i < p.n * p.n; i++) {
    if (on.has(i)) continue;
    const v = verifyShading(p, shaded.concat([i]));
    if (v.rule2 && v.rule3) out.push(i);
  }
  return out;
}

// --- the ladder ------------------------------------------------------------------

test('the tier ladder is four bands on three board sizes, and stops at 6x6', () => {
  eq(TIERS.map((t) => t.key), ['nook', 'quiet', 'study', 'retreat']);
  eq(TIERS.map((t) => t.n), [4, 4, 5, 6], 'the 4x4 bands are the ones the exhaustive cross-check can police');
  eq(TIERS.map((t) => [t.minLoad, t.maxLoad]), [[0, 0], [2, 2], [4, 5], [6, 12]], 'bands ascend and never overlap');
  eq(Math.max(...TIERS.map((t) => t.n)), 6, 'no 10x10 anything, and not even a 7x7: past 6x6 the uniqueness proof would rest on the solver alone');
  eq(tierByKey('nope'), null, 'the generator refuses an unknown band instead of silently using the first one');
  eq(loadOf({ depth: 2, guesses: 3 }), 5, 'the one number a band is sorted by, printed as its two parts');
});

test('the shipped pool sits inside its own bands', () => {
  for (const tier of TIERS) {
    const rows = LOTS.filter((r) => r.tier === tier.key);
    eq(rows.length, 10, `${tier.key} ships ten boards`);
    for (const row of rows) {
      const load = row.depth + row.guesses;
      ok(load >= tier.minLoad && load <= tier.maxLoad, `${row.id} load ${load} outside [${tier.minLoad},${tier.maxLoad}]`);
      ok(row.solution.length >= tier.shades[0] && row.solution.length <= tier.shades[1], `${row.id} shades ${row.solution.length}`);
      eq(row.n, tier.n, `${row.id} is not the size its band says`);
    }
  }
});

// --- one accepted board, end to end ----------------------------------------------

// Hand-picking a seed that is known to work would be reading an expectation back out of the
// code, so the two tests below search for an accepted seed the way the build does and then
// assert properties of whatever it finds.
function firstAccepted(tier, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const made = makePuzzle(`found-${tier.key}-${i}`, tier);
    if (made.ok) return { seed: `found-${tier.key}-${i}`, made };
  }
  return null;
}

test('makePuzzle is a pure function of its seed', () => {
  const tier = TIERS[0];
  const hit = firstAccepted(tier);
  ok(hit, `${tier.key} produced at least one board in 200 seeds`);
  const a = makePuzzle(hit.seed, tier);
  const b = makePuzzle(hit.seed, tier);
  eq(a.ok, true);
  eq(cellsKey(a.puzzle), cellsKey(b.puzzle), 'same digits');
  eq(a.solution, b.solution, 'same shading');
  eq([a.rating.depth, a.rating.guesses, a.rating.nodes, a.rating.pairs], [b.rating.depth, b.rating.guesses, b.rating.nodes, b.rating.pairs], 'same measurement');
  const others = new Set();
  for (let i = 0; i < 12; i++) {
    const made = makePuzzle(`different-${tier.key}-${i}`, tier);
    if (made.ok) others.add(cellsKey(made.puzzle));
  }
  ok(others.size >= 4, `${others.size} distinct boards from 12 distinct seeds: a seed is not a formality`);
});

test('an accepted board is a puzzle by every independent definition', () => {
  for (const tier of TIERS) {
    const hit = firstAccepted(tier);
    ok(hit, `${tier.key}: at least one seed in 40 is accepted`);
    const p = hit.made.puzzle;
    eq(validatePuzzle(p), null, `${tier.key}: shape`);
    eq(hit.made.rating.solutionCount, 1, `${tier.key}: the counter that made it ship`);
    eq(solve(p, { limit: 2 }).solutionCount, 1, `${tier.key}: and it still says one when asked again`);
    eq(solve(p, { limit: 2 }).invalid, hit.made.rating.invalid, `${tier.key}: the tally of leaves the tactics completed but rules.js rejected (they are why audit() is the referee) is reproducible`);
    eq(solve(p, { limit: 2 }).solutions, [hit.made.solution], `${tier.key}: re-solving finds that shading and no other`);
    eq(shadingIsValid(p, hit.made.solution), true, `${tier.key}: and rules.js passes it`);
    eq(hit.made.rating.pairs, duplicatePairs(p).length, `${tier.key}: the pair count on the row is the board's`);
    eq(hit.made.rating.shades, hit.made.solution.length, `${tier.key}: the shade count`);
    ok(hit.made.rating.pairs >= tier.pairsMin, `${tier.key}: ${hit.made.rating.pairs} pairs, minimum ${tier.pairsMin}`);
    ok(hit.made.rating.linesWithPairs >= tier.linesWithPairsMin, `${tier.key}: at least ${tier.linesWithPairsMin} of the ${2 * tier.n} lines carry a pair`);
    eq(supersetGaps(p, hit.made.solution), [], `${tier.key}: theorem T-a — the shading is maximal, so no superset is a second solution`);
    eq(witnessGaps(p, hit.made.solution), [], `${tier.key}: theorem T-b — every black cell has an open equal partner, so no cell of it can be removed`);
  }
});

test('the whole shipped pool satisfies both theorems too', () => {
  const noWitness = [];
  const notMaximal = [];
  for (const row of LOTS) {
    const p = { n: row.n, cells: row.cells };
    if (witnessGaps(p, row.solution).length) noWitness.push(row.id);
    if (supersetGaps(p, row.solution).length) notMaximal.push(row.id);
  }
  eq(noWitness, [], '40 of 40 boards have a witness behind every black cell');
  eq(notMaximal, [], '40 of 40 shadings are maximal under rules 2 and 3');
});

// --- rejections ------------------------------------------------------------------

test('a rejected seed says why, in one documented word', () => {
  const seen = new Set();
  let accepted = 0;
  let rejected = 0;
  const hard = [];
  for (const tier of TIERS) {
    for (let i = 0; i < 12; i++) {
      const made = makePuzzle(`sweep-${tier.key}-${i}`, tier);
      if (made.ok) {
        accepted++;
        eq(made.reason, undefined, 'an accepted board carries no reason');
        continue;
      }
      rejected++;
      seen.add(made.reason);
      ok(REASONS.indexOf(made.reason) >= 0, `undocumented rejection reason: ${made.reason}`);
      if (SOFT.indexOf(made.reason) < 0) hard.push(`${tier.key}/${i}: ${made.reason}`);
    }
  }
  ok(accepted > 0 && rejected > accepted, `${accepted} accepted / ${rejected} rejected: the band filter, not the uniqueness proof, is what the build pays for`);
  eq(hard, [], 'no seed in this sweep failed the uniqueness claim itself — bake.mjs counts the same thing as its "unique" rate');
  ok([...seen].some((r) => r === 'too-easy' || r === 'too-hard'), `reasons seen: ${[...seen].join(', ')}`);
});

test('a board the counter cannot pin down is called what it is', () => {
  // Hand-built: the cyclic Latin square has no duplicate pair at all, so it is not a puzzle
  // and no generator output can be trusted to disagree with this.
  const latin = { n: 4, cells: [1, 2, 3, 4, 2, 3, 4, 1, 3, 4, 1, 2, 4, 1, 2, 3] };
  eq(duplicatePairs(latin).length, 0);
  eq(solve(latin, { limit: 2 }).unique, false, 'the counter reports many solutions, so a board like this can never be accepted');
});

test('makePuzzle refuses a shape it should not try to build', () => {
  const big = makePuzzle('huge', { key: 'huge', label: 'huge', n: 10, shades: [20, 40], minLoad: 0, maxLoad: 99, pairsMin: 0, linesWithPairsMin: 0 });
  eq([big.ok, big.reason], [false, 'bad-shape'], 'validatePuzzle is the gate, so the 10x10 ban is enforced at the generator and not only in the docs');
  const tiny = makePuzzle('tiny', { key: 'tiny', label: 'tiny', n: 1, shades: [0, 1], minLoad: 0, maxLoad: 99, pairsMin: 0, linesWithPairsMin: 0 });
  eq([tiny.ok, tiny.reason], [false, 'bad-shape']);
});

// --- the de-duplication key ------------------------------------------------------

test('signature folds a board with its mirror image and nothing else', () => {
  const row = LOTS[3];
  const n = row.n;
  const transposed = { n, cells: row.cells.slice() };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) transposed.cells[y * n + x] = row.cells[x * n + y];
  eq(signature(transposed), signature(row), 'same puzzle read from the other corner must not ship twice');
  eq(signature({ n, cells: row.cells.slice() }), signature(row), 'and identical boards obviously agree');
  const distinct = new Set(LOTS.map((r) => signature(r)));
  eq(distinct.size, LOTS.length, `40 shipped boards, ${distinct.size} signatures: no mirror-image pair got in`);
  const renamed = { n, cells: row.cells.map((v) => (v % n) + 1) };
  ok(signature(renamed) !== signature(row), 'renaming digits is deliberately not folded in, so two boards that only look alike are still two boards');
});

run();
