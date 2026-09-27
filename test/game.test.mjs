// The player's board: the three-state tap cycle, the win test and the counters the win card
// prints. This is where "a completed but illegal board must not read as a win" lives, so the
// negatives below are stated as final, fully decided boards — an undecided board failing to
// win is not interesting, an *illegal* one is.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { FIXTURE_A, FIXTURE_A_SHADED, FIXTURE_B, FIXTURE_B_SHADED } from './fixtures.mjs';
import {
  createGame, review, minTaps, violationsOf, tap, undo, reset, matchesSolution,
  solutionMarks, undecided, OPEN, SHADED, DOT,
} from '../js/core/game.js';
import { audit } from '../js/core/rules.js';
import { LOTS } from '../js/data/lots.js';

const lotA = { id: 'fixture-a', n: 5, puzzle: FIXTURE_A, solution: FIXTURE_A_SHADED };
const lotB = { id: 'fixture-b', n: 4, puzzle: FIXTURE_B, solution: FIXTURE_B_SHADED };
const row1 = LOTS[0];
const lotRow = { id: row1.id, n: row1.n, puzzle: { n: row1.n, cells: row1.cells }, solution: row1.solution };

const allDots = (n) => new Array(n * n).fill(DOT);
const withShades = (n, shaded) => {
  const m = allDots(n);
  for (const i of shaded) m[i] = SHADED;
  return m;
};

// Drive a game to a fully decided board through the same entry point a finger uses.
function playOut(game, shaded) {
  const total = game.puzzle.n * game.puzzle.n;
  for (let i = 0; i < total; i++) {
    const want = shaded.indexOf(i) >= 0 ? SHADED : DOT;
    let guard = 0;
    while (game.marks[i] !== want) {
      if (++guard > 3) throw new Error(`cell ${i} did not reach ${want}`);
      if (tap(game, i) === null) throw new Error(`tap(${i}) refused on a board that is not done`);
    }
  }
  return game;
}

test('a fresh board is empty, undecided and not won', () => {
  const g = createGame(lotA);
  eq(g.marks, new Array(25).fill(OPEN), '25 cells, no opinion on any of them');
  eq([g.taps, g.fixes, g.done], [0, 0, false]);
  eq(g.history, []);
  const a = review(g);
  eq([a.undecided.length, a.complete, a.clean, a.done], [25, false, true, false], 'an untouched board is clean — which is exactly why `done` also demands every cell be decided');
  eq(undecided(g).length, 25);
  eq(a.forcedOpen, [], 'and with nothing black, rule 2 has forced nothing');
});

test('createGame copies the digits, so play cannot corrupt the pool', () => {
  const before = LOTS[0].cells.join(',');
  const g = createGame(lotRow);
  g.puzzle.cells[0] = 99;
  eq(LOTS[0].cells.join(','), before, 'js/data/lots.js is read-only from here on');
  eq(g.puzzle.cells[0], 99, 'and the game kept its own copy');
});

test('one tap cycles 未涂 → 涂黑 → 打点 → 未涂', () => {
  const g = createGame(lotA);
  eq([tap(g, 7), tap(g, 7), tap(g, 7)], [SHADED, DOT, OPEN], 'three taps, one full turn, and every intermediate state is reachable in one');
  eq(g.taps, 3, 'the counter is taps, not moves: a dot costs what a dot costs');
  eq(g.history, [7, 7, 7]);
  eq([tap(g, 25), tap(g, -1), tap(g, 1.5), tap(g, null)], [null, null, null, null], 'off the board is not a tap');
  eq(g.taps, 3, 'and a refused tap is not counted');
});

test('the cheapest finished board is derived from the shading, not from opinion', () => {
  eq(minTaps(lotA), 7 + 2 * 18, 'seven blacks at one tap, eighteen dots at two: 43');
  eq(minTaps(lotRow), row1.solution.length + 2 * (16 - row1.solution.length));
  const g = playOut(createGame(lotA), FIXTURE_A_SHADED);
  eq([g.taps, g.done, matchesSolution(g)], [43, true, true], 'playing it out takes exactly the printed floor');
});

test('the certified solution wins', () => {
  const g = playOut(createGame(lotA), FIXTURE_A_SHADED);
  const a = review(g);
  eq([a.violations.length, a.components, a.complete, a.done], [0, 1, true, true]);
  eq(a.undecided, []);
  eq(g.marks.filter((m) => m === SHADED).length, 7);
  eq(g.marks.filter((m) => m === DOT).length, 18, 'dotted cells are the player\'s own confirmed 留白');
  eq(a.forcedOpen.length, 18, 'and every one of them was already forced by rule 2 — the faint dots the view paints');
  eq(tap(g, 0), null, 'a won board is locked: the shell cannot tap its way into a second record');
});

test('negative: two adjacent blacks, fully decided, is not a win', () => {
  const g = createGame(lotA);
  g.marks = withShades(5, [1, 3, 4, 10, 12, 14, 21, 23]);
  const a = review(g);
  eq(a.byRule[2].map((v) => v.cells.join('-')), ['3-4'], 'rule 2 names the pair for the highlight');
  eq([a.complete, a.clean, a.done], [true, false, false], 'decided, dirty, lost — the shell says so without ending the game');
  eq(g.done, false, 'review() does not set `done`; only a winning tap does');
  eq(violationsOf(g).length, 1);
  eq(tap(g, 3), DOT, 'one more tap moves the black at 3 out of the way — a violation is feedback, not a punishment');
  const b = review(g);
  eq([b.byRule[2].length, b.byRule[1].length], [0, 1], 'the adjacency is gone, and cells 2 and 3 are now the two 1s left on row 0');
  eq([b.complete, b.done, g.done], [true, false, false], 'still fully decided, still not a win');
});

test('negative: an unsplit duplicate pair, fully decided, is not a win', () => {
  const g = createGame(lotA);
  g.marks = allDots(5);
  const a = review(g);
  eq([a.byRule[1].length, a.complete, a.done], [12, true, false], 'all twenty-five cells say "leave me on the board", so rule 1 reports its twelve pairs');
  eq(g.done, false);
  g.marks = withShades(5, FIXTURE_A_SHADED.filter((i) => i !== 14));
  const b = review(g);
  eq([b.byRule[1].length, b.byRule[2].length, b.byRule[3].length, b.done], [2, 0, 0, false], 'drop the black at cell 14 and its 4 now pairs with both the 4 to its left (13) and the 4 below it (19): two unsplit pairs, one lost board');
});

test('negative: a rule-3 cut is not a win even when the digits are all happy', () => {
  const g = createGame(lotB);
  g.marks = withShades(4, FIXTURE_B_SHADED);
  const a = review(g);
  eq([a.byRule[1].length, a.byRule[2].length, a.byRule[3].length], [0, 0, 1], 'on a cyclic Latin square rules 1 and 2 are satisfied by any shading at all');
  eq([a.components, a.orphans, a.done], [2, [12], false], 'the corner is cut off, so this is a loss and not a win');
});

test('fixes counts the taps that walked into trouble', () => {
  const g = createGame(lotA);
  g.marks = withShades(5, FIXTURE_A_SHADED);
  eq([review(g).violations.length, g.fixes], [0, 0], 'starting from the certified, clean board');
  tap(g, 4);
  eq([g.marks[4], g.fixes], [OPEN, 0], 'the first tap only takes the dot away: no opinion is not a violation');
  tap(g, 4);
  eq([review(g).byRule[2].map((v) => v.cells.join('-')), g.fixes], [['3-4'], 1], 'the second puts a black next to 3, and that step is the mistake counted');
  tap(g, 11);
  tap(g, 11);
  eq([review(g).violations.length, g.fixes], [3, 1], '11 lands between the blacks at 10 and 12: two more violations, no second count, because the board was already dirty');
  tap(g, 11);
  eq([review(g).violations.length, g.fixes], [1, 1], 'back to a dot');
  tap(g, 4);
  eq([review(g).violations.length, g.fixes, g.done], [0, 1, true], 'the detour ends on the certified board: one mistake remembered, and a win');
});

test('undo walks one cell back and recomputes the win', () => {
  const g = playOut(createGame(lotA), FIXTURE_A_SHADED);
  eq([g.done, g.taps], [true, 43]);
  eq(undo(g), true);
  eq([g.taps, g.done], [42, false], 'a tap is counted once and refunded once, and the win goes with it');
  eq(g.marks[24], SHADED, 'cell 24 was dotted, so one step back along the cycle is black');
  const a = review(g);
  eq([a.byRule[2].map((v) => v.cells.join('-')), a.complete], [['23-24'], true], 'and it sits next to the black at 23');
  const fresh = createGame(lotA);
  eq(undo(fresh), false, 'and a board nobody has touched has nothing to take back');
  tap(fresh, 5);
  eq(tap(fresh, 5), DOT);
  eq(undo(fresh), true);
  eq(fresh.marks[5], SHADED, 'undo reverses the cycle, it does not erase to blank');
});

test('reset really puts the board back', () => {
  const g = playOut(createGame(lotA), [1, 3, 10, 12]);
  ok(g.taps > 30, 'this board has been played and left unfinished');
  eq(g.done, false);
  ok(reset(g) === g, 'reset mutates the same game object the shell holds');
  eq([g.taps, g.fixes, g.done, g.history.length], [0, 0, false, 0]);
  eq(g.marks.filter((m) => m !== OPEN).length, 0, 'every cell is 未涂 again');
});

test('solutionMarks is the data file read as a board, for the browser suite', () => {
  const m = solutionMarks(lotRow);
  eq(m.filter((x) => x === SHADED).length, row1.solution.length);
  const a = audit({ n: row1.n, cells: row1.cells }, m);
  eq([a.done, a.violations.length], [true, 0], 'a completed board built from the baked shading passes the rules — the same check the win path makes');
  eq(m, allDots(4).map((x, i) => (row1.solution.indexOf(i) >= 0 ? SHADED : x)));
});

test('every sampled board is winnable by tapping the baked shading, and by nothing else', () => {
  const wrong = [];
  for (const row of LOTS.slice(0, 8)) {
    const lot = { id: row.id, n: row.n, puzzle: { n: row.n, cells: row.cells }, solution: row.solution };
    const g = playOut(createGame(lot), row.solution);
    if (!g.done || !matchesSolution(g)) wrong.push(`${row.id} did not win with its own shading`);
    const flipped = playOut(createGame(lot), row.solution.map((i) => (i + 1) % (row.n * row.n)));
    if (flipped.done) wrong.push(`${row.id} won with the wrong shading`);
    if (matchesSolution(flipped)) wrong.push(`${row.id} matched a shading that is not its solution`);
  }
  eq(wrong, [], 'eight boards across all four bands: the certified shading wins, a rotated one does not');
});

run();
