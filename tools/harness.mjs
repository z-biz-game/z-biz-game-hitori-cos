// Tiny zero-dep test harness: every tools/../test/*.mjs suite prints the same shape so
// verify.sh can aggregate node suites and browser suites on one line.

const rows = [];

export function test(name, fn) {
  try {
    fn();
    rows.push({ test: name, pass: true });
  } catch (err) {
    rows.push({ test: name, pass: false, detail: String((err && err.message) || err) });
  }
}

export function ok(cond, msg = 'expected truthy') {
  if (!cond) throw new Error(msg);
}

export function eq(a, b, msg = 'not equal') {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}\n    got      ${sa}\n    expected ${sb}`);
}

export function fail(msg) {
  throw new Error(msg);
}

export function run() {
  const bad = rows.filter((r) => !r.pass);
  for (const r of rows) console.log(`${r.pass ? '  ok  ' : '  FAIL'} ${r.test}${r.pass ? '' : '\n         ' + r.detail}`);
  console.log(`rows: ${rows.length} fail: ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
}

// node:test 那一族套件的适配器：它们用 node 自带的 TAP 输出，跟上面这套手写的形状不一样，
// 但仓里**每个** node 套件都必须打印同一行 `rows: N fail: M`——文档里的「M 条断言」就是对着
// 这一行算的（tools/doctest.mjs 的 D4a/D4b 会逐个套件读它，也读 test/ 目录里的套件数）。
// 这一族此前没报这一行，于是文档里的条数只数到一半的套件：这里把两族接到同一行上，条数不变、
// 强度不变，只是把漏掉的那几个套件也算了进来。
export function tapSuite(nodeTest, after) {
  let pass = 0;
  let fail = 0;
  const test = (name, fn) => nodeTest(name, async (t) => {
    try {
      await fn(t);
      pass += 1;
    } catch (err) {
      fail += 1;
      throw err;
    }
  });
  after(() => { console.log(`rows: ${pass + fail} fail: ${fail}`); });
  return test;
}
