// The shipped pool. The game picks levels from here and never generates one, which is
// the point: a board's `solutionCount === 1` was proven at build time by two independent
// routes, and proving it again on tap would put a backtracking search in the click path.
//
// Everything below is a pure lookup over js/data/lots.js, so a shared `#/lot/<id>` link
// and the daily board are reproducible with no state at all: the pool is fixed and the
// seed only chooses an index in it.

import { LOTS, TIERS_META } from '../data/lots.js';
import { hashSeed } from './rng.js';

// Generation-side tier ladder (with its budgets) lives in js/core/make.js and is not
// needed once the boards are baked; TIERS_META is what actually shipped, measured off the
// rows below.
export const TIERS = TIERS_META;

const prepared = LOTS.map((row) => ({
  id: row.id,
  tier: row.tier,
  n: row.n,
  puzzle: { n: row.n, cells: row.cells.slice() },
  solution: row.solution.slice(),
  solutionCount: row.solutionCount,
  depth: row.depth,
  guesses: row.guesses,
  nodes: row.nodes,
  pairs: row.pairs,
  shades: row.shades,
  load: row.depth + row.guesses,
  brute: row.brute,
}));

export const ALL = prepared;

function pick(list, seed, salt) {
  if (!list.length) return null;
  return list[hashSeed(`${salt}|${seed}`) % list.length];
}

export function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || TIERS[0];
}

export function lotsIn(key) {
  return prepared.filter((l) => l.tier === key);
}

export function byId(id) {
  return prepared.find((l) => l.id === id) || null;
}

// The campaign: every baked board, easiest band first and inside a band by measured load.
export function campaign() {
  return prepared;
}

export function levelAt(index) {
  return prepared[((index % prepared.length) + prepared.length) % prepared.length];
}

export function randomLot(seed, tierKey) {
  const list = tierKey ? lotsIn(tierKey) : prepared;
  return pick(list, seed, 'random');
}

export function dailyLot(dateKey) {
  return pick(prepared, dateKey, 'daily');
}

function median(sorted) {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}

function spread(values) {
  const s = [...values].sort((a, b) => a - b);
  return { min: s[0], max: s[s.length - 1], med: median(s) };
}

// What the pool actually contains, measured rather than claimed. The docs quote this
// table; library.test.mjs asserts every number in it still comes out of the shipped rows,
// so a re-bake that quietly loses difficulty shows up as a changed band instead of a lie.
export function stats() {
  const byTier = {};
  for (const l of prepared) {
    const s = byTier[l.tier] || (byTier[l.tier] = {
      count: 0, size: l.n, loads: [], depths: [], guesses: [], shades: [], pairs: [], nodes: [],
    });
    s.count++;
    s.loads.push(l.load);
    s.depths.push(l.depth);
    s.guesses.push(l.guesses);
    s.shades.push(l.shades);
    s.pairs.push(l.pairs);
    s.nodes.push(l.nodes);
  }
  for (const [key, s] of Object.entries(byTier)) {
    const load = spread(s.loads);
    const shades = spread(s.shades);
    const pairs = spread(s.pairs);
    byTier[key] = {
      count: s.count,
      size: s.size,
      min: load.min,
      max: load.max,
      med: load.med,
      depthMax: Math.max(...s.depths),
      guessesMax: Math.max(...s.guesses),
      nodesMax: Math.max(...s.nodes),
      shadesMin: shades.min,
      shadesMax: shades.max,
      pairsMin: pairs.min,
      pairsMax: pairs.max,
    };
  }
  return { lots: prepared.length, byTier };
}
