// The second opinion. If the only thing standing between this game and a ship of
// multi-solution boards were js/core/solve.js, the claim would be self-referential: the
// same propagation tactics that find the solution would also be the ones proving it is
// alone. So this file re-answers the question a completely different way — enumerate
// shading subsets and check the three rules directly, from scratch.
//
// Independence is the point, so this module imports nothing from rules.js or solve.js:
// no union-find (a flood fill instead for rule 3), no lines/neighbours helpers (index
// arithmetic redone here), no candidate tactics. It only shares the *wording* of the
// rules, which is what DESIGN.md freezes.
//
//   4x4  -> every one of the 2^16 = 65536 subsets is tested. Exhaustive, not sampling.
//   5x5+ -> 2^25 and up is out of reach for a build step, so `bruteSample` degrades to a
//           seeded sample (random masks plus low-Hamming neighbours of a given shading).
//           How many, and around what, is reported honestly by tools/bake.mjs.

const MAX_FULL_CELLS = 16; // 2^16 = 65536 masks: a few tens of ms. Beyond this, full mode is refused.

export const FULL_SUBSETS = 1 << MAX_FULL_CELLS;

export function canEnumerate(p) {
  return !!p && Number.isInteger(p.n) && p.n * p.n <= MAX_FULL_CELLS;
}

function shapeOk(p) {
  return !!p && Number.isInteger(p.n) && p.n >= 2 && Array.isArray(p.cells) && p.cells.length === p.n * p.n;
}

// --- the three rules, written again on purpose -------------------------------------

// Rule 1: two equal digits still printed on the same line.
function rule1Breaks(n, cells, bit) {
  for (let y = 0; y < n; y++) {
    for (let x1 = 0; x1 < n; x1++) {
      const i = y * n + x1;
      if (bit(i)) continue;
      for (let x2 = x1 + 1; x2 < n; x2++) {
        const j = y * n + x2;
        if (!bit(j) && cells[i] === cells[j]) return true;
      }
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y1 = 0; y1 < n; y1++) {
      const i = y1 * n + x;
      if (bit(i)) continue;
      for (let y2 = y1 + 1; y2 < n; y2++) {
        const j = y2 * n + x;
        if (!bit(j) && cells[i] === cells[j]) return true;
      }
    }
  }
  return false;
}

// Rule 2: two black cells sharing an edge. Right and down only, so each pair is seen once.
function rule2Breaks(n, bit) {
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (!bit(i)) continue;
      if (x + 1 < n && bit(i + 1)) return true;
      if (y + 1 < n && bit(i + n)) return true;
    }
  }
  return false;
}

// Rule 3: flood fill over unshaded cells, then count. Nothing here is shared with the
// union-find in rules.js beyond the definition of a neighbour.
function rule3Breaks(n, bit) {
  const total = n * n;
  let start = -1;
  let unshaded = 0;
  for (let i = 0; i < total; i++) {
    if (!bit(i)) {
      unshaded++;
      if (start < 0) start = i;
    }
  }
  if (unshaded <= 1) return false;
  const seen = new Uint8Array(total);
  const stack = [start];
  seen[start] = 1;
  let reached = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % n;
    const y = (i - x) / n;
    if (x > 0 && !bit(i - 1) && !seen[i - 1]) { seen[i - 1] = 1; reached++; stack.push(i - 1); }
    if (x + 1 < n && !bit(i + 1) && !seen[i + 1]) { seen[i + 1] = 1; reached++; stack.push(i + 1); }
    if (y > 0 && !bit(i - n) && !seen[i - n]) { seen[i - n] = 1; reached++; stack.push(i - n); }
    if (y + 1 < n && !bit(i + n) && !seen[i + n]) { seen[i + n] = 1; reached++; stack.push(i + n); }
  }
  return reached !== unshaded;
}

// Full verdict on one shading, given as a list of shaded indices. Reports each rule
// separately so a test can prove a board is rejected for the reason it claims.
export function verifyShading(p, shaded) {
  if (!shapeOk(p)) throw new Error('verifyShading: bad puzzle');
  const on = new Uint8Array(p.n * p.n);
  for (const i of shaded) {
    if (!Number.isInteger(i) || i < 0 || i >= on.length) throw new Error(`verifyShading: cell ${i} off the board`);
    on[i] = 1;
  }
  const bit = (i) => on[i] === 1;
  return {
    rule1: !rule1Breaks(p.n, p.cells, bit),
    rule2: !rule2Breaks(p.n, bit),
    rule3: !rule3Breaks(p.n, bit),
    get ok() { return this.rule1 && this.rule2 && this.rule3; },
  };
}

function bitsOfMask(mask, total) {
  const out = [];
  for (let i = 0; i < total; i++) if (mask & (1 << i)) out.push(i);
  return out;
}

// Enumerate every subset (4x4 and smaller) and keep the ones that satisfy all three
// rules. `opts.limit` stops early once that many solutions are in hand; with no limit the
// solution list is complete, which is what the cross-check needs.
export function bruteSolve(p, opts = {}) {
  if (!shapeOk(p)) throw new Error('bruteSolve: bad puzzle');
  const total = p.n * p.n;
  if (total > MAX_FULL_CELLS) {
    if (opts.force) throw new Error(`bruteSolve: refusing ${total} cells (limit ${MAX_FULL_CELLS})`);
    throw new Error(`bruteSolve: ${total} cells is beyond exhaustive enumeration — use bruteSample`);
  }
  const t0 = Date.now();
  const limit = opts.limit || Infinity;
  const n = p.n;
  const cells = p.cells;
  const solutions = [];
  const subsets = 1 << total;
  const on = new Uint8Array(total);
  let count = 0;
  for (let mask = 0; mask < subsets; mask++) {
    for (let i = 0; i < total; i++) on[i] = (mask >> i) & 1;
    const bit = (i) => on[i] === 1;
    if (rule2Breaks(n, bit)) continue;
    if (rule1Breaks(n, cells, bit)) continue;
    if (rule3Breaks(n, bit)) continue;
    count++;
    if (solutions.length < limit) solutions.push(bitsOfMask(mask, total));
  }
  return {
    mode: 'full',
    subsetsChecked: subsets,
    totalSubsets: subsets,
    count,
    complete: true,
    solutions,
    ms: Date.now() - t0,
  };
}

// Sampling for 5x5 and up. Two families of subsets, because plain random masks essentially
// never land on a solution of a real board:
//   * `randomDraws` at binomial density, which exercises the checkers themselves;
//   * every 1-, 2- and 3-bit Hamming neighbour of each shading in `opts.around`, which is
//     what can actually disprove uniqueness locally.
// Note the representation: a 6x6 board has 36 cells, so a shading is a byte array here and
// not a bitmask — `1 << 32` silently aliases to `1 << 0` in JS, and the first version of
// this function shipped that bug as a green cross-check.
//
// What sampling can and cannot prove is stated in README/DESIGN: it confirms the certified
// shading is legal and that no near-neighbour of it is a second one. It does not enumerate,
// and the docs say so with the numbers from `subsetsChecked`.
export function bruteSample(p, opts = {}) {
  if (!shapeOk(p)) throw new Error('bruteSample: bad puzzle');
  const total = p.n * p.n;
  if (total <= MAX_FULL_CELLS && !opts.force) {
    return Object.assign(bruteSolve(p, opts), { note: 'upgraded to full enumeration' });
  }
  const rng = makeRng(opts.seed === undefined ? 20260927 : hashOf(String(opts.seed)));
  const randomBudget = opts.subsets === undefined ? 40000 : opts.subsets;
  const around = Array.isArray(opts.around) ? opts.around : (opts.around ? [opts.around] : []);
  const t0 = Date.now();
  const seen = new Set();
  const solutions = [];
  let checked = 0;
  const on = new Uint8Array(total);
  const bit = (i) => on[i] === 1;
  const key = () => String.fromCharCode.apply(null, on);
  const test = () => {
    const k = key();
    if (seen.has(k)) return;
    seen.add(k);
    checked++;
    if (rule2Breaks(p.n, bit)) return;
    if (rule1Breaks(p.n, p.cells, bit)) return;
    if (rule3Breaks(p.n, bit)) return;
    const sol = [];
    for (let i = 0; i < total; i++) if (on[i]) sol.push(i);
    solutions.push(sol);
  };
  const stamp = () => {
    for (let i = 0; i < total; i++) on[i] = 0;
  };

  for (let k = 0; k < randomBudget; k++) {
    for (let i = 0; i < total; i++) on[i] = rng() < 0.5 ? 1 : 0;
    test();
  }
  let neighbourhoodFlips = 0;
  for (const shaded of around) {
    stamp();
    for (const i of shaded) {
      if (!Number.isInteger(i) || i < 0 || i >= total) throw new Error(`bruteSample: cell ${i} off the board`);
      on[i] = 1;
    }
    test();
    for (let i = 0; i < total; i++) {
      on[i] ^= 1;
      test();
      for (let j = i + 1; j < total; j++) {
        on[j] ^= 1;
        test();
        for (let k = j + 1; k < total; k++) {
          on[k] ^= 1;
          test();
          neighbourhoodFlips++;
          on[k] ^= 1;
        }
        neighbourhoodFlips++;
        on[j] ^= 1;
      }
      neighbourhoodFlips++;
      on[i] ^= 1;
    }
  }
  return {
    mode: 'sample',
    subsetsChecked: checked,
    randomDraws: randomBudget,
    neighbourhoodFlips,
    count: solutions.length,
    complete: false,
    solutions,
    ms: Date.now() - t0,
  };
}

// FNV-1a, in here rather than imported from rng.js, for the same reason the rules are
// written twice: this module should fail or pass on its own.
function hashOf(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (str.charCodeAt(i) >> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A local copy of the seeded generator, so the sample does not depend on rng.js either.
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
