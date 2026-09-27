// The content gate a browser-free job can run: everything README.md claims about js/data/lots.js
// is checked here against the file that actually ships. `@boot` asserts the same self-agreement
// through the page, but CI has no Chrome, and the rows are the artifact the game is made of.
//
//   node tools/audit-lots.mjs
//
// Exit 0 with a per-tier summary, or exit 1 naming every row that broke and how.
import { LOTS, TIERS_META } from '../js/data/lots.js';
import { validatePuzzle, duplicatePairs } from '../js/core/grid.js';
import { shadingIsValid } from '../js/core/rules.js';
import { minTaps } from '../js/core/game.js';
import { campaign, spreadText } from '../js/core/library.js';

const bad = [];
const fail = (id, msg) => bad.push(`${id}: ${msg}`);

// A 4x4 has 65536 subsets: at that size the independent route enumerates the whole space, and
// above it samples. The claim is per-tier, so the check has to be per-row.
const FULL_SUBSETS = { 4: 2 ** 16 };

const byTier = {};
for (const row of LOTS) {
  const p = { n: row.n, cells: row.cells };
  const err = validatePuzzle(p);
  if (err) fail(row.id, `题面不合法：${err}`);
  if (!TIERS_META.some((t) => t.key === row.tier && t.n === row.n)) fail(row.id, `tier ${row.tier} 与 n=${row.n} 不符`);
  if (row.solutionCount !== 1) fail(row.id, `solutionCount=${row.solutionCount}，唯一解没被证完`);
  if (!shadingIsValid(p, row.solution)) fail(row.id, '烘焙的解不满足三条规则');
  if (row.shades !== row.solution.length) fail(row.id, `shades=${row.shades} 与 solution.length=${row.solution.length} 不符`);
  if (row.load !== row.depth + row.guesses) fail(row.id, `load=${row.load} 而 假设+枯竭=${row.depth + row.guesses}`);
  if (minTaps(row) !== row.solution.length + 2 * (row.n * row.n - row.solution.length)) {
    fail(row.id, 'minTaps 不再是「一个黑格一下、一个点两下」的地板价');
  }
  if (row.pairs !== duplicatePairs(p).length) fail(row.id, `pairs=${row.pairs} 与题面重算的相等对不符`);
  if (!row.brute || !row.brute.mode) fail(row.id, '没有独立复核记录');
  else {
    const want = row.n === 4 ? 'full' : 'sample';
    if (row.brute.mode !== want) fail(row.id, `brute.mode=${row.brute.mode}，n=${row.n} 应该是 ${want}`);
    if (!(row.brute.subsets > 0)) fail(row.id, `brute.subsets=${row.brute.subsets}`);
    if (want === 'full' && FULL_SUBSETS[row.n] && row.brute.subsets !== FULL_SUBSETS[row.n]) {
      fail(row.id, `全枚举却只核了 ${row.brute.subsets} 个子集（应为 ${FULL_SUBSETS[row.n]}）`);
    }
  }
  // Wall-clock on a row is how a reproducible pool turns into a dirty tree: the bytes would change
  // on another machine while every board stayed identical.
  const leak = Object.keys(row).filter((k) => k === 'ms' || /Ms$|duration|elapsed|took/i.test(k))
    .concat(Object.keys(row.brute || {}).filter((k) => k === 'ms' || /Ms$|duration|elapsed|took/i.test(k)));
  if (leak.length) fail(row.id, `数据行里出现墙上时间字段：${leak.join(', ')}`);
  (byTier[row.tier] ||= []).push(row);
}

const ids = new Set(LOTS.map((r) => r.id));
if (ids.size !== LOTS.length) fail('(pool)', `id 不唯一：${LOTS.length} 行 / ${ids.size} 个 id`);

for (const t of TIERS_META) {
  const rows = byTier[t.key] || [];
  if (rows.length === 0) fail(t.key, '这一档一行都没有');
  const loads = rows.map((r) => r.load);
  if (t.min !== Math.min(...loads) || t.max !== Math.max(...loads)) {
    fail(t.key, `档级 min/max=${t.min}/${t.max} 而实测负荷 ${Math.min(...loads)}/${Math.max(...loads)}`);
  }
  // The blurb is the sentence the menu prints. It used to quote the *load* span under the word
  // 枯竭, which is one of the two numbers it adds up to — so it is recomputed here and compared
  // as a string, not eyeballed. It also used to print 枯竭 3-5 次 for a tier that shipped nine
  // boards at 3 and one at 5, so the sentence now carries a board count per value and is
  // recomputed with the very function the page renders with (js/core/library.js:spreadText):
  // bake.mjs spells the same sentence a second time, and the two spellings agreeing is the gate.
  const want = `${t.n}×${t.n} · ${spreadText(rows.map((r) => r.guesses), '枯竭', '次')} · ${spreadText(rows.map((r) => r.depth), '假设', '层')}`;
  if (t.blurb !== want) fail(t.key, `blurb 说的是「${t.blurb}」，从行上重算是「${want}」`);
}

// campaign() hands the ladder to the shell in file order and does not sort, so the promise in
// js/core/library.js:53 ("easiest band first and inside a band by measured load") is a claim about
// this array's order.
const order = TIERS_META.map((t) => t.key);
let prev = -Infinity;
let prevTier = 0;
for (const row of campaign()) {
  const at = order.indexOf(row.tier);
  if (at < prevTier) fail(row.id, `战役顺序里 ${row.tier} 排在了更晚的档后面`);
  if (at > prevTier) { prevTier = at; prev = -Infinity; }
  if (row.load < prev) fail(row.id, `战役顺序内负荷回退：${prev} → ${row.load}`);
  prev = row.load;
}

const head = TIERS_META.map((t) => {
  const rows = byTier[t.key] || [];
  // The summary line prints the multiset, not a min/max: `负荷 6-10` was the same
  // one-board-span reading that the menu used to ship.
  const loads = spreadText(rows.map((r) => r.load), '负荷');
  const mode = [...new Set(rows.map((r) => r.brute && r.brute.mode))].join('/') || '-';
  const sub = rows.map((r) => (r.brute ? r.brute.subsets : 0));
  return `${t.key.padEnd(8)} n=${rows.length} ${t.n}×${t.n} ${loads}（${Math.min(...rows.map((r) => r.load))}-${Math.max(...rows.map((r) => r.load))}） 复核=${mode} 子集 ${Math.min(...sub)}-${Math.max(...sub)}`;
}).join('\n');

console.log(head);
console.log(`rows: ${LOTS.length} tiers: ${TIERS_META.length} unique ids: ${ids.size}`);
if (bad.length) {
  for (const b of bad) console.log('  FAIL ' + b);
  console.log(`rows: ${LOTS.length} fail: ${bad.length}`);
  process.exit(1);
}
console.log(`rows: ${LOTS.length} fail: 0`);
