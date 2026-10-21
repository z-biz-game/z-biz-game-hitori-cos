// 静音的行为闸：用一台假的 AudioContext 数**振荡器分配次数**。
//
// 为什么不用读代码代替：把 gain 设成 0 也写着 mute，读字符串分辨不出来；而线上真正的错法是
// "静音了还在建振荡器"——手机听不见声音却照样为每个音付费，音频线程一刻不停。这里唯一有意义的
// 断言是：静音期间的 createOscillator 调用数 = 0，且 suspend() 真的落到了 context 上。
import nodeTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createAudio } from '../js/core/audio.js';
// 仓里每个 node 套件都打印同一行 `rows: N fail: M`（文档里的「M 条断言」就是对着这一行算的）；
// node:test 这一族用适配器接到那一行上。
import { tapSuite } from '../tools/harness.mjs';

const test = tapSuite(nodeTest, after);

function fakeContext() {
  const ac = {
    state: 'running',
    currentTime: 0,
    destination: { connect() {} },
    osc: 0,
    suspends: 0,
    resumes: 0,
    created: 0,
    createGain() {
      ac.created += 1;
      return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    },
    createOscillator() {
      ac.osc += 1;
      return {
        type: 'sine',
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        start() {},
        stop() {},
      };
    },
    suspend() { ac.suspends += 1; ac.state = 'suspended'; return Promise.resolve(); },
    resume() { ac.resumes += 1; ac.state = 'running'; return Promise.resolve(); },
  };
  return ac;
}

function rig() {
  const ac = fakeContext();
  function Ctor() { return ac; }
  const audio = createAudio({ AudioContext: Ctor });
  return { ac, audio };
}

test('the context is built on the first sound, not at import', () => {
  const { ac, audio } = rig();
  assert.equal(audio.stats().hasContext, false);
  assert.equal(ac.osc, 0);
  audio.tap(1);
  assert.equal(audio.stats().hasContext, true);
  assert.ok(ac.osc >= 1, '涂黑这一下该有一个振荡器');
});

test('mute allocates nothing and suspends the context', () => {
  const { ac, audio } = rig();
  audio.tap(1);
  const before = ac.osc;
  assert.equal(audio.setMuted(true), true);
  assert.equal(ac.state, 'suspended', '静音必须真的把 AudioContext 停下来');
  assert.equal(ac.suspends, 1);
  const oscAfterMute = ac.osc;
  for (const mark of [0, 1, 2]) audio.tap(mark);
  audio.clash();
  audio.hint();
  audio.win();
  assert.equal(ac.osc, oscAfterMute, `静音后又分配了 ${ac.osc - oscAfterMute} 个振荡器 = 假静音`);
  assert.ok(audio.stats().blocked >= 9, '被拒的次数要数得出来，否则这条断言是空跑的');
  assert.ok(before >= 1);
});

test('unmute resumes and the next tap is audible again', () => {
  const { ac, audio } = rig();
  audio.tap(1); // 先让 context 真的存在（它是首次发声时懒建的）
  const oscAtMute = ac.osc;
  audio.setMuted(true);
  audio.tap(1);
  assert.equal(ac.osc, oscAtMute, '静音期间不该再分配');
  audio.setMuted(false);
  assert.equal(ac.state, 'running');
  assert.ok(ac.resumes >= 1);
  audio.tap(2);
  assert.ok(ac.osc > oscAtMute, '取消静音之后还不响，那是坏开关不是静音');
});

test('pause suspends without unmuting, resume keeps the mute', () => {
  const { ac, audio } = rig();
  audio.tap(1);
  assert.equal(audio.suspend(), true);
  assert.equal(ac.state, 'suspended');
  assert.equal(audio.muted(), false, '暂停不是静音');
  assert.equal(audio.resume(), true);
  assert.equal(ac.state, 'running');
  // 静音态下暂停/恢复都不该把声音放出来
  audio.setMuted(true);
  audio.suspend();
  assert.equal(audio.resume(), false, '静音时 resume() 不该把 context 叫醒');
  assert.equal(ac.state, 'suspended');
});

test('an environment without AudioContext degrades to silence, never a throw', () => {
  const audio = createAudio({});
  assert.equal(audio.supported(), false);
  assert.equal(audio.tap(1), 0);
  assert.equal(audio.win(), 0);
  assert.equal(audio.setMuted(true), true);
  assert.equal(audio.suspend(), false);
  assert.equal(audio.stats().blocked, 0, '没有音频设备不等于声音被拒');
});
