// 文档是被断言的那一面：README / DESIGN 里印出去的每一个「现值」，都必须等于代码、数据行，
// 或者同一个工具现在重跑一遍打印出来的值。
//
// 为什么要有这个文件：这个仓的散文写得很实在（出题种子数、落带率、负荷直方图、断言条数、端口、
// 引用行号），但仓里没有任何东西守着「文档写的数」与「代码现在的数」相等。散文可以一直抄下去，
// 直到某天代码改了字、文档还在引用上一个世界的数。这一轮对表抓到 5 处漂移（见台账之外的
// 「文档改的那一边」清单），全部按「以代码为准」改掉了文档那一侧。
//
// 三条规矩（照 kurotto / ferry / herugolf 的机制走，不自创一套）：
//   * 每一个正则/表格解析都配一条「解析到几行」的反空转断言——正则没命中不是绿，是红；
//   * bake、load-audit、test 套件、audit-lots 都由**同一个工具在本机重跑一遍**取现值，
//     不是把文档抄进代码；跑不动就说明没有现值可对，也是红；
//   * 墙钟毫秒与秒不重新计时，也不把新测的数写回散文：那几列只以「文档自己写明它是哪台机器哪一轮的
//     读数、并且不进任何闸的期望」的关系出现（D10），能逐位复现的结构数字（盘数、子集数、种子数、
//     条数、阈值、行号）才在这里比数值。钉不住的数一律进 UNPINNED（D12），每条带一个 needle 断言它
//     还写在文档里——删掉那句话来变绿就是这一条红。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LOTS, TIERS_META } from '../js/data/lots.js';
import { TIERS } from '../js/core/make.js';
import { minTaps } from '../js/core/game.js';
import { campaign, spreadText } from '../js/core/library.js';
import { DOT, OPEN, SHADED, nextMark } from '../js/core/grid.js';
import { audit } from '../js/core/rules.js';
import { FULL_SUBSETS } from '../js/core/brute.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const fail = [];
const emitted = new Set();
let rows = 0;
const ok = (cond, label, detail) => {
  rows++;
  emitted.add(String(label).match(/^D\d+/)[0]);
  if (!cond) fail.push(label);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label} · ${detail}`);
};
// 台账那一行会把针与「改成」原样抄一遍，所以数文档里的现值之前先把那些行摘掉，
// 否则 K1 那一格里的 `112` 会撞上 D2 自己判红。
const LEDGER_ROW = /^\| K\d+ \| .*$/gm;
const stripLedger = s => s.replace(LEDGER_ROW, '');
// `65 536` 与 `11 893` 之间的空格是排版，不是数字的一部分。
const flat = s => s.replace(/(\d)[ \t  ]+(?=\d)/g, '$1');

const README_DOC = stripLedger(read('README.md'));
const DESIGN_DOC = stripLedger(read('DESIGN.md'));
const DOCS = flat(README_DOC + '\n' + DESIGN_DOC);
const README = flat(README_DOC);
const DESIGN = flat(DESIGN_DOC);
const PKG = JSON.parse(read('package.json'));
const CI = read('.github/workflows/ci.yml');
const VERIFY = read('tools/verify.sh');
const PLAYTEST = read('tools/playtest.mjs');
const BAKE_SRC = read('tools/bake.mjs');
const LOADSRC = read('tools/load-audit.mjs');
const SAB_SRC = read('tools/sabotage.mjs');
const MAIN = read('js/main.js');
const GAME = read('js/core/game.js');
const RULES_SRC = read('js/core/rules.js');
const GRID = read('js/core/grid.js');
const STORAGE = read('js/core/storage.js');
const SERVER = read('server.cjs');
const CSS = read('css/game.css');
const INDEX = read('index.html');

const run = (cmd, ms) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd: ROOT, encoding: 'utf8', timeout: ms, maxBuffer: 64 * 1024 * 1024 });
  return { rc: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
};

const BAKE = run('node tools/bake.mjs', 120000);
const LOTA = run('node tools/load-audit.mjs', 300000);
// 「N 盘」这种句子有两个量级：出货的 40 盘，和 load-audit 一次量的上万盘。
// 大数只能是工具自己报出来的那几个（种子总数、band 内的盘数、各档试过的种子数），
// 文档凭空多出一个大盘数就是红。
const LOAD_TOTAL = Number((LOTA.out.match(/量到负荷的盘 (\d+)/) || [])[1]);
const BAND_IN_TOTAL = Number((LOTA.out.match(/^retreat[^\n]*\n\s*band 内 (\d+)\/\d+/m) || [])[1]);
const SEEDS = Number(((LOADSRC.match(/const SEEDS = Number\(process\.env\.SEEDS \|\| (\d+)\);/) || [])[1]));
const BAKE_SEEDS = [...BAKE.out.matchAll(/^\w+\s+n=\d+\s+seeds\s+(\d+)/gm)].map(m => +m[1]);
const BIG_OK = new Set([LOAD_TOTAL, BAND_IN_TOTAL, SEEDS, ...BAKE_SEEDS].filter(Number.isFinite));
const AUDIT = run('node tools/audit-lots.mjs', 120000);
const SELFTEST = run('node tools/playtest.mjs selftest', 60000);
const SUITE_FILES = readdirSync(join(ROOT, 'test')).filter(f => f.endsWith('.test.mjs')).sort();
const SUITES = SUITE_FILES.map(f => {
  const r = run(`node test/${f}`, 120000);
  return { f, rc: r.rc, out: r.out, n: (r.out.match(/^rows: (\d+) fail: (\d+)$/m) || []).slice(1).map(Number) };
});
const lotsBytesBefore = readFileSync(join(ROOT, 'js/data/lots.js'));

// ---- D1 已发布的 40 盘：文档印在表里的每一格都在数据行上重算 ----
const perTier = {};
for (const r of LOTS) (perTier[r.tier] ||= []).push(r);
const forty = [...DOCS.matchAll(/(\d+) 盘/g)].map(m => +m[1]).filter(n => n === 40 || n === 287 || n === 10 || n === 9);
ok(LOTS.length === 40, `D1a 数据行就是 40 盘（文档全仓写的「40 盘」以此为真值）`, `LOTS ${LOTS.length} 行 · 文档「N 盘」命中 ${forty.filter(n => n === 40).length} 处 40`);
const docBig = [...DOCS.matchAll(/(\d+) 盘/g)].map(m => +m[1]).filter(n => n > LOTS.length && !BIG_OK.has(n));
ok(docBig.length === 0, `D1b 文档没有写一个比数据行更多的盘数（除 ${[...BIG_OK].join(' / ')} 这两个由 load-audit 现在报的量）`,
  docBig.length ? `凭空多出来的大盘数：${docBig.join(' ')}` : `全部 ≤ ${LOTS.length}，或由工具报出`);
const notUnique = LOTS.filter(r => r.solutionCount !== 1);
ok(notUnique.length === 0, 'D1 「40 盘全部逐格复核过唯一解」= 每一行的 solutionCount 都是 1',
  notUnique.length ? `不是 1 的行：${notUnique.map(r => `${r.id}=${r.solutionCount}`).join(' ')}` : `${LOTS.length}/${LOTS.length}`);
const PER_TIER = Number((BAKE_SRC.match(/const PER_TIER = Number\(process\.env\.PER_TIER \|\| (\d+)\);/) || [])[1]);
const tierCounts = Object.entries(perTier).map(([k, v]) => `${k}:${v.length}`);
ok(TIERS_META.length === 4 && PER_TIER === 10 && Object.values(perTier).every(v => v.length === PER_TIER),
  `D1c 每档恰好 ${PER_TIER} 盘 × ${TIERS_META.length} 档 == bake 的 PER_TIER 现值（文档写的「4 档」与「10 盘」）`,
  `${tierCounts.join(' ')} · PER_TIER=${PER_TIER} · 文档「4 档」命中 ${(DOCS.match(/4 档/g) || []).length} 处`);
const bruteRows = [...README.matchAll(/^\| (.+?) \| (\d+)×\2 \| (全枚举|抽样) \| (.+?) \|$/gm)];
ok(bruteRows.length === 3, `D1d 「第三条复核」那张表解析到 3 行（不是 3 行就是表格形状改了）`, `${bruteRows.length} 行`);
const modeOf = k => [...new Set(perTier[k].map(r => r.brute.mode))];
const subsOf = k => perTier[k].map(r => r.brute.subsets);
for (const [key, cell] of [['nook/quiet', '一隅 nook / 静室 quiet'], ['study', '书房 study'], ['retreat', '隐修 retreat']]) {
  const row = bruteRows.find(m => m[1] === cell);
  const keys = key === 'nook/quiet' ? ['nook', 'quiet'] : [key];
  const modes = [...new Set(keys.flatMap(k => modeOf(k)))];
  const subs = keys.flatMap(k => subsOf(k));
  const lo = Math.min(...subs), hi = Math.max(...subs);
  const wantCell = modes.includes('full') ? '全枚举' : '抽样';
  const wantRange = lo === hi ? `${lo}` : `${lo}–${hi}`;
  ok(!!row && row[3] === wantCell && flat(row[4]) === wantRange,
    `D1 ${cell}：文档写的复核方式与子集数 == 行上的 brute.mode / brute.subsets`,
    row ? `文档 ${row[3]} ${row[4]} vs 行 ${wantCell} ${wantRange}` : '解析不到那一行');
}
ok(FULL_SUBSETS === 65536 && /65536/.test(DOCS) && /全枚举/.test(README),
  `D1e 4×4 的「全枚举」= brute.js 的 FULL_SUBSETS 现值 ${FULL_SUBSETS}`, `代码 ${FULL_SUBSETS} · 文档写 65 536：${/65536/.test(DOCS)}`);
const camp = campaign();
const campLoads = camp.map(l => l.load);
ok(camp.length === LOTS.length && campLoads.every((v, i) => i === 0 || v >= campLoads[i - 1]),
  'D1f 「战役按 load 从小到大走完 40 盘」= campaign() 现在的顺序确实单调不减',
  `${camp.length} 盘 · load ${campLoads[0]}→${campLoads[campLoads.length - 1]}`);

// ---- D2 bake 报告：重跑同一个工具，拿它现在打印的数对表（墙钟那一列除外） ----
ok(BAKE.rc === 0, `D2a bake 这一趟跑成（rc=${BAKE.rc}）——跑不动就没有现值可对，是红不是跳过`, `rc=${BAKE.rc}`);
const bakeRows = [...BAKE.out.matchAll(/^(\w+)\s+n=(\d+)\s+seeds\s+(\d+)\s+unique\s+([\d.]+)%\s+in-band\s+([\d.]+)%.*loads \[([\d,]*)\]/gm)];
ok(bakeRows.length === TIERS_META.length, `D2b bake 的报告解析到 ${TIERS_META.length} 行（解析不到不等于通过）`,
  `解析 ${bakeRows.length} 行 · rc=${BAKE.rc}`);
const docBake = [...README.matchAll(/^\| (\S+ \S+) \| (\d+)×\2 \| (\d+) \| ([\d.]+)% \| \**([\d.]+)%\** \| `(.+?)` \| ≤ (\d+) ms \|$/gm)];
ok(docBake.length === 4, `D2c README 的 bake 表解析到 4 行 × 8 列（少一行就是被删了或改了列名）`, `${docBake.length} 行`);
const TIER_LABEL = { nook: '一隅 nook', quiet: '静室 quiet', study: '书房 study', retreat: '隐修 retreat' };
// 每一档的断言名写成字面量（不是 `D2 ${key} …` 插值）：台账那一列要点名一条**能在本文件源码里
// 逐字找到**的断言，插值出来的名字没有刀能引用。
const TIER_ASSERT = {
  nook: ['D2 nook 那一档在 README 的 bake 表里还在', 'D2 nook 行：尺寸 / 出题种子数 / 唯一解率 / 落带率 / 出货负荷 逐格 == bake 现在报的', 'D2d nook 的落带率就是 PER_TIER/tried'],
  quiet: ['D2 quiet 那一档在 README 的 bake 表里还在', 'D2 quiet 行：尺寸 / 出题种子数 / 唯一解率 / 落带率 / 出货负荷 逐格 == bake 现在报的', 'D2d quiet 的落带率就是 PER_TIER/tried'],
  study: ['D2 study 那一档在 README 的 bake 表里还在', 'D2 study 行：尺寸 / 出题种子数 / 唯一解率 / 落带率 / 出货负荷 逐格 == bake 现在报的', 'D2d study 的落带率就是 PER_TIER/tried'],
  retreat: ['D2 retreat 那一档在 README 的 bake 表里还在', 'D2 retreat 行：尺寸 / 出题种子数 / 唯一解率 / 落带率 / 出货负荷 逐格 == bake 现在报的', 'D2d retreat 的落带率就是 PER_TIER/tried'],
};
for (const b of bakeRows) {
  const key = b[1];
  const [inTable, cellEq, rateEq] = TIER_ASSERT[key] || ['D2 未知档', 'D2 未知档', 'D2 未知档'];
  const d = docBake.find(m => m[1] === TIER_LABEL[key]);
  ok(!!d, inTable, d ? `| ${d[1]} |` : '文档里没有这一行');
  const loads = b[6].split(',').map(Number);
  const mult = [...loads.reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map()).entries()]
    .sort((a, b2) => a[0] - b2[0]).map(([v, n2]) => `${v} ×${n2} 盘`).join(' · ');
  ok(!!d && +d[2] === +b[2] && +d[3] === +b[3] && +d[4] === +Number(b[4]) && +d[5] === +Number(b[5]) && d[6] === mult,
    cellEq,
    d ? `文档 ${d[2]}×${d[2]} ${d[3]} ${d[4]}% ${d[5]}% ${d[6]} vs 工具 ${b[2]}×n=${b[2]} ${b[3]} ${b[4]}% ${b[5]}% ${mult}` : '解析不到那一行');
  const tried = +b[3];
  ok(!!d && Math.abs(+d[5] - (+PER_TIER / tried) * 100) < 0.05, rateEq,
    d ? `文档 ${d[5]}% vs ${((PER_TIER / tried) * 100).toFixed(1)}%` : '解析不到');
}
const allUnique = bakeRows.every(b => +b[4] === 100);
ok(allUnique && /唯一解率四档都是 100%/.test(README), 'D2e 「唯一解率四档都是 100%」= 这一趟 bake 的四档都是 100.0%',
  bakeRows.map(b => `${b[1]} ${b[4]}%`).join(' / '));
const retreatRow = bakeRows.find(b => b[1] === 'retreat');
const docTried = README.match(/(\d+) 次才凑够 (\d+) 盘/);
ok(!!retreatRow && !!docTried && +docTried[1] === +retreatRow[3] && +docTried[2] === PER_TIER,
  `D2f 文档那句「${docTried ? docTried[1] : '?'} 次才凑够 ${docTried ? docTried[2] : '?'} 盘」== bake 现在报的 retreat 种子数`,
  retreatRow ? `工具 seeds ${retreatRow[3]} · PER_TIER ${PER_TIER}` : '跑不出 retreat 那一行');
const docPerTier = README.match(/分子恒为 (\d+)（`PER_TIER`）/);
ok(!!docPerTier && +docPerTier[1] === PER_TIER, `D2g 文档那句「分子恒为 ${docPerTier ? docPerTier[1] : '?'}（PER_TIER）」== bake.mjs 的 PER_TIER 现值 ${PER_TIER}`,
  docPerTier ? `文档 ${docPerTier[1]}` : '解析不到那句');
ok(readFileSync(join(ROOT, 'js/data/lots.js')).equals(lotsBytesBefore),
  'D2h bake 重跑之后 js/data/lots.js 一个字节都没变（文档那句「与上一次烘焙逐字节相同」是这一趟证的）',
  `重跑前后 md5 同源：${lotsBytesBefore.length} 字节`);

// ---- D3 load-audit 的直方图：文档那张表由同一个工具重跑 ----
ok(LOTA.rc === 0, `D3a load-audit 这一趟跑成（rc=${LOTA.rc}）`, `rc=${LOTA.rc}`);
// SEEDS 在上面与 load-audit 的合计一起解析（同一个来源，两处不许有两个数）
const loadRows = [...LOTA.out.matchAll(/^(\w+)\s+band (\d+)\.\.\s*(\d+)\s+负荷 (.+?)（(\d+) 个种子还没量到负荷就被拒）\s*\n\s+band 内 (\d+)\/(\d+) 盘：(.+?)\s+拒收 (.+)$/gm)];
ok(loadRows.length === TIERS.length && SEEDS === 3000, `D3b load-audit 的输出解析到 ${loadRows.length} 档 × 2 行（解析不到就是工具换了打印形状）`,
  `${loadRows.length} 档 · SEEDS=${SEEDS} · rc=${LOTA.rc}`);
const docLoad = [...README_DOC.matchAll(/^\| (\w+) \| (\d+)\.\.(\d+) \| `(.+?)` \|$/gm)];
ok(docLoad.length === TIERS.length, `D3c README 的负荷表解析到 ${TIERS.length} 行`, `${docLoad.length} 行`);
const LOAD_ASSERT = {
  nook: 'D3 nook 档：band 与直方图逐格 == make.js 的 TIERS 现值与 load-audit 现在的打印',
  quiet: 'D3 quiet 档：band 与直方图逐格 == make.js 的 TIERS 现值与 load-audit 现在的打印',
  study: 'D3 study 档：band 与直方图逐格 == make.js 的 TIERS 现值与 load-audit 现在的打印',
  retreat: 'D3 retreat 档：band 与直方图逐格 == make.js 的 TIERS 现值与 load-audit 现在的打印',
};
// 第 4 组是整段直方图，第 6 组是 band 内的盘数，第 8 组是 band 内的直方图，第 9 组是拒收原因。
// 文档里印的是「值×盘数」用**单个空格**分隔，工具打印时串了两个——比较前先各自把空白归一，
// 这样「文档少写一格」与「排版多一个空格」这两种情况不会混成同一种红。
const normHist = s => String(s === undefined ? '' : s).trim().replace(/\s+/g, ' ');
for (const t of TIERS) {
  const tool = loadRows.find(x => x[1] === t.key);
  const d = docLoad.find(x => x[1] === t.key);
  ok(!!tool && !!d && +d[2] === t.minLoad && +d[3] === t.maxLoad && normHist(d[4]) === normHist(tool[4]),
    LOAD_ASSERT[t.key] || 'D3 未知档',
    d && tool ? `文档 ${d[2]}..${d[3]} ${d[4]} vs 工具 ${tool[2]}..${tool[3]} ${normHist(tool[4])}` : `解析：文档${d ? '在' : '缺'} / 工具${tool ? '在' : '缺'}`);
}
const totalM = LOTA.out.match(/量到负荷的盘 (\d+)（(\d+) 档 × (\d+) 个种子）\s+奇数负荷 (\d+)\s+枯竭 ≠ 假设 的盘 (\d+)/);
ok(!!totalM, 'D3d load-audit 的合计行解析到了（拿不到这一行就没有现值）', totalM ? `${totalM[1]} 盘 · 奇数 ${totalM[4]} · 拆 ${totalM[5]}` : `rc=${LOTA.rc}`);
ok(!!totalM && +totalM[1] === 11893 && new RegExp(`11 ?893 盘`).test(DOCS),
  `D3 「11 893 盘有负荷读数」== 工具现在量的 ${totalM ? totalM[1] : '?'}`, totalM ? `工具 ${totalM[1]} · 文档命中 ${(DOCS.match(/11 ?893/g) || []).length} 处` : '解析不到');
ok(!!totalM && +totalM[2] === TIERS.length && +totalM[3] === SEEDS && /4 档 × 3000 个种子/.test(DOCS),
  `D3e 「4 档 × 3000 个种子」两个因子都等于现值（档数 ${TIERS.length} · SEEDS ${SEEDS}）`, `工具 ${totalM ? `${totalM[2]}×${totalM[3]}` : '?'} · 文档 ${(DOCS.match(/4 档 × 3000 个种子/g) || []).length} 处`);
const retreatTool = loadRows.find(x => x[1] === 'retreat');
const easy = Number(((retreatTool ? retreatTool[9] : '').match(/too-easy:(\d+)/) || [])[1]);
const bandIn = Number(retreatTool ? retreatTool[6] : NaN);
const docEasy = README.match(/量到 (\d+) 个 `too-easy`/);
const docPct = README.match(/（([\d.]+)% 的 6×6 盘枯竭不够）/);
const doc287 = [...DOCS.matchAll(/落进 band 的(?:只有)?\s*(\d+)(?:\/\d+)?\s*盘/g)].map(m => +m[1]);
ok(!!docEasy && docEasy[1] === String(easy) && !!docPct && Math.abs(+docPct[1] - (easy / SEEDS) * 100) < 0.05,
  `D3f 「too-easy ${easy}（${((easy / SEEDS) * 100).toFixed(1)}%）」== 工具现值`,
  docEasy && docPct ? `文档 ${docEasy[1]} / ${docPct[1]}% vs 工具 ${easy} / ${((easy / SEEDS) * 100).toFixed(1)}%` : '解析不到那句');
ok(bandIn === 287 && doc287.length >= 1 && doc287.every(n => n === bandIn),
  `D3g 文档写的「落进 band 的 ${bandIn} 盘」（${doc287.length} 处）== 工具现在量的 retreat band 内盘数`,
  `工具 ${bandIn}/${SEEDS} · 文档 ${doc287.join('/')}`);
const seqDoc = README.match(/6 : 7 : 8 : 9 : 10 : 11 : 12 =\s*(\d+) : (\d+) : (\d+) : (\d+) : (\d+) : (\d+) : (\d+)/);
const inBand = Object.fromEntries(normHist(retreatTool && retreatTool[8]).split(/\s+/).filter(Boolean).map(kv => kv.split('×')).map(([v, c]) => [+v, +c]));
const seqReal = [6, 7, 8, 9, 10, 11, 12].map(v => inBand[v] ?? 0);
ok(!!seqDoc && seqReal.join(',') === [1, 2, 3, 4, 5, 6, 7].map(i => seqDoc[i]).join(','),
  `D3h 文档那句 6:7:…:12 的分布 == 工具的 band 内直方图（${seqReal.join(':')}）`,
  seqDoc ? `文档 ${seqDoc.slice(1, 8).join(':')} vs 工具 ${seqReal.join(':')}` : '解析不到那句');
const oddTotal = totalM ? +totalM[4] : -1;
ok(!!totalM && oddTotal === 14 && /奇数负荷只有 14 盘/.test(README),
  `D3i 「11 893 盘里奇数负荷只有 ${oddTotal} 盘」== 工具现值`, `工具 ${oddTotal} · 文档 ${(README.match(/奇数负荷只有 14 盘/g) || []).length} 处`);
const oddInBand = loadRows.map(x => [x[1], normHist(x[8]).split(/\s+/).filter(Boolean).filter(kv => +kv.split('×')[0] % 2 === 1).reduce((a, kv) => a + +kv.split('×')[1], 0)]);
const splitTotal = totalM ? +totalM[5] : -1;
const oddSplit = [...README.matchAll(/假设 ≠ 枯竭」\s*的?(?:正好)?是那 (\d+) 盘/g)].map(m => +m[1]);
ok(!!totalM && splitTotal === oddInBand.reduce((a, [, c]) => a + c, 0) && oddSplit.length >= 1 && oddSplit.every(n => n === splitTotal),
  `D3j 文档那句「落进 band 的盘里假设 ≠ 枯竭的正好是那 ${splitTotal} 盘」== 工具合计，也== 各档 band 内奇数负荷之和`,
  `工具 ${splitTotal} · 各档 ${oddInBand.map(([k, c]) => `${k} ${c}`).join(' ')} · 合计 ${oddInBand.reduce((a, [, c]) => a + c, 0)}`);
const docSplit = README.match(/`书房` (\d+) 盘 \+ `隐修` (\d+) 盘/);
ok(!!docSplit && +docSplit[1] === (oddInBand.find(x => x[0] === 'study') || [])[1] && +docSplit[2] === (oddInBand.find(x => x[0] === 'retreat') || [])[1],
  `D3k 文档那句「书房 ${docSplit ? docSplit[1] : '?'} 盘 + 隐修 ${docSplit ? docSplit[2] : '?'} 盘」== 工具的各档 band 内奇数盘数`,
  `工具 study ${(oddInBand.find(x => x[0] === 'study') || [])[1]} · retreat ${(oddInBand.find(x => x[0] === 'retreat') || [])[1]}`);
const studyTool = loadRows.find(x => x[1] === 'study');
const studyFive = +(normHist(studyTool && studyTool[8]).match(/(?:^|\s)5×(\d+)/) || [])[1];
const docFive = README.match(/3000 个种子里有 (\d+) 盘负荷 5/);
ok(!!docFive && +docFive[1] === studyFive, `D3l 文档那句「${docFive ? docFive[1] : '?'} 盘负荷 5」== 工具 study 直方图里的 5×${studyFive}`,
  docFive ? `文档 ${docFive[1]} vs 工具 ${studyFive}` : '解析不到那句');
ok(LOTA.out.includes('✓ 出货 40 盘的每一个负荷值'), 'D3m 「npm run loads 会红」那条判据真的在工具里（不是文档里的一句话）',
  `load-audit 的收尾判据在，rc=${LOTA.rc}`);

// ---- D4 引擎层的条数：真跑五个套件 ----
ok(SUITES.length === 5 && SUITES.every(s => s.rc === 0 && s.n.length === 2 && s.n[1] === 0),
  `D4a ${SUITES.length} 个 node 套件这一趟全绿（红着的条数不算现值）`,
  SUITES.map(s => `${s.f} rc=${s.rc} rows=${s.n[0] ?? '?'} fail=${s.n[1] ?? '?'}`).join(' · '));
const suiteTotal = SUITES.reduce((a, s) => a + (s.n[0] || 0), 0);
const docSuites = [...DOCS.matchAll(/(\d+) 个 node 套件[，,] ?(\d+) 条断言/g)];
const docEngine = [...DOCS.matchAll(/(\d+) 条引擎断言/g)].map(m => +m[1]);
ok(docSuites.length >= 1 && docSuites.every(m => +m[1] === SUITES.length && +m[2] === suiteTotal) && docEngine.length >= 2 && docEngine.every(n => n === suiteTotal),
  'D4b 文档那句「N 个 node 套件，M 条断言」与两处「M 条引擎断言」逐处等于实跑合计',
  `实跑 ${SUITES.map(s => s.n[0]).join('+')} = ${suiteTotal} · 文档 ${[...docSuites.map(m => `${m[1]}套/${m[2]}条`), ...docEngine.map(n => n + '条引擎')].join(' / ')}`);
const suiteNames = SUITES.map(s => s.f.replace(/\.test\.mjs$/, ''));
ok(/5 个 node 套件/.test(DOCS) && suiteNames.length === 5 && readdirSync(join(ROOT, 'test')).filter(f => f.endsWith('.mjs')).length === 6,
  `D4b test/ 目录里就是文档说的那 ${SUITES.length} 个套件（+ fixtures.mjs）`, `套件 ${suiteNames.join(' ')} · 目录 6 个 .mjs`);
ok(AUDIT.rc === 0 && /^rows: 40 fail: 0$/m.test(AUDIT.out), `D4c audit-lots 独立核对 40 盘绿（rc=${AUDIT.rc}）`,
  (AUDIT.out.match(/^rows: \d+ fail: \d+$/m) || ['（没读到那一行）'])[0]);
const blurbClaims = TIERS_META.map(t => {
  const rowsOfTier = perTier[t.key];
  const want = `${t.n}×${t.n} · ${spreadText(rowsOfTier.map(r => r.guesses), '枯竭', '次')} · ${spreadText(rowsOfTier.map(r => r.depth), '假设', '层')}`;
  return { key: t.key, want, same: want === t.blurb, printed: DOCS.includes(want) };
});
ok(blurbClaims.every(b => b.same), `D4d 数据行上的 blurb 用 spreadText 从行重算得到（${blurbClaims.filter(b => b.same).length}/${blurbClaims.length} 档逐字相同）`,
  blurbClaims.map(b => `${b.key}:${b.same ? '✓' : '✗'}`).join(' '));
const printedBlurbs = blurbClaims.filter(b => b.printed);
ok(printedBlurbs.length >= 1 && printedBlurbs.every(b => b.same),
  `D4e 文档真的印了一串 blurb（${printedBlurbs.map(b => b.key).join('/')}），那一串 == spreadText 现在拼出来的`,
  `文档印了 ${printedBlurbs.length} 档的完整 blurb：${printedBlurbs.map(b => b.want.slice(0, 26)).join(' ｜ ')}`);

// ---- D5 门禁的形状：场景表、静态站点数、verify.sh 的条数表 ----
const sceneRows = [...README.matchAll(/^\| `@(\w+)` \| (\d+) \| (.+?) \|$/gm)];
ok(sceneRows.length === 9, `D5a README 的场景表解析到 9 行（不是 9 行就是形状改了）`, `${sceneRows.length} 行`);
// 场景条数的代码侧口径：一行 `rec(` 站点就是一条断言。两种例外要分开看：
//   * 驱动里的 `const rec = (name, pass, detail) => …` 是定义，不是站点（它不匹配 `rec(`）；
//   * `rec('…', false, detail)` 是**负控被打破时**才走的那一行红字分支，绿跑里没有这一条，
//     所以不计数——但它在文档里对应的那条断言仍然存在（全仓几处这样的分支，下面单独钉住数量）。
const PL = PLAYTEST.split('\n');
const REC_SITE = /^\s*rec\(/;
const REC_GUARD = /^\s*rec\([^)]*,\s*false\s*[,)]/;
const countRecs = ls => {
  const sites = ls.filter(l => REC_SITE.test(l));
  const guards = sites.filter(l => REC_GUARD.test(l));
  return { rows: sites.length - guards.length, sites: sites.length, guards: guards.length };
};
const sceneAt = PL.findIndex(l => /^const SCENARIOS = \{/.test(l));
const sceneEnd = PL.findIndex((l, i) => i > sceneAt && /^\};/.test(l));
const keyAt = PL.map((l, i) => (/^  (\w+): /.test(l) && i > sceneAt && i < sceneEnd ? { k: /^  (\w+): (.*)$/.exec(l)[1], i } : null)).filter(Boolean);
const pageBlock = { c: {}, sites: 0, guards: 0, n: keyAt.length };
keyAt.forEach((p, j) => {
  const r = countRecs(PL.slice(p.i, j + 1 < keyAt.length ? keyAt[j + 1].i : sceneEnd));
  pageBlock.c[p.k] = r.rows; pageBlock.sites += r.sites; pageBlock.guards += r.guards;
});
const driverCounts = {};
let driverSites = 0, driverGuards = 0;
for (const name of ['pointer', 'motion']) {
  const at = PL.findIndex(l => new RegExp(`^// -{10,} @${name}$`).test(l));
  const next = PL.findIndex((l, i) => i > at && /^\/\/ -{10,} /.test(l));
  const r = countRecs(PL.slice(at, next < 0 ? PL.length : next));
  driverCounts[name] = r.rows; driverSites += r.sites; driverGuards += r.guards;
}
const allSites = pageBlock.sites + driverSites;
const allGuards = pageBlock.guards + driverGuards;
ok(allSites - allGuards === 196 && allGuards >= 1 && keyAt.length === 7 && Object.keys(driverCounts).length === 2,
  `D5z 代码侧的 rec() 站点解析到 ${allSites} 处、扣掉 ${allGuards} 处负控红字分支之后正好 196 条，页面体 ${keyAt.length} 段 + node 驱动 2 段——解析不到就没有条数可对`,
  `站点 ${allSites} · 红字分支 ${allGuards} · 页面 ${pageBlock.sites} · 驱动 ${driverSites}`);
const codeCount = Object.fromEntries(sceneRows.map(m => [m[1], pageBlock.c[m[1]] ?? driverCounts[m[1]]]));
ok(sceneRows.every(m => Number.isFinite(codeCount[m[1]])), `D5b 九个场景的**代码侧**计数站点都解析到了（{ } 是页面体，pointer/motion 是 node 侧驱动）`,
  sceneRows.map(m => `@${m[1]}:${codeCount[m[1]] ?? 'X'}`).join(' '));
const SCENE_ASSERT = Object.fromEntries(['boot', 'taps', 'rules', 'logic', 'routes', 'save', 'reloaded', 'motion', 'pointer']
  .map(k => [k, `D5 @${k} 的断言数 == playtest.mjs 里这个场景的 rec() 站点数`]));
for (const m of sceneRows) {
  ok(+m[2] === codeCount[m[1]], SCENE_ASSERT[m[1]] || 'D5 未知场景',
    `文档 ${m[2]} vs 代码 ${codeCount[m[1]]}`);
}
const sceneSum = sceneRows.reduce((a, m) => a + +m[2], 0);
ok(sceneSum === 196 && (DOCS.match(/196 条/g) || []).length >= 4,
  `D5c 表里加起来 ${sceneSum} 条 == 文档写的 196 条（文档 ${(DOCS.match(/196 条/g) || []).length} 处）`, `${sceneRows.length} 行合计 ${sceneSum}`);
const expects = Object.fromEntries(((VERIFY.match(/EXPECTS='([^']*)'/) || [, ''])[1].trim().split(/\s+/).filter(Boolean).map(kv => kv.split('='))));
ok(Object.keys(expects).length === 9, `D5d verify.sh 的条数表解析到 9 格（解析不到就是脚本没接上这一步）`,
  `${Object.keys(expects).length} 格：${Object.keys(expects).join(' ')}`);
const expectDrift = sceneRows.filter(m => +expects[m[1]] !== +m[2]);
ok(expectDrift.length === 0, 'D5e 文档表与 verify.sh 的 EXPECTS 逐格相同（脚本与文档不许有两个数）',
  expectDrift.length ? `漂了：${expectDrift.map(m => `${m[1]} 文档 ${m[2]} vs 脚本 ${expects[m[1]]}`).join('，')}` : '9 格相同');
const verifyList = (VERIFY.match(/for s in \$\{SCENARIOS:-([^}]*)\}/) || [])[1];
const verifyScens = verifyList ? verifyList.trim().split(/\s+/) : [];
ok(verifyScens.join(' ') === sceneRows.map(m => m[1]).join(' '), `D5f README 的场景表名字与顺序逐条 == verify.sh 的 SCENARIOS 默认值`,
  `脚本 ${verifyScens.join(' ')} vs 文档 ${sceneRows.map(m => m[1]).join(' ')}`);
const stRows = Number((SELFTEST.out.match(/"rows":(\d+)/) || [])[1]);
const stPass = /"pass":true/.test(SELFTEST.out);
const sevenHits = (DOCS.match(/七个页面场景体/g) || []).length;
ok(stPass && pageBlock.n === 7 && stRows === pageBlock.n && sevenHits === 2,
  'D5g 「七个页面场景体」== SCENARIOS 的键数 == selftest 这一趟报的 rows，文档两处都还这么写',
  `SCENARIOS ${pageBlock.n} 键 · selftest ${stRows} 项 · 文档 ${sevenHits} 处 · rc=${SELFTEST.rc}`);
ok(/SCENARIOS=.*至少|COMPARED/.test(VERIFY) && /九格全跑时必须比满九格/.test(README),
  'D5h verify.sh 真的逐格比实测条数（文档第 7 步那句话有脚本作证，不是一句愿望）',
  VERIFY.includes('COMPARED') ? '脚本里有 COMPARED 计数' : '脚本里没有条数对账');

// ---- D6 端口：文档 == 三个脚本的现值 ----
const vCdp = Number((VERIFY.match(/CDP_PORT=\$\{CDP_PORT:-(\d+)\}/) || [])[1]);
const vWeb = Number((VERIFY.match(/WEB_PORT=\$\{WEB_PORT:-(\d+)\}/) || [])[1]);
const pCdp = Number((PLAYTEST.match(/CDP_PORT \|\| (\d+)/) || [])[1]);
const pBase = Number((PLAYTEST.match(/BASE_URL \|\| 'http:\/\/127\.0\.0\.1:(\d+)/) || [])[1]);
const srvDefault = Number((SERVER.match(/\|\| (\d+);/) || [])[1]);
const npmStart = (PKG.scripts.start || '') + '|' + (PKG.scripts.dev || '');
const docHttpCdp = [...DOCS.matchAll(/HTTP (\d{4}) \/ CDP (\d{4})/g)];
ok([vCdp, vWeb, pCdp, pBase, srvDefault].every(Number.isFinite) && docHttpCdp.length >= 2,
  `D6a 五个端口来源 + 文档那一句都解析到了（verify ${vWeb}/${vCdp} · playtest ${pBase}/${pCdp} · server ${srvDefault} · 文档「HTTP N / CDP N」${docHttpCdp.length} 处）`,
  `verify ${vWeb}/${vCdp} · playtest ${pBase}/${pCdp} · server.cjs 裸跑 ${srvDefault}`);
ok(vCdp === pCdp && vWeb === pBase && vWeb === 5256 && vCdp === 9365 && docHttpCdp.every(m => +m[1] === vWeb && +m[2] === vCdp),
  `D6 闸与台架的默认号是同一对（HTTP ${vWeb} / CDP ${vCdp}），文档两处写的也是这一对`,
  docHttpCdp.map(m => `${m[1]}/${m[2]}`).join(' '));
ok(/5256/.test(npmStart) && srvDefault === 5173 && /5173/.test(README),
  `D6b server.cjs 自己不传参时落 ${srvDefault}，5256 是 npm start 显式传进去的（文档这么写的就是这一条）`,
  `server ${srvDefault} · npm start=${PKG.scripts.start} · 文档提到 5173：${/5173/.test(README)}`);
ok((README.match(/三种形态各 196 条|各 196 条/) || []).length >= 1 && (README.match(/BASE_URL=/g) || []).length >= 2,
  'D6c 文档明写三种 URL 形态各 196 条（这条是被 D5c 的合计证的现值）', `BASE_URL 出现 ${(README.match(/BASE_URL=/g) || []).length} 次`);

// ---- D7 屏上的口径：audit() 的键、三态、最佳、星级、两个键、三条规则、三色、键盘 ----
const auditKeys = ((RULES_SRC.match(/return \{\n(\s+violations,\n[\s\S]*?)\n  \};/) || [])[1] || '')
  .split('\n').map(l => (l.trim().match(/^(\w+)\s*[,：:]/) || [])[1]).filter(Boolean);
ok(auditKeys.length >= 8, `D7a audit() 的返回键解析到 ${auditKeys.length} 个（解析不到就是函数改了形状，后面的等式全在空转）`, auditKeys.join(' '));
const namedAudit = [...README.matchAll(/`audit\(\)\.(\w+)`/g)].map(m => m[1]);
ok(namedAudit.length >= 3 && namedAudit.every(k => auditKeys.includes(k)),
  `D7 「屏上的每个数字是谁算出来的」表点名的 audit() 字段全在返回值里（${namedAudit.join(' ')}）`,
  `文档 ${namedAudit.length} 个 · 代码 ${auditKeys.length} 个 · 缺：${namedAudit.filter(k => !auditKeys.includes(k)).join(',') || '无'}`);
const probe = audit({ n: 4, cells: LOTS[0].cells }, new Array(16).fill(2).map((v, i) => (LOTS[0].solution.includes(i) ? 1 : v)));
ok(probe.done === true && probe.violations.length === 0 && probe.byRule[1].length === 0,
  'D7b 真把 audit() 跑在出货第一盘的解上：done 且三条各 0 处（文档那句「唯一口径」是行为，不是措辞）',
  `done=${probe.done} violations=${probe.violations.length} forcedOpen=${probe.forcedOpen.length}`);
const minTapsSrc = (GAME.match(/export function minTaps[\s\S]*?\n\}/) || [''])[0];
ok(/lot\.solution\.length \+ 2 \* \(total - lot\.solution\.length\)/.test(minTapsSrc) && /minTaps\(lot\) = 黑格数 \+ 2 × 非黑格数/.test(README),
  'D7c 「最佳 N 下 = 黑格数 + 2 × 非黑格数」逐字 == game.js 的 minTaps 函数体', minTapsSrc.replace(/\s+/g, ' ').slice(0, 90));
const tapsBad = LOTS.filter(l => minTaps(l) !== l.shades + 2 * (l.n * l.n - l.shades));
ok(tapsBad.length === 0, `D7d minTaps 在 40 行上逐个重算 == shades + 2 × 非 shades（${LOTS.length} 行）`,
  tapsBad.length ? `不符：${tapsBad.map(l => l.id).join(' ')}` : `${LOTS.length}/${LOTS.length}`);
const gradeSrc = (MAIN.match(/function grade\(g\)[\s\S]*?\n\}/) || [''])[0];
const gradeDoc = [...DOCS.matchAll(/`grade\(\)`：`(.+?)`/g)].map(m => m[1]);
ok(gradeDoc.length >= 1 && /const over = g\.taps - minTaps\(g\.lot\);/.test(gradeSrc) && /if \(over <= 0 && g\.fixes === 0\)/.test(gradeSrc),
  `D7e 文档写的星级判据（over = taps − 最佳，over <= 0 && fixes === 0）逐段 == main.js 的 grade() 函数体`,
  gradeDoc.length ? `文档「${gradeDoc.join(' / ')}」` : '解析不到那句');
const gradeSays = [...DOCS.matchAll(/`grade\(\)`：(.{0,120}?)才是三乘/g)].map(m => m[1]);
ok(gradeSays.length >= 1 && gradeSays.every(s => /over <= 0/.test(s) && /fixes === 0/.test(s))
  && !/taps === minTaps/.test(DOCS),
  'D7f 文档的星级那句逐处写的都是 over <= 0 && fixes === 0，没有写成 taps === minTaps',
  `文档「grade()」句 ${gradeSays.length} 处（${gradeSays.map(s => s.replace(/\s+/g, ' ').slice(0, 44)).join(' / ')}）· 旧写法 taps === minTaps 命中：${(/taps === minTaps/.test(DOCS)) ? '有（红）' : '无'}`);
const codeKeys = [...new Set([...STORAGE.matchAll(/'(hitori\.\w+\.v\d+)'/g), ...MAIN.matchAll(/'(hitori\.\w+\.v\d+)'/g)].map(m => m[1]))];
const docKeys = [...new Set((DOCS.match(/hitori\.\w+\.v\d+/g) || []))];
ok(codeKeys.length === 2 && docKeys.length === 2 && codeKeys.every(k => docKeys.includes(k)),
  `D7g localStorage 的键：代码里是 ${codeKeys.join(' + ')}，文档写的也是这两个（${docKeys.join(' + ')}）`,
  `代码 ${codeKeys.length} 个 · 文档 ${docKeys.length} 个 · 差集 ${[...codeKeys.filter(k => !docKeys.includes(k)), ...docKeys.filter(k => !codeKeys.includes(k))].join(',') || '无'}`);
const designOneKey = /一个键/.test(DESIGN);
ok(!designOneKey && /hitori\.resume\.v1/.test(DESIGN) && /两个 localStorage 键/.test(DESIGN),
  'D7h DESIGN 不再说「一个键」，明写「两个 localStorage 键」并点名 resume 那一个',
  'DESIGN 仍写「一个键」：' + designOneKey + ' · 点名 resume：' + /hitori\.resume\.v1/.test(DESIGN));
ok(OPEN === 0 && SHADED === 1 && DOT === 2 && nextMark(OPEN) === SHADED && nextMark(SHADED) === DOT && nextMark(DOT) === OPEN
  && /OPEN 0 \/ SHADED 1 \/ DOT 2/.test(DOCS) && /未涂 → 涂黑 → 打点 → 未涂/.test(README),
  `D7i 三态数值与循环 == grid.js 现值（${OPEN}/${SHADED}/${DOT}，nextMark 走一圈回到未涂）`,
  `代码 ${OPEN}→${SHADED}→${DOT}→${OPEN} · 文档两句都在：${/OPEN 0 \/ SHADED 1 \/ DOT 2/.test(DOCS) && /未涂 → 涂黑 → 打点 → 未涂/.test(README)}`);
const ruleTexts = (INDEX.match(/<li data-rule="\d">(.+?)<\/li>/g) || []).map(s => s.replace(/<[^>]+>/g, ''));
const docRuleLines = [/每行每列不得出现两个相等的\*\*未涂\*\*数字/, /^2\. 任意两个涂黑格不得正交相邻/m, /^3\. 所有未涂格必须正交连通/m].filter(re => re.test(README)).length;
const mainRuleTexts = [...MAIN.matchAll(/^\s+(\d): '([^']+)',$/gm)].filter(m => [1, 2, 3].includes(+m[1])).map(m => m[2]);
const cfRuleTexts = ((PLAYTEST.match(/const RULES = \[([^\]]*)\]/) || [])[1] || '').match(/'([^']+)'/g) || [];
ok(ruleTexts.length === 3 && mainRuleTexts.length === 3 && cfRuleTexts.length === 3 && docRuleLines === 3,
  `D7j 三条规则在四处都解析到了（页面 ${ruleTexts.length} 条 · ruleName ${mainRuleTexts.length} 条 · CF ${cfRuleTexts.length} 条 · 文档 ${docRuleLines} 条）`,
  `页面 ${ruleTexts.length} · 代码 ${mainRuleTexts.length} · CF_BODY ${cfRuleTexts.length}`);
ok(ruleTexts.length === 3 && mainRuleTexts.join('|') === ruleTexts.join('|')
  && cfRuleTexts.map(x => x.slice(1, -1)).join('|') === ruleTexts.join('|') && docRuleLines === 3,
  'D7 页面 <li> 的三条、main.js 的 ruleName、playtest 的 CF_BODY RULES 与 README 那三条是同一份文字',
  `页面「${ruleTexts.join(' / ')}」`);
const ruleColors = [...CSS.matchAll(/--rule(\d): (#[0-9a-f]{6})/g)];
ok(ruleColors.length === 3 && new Set(ruleColors.map(m => m[2])).size === 3 && /规则 1 红、规则 2 紫、规则 3 青/.test(README)
  && /红\/紫\/青三色各自对应编号 1\/2\/3/.test(MAIN),
  `D7k 一条规则一个颜色：css 里 --rule1/2/3 是三个不同的值（${ruleColors.map(m => m[2]).join(' ')}），文档与 main.js 都按 1红/2紫/3青 点名`,
  `${ruleColors.length} 个变量 · 文档那句在：${/规则 1 红、规则 2 紫、规则 3 青/.test(README)}`);
const keys = ['c', 'u', 'r', 'h'];
const keyHits = keys.filter(k => new RegExp(`k === '${k}'`).test(MAIN));
const spaceHit = /ev\.key === ' '|key === ' '/.test(MAIN);
const enterHit = /ev\.key === 'Enter'|key === 'Enter'/.test(MAIN);
ok(keyHits.length === keys.length && /ArrowUp/.test(MAIN) && /ArrowRight/.test(MAIN) && enterHit && spaceHit
  && /`c` 聚焦棋盘，方向键移动光标，`Enter` \/ `空格` 敲当前格，`u` 回退，`r` 重开，`h` 提示/.test(README),
  `D7l 键盘句的六个键都在 main.js 的 handler 里（${keyHits.join(' ')} + 方向键 + Enter + 空格）`,
  `命中 ${keyHits.length}/4 · Enter ${enterHit} · 空格 ${spaceHit} · 方向键 ${/ArrowUp/.test(MAIN) && /ArrowRight/.test(MAIN)}`);

// DESIGN §3 说「页面文件不 import make.js、brute.js（grep 可证）」。这是一句缺席断言，
// 所以：先把 import 语句真的解析出条数（解析到 0 条就是红，不是绿），再逐条比对模块路径。
const VIEW = read('js/view.js');
// 页面模块图的全部入度就是这些 `from './…'` 子句。多行的 import 语句也一起算：只看子句，
// 所以「把两条并到一行」这种改法打不掉这一条。
const importSpecs = [...(MAIN + '\n' + VIEW).matchAll(/\bfrom\s+'(\.[^']*)'/g)].map(m => m[1]);
const generatorImports = importSpecs.filter(p => /\/(make|brute)\.js$/.test(p));
const stmtCount = (MAIN.match(/^import\s/gm) || []).length + (VIEW.match(/^import\s/gm) || []).length;
ok(importSpecs.length >= 12 && stmtCount >= 12 && generatorImports.length === 0,
  'D7m 页面文件（main.js + view.js）的 import 解析到 N 条，其中没有一条来自生成器（make.js / brute.js）',
  `子句 ${importSpecs.length} 条 / 语句 ${stmtCount} 条 · 命中生成器：${generatorImports.join(',') || '无'} · DESIGN 那句「grep 可证」在：${/页面文件不 import `make\.js`、`brute\.js`/.test(DESIGN)}`);
const bruteImports = [...read('js/core/brute.js').matchAll(/\bfrom\s+'([^']*)'/g)].map(m => m[1]);
ok(bruteImports.length === 0 && /brute\.js` 也不 import `rules\.js/.test(DESIGN),
  'D7n 独立复核那一套真的零 import（第三份代码不借第一份的口径）· 解析到 0 条是这一条的正证，不是空转',
  `brute.js import ${bruteImports.length} 条 · 文档那句在：${/brute\.js` 也不 import `rules\.js/.test(DESIGN)}`);

// ---- D8 引用锚点：文档与注释里的 file:NN 都得落在真行上，带符号的还要真指到那个符号 ----
const citeRe = /((?:\.github\/workflows\/|tools\/|js\/|css\/|test\/)?[\w./-]+\.(?:js|mjs|cjs|sh|json|html|yml|css)):(\d+)(?:-(\d+))?/g;
const srcForCites = [README_DOC, DESIGN_DOC, read('tools/load-audit.mjs'), read('tools/playtest.mjs'), read('js/main.js'), read('js/core/library.js')].join('\n');
const cites = [...srcForCites.matchAll(citeRe)];
ok(cites.length >= 8, `D8a path:NN 引用解析到 ${cites.length} 条（少于 8 条说明引用格式被换了，下面的等式就在空转）`, `${cites.length} 条`);
const CITABLE = ['', 'js/', 'js/core/', 'js/data/', 'tools/', 'css/', 'test/'];
const resolveCite = p => CITABLE.map(pre => pre + p).find(q => existsSync(join(ROOT, q))) || null;
const citeBad = [];
for (const c of cites) {
  const rp = resolveCite(c[1]);
  if (!rp) { citeBad.push(`${c[1]}:${c[2]}（仓里找不到这个文件）`); continue; }
  const src = read(rp);
  const n = src.split('\n').length;
  if (+c[2] > n || (+c[3] && +c[3] > n)) citeBad.push(`${rp}:${c[2]}${c[3] ? '-' + c[3] : ''}（该文件只有 ${n} 行）`);
}
ok(citeBad.length === 0, `D8 ${cites.length} 条 path:NN 引用都落在真实文件的行数内`,
  citeBad.length ? `越界：${citeBad.join('，')}` : `${cites.length} 条全部在范围内`);
const ANCHORS = [
  ['js/core/grid.js', 'OPEN', /`(js\/core\/grid\.js):(\d+)-(\d+)` 定死 `OPEN/, 'D8b js/core/grid.js 的行号引用真指着 OPEN'],
  ['js/core/game.js', 'minTaps', /`(js\/core\/game\.js):(\d+)-(\d+)`）——打点要两下/, 'D8b js/core/game.js 的行号引用真指着 minTaps'],
  ['js/core/solve.js', 'UNKNOWN', /`(js\/core\/solve\.js):(\d+)-(\d+)` 另有一组 `UNKNOWN/, 'D8b js/core/solve.js 的行号引用真指着 UNKNOWN'],
  ['js/core/make.js', 'band', /`(js\/core\/make\.js):(\d+)` 那句注释就是这个意思/, 'D8b js/core/make.js 的行号引用真指着 band'],
  ['css/game.css', '.menu', /`(css\/game\.css):(\d+)` 给 `\.menu` 定了 `display: grid`/, 'D8b css/game.css 的行号引用真指着 .menu'],
];
for (const [file, token, re, label] of ANCHORS) {
  const m = DESIGN.match(re);
  let hit = false;
  let detail = `文档里没有「${file}:NN 的 ${token}」这条引用`;
  if (m) {
    const a = +m[2];
    const b = +(m[3] || m[2]);
    const lines = read(file).split('\n');
    const seg = lines.slice(a - 1, b).join('\n');
    hit = seg.includes(token);
    detail = `${file}:${a}${m[3] ? '-' + m[3] : ''} 那${m[3] ? '几' : '一'}行${hit ? '含' : '不含'} ${token}（实际是「${(lines[a - 1] || '').trim().slice(0, 46)}」）`;
  }
  ok(hit, label, detail);
}
const gradeAt = MAIN.split('\n').findIndex(l => /function grade\(g\)/.test(l)) + 1;
const rangeCite = (PLAYTEST.match(/test\/game\.test\.mjs:(\d+)-(\d+)/) || [])[0];
const rangeM = PLAYTEST.match(/test\/game\.test\.mjs:(\d+)-(\d+)/);
let rangeHit = false;
if (rangeM) {
  const lines = read('test/game.test.mjs').split('\n');
  rangeHit = lines.slice(+rangeM[1] - 1, +rangeM[2]).join('\n').includes('fixes');
}
ok(gradeAt > 0 && rangeHit, `D8c 代码注释里的引用也一起钉：playtest 写的 ${rangeCite || '?'} 那几行现在真的在讲 fixes（grade() 在 main.js 第 ${gradeAt} 行，文档按名字引它，不抄行号）`,
  `game.test.mjs 那 15 行含 fixes：${rangeHit} · grade() 第 ${gradeAt} 行`);

// ---- D9 接线：文件地图、npm scripts、CI、verify.sh 跑的是同一套 ----
const mapRows = [...README.matchAll(/^([a-z][\w./-]*\.(?:js|mjs|cjs|sh|html|css|yml)) {2,}\S/gm)];
ok(mapRows.length >= 18, `D9a README 的「目录」文件地图解析到 ${mapRows.length} 条（解析不到就是整节被删）`, `${mapRows.length} 条`);
const mapMissing = mapRows.map(m => m[1]).filter(p => !existsSync(join(ROOT, p)));
ok(mapMissing.length === 0, `D9 「目录」里点名的 ${mapRows.length} 个文件都在树里`,
  mapMissing.length ? `不在树里：${mapMissing.join('，')}` : '全部存在');
const treeTools = readdirSync(join(ROOT, 'tools')).filter(f => f.endsWith('.mjs') || f.endsWith('.sh')).sort();
const unmaped = treeTools.filter(f => !README.includes(`tools/${f}`));
ok(unmaped.length === 0, `D9b tools/ 下每一个闸都被「目录」点名（新增一道闸不写进地图就是红）：${treeTools.join(' ')}`,
  unmaped.length ? `没写进地图：${unmaped.join(' ')}` : `${treeTools.length} 个全在`);
const docNpm = [...new Set((README.match(/npm run (\w+)/g) || []).map(s => s.split(' ')[2]))];
const phantom = docNpm.filter(k => !PKG.scripts[k]);
ok(docNpm.length >= 8 && phantom.length === 0, `D9c 文档里每一条 \`npm run X\`（${docNpm.length} 条）都在 package.json 的 scripts 里`,
  phantom.length ? `空头命令：${phantom.join('，')}` : docNpm.join(' '));
const gates = ['doctest', 'sabotage', 'verify'];
ok(gates.every(k => PKG.scripts[k] && /^node tools\/(doctest|sabotage)\.mjs$|^bash tools\/verify\.sh$/.test(PKG.scripts[k])),
  `D9d npm 入口 ${gates.join('/')} 都在，且指向仓里那三个文件`, gates.map(k => `${k}=${PKG.scripts[k] || '缺'}`).join(' · '));
ok(/node tools\/doctest\.mjs/.test(VERIFY) && /node tools\/doctest\.mjs/.test(CI) && /node tools\/sabotage\.mjs/.test(CI),
  'D9e doctest 同时接在 verify.sh 与 ci.yml 上，sabotage 接在 ci.yml 上（本地与 CI 是同一条命令，不是两个东西）',
  `verify ${/doctest/.test(VERIFY)} · ci ${/doctest/.test(CI)}/${/sabotage/.test(CI)}`);
const ciRuns = [...new Set((CI.match(/(?:node|bash) tools\/[\w.-]+/g) || []))];
const ciGone = ciRuns.filter(c => !existsSync(join(ROOT, c.split(' ')[1])));
ok(ciRuns.length >= 4 && ciGone.length === 0, `D9f ci.yml 跑的 ${ciRuns.length} 条 tools 命令指的文件都在`,
  ciGone.length ? `空头：${ciGone.join('，')}` : ciRuns.join(' / '));
const verifyCmds = [...new Set((VERIFY.match(/(?:node|bash) tools\/[\w.-]+/g) || []))];
ok(PKG.scripts.verify === 'bash tools/verify.sh' && verifyCmds.includes('node tools/doctest.mjs'),
  `D9g 本地入口（npm run verify）与 CI 入口是同一个脚本，verify.sh 里也确实串了 doctest`,
  `npm=${PKG.scripts.verify} · verify.sh 串了 ${verifyCmds.join(' / ')}`);
ok(/node tools\/doctest\.mjs/.test(DESIGN) && /node tools\/sabotage\.mjs/.test(DESIGN),
  'D9h DESIGN §13 的复现块里有这两道新闸的命令（照别人抄的复现步骤必须包含全部闸）', `DESIGN 点名 doctest/sabotage`);

// ---- D10 墙钟纪律：钉出处与方向，不重测、不写新数 ----
const datedLoads = README.match(/（(20\d\d-\d\d-\d\d) 本机约 (\d+)s；耗时随机器与负载漂，不是闸的期望）/);
ok(!!datedLoads && (DOCS.match(/本机约 20s/g) || []).length === 1,
  `D10a \`npm run loads\` 的秒数只以「${datedLoads ? datedLoads[1] : '?'} 本机」的读数出现，且带一句方向（全仓 ${(DOCS.match(/本机约 20s/g) || []).length} 处）`,
  datedLoads ? `${datedLoads[1]} · ${datedLoads[2]}s · 不是闸的期望` : '解析不到那句');
const datedBake = README.match(/`node tools\/bake\.mjs` 的报告（本机，(20\d\d-\d\d-\d\d).+?）/);
ok(!!datedBake, `D10b bake 报告那一句写明它是本机哪一天的读数（${datedBake ? datedBake[1] : '没写'}）`, datedBake ? datedBake[0].slice(0, 70) : '解析不到');
const msCells = docBake.map(m => +m[7]);
ok(docBake.length === 4 && msCells.length === 4 && msCells.every(n => n > 0)
  && /「独立复核耗时」是那一台机器那一轮的读数，随负载漂，不进任何闸的期望/.test(README)
  && /前面四列（种子数、唯一解率、落带率、出货负荷）是结构数字/.test(README),
  `D10c bake 表只有最后一列是墙钟（${msCells.join('/')} ms），文档自己就是这么声明的`,
  `最后一列 ${msCells.join('/')} · 方向句在：${/不进任何闸的期望/.test(README)}`);
const designProse = DESIGN.replace(/```[\s\S]*?```/g, '');
const designWall = [...designProse.matchAll(/\d+(?:\.\d+)? ?(ms|秒|s)\b/g)];
const readmeWall = [...README.matchAll(/(\d+(?:\.\d+)?) ?(ms|秒)/g)].map(m => +m[1]);
ok(designWall.length === 0 && readmeWall.length === docBake.length && readmeWall.every((v, i) => v === +docBake[i][7]) && !!datedBake,
  `D10d 文档里带数字的墙钟只剩 bake 表最后一列那 ${readmeWall.length} 格（${readmeWall.join('/')} ms），全部坐在带日期的那一句下面；DESIGN 的散文里一个裸读数都没有`,
  `README ms 命中 ${readmeWall.length} 处 · DESIGN 裸墙钟 ${designWall.length} 处（${designWall.map(m => m[0]).join(' ') || '无'}）`);

// ---- D11 台账：刀是从 README 那张表里解析出来的，每一把都得打得住 ----
const ledger = read('README.md').split('\n').filter(l => /^\| K\d+ \| /.test(l));
ok(ledger.length >= 8, `D11a README 的破坏试验台账解析到 ${ledger.length} 把刀（解析不到不等于通过）`, `${ledger.length} 行`);
const PHC = String.fromCharCode(1);
const parse = l => l.replace(/\\\|/g, PHC).split('|').slice(1, -1).map(c => c.trim().replace(new RegExp(PHC, 'g'), '|'));
const kn = ledger.map(l => {
  const c = parse(l);
  return { id: c[0], why: c[1], file: (c[2] || '').replace(/`/g, ''), needle: (c[3] || '').replace(/`/g, '').replace(/\\n/g, '\n'),
    repl: (c[4] || '').replace(/`/g, '').replace(/\\n/g, '\n'), expect: (c[5] || '').replace(/`/g, ''), cmd: (c[6] || '').replace(/`/g, ''), rc: c[7] };
});
ok(kn.length === ledger.length && kn.every(k => k.id && k.file && k.needle && k.repl && k.expect && k.cmd && k.rc !== undefined),
  `D11b 台账每行 8 列都解析到了（列数不是 8 就是形状改了）`, kn.map(k => `${k.id}:${parse(ledger[kn.indexOf(k)]).length}`).join(' '));
const badCol = kn.filter(k => parse(ledger[kn.indexOf(k)]).length !== 8);
ok(badCol.length === 0, `D11c 台账每行都是 8 列`, badCol.map(k => `${k.id} ${parse(ledger[kn.indexOf(k)]).length} 列`).join('，') || `${kn.length} 行 × 8 列`);
const ids = kn.map(k => k.id);
ok(new Set(ids).size === ids.length, `D11d 刀号唯一（${ids.join(' ')}）`, ids.join(' '));
const gateSrc = [README_DOC, DESIGN_DOC, VERIFY, CI, SAB_SRC, read('tools/doctest.mjs'), read('tools/audit-lots.mjs'), read('package.json')].join('\n');
for (const k of kn) {
  let src = '';
  try { src = read(k.file); } catch { ok(false, `D11 ${k.id} 打的文件还在树里`, `${k.file} 不存在`); continue; }
  const outside = stripLedger(src);
  const hits = outside.split(k.needle).length - 1;
  ok(hits === 1, `D11 ${k.id} 的针在 ${k.file}（台账行之外）唯一命中`, `命中 ${hits} 次`);
  ok(gateSrc.includes(k.expect), `D11 ${k.id} 期望点名的断言还写在闸里`, `「${k.expect.slice(0, 40)}」${gateSrc.includes(k.expect) ? '在' : '不在'}`);
}
ok(kn.every(k => /^node tools\/doctest\.mjs$|^npm test$|^node tools\/audit-lots\.mjs$/.test(k.cmd)),
  `D11f 台账的命令格全部指向纯逻辑闸（浏览器腿不进台账：它起 Chrome，刀打的文件可能与它无关）`,
  [...new Set(kn.map(k => k.cmd))].join(' ｜ '));
const rcCells = kn.map(k => k.rc);
const stamped = rcCells.filter(x => /^\d+$/.test(x));
ok(rcCells.every(x => x === '?' || /^\d+$/.test(x)) && (stamped.length === 0 || stamped.length === rcCells.length),
  `D11g 台账的 rc 格要么整列还是「?」（这一轮没跑过），要么整列都是读回来的数字——不许半戳`,
  rcCells.join(' '));
const groupsHit = new Set(kn.map(k => (k.expect.match(/^D\d+/) || [])[0]).filter(Boolean));
ok(groupsHit.size >= 6, `D11h 台账覆盖 ${groupsHit.size} 个不同的断言组（${[...groupsHit].sort().join(' ')}），不是只把一组成员翻来覆去打`,
  `${groupsHit.size} 组 / 共 ${emitted.size} 组`);
// 每一类谎都得有自己的反刀（rule 5：「扫不到就绿」的那一类尤其）。
const KNIFE_CLASS = [
  ['文档表格的逐格现值（bake / loads / 复核表）', /^D1 |^D2 |^D3 /],
  ['场景条数与脚本里的条数表', /^D5/],
  ['引擎断言的合计', /^D4/],
  ['星级口径与两个 localStorage 键', /^D7f|^D7g/],
  ['缺席类断言（页面不 import 生成器）', /^D7m|^D7n/],
  ['file:NN 引用锚点', /^D8/],
  ['接线（verify.sh 与 ci.yml 跑同一条命令）', /^D9/],
  ['数据行本身（audit-lots 的口径）', /假设\+枯竭/],
];
const classMiss = KNIFE_CLASS.filter(([, re]) => !kn.some(k => re.test(k.expect)));
ok(classMiss.length === 0, `D11i 台账覆盖 ${KNIFE_CLASS.length} 类断言，每一类都有自己的反刀（rule 5：缺席类与引用类不许只靠「扫不到就绿」）`,
  classMiss.length ? `没有刀：${classMiss.map(([n]) => n).join('，')}` : KNIFE_CLASS.map(([n, re]) => `${n}→${(kn.find(k => re.test(k.expect)) || {}).id}`).join(' · '));

// ---- D12 UNPINNED：钉不住的数一条一条登记，每条带一个 needle 断言它还在文档里 ----
const UNPINNED = [
  ['U1', 'bake 表最后一列「独立复核耗时」的 ≤ 11 / ≤ 2 / ≤ 36 / ≤ 49 ms', '独立复核耗时', '那一台机器那一轮的读数；D10c 钉的是「这一列是墙钟、不进闸的期望」这个声明，不是数'],
  ['U2', 'npm run loads 的「本机约 20s」', '本机约 20s', '墙钟；D10a 钉它的日期与方向。本机这一趟 load-audit 远快于此，但按规矩不拿新数覆盖旧数'],
  ['U3', '浏览器 196 条的**实测**条数', '合计 196 条浏览器断言', '要真 Chrome；doctest 只比文档表、verify.sh 的 EXPECTS 与代码侧站点数，实测逐格比对在 verify.sh 第 7 步'],
  ['U4', '三种 URL 形态各 196 条', '三种形态各 196 条', '含已上线产物那一种：只能部署之后跑'],
  ['U5', '台账 rc 一列的实测退出码', '实测 rc', '由 tools/sabotage.mjs 把 rc 读回来盖进 README；D11g 只钉这一列的形状（不许半戳）'],
  ['U6', 'DESIGN §8 的亮度读数「从 21 抬到 60」', '从 21 抬到 60', '那一轮 @pointer 的像素观察，代码里没有第二份'],
  ['U7', 'DESIGN §11 的 y=1062 与 773 高', 'y=1062', '当年那个 bug 的视口读数（历史观察）；今天的命中盒负控由 @pointer 跑'],
  ['U8', '「一次泄漏的 headless Chrome 让预检在毫秒级就通过」', '毫秒级', '一次历史故障的观察；端口归属预检本身由 D6 钉现值'],
  ['U9', '提示环在 prefers-reduced-motion 下永久停留的旧行为', '永久停留', '修复过程的观察；现在的行为由 @motion 那 11 条浏览器断言钉'],
  ['U10', '「40 盘写盘与上一次烘焙逐字节相同」那一轮', '逐字节相同', '这是历史叙述；本仓的常驻证据是 D2h（这一趟重跑之后字节不变）'],
];
UNPINNED.forEach(([id, what, needle]) => {
  const hits = DOCS.split(needle).length - 1;
  ok(hits >= 1, `D12 ${id} 未钉死的数「${what.slice(0, 34)}」还写在文档里（删掉那句话来变绿就是这一条红）`, `${hits} 处 · needle「${needle}」`);
});
ok(UNPINNED.every(([, , n]) => DOCS.includes(n)), `D12a 反空转：${UNPINNED.length} 条 unpinned 逐条在文档里找到 needle`,
  `${UNPINNED.filter(([, , n]) => DOCS.includes(n)).length}/${UNPINNED.length}`);
const unpinnedDoc = [...DOCS.matchAll(/unpinned（(\d+) 条\)|(\d+) 条 unpinned/g)].map(m => +(m[1] || m[2]));
ok(unpinnedDoc.length >= 1 && unpinnedDoc.every(n => n === UNPINNED.length),
  `D12b 文档写的 unpinned 条数 == 本文件那张清单的长度 ${UNPINNED.length}`, `文档 ${unpinnedDoc.join('/') || '没写'} vs 清单 ${UNPINNED.length}`);
// 文档写的必须是**全部跑完**的那本账，而 CI 那一步钉的是最后一行打印的 `rows:`。
// 本节自己还有 D12c/D12d/D12e/D12f 四条没入账，所以先把它们数进来——不数进来就会出现
// 「闸自己打印 135 项、却要求文档写 132 项」这种两边永远对不齐的红。
// TRAILING 写错由 D12f 逐字抓住（往本节末尾加一条却不改这个数，就是那一格红）。
const TRAILING = 4;
const finalRows = rows + TRAILING;
const pinnedRows = finalRows - UNPINNED.length;
const itemDoc = [...DOCS.matchAll(/doctest[^。]{0,40}?（(\d+) 项 = (\d+) 条等式 \+ (\d+) 条 unpinned）/g)];
ok(itemDoc.length >= 1 && +itemDoc[0][1] === finalRows && +itemDoc[0][2] === pinnedRows && +itemDoc[0][3] === UNPINNED.length,
  `D12c 文档写的「（${finalRows} 项 = ${pinnedRows} 条等式 + ${UNPINNED.length} 条 unpinned）」等于这一趟跑出来的账`,
  itemDoc.length ? `文档 ${itemDoc.map(m => m.slice(1, 4).join('/')).join(' ')} vs 本次 ${finalRows}/${pinnedRows}/${UNPINNED.length}` : `解析不到那句（本次 ${finalRows}/${pinnedRows}/${UNPINNED.length}）`);
ok(rows >= 60, `D12d 这道闸自己至少 60 项（本次 ${rows}）——项数掉下去说明有一组被整节删了`, `${rows} 项 · ${[...emitted].sort((a, b) => +a.slice(1) - +b.slice(1)).length} 个组`);
const docGroupMax = [...DOCS.matchAll(/D1[^\d]{1,3}(\d+) 个组/g)].map(m => +m[1]);
ok(docGroupMax.length === 0 || docGroupMax.every(n => n === emitted.size),
  `D12e 文档若写了「D1–DN 个组」，N 等于这一次真的发出的组数 ${emitted.size}`, docGroupMax.length ? `文档 ${docGroupMax.join('/')}` : `文档没有写组区间（本次 ${emitted.size} 组）`);
// D12c 里那个 TRAILING 是一个手写常数，手写常数会烂。这一条钉住「D12f 自己就是末尾那第 finalRows
// 项」，本节末尾之后的那段守卫再钉住「合计打印的项数 == 文档写的那个数」——往这一本的最后加一条
// 断言而不改 TRAILING，两处都会红，而不是让文档里那个总数悄悄变成另一个数。
ok(rows + 1 === finalRows, `D12f 这一条自己就是第 ${finalRows} 项（TRAILING=${TRAILING} 数的是 D12c/D12d/D12e/D12f 四条；跑完打印的合计必须等于文档写的那个数）`,
  `跑到这里 ${rows} 项 · 文档与 CI 钉的 ${finalRows} 项`);

console.log(`\n合计 ${rows} 项，${fail.length} 项失败`);
console.log(`rows: ${rows} fail: ${fail.length}`);
console.log(`钉成等式的文档现值：${pinnedRows} 项 · 显式 unpinned：${UNPINNED.length} 项`);
// 守卫（不是一行新的 ok()，所以不改上面那本账）：打印出来的总数必须就是文档与 CI 钉的那个数。
if (rows !== finalRows) {
  const msg = `合计打印 ${rows} 项，而文档写的总数是 ${finalRows} 项（TRAILING=${TRAILING} 该改了）`;
  fail.push(msg);
  console.log(`  FAIL ${msg}`);
}
if (fail.length) {
  for (const f of fail) console.log(`  未过：${f}`);
  process.exit(1);
}
