// Hand-built boards. Every digit here was written by hand, and every expectation attached
// to them in the test files is hand-derived: DESIGN.md carries the derivation
// ("fixture A/B/C/D"), so a change in the solver that breaks a claim shows up as a red
// test rather than as a re-recorded expectation. Nothing in this file imports core code.
//
// Board convention: cells are row-major, index i = y * n + x.

// --- A ---------------------------------------------------------------------------
// 5x5. Claimed solution: shade [1, 3, 10, 12, 14, 21, 23].
//
//   y=0: 5 1 1 1 2
//   y=1: 3 5 4 2 1
//   y=2: 2 2 2 4 4
//   y=3: 1 3 5 6 4
//   y=4: 4 3 3 3 5
//
// Hand proof of uniqueness, three rule applications per line:
//   * 三明治: row 0 cells x=1,2,3 are all 1 and consecutive -> the two ends are shaded and
//     the middle is open => shade 1, 3; keep 2 open.
//   * 三明治: row 2 x=0,1,2 are all 2 => shade 10, 12; keep 11 open.
//   * 三明治: row 4 x=1,2,3 are all 3 => shade 21, 23; keep 22 open.
//   * 规则 2: 12 is shaded, so its neighbour 13 must stay open.
//   * 重复对: 13 and 14 are both 4 in row 2, 13 is open, so 14 must be shaded. (The 4 below
//     it, at 19, is a second reason for the same black — fixture C removes both.)
//   * 规则 2 maximality: every one of the remaining 18 cells is orthogonally adjacent to
//     one of the seven shaded cells, so no eighth cell can be shaded at all.
// => exactly one shading. And it is legal: the seven are pairwise non-adjacent, the open
// digits are distinct along every line, and rows 1 and 3 are untouched corridors so the
// open area is connected.
export const FIXTURE_A = {
  n: 5,
  cells: [
    5, 1, 1, 1, 2,
    3, 5, 4, 2, 1,
    2, 2, 2, 4, 4,
    1, 3, 5, 6, 4,
    4, 3, 3, 3, 5,
  ],
};
export const FIXTURE_A_SHADED = [1, 3, 10, 12, 14, 21, 23];

// --- C ---------------------------------------------------------------------------
// A with one clue deleted: the 4 at index 14 is changed to 7, which removes both pairs that
// cell sat in — (13, 14) along row 2 and (14, 19) down column 4. Those two pairs were the
// only reason 14 had to be black, so 14 becomes optional and the board has at least two
// shadings. This is the "人为抹掉一条线索 -> ≥2" check on the uniqueness claim, not on a
// weakened ruleset.
export const FIXTURE_C = {
  n: 5,
  cells: [
    5, 1, 1, 1, 2,
    3, 5, 4, 2, 1,
    2, 2, 2, 4, 7,
    1, 3, 5, 6, 4,
    4, 3, 3, 3, 5,
  ],
};
// Both hand-derived shadings of C: A's seven cells, or the same six with 14 left open.
export const FIXTURE_C_SHADED = [1, 3, 10, 12, 14, 21, 23];
export const FIXTURE_C_SHADED_ALT = [1, 3, 10, 12, 21, 23];

// --- B ---------------------------------------------------------------------------
// Rule 3's own negative case. A cyclic Latin square has no equal digits on any line, so
// rule 1 cannot object to anything; the two shaded cells are a knight's move apart, so rule
// 2 is happy too. Only the corner (index 12) being cut off condemns the board.
//
//   y=0: 1 2 3 4        shade (2,0) -> 8 and (1,3) -> 13
//   y=1: 2 3 4 1        cell 12 = (0,3) has exactly two neighbours: (0,2) = 8 above it and
//   y=2: 3 4 1 2        (1,3) = 13 to its right. Both are black, so 12 is unshaded and
//   y=3: 4 1 2 3        reachable from nobody: the unshaded area falls into two pieces.
export const FIXTURE_B = {
  n: 4,
  cells: [
    1, 2, 3, 4,
    2, 3, 4, 1,
    3, 4, 1, 2,
    4, 1, 2, 3,
  ],
};
// Shading 8 and 13: not adjacent to each other (they are a knight's move apart), so rule 2
// passes; the Latin square means rule 1 passes; and cell 12 is now open with both its
// neighbours shaded, so the open area falls into two pieces.
export const FIXTURE_B_SHADED = [8, 13];

// --- rule 1 negatives ------------------------------------------------------------
// A row carrying the same digit three times. Shading one of the three still leaves two
// printed side by side, so "拆开一对" is not enough: all pairs have to be split.
export const TRIPLE_ROW = {
  n: 3,
  cells: [
    7, 7, 7,
    1, 2, 3,
    3, 1, 2,
  ],
};

// Two adjacent equal digits: whichever way it is solved, the two blacks may not touch.
export const ADJACENT_PAIR = {
  n: 3,
  cells: [
    9, 9, 1,
    2, 3, 4,
    4, 1, 2,
  ],
};

// --- D ---------------------------------------------------------------------------
// Hand-countable 2x2. The only equal pair, 1 at index 0 and index 3, sits on a diagonal, so
// rule 1 never fires and every shading that keeps the open area connected is legal:
// the empty shading plus the four single-cell ones. Shading {0, 3} splits the open cells
// {1, 2} (a knight's move apart), and any two-cell shading containing neighbours breaks
// rule 2. Expected solution count: 5.
export const FIXTURE_D = {
  n: 2,
  cells: [1, 2, 3, 1],
};
export const FIXTURE_D_SOLUTIONS = [[], [0], [1], [2], [3]];
export const FIXTURE_D_COUNT = 5;

// The 4x4 cross-check budget asserted in test/brute.test.mjs: every subset, always.
export const SUBSETS_4X4 = 65536;
