// The counter and the effort meter. This is the module the whole game's claim rests on, so
// the numbers it is tested against are written out by hand here — from the derivations in
// DESIGN.md ("fixture A/B/C/D"), not from a run of the code.
//
// Fixture A is the load-bearing case: its propagation table is asserted cell by cell, which
// means a tactic that starts firing on the wrong board shows up as 25 characters disagreeing.

import { test, run, ok, eq } from '../tools/harness.mjs';
import {
  FIXTURE_A, FIXTURE_A_SHADED, FIXTURE_B, FIXTURE_C, FIXTURE_C_SHADED, FIXTURE_C_SHADED_ALT,
  FIXTURE_D, FIXTURE_D_COUNT, FIXTURE_D_SOLUTIONS, TRIPLE_ROW,
} from './fixtures.mjs';
import {
  solve, propagate, facts, UNKNOWN, MUST_OPEN, MUST_SHADED,
} from '../js/core/solve.js';
import { marksFromShaded, blankMarks, cellsKey } from '../js/core/grid.js';
import { audit } from '../js/core/rules.js';
import { bruteSolve, verifyShading } from '../js/core/brute.js';
import { LOTS } from '../js/data/lots.js';

// A candidate state written as a string, one character per cell, for legible diffs:
// 0 = 未知, 1 = 必留白, 2 = 必涂黑.
const show = (cand) => cand.join('');

// Fixture A's propagation table, derived by hand in fixtures.mjs and DESIGN.md:
//   row 0 1 1 1 -> sandwich: black at 1 and 3, cell 2 stays 白   => 1 2 1 2 1
//   row 1 nothing is decided about this row by itself; every cell in it touches a black
//     in row 0 or row 2, so rule 2 makes all five 白              => 1 1 1 1 1
//   row 2 2 2 2 -> black at 10 and 12, cell 11 白, and the pair (13,14) with 13 白 forces
//     14 black                                                    => 2 1 2 1 2
//   row 3 as row 1                                              => 1 1 1 1 1
//   row 4 3 3 3 -> black at 21 and 23, cell 22 白                => 1 2 1 2 1
const A_TABLE = '12121' + '11111' + '21212' + '11111' + '12121';

test('the candidate vocabulary is three states and no more', () => {
  eq([UNKNOWN, MUST_OPEN, MUST_SHADED], [0, 1, 2], 'a solver proves cells, it never "dots" one');
});

test('facts() finds exactly the three sandwiches and the two corner Ls in fixture A', () => {
  const f = facts(FIXTURE_A);
  eq(f.triples, [[1, 2, 3], [10, 11, 12], [21, 22, 23]], 'rows 0, 2 and 4; no column of A has three in a row');
  eq(f.pairs.length, 12, 'the same 12 pairs rules.duplicateViolations counts on an empty board');
  // Two L-shaped triples, each found by hand: (13,14,19) all 4 with the vertex at 14, and
  // (16,21,22) all 3 with the vertex at 21. The fourth cell of each 2x2 block is the far
  // corner T4 would force open.
  eq(f.corners, [[14, 13, 19, 18], [21, 16, 22, 17]], 'both vertices, their two arms and the far corner');
  eq(f.corners.map((q) => q.map((i) => FIXTURE_A.cells[i])), [[4, 4, 4, 6], [3, 3, 3, 5]], 'the three arms do carry the same digit, the far corner need not');
  eq(f.adj[12], [7, 11, 13, 17], 'the neighbour list is the one rule 2 uses');
});

test('propagate solves fixture A with no assumption at all', () => {
  const f = facts(FIXTURE_A);
  const cand = new Array(25).fill(UNKNOWN);
  eq(propagate(FIXTURE_A, f, cand), true, 'no contradiction');
  eq(show(cand), A_TABLE, 'the hand-derived table, cell by cell');
  eq(cand.filter((c) => c === UNKNOWN).length, 0, 'nothing left to guess about');
  eq(cand.map((c, i) => (c === MUST_SHADED ? i : -1)).filter((i) => i >= 0), FIXTURE_A_SHADED, 'the blacks it derived are the hand-copied seven');
});

test('T2 spreads from one black and stops there on a board rule 1 cannot see', () => {
  // FIXTURE_B is a cyclic Latin square: no equal pair anywhere, so shading one cell can
  // only ever decide its four orthogonal neighbours.
  const f = facts(FIXTURE_B);
  eq([f.pairs.length, f.triples.length, f.corners.length], [0, 0, 0], 'rule 1 has literally nothing to say about this board');
  const cand = new Array(16).fill(UNKNOWN);
  cand[5] = MUST_SHADED;
  eq(propagate(FIXTURE_B, f, cand), true);
  eq(show(cand), '0100121001000000', 'cells 1, 4, 6, 9 become 必留白 and nothing else moves');
  const blacks = cand.map((c, i) => (c === MUST_SHADED ? i : -1)).filter((i) => i >= 0);
  eq(blacks, [5], 'no second black is forced — so this board is nowhere near a puzzle');
});

test('T3 on four equal digits in a row is a contradiction, not a puzzle', () => {
  // Hand: 6 6 6 6. The first triple demands 0 and 2 black, 1 white; the second demands 1
  // black and 2 white. Nothing else on this board has a duplicate pair.
  const four = { n: 4, cells: [6, 6, 6, 6, 1, 2, 3, 4, 2, 3, 4, 1, 3, 4, 1, 2] };
  const f = facts(four);
  eq(f.triples, [[0, 1, 2], [1, 2, 3]]);
  eq(propagate(four, f, new Array(16).fill(UNKNOWN)), false, 'the two sandwiches disagree about cells 1 and 2');
  const r = solve(four);
  eq([r.solutionCount, r.unique, r.invalid], [0, false, 0], 'an over-constrained board reports zero solutions rather than crashing');
});

test('T1 does the last step of fixture A: a dotted partner blackens cell 14', () => {
  const f = facts(FIXTURE_A);
  const cand = new Array(25).fill(UNKNOWN);
  cand[12] = MUST_SHADED;
  eq(propagate(FIXTURE_A, f, cand), true);
  eq([cand[13], cand[14]], [MUST_OPEN, MUST_SHADED], '13 is 白 because 12 is black, so its equal partner 14 has to go');
  eq(cand[0], MUST_OPEN, 'and cell 0, next to the seeded black at 1, is 白 too');
});

test('the corner vertex of A cannot stay on the board', () => {
  // Hand: cell 14 is the vertex of the 4-L (13, 14, 19). Suppose it stays open. The row-2
  // sandwich blacks cell 12, which forces 13 open by rule 2, and 13 is 14's equal partner —
  // so 14 has to go black. The hypothesis refutes itself, which is exactly what `false`
  // means to propagate() and what the counter then reads as "this branch is dead".
  const f = facts(FIXTURE_A);
  const cand = new Array(25).fill(UNKNOWN);
  cand[14] = MUST_OPEN;
  eq(propagate(FIXTURE_A, f, cand), false, 'open 14 contradicts the sandwich two cells to its left');
});

test('T4 is sound and, in this tactic order, never needed', () => {
  // The corner rule's conclusion is entailed by T1 + T2 in any state (an open vertex blacks
  // both arms by the pair rule, and a cell between two arms is opened by rule 2 again), so
  // stripping the corner facts must not move a single measurement. Measured on fixture A and
  // on the shipped boards rather than asserted: js/core/make.js keeps T4 in the human
  // vocabulary the rules card teaches, and this test is what stops it becoming a ghost.
  const boards = [FIXTURE_A, FIXTURE_C, FIXTURE_D];
  for (const row of LOTS.slice(0, 8)) boards.push({ n: row.n, cells: row.cells });
  for (const p of boards) {
    const withT4 = solve(p, { limit: 2 });
    const f = facts(p);
    const without = solve(p, { limit: 2, facts: Object.assign({}, f, { corners: [] }) });
    eq(
      [withT4.solutionCount, withT4.depth, withT4.guesses, withT4.nodes],
      [without.solutionCount, without.depth, without.guesses, without.nodes],
      `corner rule contributes nothing on ${cellsKey(p).slice(0, 12)}...`,
    );
  }
});

test('fixture A has exactly one solution, and it is the hand-copied shading', () => {
  const r = solve(FIXTURE_A);
  eq(r.solutionCount, 1, 'the claim this game ships on');
  eq(r.solutions, [FIXTURE_A_SHADED], 'the seven cells, in the order they were written down');
  eq([r.unique, r.invalid, r.truncated], [true, 0, false]);
  eq([r.depth, r.guesses, r.nodes], [0, 0, 1], 'the hand proof needs no assumption, so the meter must read zero');
  eq(audit(FIXTURE_A, marksFromShaded(FIXTURE_A, r.solutions[0])).violations.length, 0, 'and rules.js agrees the board is clean');
});

test('fixture C: erasing one duplicate pair leaves cell 14 optional', () => {
  const r = solve(FIXTURE_C, { limit: 2 });
  eq(r.solutionCount, 2, 'two shadings survive — this is the >=2 case that must never ship');
  eq(r.solutions.map((s) => s.join(',')).sort(), [FIXTURE_C_SHADED, FIXTURE_C_SHADED_ALT].map((s) => s.join(',')).sort(), 'and they are the two written out by hand');
  eq(r.unique, false);
  eq([r.depth, r.guesses], [1, 1], 'A is forced everywhere; C differs in one cell, so one branch at depth one');
  // Both of them are legal boards, by the independent rule checkers.
  eq([verifyShading(FIXTURE_C, FIXTURE_C_SHADED).ok, verifyShading(FIXTURE_C, FIXTURE_C_SHADED_ALT).ok], [true, true]);
  // The second one is only legal because the pair is gone: on A the same six blacks break
  // rule 1 (cells 13 and 14 both print 4) and nothing else.
  eq(verifyShading(FIXTURE_A, FIXTURE_C_SHADED_ALT), { rule1: false, rule2: true, rule3: true, ok: false }, 'fewer blacks can never break rule 2 or rule 3, so only rule 1 can object');
});

test('the cap is honoured: limit 1 stops the count at one without proving anything', () => {
  const one = solve(FIXTURE_C, { limit: 1 });
  eq([one.solutionCount, one.unique, one.capped], [1, false, true], 'a search that stopped because it was told to has proven nothing: unique stays false');
  eq(one.solutions, [FIXTURE_C_SHADED], 'branch order is black-first, and cell 14 is the branch');
  const two = solve(FIXTURE_C, { limit: 2 });
  eq(two.solutions.length, 2, 'one more leaf and the board is disqualified');
  eq(solve(FIXTURE_A).capped, false, 'a unique board is only called unique by a search that ran out on its own');
});

test('fixture D: five solutions, counted by hand and by a wider cap', () => {
  const capped = solve(FIXTURE_D);
  eq([capped.solutionCount, capped.truncated], [2, false], 'the default cap of 2 stops early and still says not-unique');
  const wide = solve(FIXTURE_D, { limit: 8 });
  eq(wide.solutionCount, FIXTURE_D_COUNT, 'the hand count');
  eq(wide.solutions.map((s) => s.join(',')).sort(), FIXTURE_D_SOLUTIONS.map((s) => s.join(',')).sort(), 'the same five sets, order aside');
  eq(wide.truncated, false, 'and the search actually ran out, which is what makes the count trustworthy');
  const brute = bruteSolve(FIXTURE_D);
  eq([brute.count, brute.subsetsChecked], [FIXTURE_D_COUNT, 16], '4 cells -> 16 subsets, exhaustively, same five');
});

test('TRIPLE_ROW: rule 1 says "split every pair", and the counter agrees', () => {
  // 7 7 7 in row 0 of a 3x3 whose other rows are Latin. Two of the three must be hidden and
  // no two blacks touch, so the only way out is both ends: 0 and 2 black, 1 white. That is
  // the whole clue content of the board, and it leaves the other six cells free — which is
  // why this board can never ship.
  const r = solve(TRIPLE_ROW, { limit: 4 });
  ok(r.solutions.every((s) => s.indexOf(0) >= 0 && s.indexOf(2) >= 0), 'every solution blacks both ends of the triple');
  ok(r.solutions.every((s) => s.indexOf(1) < 0), 'and never its middle');
  ok(r.solutionCount >= 2, 'nothing pins the rest down, so the count is above one');
  eq(r.truncated, false, 'the count is a finished search, not a timeout');
});

test('a node budget that runs out says so instead of reporting a count', () => {
  const r = solve(FIXTURE_B, { nodeLimit: 1 });
  eq([r.truncated, r.unique, r.solutionCount], [true, false, 0], 'only the root fits, so nothing is proven — and truncated boards cannot ship');
  const room = solve(FIXTURE_B, { limit: 700 });
  eq(room.truncated, false, 'given room, the Latin square search finishes');
  ok(room.solutions.some((s) => s.length === 0), 'the all-open board is among them: a Latin square breaks no rule with nothing hidden');
  eq(room.solutionCount, bruteSolve(FIXTURE_B).count, 'and the exhaustive enumeration in js/core/brute.js returns the same number of shadings');
  ok(room.depth > 0 && room.guesses > 0, 'a board with no clues is found by branching, which is exactly what the meter is for');
});

test('solve() never writes into the puzzle it is handed', () => {
  const before = cellsKey(FIXTURE_A);
  const marksBefore = blankMarks(FIXTURE_A);
  const r = solve(FIXTURE_A);
  eq(cellsKey(FIXTURE_A), before, 'the digits are untouched');
  eq(FIXTURE_A.cells.length, 25);
  eq(marksBefore.filter((m) => m !== 0).length, 0, 'and the helper array the caller kept is still blank');
  r.solutions[0].push(999);
  const again = solve(FIXTURE_A);
  eq(again.solutions[0], FIXTURE_A_SHADED, 'a caller cannot corrupt the next answer by mutating the last one');
});

test('the same board always measures the same', () => {
  const a = solve(FIXTURE_C, { limit: 2 });
  const b = solve(FIXTURE_C, { limit: 2 });
  eq([a.depth, a.guesses, a.nodes, a.solutions], [b.depth, b.guesses, b.nodes, b.solutions], 'the meter is a function of the board, which is what lets it be printed in a data file');
  const tie = solve(FIXTURE_A, { facts: facts(FIXTURE_A) });
  eq([tie.solutionCount, tie.nodes], [1, 1], 'and reusing a cached fact table does not change it');
});

run();
