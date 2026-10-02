// 破坏试验台账：README 里那张 `| K… |` 表是**唯一来源**，这个文件不另存一份刀。
//
// 一把刀 = 把一类已经写在文档里的谎**写回原处**，跑那道闸，要求它 rc 非 0 **并且点名**它杀掉的
// 那条断言，然后按内存里读到的原字节把文件还原，最后把实测退出码盖回表的最后一列。
// 没有这一本，「这道闸能咬」就只是一句自述——它咬不咬，只有把谎放回去才知道。
//
// 三道前提，每一条都是这个农场用红字付过钱的：
//   1. 工作树必须干净——不干净时「绿」是别人未提交的改动撑的，这一轮的刀不属于这一轮；
//   2. 针必须**恰好命中一次**（台账行自己不算）：命中 0 次的刀在空转，命中多次的刀改的不是它声称那一处；
//   3. 变红还不够：rc 必须非 0，**且**输出里得有一行 FAIL 把第 6 列点名的那条断言原文写出来。
//      只比 rc 的话，磁盘满、拼错的命令、起不来的浏览器都能把台账刷成一片绿。
//
// 还原只用一开始读进内存的那份字节 writeFileSync 回去，不叫 git——`git checkout --` / `git restore`
// 会顺手把别人未提交的改动一起吞掉。还原之后立刻把文件读回来比对，比不拢就当场停。
//
// rc 那一列是**读回来的退出码**，不是写上去的期望：跑之前允许 `?` / `待跑` / 数字，跑完统一盖成
// 真实 rc。所以在已经盖过戳的树上重跑整本台账，README 一个字节都不会变——CI 用
// `git diff --exit-code` 证这一步，本地重跑也应当 `CHANGED=0`。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README_PATH = join(ROOT, 'README.md');
// 刀跑完一道闸要把 stdout+stderr 落成日志再 grep（`cmd | grep && continue` 会把 rc 换成 grep 的，
// 于是断掉的刀与从没跑过的刀长得一模一样）。日志写在**工作区根**，不进仓、不进 /tmp。
const LOG_DIR = process.env.LOG_DIR || dirname(ROOT);
const LEDGER = /^\| K\d+ \| /;
const BARE_PIPE = /(?<!\\)\|/;                  // 单元格里的竖线一律写成 \|，所以只有裸竖线是分隔符
const EVIDENCE = /^\s*(FAIL|未过|✗)/;           // 闸打印「这一条没通过」的那几种前缀
const rcOf = r => (r.status === null || r.status === undefined ? (r.signal ? 1 : 0) : r.status);
const run = cmd => spawnSync('bash', ['-c', cmd], {
  cwd: ROOT, encoding: 'utf8', timeout: Number(process.env.SAB_TIMEOUT || 900000), maxBuffer: 64 * 1024 * 1024,
});
const isStamped = s => /^[1-9]\d*$/.test(s) || s === '0' || s === '?' || s === '待跑';
const cellsOf = line => line.split(BARE_PIPE).slice(1, -1).map(c => c.trim().replace(/\\\|/g, '|'));
// 只把倒数第二个格子（实测 rc）换掉，其余格子一个字节都不动——重跑时才能验「戳没变」。
const setRcCell = (line, rc) => {
  const parts = line.split(BARE_PIPE);
  parts[parts.length - 2] = ` ${rc} `;
  return parts.join('|');
};

const out = [];
const say = line => { out.push(line); console.log(line); };
const die = msg => {
  say(`\n台账停住了：${msg}`);
  writeFileSync(join(LOG_DIR, '_tmp-hitori-sab-ledger.log'), `${out.join('\n')}\nRC=1\n`);
  process.exit(1);
};

// ---- 前提一：干净树（刀在飞、树在改＝假绿） ----
const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
if (rcOf(status) !== 0) die(`git status --porcelain 跑不动（rc=${rcOf(status)}）`);
if (status.stdout.trim() !== '') {
  die(`工作树不干净，这一轮的「绿」不知道是谁撑的。先提交再跑台账：\n${status.stdout.trim().split('\n').map(l => '  ' + l).join('\n')}`);
}
say('前提：工作树干净（git status --porcelain 空输出）');

// ---- 台账：从 README 的表里解析出刀 ----
const raw = readFileSync(README_PATH, 'utf8');
const lines = raw.split('\n');
const rowAt = new Map();
lines.forEach((l, i) => { if (LEDGER.test(l)) rowAt.set(cellsOf(l)[0], i); });
const knives = [...rowAt.values()].map(i => {
  const c = cellsOf(lines[i]);
  return { i, id: c[0], why: c[1], file: c[2], needle: c[3], repl: c[4], want: c[5], cmd: c[6], rc: c[7] };
});
if (knives.length < 8) die(`README 的台账只有 ${knives.length} 把刀（少于 8 把就是这张表被删过，反空转）`);
say(`台账：${knives.length} 把刀 · 命令 ${[...new Set(knives.map(k => k.cmd))].join(' ｜ ')}`);

const bad = [];
for (const k of knives) {
  if (!k.id || !k.needle || !k.repl || !k.want || !k.cmd) bad.push(`${k.id}: 列有空格`);
  if (k.cmd.includes('|') || k.cmd.includes('>')) bad.push(`${k.id}: 命令格不能含裸竖线/重定向`);
  if (k.needle.includes('\n') || k.repl.includes('\n')) bad.push(`${k.id}: 本台账只在一行内下刀`);
  if (!isStamped(k.rc)) bad.push(`${k.id}: rc 列「${k.rc}」不是 ?/待跑/数字`);
}
if (bad.length) die(`台账形状不对：${bad.join('，')}`);

for (const k of knives) {
  if (k.file.includes('tools/sabotage.mjs')) continue;          // 拿台账自己的针打台账是假动作
  const abs = join(ROOT, k.file);
  if (!existsSync(abs)) { bad.push(`${k.id}: ${k.file} 不在树里`); continue; }
  const before = readFileSync(abs);                              // 内存里那份原始字节 = 唯一的还原依据
  const fileLines = before.toString('utf8').split('\n');
  const hits = fileLines
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => !((k.file === 'README.md' || k.file === 'DESIGN.md') && LEDGER.test(l)) && l.includes(k.needle))
    .map(x => x.i);
  if (hits.length !== 1) { bad.push(`${k.id}: 针在 ${k.file}（台账行之外）命中 ${hits.length} 次，要求恰好 1 次`); continue; }
  if (fileLines[hits[0]] === k.repl || fileLines[hits[0]].split(k.needle).join(k.repl) === fileLines[hits[0]]) {
    bad.push(`${k.id}: 替换前后一样（这一刀什么都不改）`); continue;
  }
  const cut = fileLines.slice();
  cut[hits[0]] = cut[hits[0]].split(k.needle).join(k.repl);
  writeFileSync(abs, cut.join('\n'), 'utf8');

  const r = run(k.cmd);
  const rc = rcOf(r);
  const combined = `${r.stdout || ''}${r.stderr || ''}`;
  const logPath = join(LOG_DIR, `_tmp-hitori-sab-${k.id}.log`);
  const log = `$ ${k.cmd}\nRC=${rc}\n${k.id} · 把 ${k.file} 的「${k.needle}」改成「${k.repl}」之后\n${combined}`;
  writeFileSync(logPath, log);

  const grep = spawnSync('grep', ['-cE', EVIDENCE.source, logPath], { encoding: 'utf8' });
  const hitsInLog = rcOf(grep) === 0 ? Number((grep.stdout || '0').trim()) : 0;
  const named = combined.split('\n').filter(l => EVIDENCE.test(l) && l.includes(k.want)).length;
  if (rc !== 0 && hitsInLog > 0 && named > 0) {
    say(`红 ✓ ${k.id} rc=${rc} 点名 ${named} 行 · ${k.want.slice(0, 46)}`);
  } else {
    bad.push(`${k.id}: rc=${rc}、FAIL 行 ${hitsInLog} 行、点名 ${k.want.slice(0, 24)} 的行 ${named}——没打红，或红了但没有一行 FAIL 把点名的那条断言写出来（见 ${logPath}）`);
  }
  if (k.rc === '?') k.rc = String(rc);
  if (k.rc !== '?' && /^\d+$/.test(k.rc) && rc !== Number(k.rc)) {
    bad.push(`${k.id}: 这一轮读到 rc=${rc}，与已盖戳的 ${k.rc} 不符（台账不幂等）`);
  }
  writeFileSync(abs, before);
  if (!readFileSync(abs).equals(before)) bad.push(`${k.id}: ${k.file} 没能还原成读进来的字节——不再跑下一把刀`);
}

// ---- 把实测退出码盖回最后一列（幂等：本来就相同就一个字都不动） ----
const stamped = lines.slice();
for (const k of knives) stamped[k.i] = setRcCell(stamped[k.i], k.rc);
const stampedRaw = stamped.join('\n');
const changed = stampedRaw !== raw;
if (changed) writeFileSync(README_PATH, stampedRaw, 'utf8');
say(`rc 列：${changed ? '已把这一轮读到的退出码写回 README（再跑一遍应当一字不变）' : '与这一轮读到的退出码逐格相同，README 一个字节没动'}`);

const after = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
const left = (after.stdout || '').trim().split('\n').filter(Boolean).map(l => l.slice(3).trim());
if (left.length > 1 || (left.length === 1 && left[0] !== 'README.md')) {
  say(`未还原：台账跑完还留着 ${left.join(' ，') || '（空）'}——除 README 的 rc 戳之外什么都不该留`);
  bad.push('树没回到干净');
}

const total = knives.length;
const killed = knives.filter(k => !bad.some(b => b.startsWith(`${k.id}:`) || b.startsWith(`${k.id} `))).length;
const fails = bad.length;
for (const b of bad) say(`  未过 ${b}`);
say(`\n合计 ${total} 把刀：${killed} 把点名变红，${total - killed} 把不合格`);
say(`rows: ${total} fail: ${fails}`);
writeFileSync(join(LOG_DIR, '_tmp-hitori-sab-ledger.log'), `${out.join('\n')}\nRC=${fails ? 1 : 0}\n`);
if (fails) process.exit(1);
