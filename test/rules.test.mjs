// The three rules, each hit by its own negative case, plus the geometry they are stated on.
//
// Every expectation in this file is hand-derived from the boards written out in
// test/fixtures.mjs (and the derivations recorded in DESIGN.md "fixture A/B/C/D"), not
// read back out of the module under test. Where a number is counted by hand it is written
// as a literal, with the count shown in the comment, so a future edit that changes a rule
// reading has somewhere to disagree with.

import { test, run, ok, eq } from '../tools/harness.mjs';
import {
  FIXTURE_A, FIXTURE_A_SHADED, FIXTURE_B, FIXTURE_B_SHADED, FIXTURE_C, FIXTURE_D,
  TRIPLE_ROW, ADJACENT_PAIR,
} from './fixtures.mjs';
import {
  OPEN, SHADED, DOT, MARK_NAMES, nextMark, isUnshaded, validatePuzzle, size, at, idxOf,
  xyOf, lines, neighbours, duplicatePairs, blankMarks, marksFromShaded, shadedOf,
  undecidedOf, cloneMarks, cellsKey, shadingKey,
} from '../js/core/grid.js';
import {
  UnionFind, duplicateViolations, openConflicts, adjacencyViolations, connectivity,
  forcedOpen, audit, isSolution, shadingIsValid,
} from '../js/core/rules.js';

// --- vocabulary ------------------------------------------------------------------

test('the three marks are 0/1/2 in tap order and cycle 未涂→涂黑→打点→未涂', () => {
  eq([OPEN, SHADED, DOT, MARK_NAMES], [0, 1, 2, ['open', 'shaded', 'dot']], 'the paint switch in js/view.js depends on these exact values');
  eq([nextMark(OPEN), nextMark(SHADED), nextMark(DOT)], [SHADED, DOT, OPEN], 'one tap per state, three taps per round trip');
  eq([isUnshaded(OPEN), isUnshaded(DOT), isUnshaded(SHADED)], [true, true, false], 'a dot is an opinion about the same thing an empty cell is: not black');
});

test('validatePuzzle takes a real board and rejects the shapes that would silently mis-size one', () => {
  eq(validatePuzzle(FIXTURE_A), null, 'fixture A is a well formed 5x5');
  eq(validatePuzzle({ n: 1, cells: [1] }), 'n must be an integer in 2..9, got 1');
  eq(validatePuzzle({ n: 10, cells: new Array(100).fill(1) }), 'n must be an integer in 2..9, got 10', 'a 10x10 board is outside the class this game ships');
  eq(validatePuzzle({ n: 4, cells: [1, 2, 3] }), 'cells must be an array of length 16, got 3');
  eq(validatePuzzle({ n: 3, cells: [0, 1, 2, 3, 4, 5, 6, 7, 8] }), 'cell values must be integers in 1..99, got 0', 'a printed 0 would be indistinguishable from an empty cell in the data file');
  eq(validatePuzzle({ n: 3, cells: new Array(9).fill(1.5) }), 'cell values must be integers in 1..99, got 1.5');
  eq(validatePuzzle(null), 'puzzle must be an object');
});

// --- geometry ---------------------------------------------------------------------

test('lines, neighbours and coordinates are orthogonal only', () => {
  eq(size(FIXTURE_B), 16);
  eq(lines(FIXTURE_B).length, 8, '4 rows + 4 columns');
  eq(lines(FIXTURE_B)[0], [0, 1, 2, 3]);
  eq(lines(FIXTURE_B)[4], [0, 4, 8, 12], 'column 0 runs down the board, row-major indices step by n');
  eq(neighbours(FIXTURE_B, 0), [1, 4], 'a corner has two neighbours, not three');
  eq(neighbours(FIXTURE_B, 5), [1, 4, 6, 9], 'an interior cell has four');
  eq(neighbours(FIXTURE_B, 15), [11, 14], 'the far corner mirrors the near one');
  eq([idxOf(FIXTURE_B, 2, 1), xyOf(FIXTURE_B, 6)], [6, { x: 2, y: 1 }], 'index and coordinate agree both ways');
  eq(at(FIXTURE_A, 4, 2), 4, 'row 2 of A is 2,2,2,4,4');
  eq(cellsKey({ n: 2, cells: [1, 2, 3, 1] }), '1,2,3,1', 'the form the signature and the hand-copied boards are written in');
});

test('duplicatePairs restates rule 1 as a clue list, counted by hand on fixture A', () => {
  // row 0: 5 1 1 1 2   -> the three 1s give 3 pairs
  // row 1: 3 5 4 2 1   -> none
  // row 2: 2 2 2 4 4   -> 3 + 1 = 4 pairs
  // row 3: 1 3 5 6 4   -> none
  // row 4: 4 3 3 3 5   -> 3 pairs
  // cols:  5 3 2 1 4 / 1 5 2 3 3 / 1 4 2 5 3 / 1 2 4 6 3 / 2 1 4 4 5 -> 0 + 1 + 0 + 0 + 1
  // total: 3 + 4 + 3 + 1 + 1 = 12
  const pairs = duplicatePairs(FIXTURE_A);
  eq(pairs.length, 12, 'hand count');
  ok(pairs.some((q) => q[0] === 1 && q[1] === 3), 'the two ends of the row-0 sandwich are a pair');
  ok(pairs.some((q) => q[0] === 13 && q[1] === 14), 'the 4-pair that pins cell 14 is a pair');
  eq(pairs, [...pairs].sort((u, v) => (u[0] - v[0]) || (u[1] - v[1])), 'ascending, so a signature of it is stable');
  eq(duplicatePairs(FIXTURE_B).length, 0, 'a cyclic Latin square has no pair anywhere: rule 1 is silent on it');
});

// --- rule 1 ----------------------------------------------------------------------

test('rule 1 negative: three copies need two blacks, not one', () => {
  // 7 7 7 in row 0. Shading only cell 0 leaves cells 1 and 2 both printed and equal.
  const one = marksFromShaded(TRIPLE_ROW, [0]);
  const v = duplicateViolations(TRIPLE_ROW, one);
  eq(v, [{ rule: 1, cells: [1, 2], value: 7 }], 'the surviving pair is named, with its digit, for the highlight');
  const two = marksFromShaded(TRIPLE_ROW, [0, 2]);
  eq(duplicateViolations(TRIPLE_ROW, two), [], 'the sandwich solution (both ends black) does satisfy rule 1');
  eq(duplicateViolations(TRIPLE_ROW, blankMarks(TRIPLE_ROW)).length, 3, 'an untouched board reports all three pairs of the triple');
});

test('rule 1 reads only unshaded digits, so dotted cells still count', () => {
  const marks = blankMarks(FIXTURE_A).map((m, i) => (i === 1 || i === 2 ? DOT : m));
  const v = duplicateViolations(FIXTURE_A, marks);
  ok(v.some((x) => x.cells.join(',') === '1,2'), 'cells 1 and 2 are both dotted, so both are still on the board and the pair still bites');
  eq(v.length, 12, 'dotted cells are unshaded cells: nothing about the count changed');
  const nulled = marksFromShaded(FIXTURE_A, [1]);
  eq(duplicateViolations(FIXTURE_A, nulled).length, 10, 'hiding cell 1 kills exactly the two pairs it was in: (1,2) and (1,3)');
});

// --- rule 1 on a half-played board -------------------------------------------------

test('audit reads claimed conflicts, so an untouched board shows no red', () => {
  const blank = blankMarks(FIXTURE_A);
  eq(duplicateViolations(FIXTURE_A, blank).length, 12, 'the strict reading sees all 12 hand-counted pairs');
  eq(openConflicts(FIXTURE_A, blank), [], 'but 未涂 is not an assertion, so the player has claimed none of them');
  eq(audit(FIXTURE_A, blank).violations, [], 'and therefore a fresh board is clean');
  // 打点 is an assertion: two dotted equal digits on one line is a pair the player wrote down.
  const dotted = blank.map((m, i) => (i === 1 || i === 2 ? DOT : m));
  eq(openConflicts(FIXTURE_A, dotted), [{ rule: 1, cells: [1, 2], value: 1 }], 'named with its digit, same shape as the strict reading');
  eq(audit(FIXTURE_A, dotted).clean, false, 'so the highlight fires on what was actually claimed');
  // Shading one side is a repair: the strict count and the claimed count agree again at 0.
  eq([openConflicts(FIXTURE_A, marksFromShaded(FIXTURE_A, [1])).length,
    duplicateViolations(FIXTURE_A, marksFromShaded(FIXTURE_A, [1])).length], [0, 10],
  'cell 1 black: the pairs it was in are gone, and the 10 survivors are still undecided');
});

test('the two readings of rule 1 coincide on every completed board, exhaustively', () => {
  // With no 未涂 cell left, isUnshaded is exactly DOT, so the lenient source audit uses cannot
  // answer differently from the strict one. Enumerating every SHADED/DOT assignment is what makes
  // that swap free for isSolution, the solver and brute.js's cross-check — those never see a
  // half-played board, so nothing about the win test moved.
  for (const p of [FIXTURE_D, TRIPLE_ROW, ADJACENT_PAIR]) {
    const total = size(p);
    let boards = 0;
    let mismatched = 0;
    for (let mask = 0; mask < (1 << total); mask++) {
      const marks = [];
      for (let i = 0; i < total; i++) marks.push((mask >> i) & 1 ? DOT : SHADED);
      const a = audit(p, marks);
      if (!a.complete) mismatched++;
      if (JSON.stringify(a.byRule[1]) !== JSON.stringify(duplicateViolations(p, marks))) mismatched++;
      if (a.clean !== duplicateViolations(p, marks).length + adjacencyViolations(p, marks).length + a.byRule[3].length === 0) mismatched++;
      boards++;
    }
    eq([boards, mismatched], [1 << total, 0], `${total} cells, every completed board, both readings and \`clean\` identical`);
  }
});

// --- rule 2 ----------------------------------------------------------------------

test('rule 2 negative: two blacks sharing an edge', () => {
  eq(adjacencyViolations(ADJACENT_PAIR, marksFromShaded(ADJACENT_PAIR, [0, 1])), [{ rule: 2, cells: [0, 1] }]);
  eq(adjacencyViolations(ADJACENT_PAIR, marksFromShaded(ADJACENT_PAIR, [0, 2])), [], '0 and 2 sit two apart in the same row: no shared edge');
  eq(adjacencyViolations(ADJACENT_PAIR, marksFromShaded(ADJACENT_PAIR, [0, 4])), [], 'diagonals are not adjacency — the frozen wording says orthogonal');
  eq(adjacencyViolations(ADJACENT_PAIR, marksFromShaded(ADJACENT_PAIR, [3, 6, 7])).length, 2, '3|6 down column 0 and 6|7 along row 2: two edges, reported once each');
});

// --- rule 3 ----------------------------------------------------------------------

test('rule 3 negative: a shading that passes rules 1 and 2 and still cuts the board', () => {
  const marks = marksFromShaded(FIXTURE_B, FIXTURE_B_SHADED);
  const c = connectivity(FIXTURE_B, marks);
  eq([c.components, c.orphans], [2, [12]], 'cell 12 has both its neighbours black, so it stands alone');
  eq([duplicateViolations(FIXTURE_B, marks).length, adjacencyViolations(FIXTURE_B, marks).length], [0, 0], 'and nothing else objects: this is rule 3 on its own');
  const a = audit(FIXTURE_B, marks);
  eq([a.byRule[1].length, a.byRule[2].length, a.byRule[3].length, a.clean, a.done], [0, 0, 1, false, false]);
});

test('connectivity: all-black, all-open and single-float cases', () => {
  const all = new Array(16).fill(SHADED);
  const dead = connectivity(FIXTURE_B, all);
  eq([dead.components, dead.unshaded, dead.orphans.length], [0, 0, 0], 'an empty unshaded set is not "disconnected", it is a lost board');
  const open = connectivity(FIXTURE_B, new Array(16).fill(OPEN));
  eq([open.components, open.unshaded, open.orphans.length], [1, 16, 0]);
  eq([...open.roots], [0], 'one root for one piece');
  eq(connectivity(FIXTURE_B, [DOT, ...new Array(15).fill(SHADED)]).components, 1, 'one unshaded cell is trivially connected to itself');
  // blacks on the four corners: the remaining 12 cells form one piece
  eq(connectivity(FIXTURE_B, marksFromShaded(FIXTURE_B, [0, 3, 12, 15])).components, 1);
  // blacks on the main diagonal: you cannot step from one side to the other without using
  // a corner, so a diagonal wall *does* separate. Hand-drawn: above/right of the wall
  // 1,2,3,6,7,11; below/left of it 4,8,9,12,13,14. The first unshaded cell is 1, so the
  // second group are the orphans. This is what "orthogonal" costs, and it is why rule 3
  // cannot be dropped: this shading breaks nothing else on a Latin square.
  const wall = connectivity(FIXTURE_B, marksFromShaded(FIXTURE_B, [0, 5, 10, 15]));
  eq([wall.components, wall.unshaded, wall.orphans], [2, 12, [4, 8, 9, 12, 13, 14]], 'a full diagonal wall splits the board');
  // break the wall by leaving 15 open and the two halves meet again through it
  eq(connectivity(FIXTURE_B, marksFromShaded(FIXTURE_B, [0, 5, 10])).components, 1, 'one hole in the wall is a road');
});

// --- forced open ------------------------------------------------------------------

test('forcedOpen is a hint about rule 2, never an answer', () => {
  eq(forcedOpen(FIXTURE_A, blankMarks(FIXTURE_A)), [], 'nothing is decided yet');
  // hand proof of A: after the three sandwiches and cell 14, the remaining 18 cells each
  // touch one of the seven blacks, and none of the seven is itself a neighbour of a black.
  const marks = marksFromShaded(FIXTURE_A, FIXTURE_A_SHADED);
  const forced = forcedOpen(FIXTURE_A, marks);
  eq(forced.length, 18, '18 of the 25 cells are already decided by rule 2 alone');
  eq(forced.filter((i) => FIXTURE_A_SHADED.indexOf(i) >= 0), [], 'no black cell is ever "forced open"');
  eq(forced, [...forced].sort((u, v) => u - v), 'ascending for the paint loop');
});

// --- audit ------------------------------------------------------------------------

test('audit keeps "no violations" and "finished" apart', () => {
  const certified = marksFromShaded(FIXTURE_A, FIXTURE_A_SHADED);
  const a = audit(FIXTURE_A, certified);
  eq([a.violations.length, a.components, a.complete, a.done], [0, 1, false, false], 'an undecided board is clean but not solved — otherwise an untouched grid would win on load');
  eq(a.undecided.length, 18, '25 cells, 7 black, and marksFromShaded leaves the rest as 未涂');
  const dotted = certified.map((m) => (m === SHADED ? SHADED : DOT));
  const b = audit(FIXTURE_A, dotted);
  eq([b.clean, b.complete, b.done, b.undecided.length], [true, true, true, 0], 'the same shading, every cell having an opinion, is a finished board');
  eq(isSolution(FIXTURE_A, dotted), true);
  eq(shadingIsValid(FIXTURE_A, FIXTURE_A_SHADED), true, 'the data-file form of a solution');
  eq(shadingIsValid(FIXTURE_A, FIXTURE_A_SHADED.slice(1)), false, 'drop cell 1 and the two surviving 1s in row 0 print side by side');
  eq(shadingIsValid(FIXTURE_A, [1, 3, 10, 12, 21, 23]), false, 'drop cell 14 and A dies on rule 1 — on fixture C the same shading is legal');
});

test('audit reports every rule it sees at once', () => {
  // A's certified seven, plus cell 4 (next to 3), 13 (between 12 and 14) — hand count of
  // the black-black edges that appear: 3|4, 12|13, 13|14. Every printed digit is still
  // unique on its line, so rule 1 says nothing and rule 3 says nothing either.
  const marks = marksFromShaded(FIXTURE_A, [1, 3, 4, 10, 12, 13, 14, 21, 23]);
  const a = audit(FIXTURE_A, marks);
  eq([a.byRule[1].length, a.byRule[2].length, a.byRule[3].length], [0, 3, 0], 'three adjacencies, nothing else');
  eq(a.violations.map((v) => v.cells.join('-')), ['3-4', '12-13', '13-14']);
  eq(a.clean, false);
  eq(a.done, false);
});

// --- helpers ---------------------------------------------------------------------

test('mark helpers round-trip the shading form the data file uses', () => {
  const marks = marksFromShaded(FIXTURE_A, FIXTURE_A_SHADED);
  eq(shadedOf(marks), FIXTURE_A_SHADED, 'ascending indices, exactly as baked');
  eq(shadingKey(marks), '1+3+10+12+14+21+23');
  eq(undecidedOf(marks).length, 18);
  const copy = cloneMarks(marks);
  copy[0] = DOT;
  eq(marks[0], OPEN, 'a clone is not a reference — the solver must not be able to write through it');
});

// --- union-find ------------------------------------------------------------------

test('the union-find behind rule 3 behaves', () => {
  const uf = new UnionFind(6);
  eq(uf.count, 6);
  eq(uf.union(0, 1), true);
  eq(uf.union(0, 1), false, 'an already-connected pair does not decrement the count twice');
  uf.union(1, 2);
  uf.union(3, 4);
  eq(uf.count, 3, '6 cells, three merges');
  eq([uf.connected(0, 2), uf.connected(0, 3), uf.connected(3, 4)], [true, false, true]);
  uf.union(2, 4);
  eq([uf.count, uf.connected(0, 4)], [2, true]);
  for (let i = 0; i < 200; i++) uf.find(0);
  eq(uf.count, 2, 'path halving is not allowed to change the partition');
});

run();
