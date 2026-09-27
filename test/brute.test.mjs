// The second route: enumerate shading subsets and check the three rules from scratch, with
// its own arithmetic and its own flood fill. This file exists because js/core/solve.js
// cannot be asked to grade itself.
//
// The 4x4 sweep below is exhaustive — 65,536 subsets per board, every one of them, no
// sampling — and it is run three ways at once: brute.js's checkers, the union-find checker
// in js/core/rules.js, and the solver's own count. Any disagreement between the three is a
// bug in one of them, which is the whole point of having three.

import { test, run, ok, eq } from '../tools/harness.mjs';
import {
  FIXTURE_A, FIXTURE_A_SHADED, FIXTURE_B, FIXTURE_B_SHADED, FIXTURE_C, FIXTURE_C_SHADED_ALT,
  FIXTURE_D, FIXTURE_D_COUNT, FIXTURE_D_SOLUTIONS, SUBSETS_4X4, TRIPLE_ROW,
} from './fixtures.mjs';
import {
  bruteSolve, bruteSample, verifyShading, canEnumerate, FULL_SUBSETS,
} from '../js/core/brute.js';
import { audit } from '../js/core/rules.js';
import { solve } from '../js/core/solve.js';
import { SHADED, DOT, cellsKey, size } from '../js/core/grid.js';
import { LOTS } from '../js/data/lots.js';

const board = (row) => ({ n: row.n, cells: row.cells.slice() });
const keyOf = (list) => list.map((s) => s.join(',')).sort().join(' | ');

// A third, deliberately naive implementation of the rules, written inside this test file
// from the frozen wording in DESIGN.md: no union-find, no shared helpers, no caching.
// Three independent yes/no answers per subset is a much stronger claim than two.
function naiveLegal(p, bits) {
  const n = p.n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (bits[y * n + x]) continue;
      for (let x2 = x + 1; x2 < n; x2++) if (!bits[y * n + x2] && p.cells[y * n + x] === p.cells[y * n + x2]) return false;
      for (let y2 = y + 1; y2 < n; y2++) if (!bits[y2 * n + x] && p.cells[y * n + x] === p.cells[y2 * n + x]) return false;
    }
  }
  for (let i = 0; i < n * n; i++) {
    if (!bits[i]) continue;
    const x = i % n;
    const y = (i - x) / n;
    if (x + 1 < n && bits[i + 1]) return false;
    if (y + 1 < n && bits[i + n]) return false;
  }
  let start = -1;
  let want = 0;
  for (let i = 0; i < n * n; i++) if (!bits[i]) { want++; if (start < 0) start = i; }
  if (want === 0) return false;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const i = stack.pop();
    const x = i % n;
    const y = (i - x) / n;
    for (const j of [x > 0 ? i - 1 : -1, x + 1 < n ? i + 1 : -1, y > 0 ? i - n : -1, y + 1 < n ? i + n : -1]) {
      if (j < 0 || bits[j] || seen.has(j)) continue;
      seen.add(j);
      stack.push(j);
    }
  }
  return seen.size === want;
}

function sweepCounts(p) {
  const total = size(p);
  const marks = new Array(total);
  let naive = 0;
  let viaAudit = 0;
  let viaBrute = 0;
  const legal = [];
  for (let mask = 0; mask < (1 << total); mask++) {
    for (let i = 0; i < total; i++) marks[i] = ((mask >> i) & 1) ? SHADED : DOT;
    const shaded = [];
    for (let i = 0; i < total; i++) if (marks[i] === SHADED) shaded.push(i);
    const bitArr = new Uint8Array(total);
    for (const i of shaded) bitArr[i] = 1;
    if (naiveLegal(p, bitArr)) { naive++; legal.push(shaded); }
    const a = audit(p, marks);
    if (a.done) viaAudit++;
    const v = verifyShading(p, shaded);
    if (v.ok) viaBrute++;
  }
  return { naive, viaAudit, viaBrute, legal };
}

// --- the shape of the two modes ---------------------------------------------------

test('FULL_SUBSETS is 2^16 and nothing larger is ever enumerated', () => {
  eq(FULL_SUBSETS, 65536, 'and SUBSETS_4X4 in the fixtures is the same number, hand-written twice on purpose');
  eq(SUBSETS_4X4, FULL_SUBSETS);
  eq([canEnumerate(FIXTURE_B), canEnumerate(FIXTURE_A)], [true, false], '4x4 yes, 5x5 no: 2^25 is a build step nobody waits for');
  eq(canEnumerate({ n: 9, cells: new Array(81).fill(1) }), false, 'and the sizes this game forbids are unaffordable anyway — the two guards agree');
  eq(canEnumerate(null), false, 'a missing board is not "small enough to enumerate"');
});

test('bruteSolve refuses a 5x5 instead of pretending to be exhaustive', () => {
  let msg = '';
  try { bruteSolve(FIXTURE_A); } catch (err) { msg = err.message; }
  ok(/beyond exhaustive/.test(msg), `refused with: ${msg}`);
  let forced = '';
  try { bruteSolve(FIXTURE_A, { force: true }); } catch (err) { forced = err.message; }
  ok(/refusing 25 cells/.test(forced), 'and `force` makes it throw more loudly, not less: there is no quiet path to a fake exhaustive claim');
  let shape = '';
  try { bruteSolve({ n: 4, cells: [1, 2, 3] }); } catch (err) { shape = err.message; }
  ok(/bad puzzle/.test(shape), 'a board whose cells do not match its size is rejected before any subset is tested');
});

test('verifyShading names the rule that objects', () => {
  eq(verifyShading(FIXTURE_A, FIXTURE_A_SHADED), { rule1: true, rule2: true, rule3: true, ok: true }, 'the hand-copied seven pass all three');
  eq(verifyShading(FIXTURE_B, FIXTURE_B_SHADED), { rule1: true, rule2: true, rule3: false, ok: false }, 'cell 12 is cut off and nothing else objects: rule 3 standing alone');
  eq(verifyShading(FIXTURE_C, FIXTURE_C_SHADED_ALT), { rule1: true, rule2: true, rule3: true, ok: true }, 'the same six cells without 14 are legal once the pair is gone: that is C second solution');
  let off = '';
  try { verifyShading(FIXTURE_B, [99]); } catch (err) { off = err.message; }
  ok(/off the board/.test(off), 'a cell index outside the grid is a caller bug, not a shading');
});

// --- the 4x4 exhaustive cross-check ----------------------------------------------

test('every 4x4 subset: three independent checkers, one answer', () => {
  for (const p of [FIXTURE_B, TRIPLE_ROW_4X4()]) {
    const t = sweepCounts(p);
    eq([t.naive, t.viaAudit, t.viaBrute], [t.naive, t.naive, t.naive], 'the local naive checker, rules.js and brute.js agree on all 65,536 subsets');
    const b = bruteSolve(p);
    eq(b.count, t.naive, 'and the enumeration inside brute.js reports the same number of legal shadings');
    eq(b.subsetsChecked, SUBSETS_4X4, 'that really was every subset');
    eq(b.complete, true);
  }
});
function TRIPLE_ROW_4X4() {
  // a 4x4 with one row of three equal digits plus filler, so all three kinds of objection
  // get exercised on the same board
  return { n: 4, cells: [7, 7, 7, 2, 2, 3, 4, 1, 3, 4, 1, 2, 4, 1, 2, 3] };
}

test('solver against the exhaustive list, board by board, on the shipped 4x4 pool', () => {
  const rows = LOTS.filter((r) => r.n === 4);
  eq(rows.length, 20, 'ten nook + ten quiet, all 4x4');
  let subsets = 0;
  const disagreements = [];
  for (const row of rows) {
    const p = board(row);
    const b = bruteSolve(p);
    subsets += b.subsetsChecked;
    const s = solve(p, { limit: 2 });
    const same = b.count === s.solutionCount && keyOf(b.solutions) === keyOf(s.solutions);
    if (!same) disagreements.push(`${row.id}: brute ${b.count} ${keyOf(b.solutions)} vs solver ${s.solutionCount} ${keyOf(s.solutions)}`);
  }
  eq(disagreements, [], 'no board disagrees, on count or on which shading');
  eq(subsets, 20 * SUBSETS_4X4, '1,310,720 subsets were actually tested to reach that sentence');
});

test('a unique 4x4 board has exactly one legal subset, by the naive sweep too', () => {
  const row = LOTS.find((r) => r.n === 4);
  const p = board(row);
  const t = sweepCounts(p);
  eq(t.naive, 1, 'one legal shading out of 65,536 — which is what "unique" is allowed to mean');
  eq(keyOf(t.legal), row.solution.join(','), 'and it is the shading printed in the data file');
});

test('fixture D: the hand-counted five, from both routes', () => {
  const b = bruteSolve(FIXTURE_D);
  eq([b.count, b.subsetsChecked], [FIXTURE_D_COUNT, 16], '2x2 -> 16 subsets, 5 legal');
  eq(keyOf(b.solutions), keyOf(FIXTURE_D_SOLUTIONS), 'the five written out in fixtures.mjs, setwise');
  eq(b.solutions[0], [], 'enumeration starts at the empty shading, so the first one is the all-open board');
  const t = sweepCounts(FIXTURE_D);
  eq(t.naive, FIXTURE_D_COUNT, 'and the in-test checker counts the same five');
});

test('fixture B has hundreds of legal shadings, all of them found twice', () => {
  const b = bruteSolve(FIXTURE_B);
  const t = sweepCounts(FIXTURE_B);
  eq(b.count, t.naive, 'one number, four ways of reaching it');
  eq([t.viaAudit, t.viaBrute], [b.count, b.count]);
  ok(b.count > 1, 'a cyclic Latin square is the opposite of a puzzle');
  const s = solve(FIXTURE_B, { limit: 700 });
  eq(keyOf(s.solutions), keyOf(b.solutions), 'the solver, asked for everything, returns the same list');
  ok(!b.solutions.some((x) => x.join(',') === FIXTURE_B_SHADED.join(',')), 'and the rule-3 negative shading is not among them');
});

// --- sampling for 5x5 and up -----------------------------------------------------

test('bruteSample is honest about what it did not do', () => {
  const r = bruteSample(FIXTURE_A, { subsets: 0, around: [FIXTURE_A_SHADED], seed: 'hitori-test' });
  eq([r.mode, r.complete, r.count], ['sample', false, 1], 'one shading found, and no claim of exhaustion');
  eq(r.subsetsChecked, 2626, '1 + 25 + C(25,2) + C(25,3) = 2,626 distinct subsets within three flips of the certified answer');
  eq(keyOf(r.solutions), FIXTURE_A_SHADED.join(','), 'the certified shading is the only one nearby');
  eq(r.randomDraws, 0, 'the random budget was spent on nothing, and the row says so');
});

test('the random draws exercise the checkers without finding anything illegal', () => {
  const r = bruteSample(FIXTURE_A, { subsets: 20000, around: [FIXTURE_A_SHADED], seed: 'hitori-test' });
  ok(r.subsetsChecked > 20000 + 2600, `${r.subsetsChecked} distinct subsets tested`);
  eq(r.count, 1, 'and among twenty thousand half-black random boards not one is legal — the reason generation cannot be a search for solutions');
  const again = bruteSample(FIXTURE_A, { subsets: 20000, around: [FIXTURE_A_SHADED], seed: 'hitori-test' });
  eq([again.subsetsChecked, keyOf(again.solutions)], [r.subsetsChecked, keyOf(r.solutions)], 'same seed, same sample: the cross-check is reproducible');
  const other = bruteSample(FIXTURE_A, { subsets: 20000, around: [FIXTURE_A_SHADED], seed: 'another-seed' });
  eq(other.count, 1, 'a different sample of twenty thousand also turns up nothing but the certified shading');
  ok(other.randomDraws === r.randomDraws && other.neighbourhoodFlips === r.neighbourhoodFlips, 'the budget reported is the budget spent');
});

test('every 5x5 and 6x6 row in the pool: the certified shading is legal and alone nearby', () => {
  const rows = LOTS.filter((r) => r.n >= 5);
  eq(rows.length, 20, 'ten study + ten retreat');
  let sampled = 0;
  const problems = [];
  for (const row of rows) {
    const p = board(row);
    const r = bruteSample(p, { subsets: 20000, around: [row.solution], seed: row.id });
    sampled += r.subsetsChecked;
    if (r.mode !== 'sample') problems.push(`${row.id}: mode ${r.mode}`);
    if (keyOf(r.solutions) !== row.solution.join(',')) problems.push(`${row.id}: sampled shadings ${keyOf(r.solutions)}`);
    const s = solve(p, { limit: 2 });
    if (s.solutionCount !== 1 || s.solutions[0].join(',') !== row.solution.join(',')) problems.push(`${row.id}: solver ${s.solutionCount} ${keyOf(s.solutions)}`);
  }
  eq(problems, [], 'no board in the shipped pool contradicts its own measurement');
  ok(sampled > 20 * 20000, `${sampled.toLocaleString('en-US')} sampled subsets in total, which is far short of 2^25 and 2^36 and is documented as such`);
});

test('sampling around a wrong answer finds the right one instead of confirming it', () => {
  // C's second shading (the six cells without 14) seeded on A: A must reject it on rule 1,
  // and the neighbourhood sweep must still turn up A's own seven.
  const r = bruteSample(FIXTURE_A, { subsets: 0, around: [FIXTURE_C_SHADED_ALT], seed: 'wrong' });
  eq(keyOf(r.solutions), FIXTURE_A_SHADED.join(','), 'the seed was rejected; the answer one flip away was not');
});

run();
