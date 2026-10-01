// 存档解码闸：坏一条只准丢那一条，坏整档只准退回空档，任何情况都不许抛。
//
// 这条尺为什么必须存在：`Object.assign(default, JSON.parse(raw))` 这类读法在**好档**上全都对，
// 而线上真正的事故形态是半坏档——一条 `null` 记录、一个 `best: "abc"`、一个越界的 plays。
// 那种时候如果解码抛异常，被冻住的是整局游戏；如果整份丢掉，玩家丢的是全部纪录。
// 这里逐条喂垃圾样本，要求丢的范围恰好等于坏掉的范围。
//
// node 没有 localStorage，所以每个 case 自己装一个假的，再用 forgetCache() 把模块级缓存清掉——
// 缓存是模块状态，忘了清就等于第二个 case 读到了第一个 case 的档。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanResume, forgetCache, lastDecode, store } from '../js/core/storage.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

function withStorage(ls, body) {
  const had = 'localStorage' in globalThis;
  const before = had ? globalThis.localStorage : undefined;
  if (ls) globalThis.localStorage = ls;
  else delete globalThis.localStorage;
  forgetCache();
  try {
    return body();
  } finally {
    if (before === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = before;
    forgetCache();
  }
}

const GOOD = { solved: true, best: 7, plays: 3, perfect: false };

test('a clean save round-trips through the fake storage', () => {
  withStorage(fakeStorage(), () => {
    store.solve('nook-01', { taps: 9, floor: 6, violations: 0 });
    const written = { ...store.records };
    assert.equal(written['nook-01'].best, 9);
    assert.equal(written['nook-01'].plays, 1);
    forgetCache();
    assert.deepEqual(store.records['nook-01'], { solved: true, best: 9, plays: 1, perfect: false });
    assert.equal(lastDecode().droppedRecords, 0, '好档一条都不该被丢');
    assert.equal(store.mode, 'localStorage');
  });
});

test('one corrupt record costs exactly that record, not the save', () => {
  const raw = JSON.stringify({
    records: {
      'nook-01': GOOD,
      'nook-02': null, // 一条 null 记录
      'nook-03': 'yes', // 类型错
      'nook-04': 7, // 类型错
      'nook-05': { solved: true, plays: 2 }, // 缺 best
      'nook-06': { solved: true, best: 'abc', plays: 2 }, // best 类型错
      'nook-07': { solved: true, best: 4, plays: -2 }, // plays 越界
      'nook-08': { solved: true, best: 1e20, plays: 2 }, // best 越界
      'nook-09': { best: 4, plays: 2 }, // 缺 solved 标记
      'nook-10': { solved: true, best: 5, plays: 4, perfect: true },
    },
    daily: { '2026-01-01': { id: 'nook-01', at: 1 }, '2026-01-02': null, '2026-01-03': { id: '', at: 1 } },
    unlocked: '4',
    stats: { solves: 12, perfect: -3, taps: 40.7, violations: 'x' },
  });
  withStorage(fakeStorage({ 'hitori.save.v1': raw }), () => {
    const kept = Object.keys(store.records).sort();
    assert.deepEqual(kept, ['nook-01', 'nook-10'], '只该留下两条好记录');
    assert.deepEqual(store.records['nook-10'], { solved: true, best: 5, plays: 4, perfect: true });
    const rep = lastDecode();
    assert.equal(rep.droppedRecords, 8, `丢了 ${JSON.stringify(kept)}，报告却说 ${rep.droppedRecords} 条`);
    assert.equal(rep.droppedDaily, 2);
    assert.deepEqual(store.daily['2026-01-01'], { id: 'nook-01', at: 1 });
    assert.equal(store.unlocked, 4, '"4" 是个能用的数，别把它当垃圾');
    assert.deepEqual(store.stats, { solves: 12, perfect: 0, taps: 40, violations: 0 });
    assert.equal(rep.droppedStats, 2, 'perfect 越界与 violations 类型错各算一条');
  });
});

test('an unparsable or shapeless blob degrades to a blank save and never throws', () => {
  for (const raw of ['{not json', 'null', '[]', '"a string"', '42', '']) {
    withStorage(fakeStorage({ 'hitori.save.v1': raw }), () => {
      assert.deepEqual(store.records, {}, `raw=${JSON.stringify(raw)} 应当退回空档`);
      assert.equal(store.unlocked, 1);
      assert.equal(store.stats.solves, 0);
    });
  }
});

test('a throwing getItem is a memory session, not a broken board', () => {
  const ls = fakeStorage();
  ls.getItem = () => { throw new Error('SecurityError'); };
  withStorage(ls, () => {
    assert.deepEqual(store.records, {});
    store.solve('nook-01', { taps: 8, floor: 6, violations: 1 });
    assert.equal(store.records['nook-01'].best, 8, '内存里这一局还得继续算');
  });
});

test('the resume slot decodes in two stages and reports what it dropped', () => {
  const marks = [0, 1, 2, 0];
  assert.equal(cleanResume({ id: 'nook-01', marks, history: [0, 1], taps: 2, fixes: 0 }).ok, true);
  for (const bad of [null, 'x', 7, [], {}]) {
    const r = cleanResume(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 不该被接受`);
    assert.ok(r.reason);
  }
  assert.equal(cleanResume({ id: 1, marks }).reason, 'bad-id');
  assert.equal(cleanResume({ id: 'a', marks: [0, 5] }).reason, 'illegal-mark');
  assert.equal(cleanResume({ id: 'a', marks: [] }).reason, 'bad-marks');
  assert.equal(cleanResume({ id: 'a', marks, taps: -3 }).reason, 'negative-taps');
  // 越界的 history 条目只丢那几条，槽本身仍然可用（这就是"两段式"的意义）
  const partly = cleanResume({ id: 'a', marks, history: [0, 99, -1, 2.5, 3], taps: '4', fixes: null });
  assert.equal(partly.ok, true);
  assert.deepEqual(partly.value.history, [0, 3]);
  assert.equal(partly.droppedHistory, 3);
  assert.equal(partly.value.taps, 4, '"4" 是个数，收下');
  assert.equal(partly.value.fixes, 0, '缺 fixes 退回 0，不是 NaN');
});
