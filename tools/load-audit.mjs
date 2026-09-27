// Which difficulty values does this generator actually produce? The tier table in
// js/core/make.js names a *band* (minLoad..maxLoad), and a band edge the sampler never
// reaches is decoration, not a promise — so it gets measured instead of assumed.
//
//   node tools/load-audit.mjs
//   SEEDS=8000 node tools/load-audit.mjs
//
// Every seed is rated whether or not it lands in a band: the histogram below is over the
// generator's output, not over what the bake chose to keep. makePuzzle returns the measured
// load on a rejected board too (js/core/make.js:308), which is what makes this readable.
import { LOTS } from '../js/data/lots.js';
import { TIERS, makePuzzle } from '../js/core/make.js';

const SEEDS = Number(process.env.SEEDS || 3000);
const rated = [];
let odd = 0;
let split = 0;
const splitExamples = [];

for (const t of TIERS) {
  const hist = new Map();
  const reasons = new Map();
  let noLoad = 0;
  for (let i = 0; i < SEEDS; i++) {
    const r = makePuzzle(`loads-${t.key}-${i}`, t);
    const load = r.ok ? r.rating.load : r.load;
    if (typeof load !== 'number') { noLoad++; reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1); continue; }
    hist.set(load, (hist.get(load) || 0) + 1);
    if (!r.ok) reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1);
    if (load % 2 === 1) odd++;
    if (r.ok && r.rating.depth !== r.rating.guesses) {
      split++;
      if (splitExamples.length < 3) splitExamples.push(`${t.key}#${i} 假设 ${r.rating.depth} · 枯竭 ${r.rating.guesses}`);
    }
  }
  const sorted = [...hist.entries()].sort((a, b) => a[0] - b[0]);
  const inBand = sorted.filter(([v]) => v >= t.minLoad && v <= t.maxLoad);
  rated.push({ tier: t, hist, noLoad, reasons });
  console.log(
    `${t.key.padEnd(8)} band ${String(t.minLoad)}..${String(t.maxLoad).padStart(2)}  `
    + `负荷 ${sorted.map(([v, c]) => `${v}×${c}`).join(' ')}`
    + `${noLoad ? `  （${noLoad} 个种子还没量到负荷就被拒）` : ''}`,
  );
  console.log(
    `         band 内 ${inBand.reduce((a, [, c]) => a + c, 0)}/${SEEDS} 盘：${inBand.map(([v, c]) => `${v}×${c}`).join(' ') || '一盘没有'}`
    + `  拒收 ${[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ') || '(无)'}`,
  );
}

// A band edge with zero boards behind it is not part of the ladder; say which ones.
for (const { tier: t, hist } of rated) {
  const dead = [];
  for (let v = t.minLoad; v <= t.maxLoad; v++) if (!hist.has(v)) dead.push(v);
  if (dead.length) console.log(`         ${t.key}：band 里量不到的负荷 ${dead.join('、')}`);
}

const total = rated.reduce((a, { hist }) => a + [...hist.values()].reduce((x, y) => x + y, 0), 0);
console.log(`\n量到负荷的盘 ${total}（${TIERS.length} 档 × ${SEEDS} 个种子）  奇数负荷 ${odd}  枯竭 ≠ 假设 的盘 ${split}`
  + `${splitExamples.length ? `：${splitExamples.join(' / ')}` : ''}`);

// The one thing this can legitimately fail on: a value the shipped pool advertises that the
// generator cannot produce would mean the data file and the ladder are no longer the same game.
const problems = [];
for (const { tier: t, hist } of rated) {
  for (const row of LOTS.filter((r) => r.tier === t.key)) {
    if (!hist.has(row.load)) problems.push(`${row.id} 负荷 ${row.load} 在这个档的 ${SEEDS} 个种子里一次都没出现过`);
  }
}
if (problems.length) {
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exitCode = 1;
} else {
  console.log(`  ✓ 出货 40 盘的每一个负荷值，都在同档 ${SEEDS} 个种子里被重新量到`);
}
