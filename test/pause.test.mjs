// 暂停这把尺：停表、挡输入、恢复不丢。
//
// 为什么要有这一支：暂停是本仓**唯一**一件正确性关于时间的功能，而时间不能靠等——所以这里的
// 钟是假的，手摇的（`advance()` 拨表），被摇的是生产代码本身：js/core/pause.js。
// 壳（js/main.js）只做接线，它把「谁被挡住」与「表怎么算」都交给那个纯模块，所以这一支
// 摇的是上线的那份实现，不是它的复印件。
//
// 一支只会绿的测试不算尺子。所以这一支里每一发都配一句「这发要是假绿会是什么样」：
//   * 停表那一发同时验恒等式（用时 + 被摘掉的 = 墙上时间）：少减一次立刻散；
//   * 挡输入那一发先证明「不挡的时候盘面真的会变」，再证明「挡的时候盘面一字不差」；
//   * 接线那一发直接读 js/main.js 的源码：三个入口必须**先问门再动盘面**。
//
// 台账 K10 那一刀就是照着这一点下的：把 js/core/pause.js 的记账改坏，这一支必须红。

import { readFileSync } from 'node:fs';
import { test, run, ok, eq } from '../tools/harness.mjs';
import { createPauseClock, PAUSE_WORDS } from '../js/core/pause.js';
import { createGame, tap, undo } from '../js/core/game.js';
import { FIXTURE_A, FIXTURE_A_SHADED } from './fixtures.mjs';

const lotA = { id: 'fixture-a', n: 5, puzzle: FIXTURE_A, solution: FIXTURE_A_SHADED };

// 手摇的假钟：现在时刻只由 advance() 拨。整支测试没有一个真的 setTimeout。
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; return t; },
  };
}

// 盘面的全貌快照：暂停期间它必须一个字节都不变。
const snapshot = (g) => JSON.stringify([g.marks, g.history, g.taps, g.fixes, g.done]);

// 生产路径的两步，一步不差：先问门，问到了就别碰动词。门是 js/core/pause.js 的 blocked()。
function throughTheDoor(clock, action, verb) {
  const why = clock.blocked(action);
  if (why) return { refused: true, why };
  verb();
  return { refused: false, why: '' };
}

test('暂停期间计时不前进：走 5000ms 假时间，用时一动不动', () => {
  const c = fakeClock(1000);
  const clock = createPauseClock({ now: c.now });
  c.advance(2000);
  eq(clock.elapsedMs(), 2000, '没暂停时表照走');
  clock.pause();
  const frozen = clock.elapsedMs();
  c.advance(5000);
  eq(clock.elapsedMs(), frozen, '暂停期间表不动：墙上时间走了 5 秒，用时一毫秒没动');
  eq(clock.elapsed(), Math.floor(frozen / 1000), '秒读数也不动');
  eq(clock.pausedMs(), 5000, '被摘掉的那 5000ms 记在账上（它得有个地方记）');
  // 恒等式：墙上的时间 = 用时 + 被摘掉的。这条是「少减一次立刻散」的负控。
  eq(clock.elapsedMs() + clock.pausedMs(), c.now() - clock.openedAt,
    '用时 + 被摘掉的 = 墙上时间（少减一次或多减一次都会散）');
});

test('暂停期间输入被拒：落子 / 提示 / 撤销都被门挡住，盘面一字不差', () => {
  const c = fakeClock();
  const clock = createPauseClock({ now: c.now });
  const g = createGame(lotA);
  tap(g, 0); // 先走一步，让「不变」有东西可比
  const before = snapshot(g);
  clock.pause();

  const t = throughTheDoor(clock, 'tap', () => tap(g, 1));
  const u = throughTheDoor(clock, 'undo', () => undo(g));
  const h = throughTheDoor(clock, 'hint', () => { g.taps += 1; });

  ok(t.refused, '落子被拒');
  ok(u.refused, '回退被拒');
  ok(h.refused, '提示被拒');
  eq(snapshot(g), before, '盘面（涂黑 / 打点 / 历史 / 落子数）一个字节都没变');
  eq(clock.blocked('tap'), PAUSE_WORDS.tap, '门给的是它自己的那句话');
  ok(clock.blocked('tap').includes('已暂停'), '那句话说得清是暂停挡的');
  eq(clock.blocked('nonsense'), '已暂停：按「继续」或 P 再继续',
    '没登记的动作也有一句兜底的话，不许静默放行');
});

test('恢复后接着走：再走 500ms，用时恰好 +500（不丢也不多算）', () => {
  const c = fakeClock();
  const clock = createPauseClock({ now: c.now });
  c.advance(1000);
  const before = clock.elapsedMs();
  clock.pause();
  c.advance(5000); // 暂停的五秒一秒都不算
  clock.resume();
  c.advance(500);
  eq(clock.elapsedMs() - before, 500, '暂停前用掉的 1000ms 还在，暂停的 5000ms 不算，恢复后的 500ms 算');
  eq(clock.elapsedMs(), 1500);
  eq(clock.blocked('tap'), '', '门开了');
});

test('恢复后盘面才动得了：门一开，落子照旧生效（这一发是「那把尺没在空跑」）', () => {
  const c = fakeClock();
  const clock = createPauseClock({ now: c.now });
  const g = createGame(lotA);
  tap(g, 0);
  const before = snapshot(g);
  clock.pause();
  throughTheDoor(clock, 'tap', () => tap(g, 1));
  eq(snapshot(g), before, '暂停期间没动');
  clock.resume();
  const after = throughTheDoor(clock, 'tap', () => tap(g, 1));
  ok(!after.refused, '门开了就不挡了');
  ok(snapshot(g) !== before, '盘面真的动了：前面那句「没变」不是因为动词压根不工作');
});

test('反复切换三次，计时仍自洽：三段暂停都被摘掉', () => {
  const c = fakeClock();
  const clock = createPauseClock({ now: c.now });
  let worked = 0;
  for (let i = 0; i < 3; i += 1) {
    c.advance(1000); // 每段干活的 1 秒
    worked += 1000;
    clock.pause();
    c.advance(2000); // 每段暂停的 2 秒
    clock.resume();
  }
  c.advance(1000);
  worked += 1000;
  eq(clock.elapsedMs(), worked, '三段暂停各 2000ms 都被摘掉了');
  eq(clock.pausedFor, 6000, '账上记着三段暂停，不多不少');
  eq(clock.paused, false, '现在是醒着的');
  eq(clock.elapsed(), 4, '秒读数 4 秒');
  eq(clock.elapsedMs() + clock.pausedMs(), c.now() - clock.openedAt, '恒等式仍然成立');
});

test('新的一盘是一段新的坐席：上一盘的暂停不记到新盘头上', () => {
  const c = fakeClock();
  const clock = createPauseClock({ now: c.now });
  c.advance(3000);
  clock.pause();
  c.advance(9000); // 上一盘暂停了九秒
  clock.resume();
  eq(clock.elapsedMs(), 3000, '上一盘：九秒暂停不算');
  clock.open(); // 换盘
  eq(clock.elapsedMs(), 0, '新的一盘从 0 开始');
  eq(clock.pausedFor, 0, '上一盘那九秒的欠账不跟着新盘走');
  eq(clock.paused, false);
});

test('暂停与恢复各只记一次：重复按不会把时间算两遍', () => {
  const c = fakeClock();
  const clock = createPauseClock({ now: c.now });
  c.advance(1000);
  eq(clock.pause(), true, '第一次按暂停：生效');
  eq(clock.pause(), false, '再按一次：已经在暂停里，不重复记');
  c.advance(4000);
  eq(clock.resume(), true, '恢复：生效');
  eq(clock.resume(), false, '再恢复一次：不在暂停里，不重复记');
  eq(clock.pausedFor, 4000, '那 4 秒只被摘了一次');
  eq(clock.elapsedMs(), 1000);
});

// 接线这一道：门在壳里必须**接在动词前面**。只看 core 会漏掉「壳忘了问门」这种坏法，
// 所以这里直接读 js/main.js 的源码，把三个入口与键盘那一路逐个点名。
function fnSource(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return '';
}

test('暂停的门接在壳的三个入口上：先问门，再动盘面', () => {
  const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const tapBody = fnSource(src, 'takeTap');
  const undoBody = fnSource(src, 'undoStep');
  const hintBody = fnSource(src, 'showHint');
  ok(tapBody.length > 0 && undoBody.length > 0 && hintBody.length > 0, '三个入口都找到了');
  ok(tapBody.includes("blocked('tap')") && tapBody.indexOf("blocked('tap')") < tapBody.indexOf('tapGame('),
    'takeTap：先问门，再落子');
  ok(undoBody.includes("blocked('undo')") && undoBody.indexOf("blocked('undo')") < undoBody.indexOf('undoGame('),
    'undoStep：先问门，再回退');
  ok(hintBody.includes("blocked('hint')") && hintBody.indexOf("blocked('hint')") < hintBody.indexOf('logicStep('),
    'showHint：先问门，再问提示');
  // 键盘那一路：重开也是改动盘面，暂停期间它与面板上那个被 disable 的按钮同一条规矩。
  const keyAt = src.indexOf("if (k === 'r')");
  ok(keyAt > 0, '键盘的 r 那一路找到了');
  const keySeg = src.slice(keyAt, keyAt + 700);
  ok(keySeg.includes("blocked('restart')") && keySeg.indexOf("blocked('restart')") < keySeg.indexOf('restartNow()'),
    'r 键：暂停期间不重开（面板上的重开按钮此时也是 disabled 的）');
  // 暂停牌上印的是冻住那一刻的读数：它取的就是 elapsed()，不是另一个数。
  ok(src.includes('el.pauseTime.textContent = mmss(elapsed())'), '暂停牌上的用时是冻住那一刻的 elapsed()');
});

test('暂停只停表，不改盘面：恢复之后原来的那一步还在', () => {
  const c = fakeClock();
  const clock = createPauseClock({ now: c.now });
  const g = createGame(lotA);
  tap(g, 0);
  tap(g, 1);
  const before = snapshot(g);
  clock.pause();
  c.advance(10000);
  clock.resume();
  eq(snapshot(g), before, '暂停与恢复都不碰盘面');
  ok(undo(g), '恢复之后回退照旧能退');
  eq(g.taps, 1, '退掉的是暂停之前那一步');
});

run();
