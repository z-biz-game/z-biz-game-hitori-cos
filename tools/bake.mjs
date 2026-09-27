// The content pipeline: this is where every board in the game comes from, and the browser
// never runs any of it.
//
// Why offline, measured rather than asserted: the uniqueness proof is a search. On this
// machine a 6x6 proof costs single-digit milliseconds, but the *acceptance* rate is the
// problem — most generated boards are rejected (see the reason column below), so minting
// one board costs tens of generator runs. That is a fine build step and an unacceptable
// tap.
//
//   node tools/bake.mjs
//   PER_TIER=16 node tools/bake.mjs
//   SAMPLE_SUBSETS=20000 node tools/bake.mjs     # 5x5+ cross-check budget per board
//
// A board only enters js/data/lots.js if three things hold, in this order:
//   1. the generator's own counter reports solutionCount === 1;
//   2. re-solving the *serialised* row reproduces solutionCount / depth / guesses exactly;
// `unique` below is the share of seeds whose board has exactly one solution; `shipped` is
// the smaller share that also landed inside the band, which is the real cost of the
// difficulty ladder. retreat's shipped rate is the number to read honestly (see README).
//   3. the independent brute route agrees — exhaustively for 4x4 (all 65536 subsets),
//      by sample for 5x5 and up, with the sample size recorded on the row.
// Nothing unmeasured ships, and every number the shell prints is on the row.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TIERS, makePuzzle, signature } from '../js/core/make.js';
import { solve } from '../js/core/solve.js';
import { validatePuzzle, duplicatePairs } from '../js/core/grid.js';
import { shadingIsValid } from '../js/core/rules.js';
import { bruteSolve, bruteSample, canEnumerate } from '../js/core/brute.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PER_TIER = Number(process.env.PER_TIER || 10);
const SAMPLE_SUBSETS = Number(process.env.SAMPLE_SUBSETS || 20000);

function median(sorted) {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}

const key = (list) => list.map((s) => s.join(',')).sort().join(' | ');
// Reasons that say nothing about the solution count.
const SOFT_REASONS = new Set(['too-easy', 'too-hard', 'too-few-pairs', 'bad-shading', 'bad-shape', 'duplicate']);
const serialized = (row) => JSON.parse(JSON.stringify({ n: row.n, cells: row.cells }));

const out = [];
const report = [];

for (const tier of TIERS) {
  const seen = new Set();
  const picked = [];
  const reasons = {};
  let notUnique = 0;
  const times = [];
  const uniqueTimes = [];
  let tried = 0;
  let bruteMs = 0;
  let uniqueSeen = 0;
  const t0 = Date.now();
  const seedCap = PER_TIER * 80;
  while (picked.length < PER_TIER && tried < seedCap) {
    const seed = `bake-${tier.key}-${tried}`;
    tried++;
    const a = Date.now();
    const made = makePuzzle(seed, tier);
    times.push(Date.now() - a);
    if (!made.ok) {
      reasons[made.reason] = (reasons[made.reason] || 0) + 1;
      // A board rejected for sitting outside its band, or for having too few duplicate
      // pairs, still passed the uniqueness proof — so it must not be counted as a failure
      // of the one claim this game makes. Only these reasons mean "not exactly one solution".
      if (!SOFT_REASONS.has(made.reason)) notUnique++;
      continue;
    }
    uniqueSeen++;
    // Promise #1: the generator's claim, checked by the shipped counter shape.
    const rt = Date.now();
    const again = solve(made.puzzle, { limit: 2 });
    uniqueTimes.push(Date.now() - rt);
    if (again.solutionCount !== 1 || again.solutions[0].join(',') !== made.solution.join(',')) {
      reasons['counter-disagree'] = (reasons['counter-disagree'] || 0) + 1;
      continue;
    }
    const row = {
      id: `${tier.key}-${String(picked.length + 1).padStart(2, '0')}`,
      tier: tier.key,
      n: made.puzzle.n,
      cells: made.puzzle.cells.slice(),
      solution: made.solution.slice(),
      solutionCount: again.solutionCount,
      depth: again.depth,
      guesses: again.guesses,
      nodes: again.nodes,
      pairs: duplicatePairs(made.puzzle).length,
      linesWithPairs: made.rating.linesWithPairs,
      shades: made.solution.length,
      load: again.depth + again.guesses,
      seed,
    };
    // Promise #2: whatever is about to be written to disk still measures the same.
    const shape = validatePuzzle(serialized(row));
    if (shape) throw new Error(`${row.id}: serialised board is not a puzzle — ${shape}`);
    if (!shadingIsValid(row, row.solution)) throw new Error(`${row.id}: baked solution is not a legal board`);
    const fromDisk = solve(serialized(row), { limit: 2 });
    if (
      fromDisk.solutionCount !== row.solutionCount
      || fromDisk.depth !== row.depth
      || fromDisk.guesses !== row.guesses
      || fromDisk.solutions[0].join(',') !== row.solution.join(',')
    ) {
      throw new Error(`${row.id}: measurement does not reproduce from the serialised board`);
    }
    // Promise #3: the independent route.
    let brute;
    if (canEnumerate(row)) {
      brute = bruteSolve(row);
      if (brute.count !== row.solutionCount || key(brute.solutions) !== key(fromDisk.solutions)) {
        throw new Error(`${row.id}: exhaustive brute disagrees with the solver (brute ${brute.count}, solver ${row.solutionCount})`);
      }
    } else {
      brute = bruteSample(row, { subsets: SAMPLE_SUBSETS, around: [row.solution], seed: row.id });
      if (brute.solutions.some((sol) => sol.join(',') !== row.solution.join(','))) {
        throw new Error(`${row.id}: sampled brute found a second shading the solver says does not exist`);
      }
      if (brute.count !== 1) throw new Error(`${row.id}: sampled brute did not even find the certified shading`);
    }
    // The wall-clock of the independent route is a *report* number: it belongs to the machine
    // that ran the bake, not to the board. Written into js/data/lots.js it would make a
    // re-bake of identical boards dirty the tree, so only mode and subsets ship.
    row.brute = { mode: brute.mode, subsets: brute.subsetsChecked };
    if (brute.ms > bruteMs) bruteMs = brute.ms;
    const sig = signature(row);
    if (seen.has(sig)) {
      reasons['duplicate'] = (reasons['duplicate'] || 0) + 1;
      continue;
    }
    seen.add(sig);
    picked.push(row);
    process.stdout.write(`\r${tier.key}: ${picked.length}/${PER_TIER}  tried ${tried}  ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
  }
  process.stdout.write('\n');
  // A band is played as a curve, so order it by the one measured number it was filtered on.
  picked.sort((a, b) => a.load - b.load || a.nodes - b.nodes || a.shades - b.shades);
  picked.forEach((r, i) => { r.id = `${tier.key}-${String(i + 1).padStart(2, '0')}`; });
  if (picked.length < PER_TIER) console.error(`warn: ${tier.key} only reached ${picked.length} of ${PER_TIER} boards after ${tried} seeds`);

  const sortedTimes = [...times].sort((a, b) => a - b);
  const sortedUnique = [...uniqueTimes].sort((a, b) => a - b);
  report.push({
    tier: tier.key,
    n: tier.n,
    tried,
    accepted: picked.length,
    uniqueRate: `${(((tried - notUnique) / Math.max(1, tried)) * 100).toFixed(1)}%`,
    bandRate: `${((picked.length / Math.max(1, tried)) * 100).toFixed(1)}%`,
    reasons,
    genMed: median(sortedTimes),
    genMax: sortedTimes[sortedTimes.length - 1],
    counterMed: median(sortedUnique),
    counterMax: sortedUnique[sortedUnique.length - 1],
    bruteMs,
    loads: picked.map((r) => r.load),
  });
  out.push(...picked);
}

// The band the UI prints is measured off the boards that actually shipped, never copied
// from the generator's wish list — so a re-bake that lands lighter or heavier says so.
// `min`/`max` are the *load* range (枯竭 + 深度, the key `campaign()` walks), and the
// shelf heading that renders `blurb` has to name the same thing the menu does: 枯竭 is
// `guesses`, not `load`. Printing load under the words 枯竭 N 次 is how the shelf ended up
// claiming 6-10 assumptions on rows the counter measures at 3.
const meta = TIERS.map((t) => {
  const mine = out.filter((l) => l.tier === t.key);
  const loads = mine.map((l) => l.load);
  const span = (key) => {
    const v = mine.map((l) => l[key]);
    return Math.min(...v) === Math.max(...v) ? `${Math.min(...v)}` : `${Math.min(...v)}-${Math.max(...v)}`;
  };
  const lo = Math.min(...loads);
  const hi = Math.max(...loads);
  const size = mine[0].n;
  return {
    key: t.key,
    label: t.label,
    n: size,
    min: lo,
    max: hi,
    blurb: `${size}×${size} · 枯竭 ${span('guesses')} 次 · 假设 ${span('depth')} 层`,
  };
});

const lines = [
  '// Generated by tools/bake.mjs — the levels in this game are measurements, not opinions.',
  '// Each row carries the unique-solution count, the assumption depth and the number of',
  '// times pure deduction ran dry, all three produced by js/core/solve.js and re-checked',
  '// against the independent route in js/core/brute.js. Re-run `node tools/bake.mjs`',
  '// instead of hand-editing: test/library.test.mjs re-solves every row and fails if a',
  '// line and its numbers ever disagree.',
  `export const TIERS_META = ${JSON.stringify(meta)};`,
  'export const LOTS = [',
  ...out.map((l) => `  ${JSON.stringify(l)},`),
  '];',
  '',
];
const path = join(root, 'js', 'data', 'lots.js');
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, lines.join('\n'));

console.log('\n=== bake report ===');
for (const r of report) {
  console.log(
    `${r.tier.padEnd(8)} n=${r.n}  seeds ${String(r.tried).padStart(3)}  `
    + `unique ${r.uniqueRate.padStart(6)}  in-band ${r.bandRate.padStart(6)}  `
    + `gen ms med/max ${r.genMed}/${r.genMax}  counter ms med/max ${r.counterMed}/${r.counterMax}  `
    + `brute max ${r.bruteMs}ms  loads [${r.loads.join(',')}]`,
  );
  console.log(`         rejected: ${Object.entries(r.reasons).map(([k, v]) => `${k}:${v}`).join(' ') || '(none)'}`);
}
const byTier = {};
for (const l of out) byTier[l.tier] = (byTier[l.tier] || 0) + 1;
console.log(`\nwrote ${out.length} boards (${Object.entries(byTier).map(([k, n]) => `${k}:${n}`).join(' ')}) -> js/data/lots.js`);
