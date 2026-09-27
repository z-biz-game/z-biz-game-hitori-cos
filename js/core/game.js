// The player's board: the marks, the tap cycle, and the win test. No pixels, no DOM —
// js/view.js draws what it is handed and js/main.js decides when.
//
// One tap moves a cell through 未涂 → 涂黑 → 打点 → 未涂. There is no long-press and no
// right-click fallback, because the whole game has to be playable with one finger, and
// the three-state cycle is the same one paper solvers use.
//
// The board is never "lost": a violation is highlighted by the shell (see rules.audit)
// and the player keeps tapping. `done` is the only terminal state, and it needs every
// cell decided — otherwise an untouched board would read as a solved one.

import {
  OPEN, SHADED, DOT, nextMark, blankMarks, size, shadedOf, marksFromShaded, undecidedOf,
} from './grid.js';
import { audit } from './rules.js';

export { OPEN, SHADED, DOT };

export function createGame(lot) {
  const puzzle = { n: lot.n, cells: lot.puzzle.cells.slice() };
  return {
    lot,
    puzzle,
    marks: blankMarks(puzzle),
    history: [],
    taps: 0,
    fixes: 0, // taps that walked a clean board into a violation — how often the highlights were stepped over
    done: false,
  };
}

export function review(game) {
  return audit(game.puzzle, game.marks);
}

// The cheapest complete board: one tap per shaded cell, two per dotted one. Printed on the
// win card so "最佳" has a floor to be measured against, derived from the board rather than
// from opinion.
export function minTaps(lot) {
  const total = lot.n * lot.n;
  return lot.solution.length + 2 * (total - lot.solution.length);
}

export function violationsOf(game) {
  return review(game).violations;
}

// Tap one cell. Returns the new mark, or null when the index is off the board.
export function tap(game, i) {
  const total = size(game.puzzle);
  if (!Number.isInteger(i) || i < 0 || i >= total) return null;
  if (game.done) return null;
  game.history.push(i);
  const before = review(game);
  game.marks[i] = nextMark(game.marks[i]);
  game.taps++;
  const after = review(game);
  if (!after.clean && before.clean) game.fixes++;
  if (after.done) game.done = true;
  return game.marks[i];
}

// Step one cell backwards. The mark itself is re-derived by cycling from OPEN, so a
// history entry costs one integer rather than a board copy.
export function undo(game) {
  const i = game.history.pop();
  if (i === undefined) return false;
  const steps = game.marks[i]; // OPEN->SHADED->DOT is one step each
  game.marks[i] = steps === OPEN ? DOT : steps - 1;
  game.taps = Math.max(0, game.taps - 1);
  game.done = review(game).done;
  return true;
}

export function reset(game) {
  game.marks = blankMarks(game.puzzle);
  game.history = [];
  game.taps = 0;
  game.fixes = 0;
  game.done = false;
  return game;
}

// The shell prints this as a sanity net: if a completed, violation-free board ever
// disagreed with the baked unique solution, the generator's premise would be broken.
export function matchesSolution(game) {
  const mine = shadedOf(game.marks).join(',');
  const theirs = game.lot.solution.join(',');
  return mine === theirs;
}

// A finished board that matches the certified solution, expressed the way the data file
// stores it. Used by the browser suite to drive the win path without reading the answer
// off the solver. The unshaded cells come back as DOT, not OPEN: an OPEN cell is no
// opinion, and a board with no opinions is not a finished one.
export function solutionMarks(lot) {
  const marks = new Array(lot.n * lot.n).fill(DOT);
  for (const i of lot.solution) marks[i] = SHADED;
  return marks;
}

export function undecided(game) {
  return undecidedOf(game.marks);
}
