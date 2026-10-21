// 帧率无关的仓内闸：把 /tmp 里那套三档对拍的核心不变量做成会红的断言。
//
// 为什么这条值得进仓：`node --check` 看得出一行 `x += v*dt`，看不出它是不是真的在 30Hz 与
// 120Hz 上画出同一个相位；而提示环的相位一旦回到「绝对时间取模」，玩家按下提示就会看见环跳一下。
// 这里用固定 LCG 造抖动，按同一个虚拟时长分别喂 30/60/120Hz，逐档积分，然后要求三档读到的
// 相位一致——并且第四发把累加器换成「每帧 +16.6667」，要求它必须散开，否则这把尺是空跑的。
import nodeTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FRAME_MS, breath, createPace, easeOut, phase, progress } from '../js/core/pace.js';
// 仓里每个 node 套件都打印同一行 `rows: N fail: M`（文档里的「M 条断言」就是对着这一行算的）；
// node:test 这一族用适配器接到那一行上。
import { tapSuite } from '../tools/harness.mjs';

const test = tapSuite(nodeTest, after);

const PULSE_MS = 1100; // 与 js/view.js 的呼吸周期同名同值：这里算的就是它算的那个数

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// 跑 `seconds` 秒的虚拟时间：帧间隔在标称值上下 ±25% 抖动，最后一帧钉在终点上，
// 于是三档读的是同一个时刻（不是同一个帧数——按帧数对齐会把定步长的 bug 洗绿）。
function drive(hz, seconds, seed, mode = 'dt') {
  const rnd = lcg(seed);
  const pace = createPace();
  const nominal = 1000 / hz;
  const end = seconds * 1000;
  let t = 1000; // 沙箱时钟从 1000ms 起：从 0 起步会被 lastTime===0 那类哨兵吃掉一帧
  let frames = 0;
  let fixed = 0;
  for (;;) {
    let step = nominal * (0.75 + rnd() * 0.5);
    if (t + step > end) step = end - t;
    t += step;
    frames += 1;
    if (mode === 'dt') pace.tick(t);
    else fixed += 16.6667; // 阴控：不吃帧 dt，每帧加定值
    if (t >= end) break;
  }
  const ms = mode === 'dt' ? pace.elapsed : fixed;
  return { ms, grow: (0.12 + breath(phase(ms, PULSE_MS)) * 0.1), frames, clamped: pace.clamped };
}

test('30/60/120Hz over the same virtual time land on the same phase', () => {
  const runs = [30, 60, 120].map((hz) => drive(hz, 2.4, 20261002 + hz));
  const vals = runs.map((r) => r.ms);
  const spread = Math.max(...vals) - Math.min(...vals);
  // 一阶采样滞后的上限就是一帧（30Hz 那档 41.7ms 含抖动）；比值口径与 /tmp harness 一致：
  // 离散 / 慢档单帧运动量 ≤ 3.6 判绿。
  const oneSlowFrame = Math.max(...vals.map(() => 0)) + 1000 / 30 * 1.25;
  assert.ok(spread / oneSlowFrame <= 3.6, `三档动画钟离散 ${spread.toFixed(3)}ms，比值 ${(spread / oneSlowFrame).toFixed(3)} 过红`);
  // 环的缩放差必须被「一慢帧的滞后」 bound 住：相位差的上界就是最慢档的一帧，
  // 换成每帧定值那种写法会散开几十倍（见下一发阴控），所以这个上界是真在判东西。
  const growSpread = Math.max(...runs.map((r) => r.grow)) - Math.min(...runs.map((r) => r.grow));
  const oneFrameOfMotion = 0.1 * (2 * Math.PI / PULSE_MS) * (1000 / 30);
  assert.ok(growSpread <= oneFrameOfMotion * 1.5,
    `环的缩放三档差 ${growSpread.toFixed(5)} 超过一慢帧运动量 ${(oneFrameOfMotion).toFixed(5)} 的 1.5 倍`);
  assert.ok(runs[0].frames < runs[2].frames, '帧数没有随频率增加，说明驱动没跑起来');
});

test('the same measurement with a per-frame constant diverges (negative control)', () => {
  const runs = [30, 60, 120].map((hz) => drive(hz, 2.4, 20261002 + hz, 'fixed'));
  const vals = runs.map((r) => r.ms);
  const spread = Math.max(...vals) - Math.min(...vals);
  const oneSlowFrame = 1000 / 30 * 1.25;
  // 120Hz 每帧 +16.67 会跑成 4 倍快：这把尺必须能看见，看不见就是空跑。
  assert.ok(spread / oneSlowFrame > 3.6, `阴控没有变红（离散 ${spread.toFixed(1)}ms，比值 ${(spread / oneSlowFrame).toFixed(2)}）`);
  // 环的缩放在这一发可能碰巧对齐——呼吸是周期的，2.4s 处三档的相位差刚好绕回来。
  // 所以判子钉在累加器本身：定步长的钟在 2.4 秒里与真实 dt 相差超过一个整周期，红得没有歧义。
  const drift = Math.abs(vals[2] - vals[0]);
  assert.ok(drift > PULSE_MS, `定步长的钟与 dt 钟只差 ${drift.toFixed(1)}ms，没差过 ${PULSE_MS}ms 一个周期`);
});

test('a hitch is integrated once, not teleported', () => {
  const pace = createPace();
  pace.tick(1000);
  const jumped = pace.tick(5000); // 切标签页回来那种 4 秒空档
  assert.equal(jumped.dt, MAX_FRAME_MS, `空档被整段吃进来了：dt=${jumped.dt}`);
  assert.equal(jumped.elapsed, MAX_FRAME_MS);
  assert.equal(jumped.clamped, 1);
  const after = pace.tick(5016);
  assert.equal(after.dt, 16, '空档之后的正常帧应当照常用真实间隔');
  assert.equal(after.clamped, 1, '只有越界那一帧记为被夹过');
});

test('a clock that goes backwards or repeats costs nothing', () => {
  const pace = createPace();
  assert.equal(pace.tick(1000).dt, 0, '第一帧只立原点，不该凭空算出时长');
  assert.equal(pace.tick(1000).dt, 0, '同一时间戳重复投递不该推进');
  assert.equal(pace.tick(990).dt, 0, '时钟倒退不该倒扣累加器');
  assert.equal(pace.elapsed, 0);
});

test('phase, breath and easing behave where the ring turns over', () => {
  assert.equal(phase(0, PULSE_MS), 0);
  assert.equal(phase(PULSE_MS, PULSE_MS), 0, '整周期回到 0');
  assert.equal(phase(-100, PULSE_MS) >= 0, true, '负时间也要落在 0..1');
  assert.equal(phase(10, 0), 0, '周期 <=0 不除以零');
  // 接缝连续性：0.999 → 0.001 的环宽必须几乎不变，否则就是旧那版每 1.1s 跳一次的锯齿。
  const a = breath(phase(1098.9, PULSE_MS));
  const b = breath(phase(1.1, PULSE_MS));
  assert.ok(Math.abs(a - b) < 1e-3, `呼吸在周期接缝上跳了 ${Math.abs(a - b).toFixed(4)}`);
  assert.ok(Math.abs(breath(0) - 0) < 1e-12 && Math.abs(breath(0.5) - 1) < 1e-12, '呼吸应在半周期到顶');
  assert.equal(progress(500, 1000), 0.5);
  assert.equal(progress(2000, 1000), 1, '一次性动画钳在终点');
  assert.equal(easeOut(1), 1);
  assert.ok(easeOut(0.5) > 0.5, 'easeOut 应当先快后慢');
});
