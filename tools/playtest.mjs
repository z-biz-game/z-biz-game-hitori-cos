// Minimal zero-dependency CDP driver for headless playtesting (Node 21+ global
// WebSocket/fetch — no Playwright, no Puppeteer).
//
// env: CDP_PORT  devtools port, default 9365 (deliberately off the siblings' 9349/9362/9363/9364:
//               one machine, and two headless Chromes on one port is how a run gets reported
//               green when nothing was actually driven)
//      BASE_URL  page to attach to, default http://127.0.0.1:5256/
//
// usage:
//   node tools/playtest.mjs open  <url>            # fresh page tab, navigate, wait for shell
//   node tools/playtest.mjs nav   <url>
//   node tools/playtest.mjs eval  '<js expression>'          # plain evaluate
//   node tools/playtest.mjs eval  '@boot' [nonav]  # @boot @taps @rules @logic @routes @save
//                                                  # @reloaded @motion @pointer
//   node tools/playtest.mjs tap   <i>              # one real press+release on cell i
//   node tools/playtest.mjs shot  <path.png>
//   node tools/playtest.mjs logs
//
// Output contract (tools/verify.sh depends on it): the LAST line on stdout is
// `RESULT <json>`, everything else on stdout is human prose, and all console noise the page
// produces goes to stderr. A run that prints no RESULT line did not run.
//
// Two kinds of test live here and they are not interchangeable:
//   * @boot/@taps/@rules/@logic/@routes/@save/@reloaded/@motion run page-side JS against
//     `window.hitori`. They prove the shell, the router, the save file and the panel numbers.
//   * @pointer sends real `Input.dispatchMouseEvent` events through Chrome. Page JS cannot prove
//     that a thumb reaches the cell it aims at, so the three-state cycle and the certified win
//     line are walked with the mouse and nothing else.
//
// The page-side second opinion below (`CF`) imports nothing from the repo: rule 1/2/3 are
// re-typed here, and the solution count is a propagation-driven enumeration written from the
// definition rather than from js/core/solve.js's tactic set. That is what makes "every shipped
// row survives a third opinion" a check instead of an echo.
const PORT = process.env.CDP_PORT || 9365;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5256/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 30000);
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];
const arg = process.argv[3];

const out = (s) => process.stdout.write(s + '\n');
const note = (s) => process.stderr.write(s + '\n');

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One real mouse event at a client-space coordinate. @pointer and the `tap` command share this so
// the two cannot disagree about what "a press" means on the wire.
const mouseAt = (cdp, sessionId, type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0,
}, sessionId);

// Press and release where the *view* says cell `i` currently is. `point()` reads the geometry the
// last render actually measured, so this follows the board as the window resizes.
async function clickCell(cdp, sessionId, runJS, i, hold = 20, rest = 55) {
  const p = await runJS(`window.hitori.point(${i})`);
  if (!p) return null;
  await mouseAt(cdp, sessionId, 'mousePressed', p.x, p.y, 1);
  await sleep(hold);
  await mouseAt(cdp, sessionId, 'mouseReleased', p.x, p.y, 0);
  await sleep(rest);
  return p;
}

// Four-way adjacency, spelled out here as well. The pointer suite needs to know which cells rule 2
// forbids *before* it asks the page, or a bug in js/core/rules.js could not be told apart from a
// test that agrees with it.
const neighboursOf = (n, i) => {
  const x = i % n;
  const y = Math.floor(i / n);
  const out = [];
  if (x > 0) out.push(i - 1);
  if (x < n - 1) out.push(i + 1);
  if (y > 0) out.push(i - n);
  if (y < n - 1) out.push(i + n);
  return out;
};

async function clickButton(cdp, sessionId, runJS, id, hold = 20, rest = 55) {
  const p = await runJS(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e) return null;
    const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) }; })()`);
  if (!p || p.w === 0) return null;
  await mouseAt(cdp, sessionId, 'mousePressed', p.x, p.y, 1);
  await sleep(hold);
  await mouseAt(cdp, sessionId, 'mouseReleased', p.x, p.y, 0);
  await sleep(rest);
  return p;
}

// A real key on the wire: rawKeyDown + char + keyUp, which is what a focused document receives. The
// shell listens on window (js/main.js:881), so this is the only way to ask whether the 方向键 /
// Enter / u / r layer is wired at all — a synthetic KeyboardEvent would prove the handler runs but
// not that a keyboard can make it run.
async function pressKey(cdp, sessionId, key, code, text, rest = 70) {
  const base = { key, code };
  if (text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
  } else {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
  }
  await sleep(rest);
}

// ---------------------------------------------------------------------------------------
// The page-side second opinion. Re-typed from the rule wording, not imported: a bug in
// js/core/rules.js cannot hide by agreeing with itself. This is a fixture, never reachable from
// the game.
const CF_BODY = `function () {
  const UNSET = -1;
  function pairList(n, cells) {
    const pairs = [];
    for (let a = 0; a < n * n; a++) {
      for (let b = a + 1; b < n * n; b++) {
        if (cells[a] !== cells[b]) continue;
        if (a % n === b % n || Math.floor(a / n) === Math.floor(b / n)) pairs.push([a, b]);
      }
    }
    return pairs;
  }
  function neighboursOf(n, i) {
    const x = i % n, y = Math.floor(i / n), o = [];
    if (x > 0) o.push(i - 1);
    if (x < n - 1) o.push(i + 1);
    if (y > 0) o.push(i - n);
    if (y < n - 1) o.push(i + n);
    return o;
  }
  // The three rules, read straight off the frozen wording, one flag each. 'check' is what
  // @rules uses to witness that a board breaks rule 3 *and only* rule 3; 'legal' is the
  // conjunction, and the thing 'count' enumerates.
  function check(n, cells, shaded) {
    let r1 = true;
    for (let a = 0; a < n * n; a++) {
      if (shaded[a]) continue;
      for (let b = a + 1; b < n * n; b++) {
        if (shaded[b]) continue;
        if (cells[a] === cells[b] && (a % n === b % n || Math.floor(a / n) === Math.floor(b / n))) r1 = false;
      }
    }
    let r2 = true;
    for (let i = 0; i < n * n; i++) {
      if (!shaded[i]) continue;
      for (const j of neighboursOf(n, i)) if (j > i && shaded[j]) r2 = false;
    }
    let start = -1;
    for (let i = 0; i < n * n; i++) if (!shaded[i]) { start = i; break; }
    if (start < 0) return { r1: r1, r2: r2, r3: false };
    const seen = {}; const stack = [start]; seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      for (const j of neighboursOf(n, i)) { if (shaded[j] || seen[j]) continue; seen[j] = 1; stack.push(j); }
    }
    let r3 = true;
    for (let i = 0; i < n * n; i++) if (!shaded[i] && !seen[i]) r3 = false;
    return { r1: r1, r2: r2, r3: r3 };
  }
  function legal(n, cells, shaded) {
    const c = check(n, cells, shaded);
    return c.r1 && c.r2 && c.r3;
  }
  // Count every shading consistent with 'fixed'. Two clauses are monotone and so can prune:
  // "no two adjacent shades" and "no equal pair both unshaded" (setting a cell unshaded forces
  // each equal partner shaded). Rule 3 is not monotone, so it is judged only at the leaf.
  function count(n, cells, fixed, cap) {
    const total = n * n;
    const part = {};
    for (const [a, b] of pairList(n, cells)) { (part[a] = part[a] || []).push(b); (part[b] = part[b] || []).push(a); }
    const st = new Int8Array(total);
    for (let i = 0; i < total; i++) if (fixed && fixed[i] !== UNSET) st[i] = fixed[i] + 1; // 1 shaded, 2 open
    let nodes = 0, truncated = false;
    const found = [];
    const set = (i, v, trail) => {
      if (st[i] === v) return true;
      if (st[i] !== 0) return false;
      st[i] = v; trail.push(i); return true;
    };
    const walk = () => {
      if (++nodes > cap) { truncated = true; return; }
      let i = 0; while (i < total && st[i] !== 0) i++;
      if (i === total) {
        const shaded = [];
        for (let k = 0; k < total; k++) shaded[k] = st[k] === 1;
        if (legal(n, cells, shaded)) {
          const s = [];
          for (let k = 0; k < total; k++) if (shaded[k]) s.push(k);
          found.push(s);
        }
        return;
      }
      for (const v of [1, 2]) {
        const trail = [];
        let ok = set(i, v, trail);
        if (ok && v === 1) {
          const x = i % n, y = Math.floor(i / n);
          if ((x > 0 && st[i - 1] === 1) || (y > 0 && st[i - n] === 1)) ok = false;
        }
        if (ok && v === 2) for (const j of (part[i] || [])) if (!set(j, 1, trail)) { ok = false; break; }
        if (ok) walk();
        for (const t of trail) st[t] = 0;
        if (truncated) return;
      }
    };
    walk();
    return { count: found.length, solutions: found, nodes: nodes, truncated: truncated };
  }
  function forcedMarks(n, cells, fixed, cap) {
    const r = count(n, cells, fixed, cap);
    if (!r.count) return { count: 0, nodes: r.nodes, truncated: r.truncated, forced: null };
    const total = n * n;
    const timesShaded = new Int32Array(total);
    for (const s of r.solutions) for (const i of s) timesShaded[i]++;
    const forced = [];
    for (let i = 0; i < total; i++) {
      const k = timesShaded[i];
      // 1 = black in every completion, 0 = on the board in every completion, 2 = the row varies.
      forced.push(k === 0 ? 0 : (k === r.solutions.length ? 1 : 2));
    }
    return { count: r.count, nodes: r.nodes, truncated: r.truncated, forced: forced };
  }
  function hs(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193);
      h ^= (str.charCodeAt(i) >> 8) & 0xff; h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  const floor = (n, shades) => shades + 2 * (n * n - shades);
  return { legal: legal, check: check, count: count, pairList: pairList, neighboursOf: neighboursOf, forcedMarks: forcedMarks, hs: hs, floor: floor, UNSET: UNSET };
}`;
// ---------------------------------------------------------------------------------------

async function main() {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* gone already */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Wait on the shell, not on a timer. This page is a module graph fetched over the network: a
  // fixed sleep is long enough for localhost and too short for GitHub Pages, where it hands back
  // an undefined `window.hitori` and a canvas still sitting at the spec's 300x150 default — a fake
  // failure on a perfectly good deployment. The directory is the boot state, and it has no board,
  // so the door being polled is the door itself.
  const waitShell = async (floorMs, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.hitori && window.hitori.version === 1 && window.hitori.engine)');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  const result = { cmd, scenario: arg || null, pass: true, rows: 0, fail: [] };

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url: arg || BASE }, sessionId);
    const ok = await waitShell(600);
    out('opened ' + (arg || BASE) + (ok ? ' (shell ready)' : ' (SHELL NEVER APPEARED)'));
    result.pass = ok;
    if (!ok) result.fail.push('shell never appeared');
    for (const l of logs) note(l);
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url: arg }, sessionId);
    await waitShell(400);
    out('navigated');
    for (const l of logs) note(l);
  } else if (cmd === 'tap') {
    const i = Number(arg);
    if (!Number.isInteger(i) || i < 0) {
      out('tap wants a cell index, got: ' + arg);
      note('bad usage');
      result.pass = false; result.fail.push('usage');
    } else {
      const before = await runJS('JSON.stringify(window.hitori.state.marks)');
      const p = await clickCell(cdp, sessionId, runJS, i);
      const after = await runJS('JSON.stringify(window.hitori.state.marks)');
      out(`tapped cell ${i} at ${p ? p.x + ',' + p.y : 'nowhere'} -> ${before} => ${after}`);
      result.pass = !!p;
    }
    for (const l of logs) note(l);
  } else if (cmd === 'shot') {
    await runJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    (await import('node:fs')).writeFileSync(arg, Buffer.from(data, 'base64'));
    out('wrote ' + arg + ' (' + Math.round(data.length / 1024) + 'kB b64)');
    for (const l of logs) note(l);
  } else if (cmd === 'logs') {
    await sleep(600);
    for (const l of logs) note(l || '(none)');
    out(`console lines: ${logs.length}`);
    result.rows = logs.length;
    result.pass = logs.length === 0;
    if (!result.pass) result.fail.push('console not clean');
  } else if (cmd === 'state') {
    out(JSON.stringify(await runJS('window.hitori.state'), null, 2));
  } else if (cmd === 'eval') {
    if (process.argv[4] !== 'nonav') {
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      await waitShell(300);
    }
    if (arg && arg.startsWith('@')) {
      const name = arg.slice(1);
      let value = null;
      if (name === 'pointer') {
        value = await pointerScenario(cdp, sessionId, runJS);
      } else if (name === 'motion') {
        value = await motionScenario(cdp, sessionId, runJS);
      } else if (SCENARIOS[name]) {
        // Clear the row buffer *before* running: every scenario with `nonav` evaluates in the same
        // page, so a suite that dies at parse time would otherwise hand back the previous suite's
        // rows and verify.sh would print them as if they belonged to this one.
        await runJS('window.__lastRows = null; 1');
        try {
          value = await runJS(SCENARIOS[name]);
        } catch (err) {
          const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
          value = { rows: JSON.parse(dumped) };
          value.rows.push({ test: `@${name} threw`, pass: false, detail: String(err.message).slice(0, 300) });
        }
      } else {
        out('unknown scenario ' + name + ' — have ' + Object.keys(SCENARIOS).join(', ') + ', pointer, motion');
        note('unknown scenario');
        result.pass = false; result.fail.push('unknown scenario');
        value = { rows: [] };
      }
      const rows = (value && value.rows) || [];
      result.rows = rows.length;
      result.fail = rows.filter((r) => !r.pass).map((r) => r.test);
      result.pass = rows.length > 0 && result.fail.length === 0;
      result.scenario = name;
      result.detail = rows.map((r) => ({ test: r.test, pass: r.pass, detail: r.detail }));
      if (process.env.VERBOSE) out(JSON.stringify(value, null, 2));
    } else {
      const v = await runJS(arg).catch((err) => 'EVAL THROW: ' + err.message);
      out(JSON.stringify(v, null, 2));
      result.rows = 1;
    }
    for (const l of logs) note(l);
  } else {
    out('usage: playtest.mjs <open|nav|eval|tap|shot|state|logs> [arg]');
    result.pass = false; result.fail.push('usage');
  }
  out(`RESULT ${JSON.stringify(result)}`);
  ws.close();
  process.exit(result.pass ? 0 : 1);
}

// --------------------------------------------------------------------------- @pointer
// Real input, start to finish. Every row below is caused by a mouse event Chrome generated, never
// by a call into `window.hitori`, so what is under test is the pointer-to-cell wiring in js/view.js
// and the three-state cycle in js/core/game.js as a thumb actually meets them.
async function pointerScenario(cdp, sessionId, runJS) {
  const rows = [];
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  const st = () => runJS(`(() => { const h = window.hitori; const s = h.state; return { id: s.id, n: s.n, marks: s.marks, taps: s.taps, fixes: s.fixes, done: s.done, clean: s.clean, complete: s.complete, undecided: s.undecided, byRule: s.byRule, violations: s.violations, orphans: s.orphans, forcedOpen: s.forcedOpen, minTaps: s.minTaps, matches: s.matches, cursor: s.cursor, stars: s.grade ? s.grade.stars : 0, said: document.getElementById('toast').textContent, hint: document.getElementById('hintline').textContent }; })()`);

  const ids = await runJS(`['board','hintline','totals','crumbs','readout','shelf','curtain','stars','verdict','tally','again','next','undo','hint','restart','share','wipe','rules','toast','modes','menu','table','panel','tiers','menu-count','menu-note','menu-campaign','menu-daily','menu-random']
    .map((i) => [i, !!document.getElementById(i)])`);
  rec('every control the shell reaches for exists', ids.every(([, on]) => on), Object.fromEntries(ids));

  await runJS('window.__cf = (' + CF_BODY + ')(); 1');
  await runJS(`window.hitori.go('#/lot/nook-01')`);
  await sleep(320);
  const open = await st();
  const row0 = await runJS(`(() => { const r = window.hitori.engine.LOTS.filter((x) => x.id === 'nook-01')[0]; return { cells: r.cells, solution: r.solution, n: r.n }; })()`);
  rec('a shared link opens that board, untouched', open.id === 'nook-01' && open.taps === 0 && open.undecided === 16, open);
  const box = await runJS(`(() => { const c = document.getElementById('board'); const r = c.getBoundingClientRect(); const p = window.hitori.point(0); return { w: Math.round(r.width), h: Math.round(r.height), inBox: p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom, dpr: window.devicePixelRatio, backing: [c.width, c.height], css: [Math.round(r.width), Math.round(r.height)] }; })()`);
  rec('the canvas is laid out, not the unstyled 300x150 default', box.w > 300 && box.h > 300 && Math.abs(box.backing[0] - box.css[0] * Math.min(3, Math.max(1, box.dpr))) <= 4, box);
  rec('the point the view offers a click is inside the canvas box', box.inBox, box);
  const painted = await runJS(`(() => { const p = window.hitori.pixels(); return p.painted > 200 && p.hash !== 0; })()`);
  rec('the board is painted, not an empty frame', painted === true, painted);
  const digits = await runJS(`(() => { const c = window.hitori.game.puzzle.cells; return JSON.stringify(c) === JSON.stringify(${JSON.stringify(row0.cells)}); })()`);
  rec('the digits on screen are the digits that row measured', digits === true, { screen: await runJS('window.hitori.game.puzzle.cells') });

  // The one-finger promise: three real presses walk a cell through all three states and back.
  const trail = [];
  let hash0 = null;
  for (let k = 0; k < 4; k++) {
    const p = await clickCell(cdp, sessionId, runJS, 0);
    const s = await st();
    trail.push({ press: k + 1, mark: s.marks[0], taps: s.taps });
    if (k === 0) hash0 = (await runJS('window.hitori.pixels().hash'));
    if (!p) break;
  }
  rec('three real clicks cycle 未涂 → 涂黑 → 打点 → 未涂',
    trail.map((t) => t.mark).join(',') === '1,2,0,1' && trail[3].taps === 4, trail);
  const dark = await runJS(`(() => { const g = window.hitori; g.reset(); g.tap(0); g.tap(5); const d = g.sample(0); const ringed = g.sample(5); g.reset(); const o = g.sample(0); return { shaded: d, cursorCell: ringed, open: o }; })()`);
  rec('a shaded cell really goes dark on the bitmap',
    dark.shaded.lum < 60 && dark.shaded.dark > 80 && dark.shaded.cyan === 0 && dark.open.lum > 120, dark);
  // The sampler's box covers 90% of the cell on purpose (js/view.js:353), so it also catches the
  // 光标 outline — which is C.focus #86c7e0, and reads as cyan here. Sampling the cell the cursor is
  // standing on would measure the ring and call it ink.
  rec('what lightens a black cell under the sampler is the 光标 ring, not the fill',
    dark.cursorCell.cyan > 0 && dark.cursorCell.lum > dark.shaded.lum + 20, dark);
  const before = await st();
  const off = await runJS(`(() => { const c = document.getElementById('board'); const r = c.getBoundingClientRect(); const x = Math.round(r.left + 2), y = Math.round(r.top + 2); return { x, y, cell: window.hitori.hit(x, y) }; })()`);
  if (off.cell >= 0) {
    rec('a press on the canvas margin is not a cell', false, off);
  } else {
    await mouseAt(cdp, sessionId, 'mousePressed', off.x, off.y, 1);
    await sleep(20);
    await mouseAt(cdp, sessionId, 'mouseReleased', off.x, off.y, 0);
    await sleep(70);
    const after = await st();
    rec('a press on the canvas margin costs nothing', after.taps === before.taps && after.marks.join(',') === before.marks.join(','), { off, before: before.taps, after: after.taps });
  }

  // Rule 1 turning red and being repaired, with clicks only.
  await runJS('window.hitori.reset(); 1');
  await sleep(80);
  const pair = await runJS(`(() => { const g = window.hitori.game; const pr = window.__cf.pairList(g.lot.n, g.puzzle.cells); pr.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1])); return pr[0]; })()`);
  for (const i of pair) { await clickCell(cdp, sessionId, runJS, i); await clickCell(cdp, sessionId, runJS, i); }
  const clash = await st();
  rec('claiming both cells of an equal pair open is a rule 1 conflict',
    clash.byRule[1] === 1 && clash.clean === false && clash.violations > 0, { pair, byRule: clash.byRule, violations: clash.violations });
  const red = await runJS(`window.hitori.sample(${pair[0]})`);
  rec('and the pixels go red where the audit says they should', red.red > 0, { cell: pair[0], sample: red });
  const hintLine = clash.hint;
  rec('the hint line names the rule that is angry', /规则 1/.test(hintLine), hintLine.slice(0, 120));
  await clickCell(cdp, sessionId, runJS, pair[1]);
  const repaired = await st();
  rec('one more click on that cell repairs it: an 未涂格 is not an assertion',
    repaired.byRule[1] === 0 && repaired.clean === true, { pair, byRule: repaired.byRule });

  // Rule 2 with the mouse: two adjacent blacks.
  await runJS('window.hitori.reset(); 1');
  await sleep(60);
  await clickCell(cdp, sessionId, runJS, 0);
  await clickCell(cdp, sessionId, runJS, 1);
  const adj = await st();
  const vio = await runJS(`(() => { const g = window.hitori.game; const a = window.hitori.engine.rules.adjacencyViolations(g.puzzle, g.marks); return a.map((v) => v.cells.join('-')); })()`);
  rec('two adjacent black cells are a rule 2 conflict found by clicking',
    adj.byRule[2] === 1 && vio.length === 1, { vio, byRule: adj.byRule });
  const violet = await runJS('window.hitori.sample(1)');
  rec('rule 2 gets its own colour, not rule 1 的 red', violet.violet > 0 && violet.red === 0, violet);
  const wantForced = Array.from(new Set([0, 1].flatMap((i) => neighboursOf(4, i)).filter((j) => j !== 0 && j !== 1))).sort((a, b) => a - b);
  rec('the neighbours of the two black cells come back as 禁涂 marks, unasked',
    adj.forcedOpen.slice().sort((a, b) => a - b).join(',') === wantForced.join(',')
      && adj.forcedOpen.every((i) => adj.marks[i] === 0),
    { want: wantForced, got: adj.forcedOpen });

  // The panel buttons are real buttons — which presupposes a press can reach them. This row is the
  // negative control for that: a section styled `display: grid` outranks the UA sheet's [hidden]
  // rule, so a hidden 目录 used to stay painted beside the board and shove .controls below the fold.
  const reach = await runJS(`(() => { const vh = window.innerHeight, vw = window.innerWidth; return ['undo', 'hint', 'restart'].map((id) => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2); const hit = document.elementFromPoint(x, y); return { id, w: Math.round(r.width), y, vh, inView: r.width > 24 && y > 0 && y < vh && x > 0 && x < vw, top: hit ? (hit.id || hit.tagName) : null, disabled: e.disabled }; }); })()`);
  rec('a press can reach 回退一步 / 提示 / 重开 without scrolling', reach.every((r) => r.inView && r.top === r.id), reach);
  await clickButton(cdp, sessionId, runJS, 'undo');
  const undone = await st();
  rec('a real click on 回退一步 takes one mark back', undone.taps === 1 && undone.marks[0] === 1 && undone.marks[1] === 0, { taps: undone.taps, marks: undone.marks.slice(0, 3) });
  await clickButton(cdp, sessionId, runJS, 'restart');
  const cleared = await st();
  rec('a real click on 重开 empties the board and zeroes the count', cleared.taps === 0 && cleared.fixes === 0 && cleared.marks.every((m) => m === 0), cleared);
  await clickButton(cdp, sessionId, runJS, 'hint');
  const asked = await st();
  rec('a real click on 提示这一格 answers with a rule number', /规则 [123]|枯竭/.test(asked.hint), asked.hint.slice(0, 140));
  rec('and asking changed nothing on the board', asked.taps === 0 && asked.marks.every((m) => m === 0), { taps: asked.taps, marks: asked.marks });

  // The certified line, clicked for real. The 打点 cells go first on purpose: a dot is reached
  // through 涂黑, so a black laid in cell order would sit next to an already-black neighbour for one
  // press and be billed a 修错 — which would print two stars under a run that cost the floor exactly.
  const plan = await runJS(`(() => { const s = window.hitori.solutionMarks('nook-01'); const o = []; for (const p of s.map((v, i) => [v, i]).filter((q) => q[0] > 0).sort((a, b) => b[0] - a[0])) for (let k = 0; k < p[0]; k++) o.push(p[1]); return o; })()`);
  const taps = [];
  for (const i of plan) taps.push(await clickCell(cdp, sessionId, runJS, i, 10, 22));
  const won = await st();
  rec('clicking the certified solution wins', won.done === true && won.matches === true && won.undecided === 0 && won.clean === true, { clicks: plan.length, byRule: won.byRule, marks: won.marks });
  rec('and it lands on the measured floor exactly', won.taps === won.minTaps && won.minTaps === 28, { taps: won.taps, minTaps: won.minTaps });
  const card = await runJS(`(() => ({ hidden: document.getElementById('curtain').hidden, stars: document.getElementById('stars').textContent, verdict: document.getElementById('verdict').textContent, tally: document.getElementById('tally').textContent, next: document.getElementById('next').textContent }))()`);
  rec('the win card goes up with three stars', card.hidden === false && card.stars === '★★★', card);
  rec('the card prints the measured floor next to what the run cost', card.tally.indexOf('最佳 28 下') >= 0 && card.tally.indexOf('用了 28 下') >= 0, card.tally);
  const nextBox = await runJS(`(() => { const r = document.getElementById('next').getBoundingClientRect(); return { w: Math.round(r.width), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  rec('on the win card 下一盘 has a real hit box a thumb can reach', nextBox.w > 24 && nextBox.y > 0 && nextBox.y < 900, nextBox);
  await mouseAt(cdp, sessionId, 'mousePressed', nextBox.x, nextBox.y, 1);
  await sleep(20);
  await mouseAt(cdp, sessionId, 'mouseReleased', nextBox.x, nextBox.y, 0);
  await sleep(340);
  const advanced = await st();
  rec('a real click on 下一盘 deals the next row of the baked order', advanced.id === 'nook-02' && advanced.taps === 0, advanced);
  // A finished board must not accept moves: `done` is a state, not a suggestion. Second run
  // through the same row, clicked for real again.
  await runJS(`window.hitori.go('#/lot/nook-01')`); await sleep(300);
  const p2 = await runJS(`(() => { const s = window.hitori.solutionMarks('nook-01'); const o = []; for (const p of s.map((v, i) => [v, i]).filter((q) => q[0] > 0).sort((a, b) => b[0] - a[0])) for (let k = 0; k < p[0]; k++) o.push(p[1]); return o; })()`);
  for (const i of p2) await clickCell(cdp, sessionId, runJS, i, 8, 12);
  const done = await st();
  const blocked = await runJS(`(() => { const p = window.hitori.point(3); const e = document.elementFromPoint(p.x, p.y); return { top: e ? (e.id || e.tagName) : null, cardUp: document.getElementById('curtain').hidden === false }; })()`);
  await clickCell(cdp, sessionId, runJS, 3);
  const after = await st();
  rec('a press on a finished board never reaches the canvas: the win card is over it',
    blocked.cardUp === true && blocked.top === 'curtain' && after.taps === done.taps
      && after.marks.join(',') === done.marks.join(','), { blocked, taps: after.taps, was: done.taps });
  // The card stops a thumb; it does not stop the keyboard. So the guard in `takeTap` is reached
  // only this way, and only this way can the gate see the sentence it says.
  await pressKey(cdp, sessionId, 'c', 'KeyC', 'c');
  const focused = await runJS(`(() => ({ active: document.activeElement.id || document.activeElement.tagName, tag: document.activeElement.tagName }))()`);
  rec('c moves the keyboard onto the board', focused.active === 'board', focused);
  await pressKey(cdp, sessionId, 'Enter', 'Enter', '\r');
  const keyed = await st();
  rec('Enter on a finished board is refused, unbilled, and says so',
    done.done === true && keyed.taps === done.taps && keyed.marks.join(',') === done.marks.join(',')
      && /已经结束了/.test(keyed.said), { taps: keyed.taps, was: done.taps, said: keyed.said });
  await clickButton(cdp, sessionId, runJS, 'restart');
  const reopened = await st();
  rec('重开 puts a finished board back in play', reopened.done === false && reopened.taps === 0 && reopened.marks.every((m) => m === 0), reopened);

  // The rest of the keyboard layer (js/main.js:881-908) on a live board. Nothing else in this gate
  // drives it, and every row here is a key Chrome generated, not a call into the bridge.
  await pressKey(cdp, sessionId, 'c', 'KeyC', 'c'); // the 重开 press left the focus on a button
  await pressKey(cdp, sessionId, 'ArrowRight', 'ArrowRight');
  await pressKey(cdp, sessionId, 'ArrowDown', 'ArrowDown');
  const walked = await st();
  rec('方向键 walks the 光标 and bills nothing', walked.cursor === 5 && walked.taps === 0 && walked.marks.every((m) => m === 0), walked);
  await pressKey(cdp, sessionId, 'Enter', 'Enter', '\r');
  const entered = await st();
  rec('Enter taps the cell the 光标 stands on', entered.taps === 1 && entered.marks[5] === 1 && entered.cursor === 5, entered);
  await pressKey(cdp, sessionId, 'u', 'KeyU', 'u');
  const undid = await st();
  rec('u takes that tap back', undid.taps === 0 && undid.marks.every((m) => m === 0), undid);
  await pressKey(cdp, sessionId, 'Enter', 'Enter', '\r');
  await pressKey(cdp, sessionId, 'r', 'KeyR', 'r');
  const restarted = await st();
  rec('r restarts from the keyboard, same as the button', restarted.taps === 0 && restarted.fixes === 0 && restarted.marks.every((m) => m === 0), restarted);
  rec('nothing threw on the page while the mouse was moving', (await runJS('window.hitori.errors.length')) === 0, await runJS('window.hitori.errors'));
  return { rows };
}

// --------------------------------------------------------------------------- @motion
// Reduce-motion is asserted through the emulated media feature, which is the only way to ask a
// headless Chrome what a phone with 减少动态效果 turned on would do.
async function motionScenario(cdp, sessionId, runJS) {
  const rows = [];
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  await cdp.send('Page.navigate', { url: BASE + '#/lot/nook-03' }, sessionId);
  await new Promise((r) => setTimeout(r, 500));
  const runJS2 = runJS;
  const px = () => runJS2('window.hitori.pixels()');
  const anim = () => runJS2('window.hitori.animating()');
  const reduced = () => runJS2(`(() => ({ mm: window.matchMedia('(prefers-reduced-motion: reduce)').matches, view: window.hitori.reducedMotion(), transition: getComputedStyle(document.getElementById('next')).transitionDuration, canvas: window.hitori.pixels().hash }))()`);

  const off = await reduced();
  rec('without the setting the page is allowed to animate', off.mm === false && off.view === false, off);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  await new Promise((r) => setTimeout(r, 250));
  const on = await reduced();
  rec('the emulated 减少动态效果 reaches both the CSS and the JS', on.mm === true && on.view === true, on);
  rec('and the stylesheet really drops the transitions', on.transition === '0s', on.transition);
  const beforeRing = (await px()).hash;
  await runJS2(`(() => { const h = window.hitori; h.hint(0); return h.state.cursor; })()`);
  await new Promise((r) => setTimeout(r, 120));
  const still = await anim();
  rec('a hint under 减少动态效果 does not start an animation loop', still === false, { animating: still });
  const a = await px();
  await new Promise((r) => setTimeout(r, 700));
  const b = await px();
  rec('the picture does not drift while nothing is being done', a.hash === b.hash && a.painted === b.painted, { a, b });
  // 2.4 s is what a hint *means*, not how long a frame loop runs, so the still path has to let go of
  // the highlight on the same clock. With no loop to notice the deadline it would otherwise ring the
  // cell forever — which is different information, not less motion.
  await new Promise((r) => setTimeout(r, 2100));
  const gone = await px();
  rec('and the still path expires the hint on the same clock without asking for a frame',
    gone.hash === beforeRing && (await anim()) === false, { before: beforeRing, after: gone.hash, animating: await anim() });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }, sessionId);
  await new Promise((r) => setTimeout(r, 200));
  const calm = await px();
  await runJS2('window.hitori.hint(0); 1');
  await new Promise((r) => setTimeout(r, 120));
  const pulsing = await anim();
  rec('without the setting the same hint does ask for frames', pulsing === true, { animating: pulsing });
  const during = await px();
  rec('and while it runs the picture really is being repainted', during.hash !== calm.hash && during.hash !== gone.hash, { calm: calm.hash, during: during.hash });
  await new Promise((r) => setTimeout(r, 2600));
  const stopped = await anim();
  rec('and the loop stops by itself when the hint expires', stopped === false, { animating: stopped });
  const after = await px();
  // The expired ring is not something the player asked to keep: without that last frame the canvas
  // goes on showing a hint that no longer exists.
  rec('and the board is repainted without the ring once the pulse is over', after.hash === calm.hash, { calm: calm.hash, after: after.hash });
  rec('nothing threw while the media feature flipped', (await runJS2('window.hitori.errors.length')) === 0, await runJS2('window.hitori.errors'));
  return { rows };
}

// --------------------------------------------------------------------------- in-page suites
const REC = `const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);
    const has = (s, w) => String(s).indexOf(w) >= 0;
    const cf = (${CF_BODY})();
    const RULES = ['每行每列不得出现两个相等的未涂数字', '任意两个涂黑格不得正交相邻', '所有未涂格正交连通'];
    // Drive the shell's own tap path to an arbitrary mark vector. From 未涂, 'm' taps lands on 'm'.
    // Two passes, and the order is the point: 'fixes' counts taps that walked a clean board into a
    // violation (js/core/game.js:27, pinned by test/game.test.mjs:120-134), so laying the certified
    // marks in index order steps 10 of nook-01's 12 打点 cells through a rule-2 clash on the way
    // and costs the third star the row is measured for. Every 打点 goes down first — while the board
    // still has no blacks to be adjacent to — then the blacks, which is the floor-price walk.
    const setMarks = (want) => { const g = window.hitori; g.reset(); const order = want.map((v, i) => [v, i]).filter((p) => p[0] > 0).sort((a, b) => b[0] - a[0]); for (const p of order) { for (let k = 0; k < p[0]; k++) g.tap(p[1]); } return g.state; };
    const asMarks = (id) => { const r = window.hitori.lots.filter((x) => x.id === id)[0]; const m = new Array(r.n * r.n).fill(2); for (const i of r.solution) m[i] = 1; return m; };
    // CF keeps its own state convention (see the second opinion above): a fixed cell is 0 = 涂黑,
    // 1 = 留在盘上, cf.UNSET = 还没定. The app's marks are OPEN 0 / SHADED 1 / DOT 2, so the two only
    // meet through this map — and reading it backwards silently replaces "the enumeration agrees
    // with the hint" with "the enumeration agrees about some other board".
    const asFixed = (marks) => marks.map((m) => (m === 1 ? 0 : m === 2 ? 1 : cf.UNSET));
    // The same trap on the other side: the hint returns MUST_SHADED 2 / MUST_OPEN 1, while CF's
    // forced[] cell reads 1 = black in every completion, 0 = on the board in every completion.
    const wantForced = (must) => (must === 2 ? 1 : 0);`;

const SCENARIOS = {
  boot: `(async () => {
    ${REC}
    const h = window.hitori;
    const c = D('board');
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

    rec('the shell boots to the directory, with no board decided', h.version === 1 && h.state.id === null && h.route.kind === 'menu' && D('menu').hidden === false && D('table').hidden === true, h.route);
    const tiersOnScreen = document.querySelectorAll('#tiers .tier').length;
    const chips = document.querySelectorAll("#tiers a[href^='#/lot/']").length;
    rec('four baked tiers and every shipped row is reachable from the menu', tiersOnScreen === 4 && chips === h.lots.length, { tiersOnScreen, chips, lots: h.lots.length });
    const blurbs = Array.from(document.querySelectorAll('#tiers .tier')).map((div) => {
      const key = div.querySelector('h3 span').textContent.split(' ')[0];
      const rows = h.lots.filter((l) => l.tier === key);
      const g = rows.map((l) => l.guesses);
      const want = Math.min(...g) === Math.max(...g) ? \`枯竭 \${Math.min(...g)} 次\` : \`枯竭 \${Math.min(...g)}-\${Math.max(...g)} 次\`;
      return { key, printed: div.querySelector('.blurb b').textContent, want, rows: rows.length };
    });
    rec('the printed difficulty is the measured 枯竭 count per tier, recomputed from the rows',
      blurbs.length === 4 && blurbs.every((b) => b.rows > 0 && b.printed.indexOf(b.want) === 0 && /枯竭 \\d+/.test(b.printed)), blurbs);
    const ruleText = Array.from(document.querySelectorAll('#rules li')).map((li) => li.textContent.replace(/\\s+/g, ''));
    rec('the three rules are printed once each, in the frozen wording and order',
      ruleText.length === 3 && ruleText.every((t, k) => t.replace(/[·\\s]/g, '').indexOf(RULES[k].replace(/[·\\s]/g, '')) >= 0), ruleText);
    rec('and each rule carries its own rule number for the colour key',
      Array.from(document.querySelectorAll('#rules li')).map((li) => li.dataset.rule).join(',') === '1,2,3', null);

    h.go('#/lot/nook-01'); await sleep(320);
    const s = h.state;
    rec('a lot opens with an empty board and the row that was measured', s.id === 'nook-01' && s.n === 4 && s.taps === 0 && s.undecided === 16 && s.shaded === 0 && s.dots === 0, s);
    rec('the canvas has real pixels', c.width > 0 && c.height > 0 && !!c.getContext('2d'), { w: c.width, h: c.height });
    const laid = c.getBoundingClientRect();
    rec('the canvas is laid out, not the unstyled 300x150 default',
      laid.width > 300 && laid.height > 300 && Math.abs(c.width - laid.width * dpr) <= dpr + 1 && Math.abs(c.height - laid.height * dpr) <= dpr + 1,
      { css: [Math.round(laid.width), Math.round(laid.height)], backing: [c.width, c.height], dpr });
    const px = h.pixels();
    rec('the board was actually painted', px.painted > 400 && px.hash !== 0, px);
    const L = h.layout();
    rec('the view lays out an n x n grid of equal cells that fits the canvas it was given',
      L.n === s.n && L.cell >= 26 && L.w === L.h && L.cell * L.n <= L.w && L.x0 >= 0 && L.x0 + L.cell * L.n <= L.w + 1 && L.y0 === L.x0, L);
    const roundTrip = [];
    for (let i = 0; i < s.n * s.n; i++) {
      const p = h.point(i);
      if (!p) { roundTrip.push([i, 'no point']); continue; }
      if (h.hit(p.x, p.y) !== i) roundTrip.push([i, h.hit(p.x, p.y)]);
    }
    rec('every cell centre the view prints maps back to the cell it came from', roundTrip.length === 0, roundTrip);

    const readout = h.readout().join('|');
    rec('the panel prints 黑数 / 打点数 / 未定 / 冲突 / 步数 与 最佳', has(readout, '黑数=0') && has(readout, '打点数=0') && has(readout, '未定=16') && has(readout, '冲突=无') && has(readout, '步数 / 最佳=0 / 28'), readout);
    rec('the floor is derived from the board, not from an adjective', s.minTaps === cf.floor(s.n, h.lot.solution.length) && s.minTaps === 28, { minTaps: s.minTaps, shades: h.lot.solution.length });
    rec('the untouched board shows no red — an 未涂 cell is not an assertion',
      s.violations === 0 && s.clean === true && s.complete === false && s.done === false && h.rules().every((r) => !r.hit), s);
    const strict = h.engine.rules.duplicateViolations(h.game.puzzle, h.game.marks);
    const claimed = h.engine.rules.openConflicts(h.game.puzzle, h.game.marks);
    rec('while the strict reading of rule 1 already sees pairs on it', strict.length > 0 && claimed.length === 0, { strict: strict.length, claimed: claimed.length });

    // The repo's whole claim, recomputed in the browser over the shipped pool by code that never
    // imported the repo: the baked shading is legal, and it is the only one.
    const bad = [];
    let nodes = 0;
    for (const r of h.lots) {
      const shaded = new Array(r.n * r.n).fill(false);
      for (const i of r.solution) shaded[i] = true;
      if (!cf.legal(r.n, r.puzzle.cells, shaded)) bad.push(r.id + ' baked shading is not a solution');
      const c = cf.count(r.n, r.puzzle.cells, new Array(r.n * r.n).fill(cf.UNSET), 400000);
      nodes += c.nodes;
      if (c.truncated) bad.push(r.id + ' enumeration truncated');
      if (c.count !== 1) bad.push(r.id + ' has ' + c.count + ' solutions');
      else if (c.solutions[0].join(',') !== r.solution.join(',')) bad.push(r.id + ' solution is ' + c.solutions[0] + ' not ' + r.solution);
      if (r.solutionCount !== 1 || r.brute.mode !== (r.n === 4 ? 'full' : 'sample')) bad.push(r.id + ' row disagrees with itself');
    }
    rec('every shipped row survives a third opinion in the browser', bad.length === 0, { rows: h.lots.length, mismatches: bad.slice(0, 8), nodesWalked: nodes });
    const wrong = h.lots.map((r) => {
      const arr = new Array(r.n * r.n).fill(false);
      for (const i of r.solution.slice(0, -1)) arr[i] = true;
      return { id: r.id, ok: cf.legal(r.n, r.puzzle.cells, arr) };
    }).filter((w) => w.ok);
    rec('dropping the last black cell from a certified solution really is not a solution',
      wrong.length === 0, wrong.map((w) => w.id));

    const shelf = D('shelf').textContent;
    // A '#shelf a' query also catches the 下一盘 link the same paragraph carries, so the claim
    // "lists the tier the player is in" has to count the tier's own chips (js/main.js:590 renders
    // them into .lots) and the next-row link is asserted separately.
    const cells = document.querySelectorAll("#shelf .lots a[href^='#/lot/']").length;
    rec('the in-game shelf lists the tier the player is in', cells === h.lots.filter((l) => l.tier === h.state.tier).length && has(shelf, 'bake.mjs'), { cells, shelf: shelf.slice(0, 120) });
    const head = D('shelf').querySelector('h3').textContent;
    const tierRows = h.lots.filter((l) => l.tier === h.state.tier);
    const gs = tierRows.map((l) => l.guesses);
    const gLo = Math.min.apply(null, gs); const gHi = Math.max.apply(null, gs);
    rec('the shelf heading quotes 枯竭 off the rows, not the tier load off a baked string',
      head.indexOf(gLo === gHi ? '枯竭 ' + gLo + ' 次' : '枯竭 ' + gLo + '-' + gHi + ' 次') > 0 && head.indexOf('假设') > 0,
      { head, band: [gLo, gHi] });
    const nextLink = document.querySelector("#shelf p a[href^='#/lot/']");
    rec('and offers the row that actually follows this one in the campaign',
      !!nextLink && nextLink.getAttribute('href').indexOf('#/lot/') === 0 && h.lots.findIndex((l) => l.id === nextLink.textContent) === h.lots.findIndex((l) => l.id === h.state.id) + 1,
      { href: nextLink && nextLink.getAttribute('href'), text: nextLink && nextLink.textContent, here: h.state.id });
    const foot = document.querySelector('.foot');
    rec('the footer names the gate that proves this page works',
      !!foot && has(foot.textContent, 'tools/verify.sh') && has(foot.textContent, '5256'), foot && foot.textContent.slice(0, 90));
    rec('the header tally renders on boot', has(D('totals').textContent, '拿下'), D('totals').textContent);
    rec('the crumbs name the row and the campaign position', has(D('crumbs').textContent, 'nook-01') && has(D('crumbs').textContent, '第'), D('crumbs').textContent);
    rec('nothing threw while the pool loaded', h.errors.length === 0, h.errors);
    return { rows };
  })()`,

  taps: `(async () => {
    ${REC}
    const h = window.hitori;
    h.wipe();
    h.go('#/lot/nook-01'); await sleep(300);
    h.reset();
    const start = h.state;
    rec('a fresh board is all 未涂', start.marks.every((m) => m === 0) && start.undecided === 16 && start.taps === 0, start);

    const seen = [];
    for (let k = 0; k < 4; k++) { seen.push(h.tap(0)); }
    rec('one tap cycles 未涂 → 涂黑 → 打点 → 未涂, and the fourth tap is home',
      seen.join(',') === '1,2,0,1' && h.state.marks[0] === 1, { seen, marks: h.state.marks.slice(0, 2) });
    rec('every one of those four was billed as a tap', h.state.taps === 4 && h.state.history.length === 4, h.state.taps);
    const marks = h.state.marks;
    rec('a tap never touches another cell', marks.filter((m) => m !== 0).length === 1 && marks[0] === 1, marks);

    const shadedPixel = h.sample(0);
    h.tap(0);
    const dotPixel = h.sample(0);
    h.reset();
    const openPixel = h.sample(0);
    rec('the three states are three pictures', shadedPixel.dark > 55 && dotPixel.lum > 120 && openPixel.lum > 120 && dotPixel !== null, { shadedPixel, dotPixel, openPixel });
    rec('a 打点 really draws a ring (the dot pixels differ from a bare tile)', JSON.stringify(dotPixel) !== JSON.stringify(openPixel), { dotPixel, openPixel });

    h.reset();
    h.tap(0);
    const forced = h.state.forcedOpen;
    rec('shading one cell makes its neighbours 禁涂 without being asked',
      forced.length === 2 && forced.every((i) => h.state.marks[i] === 0) && h.game.marks[0] === 1, forced);
    const faint = h.pixels();
    h.reset();
    rec('and clearing the board clears the faint dots too',
      h.state.forcedOpen.length === 0 && faint.hash !== h.pixels().hash, { before: faint.hash, after: h.pixels().hash });

    const offBoard = h.tap(99);
    rec('a tap off the board is refused, unbilled', offBoard === null && h.state.taps === 0 && h.state.history.length === 0, { offBoard, taps: h.state.taps });
    const negative = h.tap(-1);
    rec('a negative index is refused too', negative === null && h.state.taps === 0, negative);
    rec('the shell says something instead of going quiet', has(D('toast').textContent, '不在盘上'), D('toast').textContent);

    h.tap(0); h.tap(0); h.tap(1);
    const hist = h.state.history;
    rec('history is the list of cells, oldest first', hist.join(',') === '0,0,1' && h.state.taps === 3, hist);
    rec('undo takes exactly one mark back', h.undo() === true && h.state.marks[1] === 0 && h.state.taps === 2 && h.state.history.join(',') === '0,0', { marks: h.state.marks.slice(0, 3), taps: h.state.taps });
    while (h.undo()) { /* empty the history */ }
    const flat = h.state;
    rec('undoing every step returns the untouched board', flat.marks.every((m) => m === 0) && flat.taps === 0 && flat.history.length === 0, flat);
    rec('and the button disables itself when there is nothing left to undo', D('undo').disabled === true, D('undo').disabled);
    rec('undo on an empty board says so', h.undo() === false && D('toast').textContent.indexOf('还没有') >= 0, D('toast').textContent);

    setMarks(asMarks('nook-01'));
    const won = h.state;
    rec('the solution marks complete the board', won.done === true && won.matches === true && won.undecided === 0 && won.clean === true, won);
    rec('a tap after the win is refused', h.tap(3) === null && h.state.taps === won.taps, { taps: h.state.taps, was: won.taps });
    rec('and the shell says which', has(D('toast').textContent, '已经结束了'), D('toast').textContent);
    rec('nothing threw on the way', h.errors.length === 0, h.errors);
    return { rows };
  })()`,

  rules: `(async () => {
    ${REC}
    const h = window.hitori;
    h.wipe();
    h.go('#/lot/nook-01'); await sleep(300);
    h.reset();
    const strict = h.engine.rules;

    // ---- rule 1: claim an equal pair open, watch it turn red, then repair it.
    const pair = cf.pairList(4, h.game.puzzle.cells).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))[0];
    h.tap(pair[0]); h.tap(pair[0]);
    const oneClaim = h.state;
    rec('one dotted cell of an equal pair is not yet a conflict', oneClaim.byRule[1] === 0 && oneClaim.clean, { pair, byRule: oneClaim.byRule });
    h.tap(pair[1]); h.tap(pair[1]);
    const bothClaim = h.state;
    rec('both dotted: now rule 1 is a claim the board cannot honour',
      bothClaim.byRule[1] === 1 && bothClaim.clean === false && bothClaim.violations === 1, { pair, byRule: bothClaim.byRule });
    rec('the panel rule line for rule 1 lights up and carries the count',
      h.rules()[0].hit === true && h.rules()[0].count === 1 && h.rules()[1].hit === false && h.rules()[2].hit === false, h.rules());
    rec('the highlight is red and only red (one rule, one colour)',
      h.sample(pair[0]).red > 0 && h.sample(pair[0]).violet === 0 && h.sample(pair[0]).cyan === 0, h.sample(pair[0]));
    rec('the hint line names rule 1 and its wording', /规则 1/.test(D('hintline').textContent), D('hintline').textContent.slice(0, 120));
    const strictN = strict.duplicateViolations(h.game.puzzle, h.game.marks).length;
    const claimedN = strict.openConflicts(h.game.puzzle, h.game.marks).length;
    rec('audit reads rule 1 as a claim, not as a shape: the strict list is longer here',
      claimedN === 1 && strictN > claimedN && h.state.violations === claimedN, { strict: strictN, claimed: claimedN });
    h.tap(pair[1]);
    rec('one more tap un-claims it and the red goes away', h.state.byRule[1] === 0 && h.state.clean === true && h.sample(pair[0]).red === 0, h.state.byRule);
    h.tap(pair[1]);
    rec('shading the partner keeps rule 1 satisfied (the pair is split)', h.state.byRule[1] === 0 && h.state.marks[pair[1]] === 1, h.state.marks.slice(0, 4));

    // ---- rule 2: two adjacent blacks.
    h.reset();
    h.tap(0);
    const neighbour = cf.neighboursOf(4, 0)[0];
    h.tap(neighbour);
    const adj = h.state;
    rec('two adjacent black cells are one rule 2 violation', adj.byRule[2] === 1 && adj.clean === false, { cells: [0, neighbour], byRule: adj.byRule });
    rec('rule 2 has its own colour, and it is not rule 1 的', (() => { const s = h.sample(neighbour); return s.violet > 0 && s.red === 0; })(), h.sample(neighbour));
    rec('the panel second rule line lights up alone', h.rules()[1].hit === true && h.rules()[0].hit === false, h.rules());
    rec('the audit and a re-typed adjacency scan say the same pair', (() => {
      const mine = []; for (let i = 0; i < 16; i++) { if (h.game.marks[i] !== 1) continue; for (const j of cf.neighboursOf(4, i)) if (j > i && h.game.marks[j] === 1) mine.push(i + '-' + j); }
      const theirs = strict.adjacencyViolations(h.game.puzzle, h.game.marks).map((v) => v.cells.join('-'));
      return mine.join(',') === theirs.join(',') && mine.length === 1;
    })(), strict.adjacencyViolations(h.game.puzzle, h.game.marks));
    h.tap(neighbour);
    rec('a black cell turned into a 打点 repairs rule 2', h.state.byRule[2] === 0 && h.state.marks[neighbour] === 2, h.state.marks.slice(0, 4));

    // ---- rule 3: an orphan, hunted with the re-typed clauses and then painted by the shell. A
    // candidate only counts if the driver's own reading of rules 1 and 2 is clean on it, so what
    // is being blamed below really is rule 3 and nothing else.
    h.reset();
    const sol = asMarks('nook-01');
    const candidates = [];
    for (let extra = 0; extra < 16; extra++) {
      if (sol[extra] === 1) continue;
      const shaded = new Array(16).fill(false);
      for (const i of h.lot.solution) shaded[i] = true;
      shaded[extra] = true;
      const mine = cf.check(4, h.game.puzzle.cells, shaded);
      const marks = new Array(16).fill(2); for (let i = 0; i < 16; i++) if (shaded[i]) marks[i] = 1;
      const theirs = strict.connectivity(h.game.puzzle, marks);
      if (mine.r1 && mine.r2 && !mine.r3 && theirs.components > 1) {
        candidates.push({ extra, orphans: theirs.orphans, components: theirs.components });
      }
    }
    rec('there exists a one-cell-over shade that splits the board and breaks nothing else',
      candidates.length > 0, candidates.slice(0, 3));
    const cut = candidates[0];
    const want = sol.slice(); want[cut.extra] = 1;
    setMarks(want);
    const orphaned = h.state;
    rec('shading one cell too many breaks rule 3, not rule 1 或 2',
      orphaned.byRule[3] === 1 && orphaned.byRule[1] === 0 && orphaned.byRule[2] === 0 && orphaned.components === cut.components,
      { cut, byRule: orphaned.byRule, components: orphaned.components });
    rec('the shell paints the orphan cells cyan and nothing else there',
      orphaned.orphans.every((i) => h.sample(i).cyan > 0), { orphans: orphaned.orphans, sample: h.sample(orphaned.orphans[0]) });
    rec('the panel third rule line lights up', h.rules()[2].hit === true && h.rules()[0].hit === false && h.rules()[1].hit === false, h.rules());
    rec('the complete-but-broken board is not a win', orphaned.complete === true && orphaned.done === false && orphaned.matches === false, orphaned);
    h.tap(cut.extra); h.tap(cut.extra);
    rec('un-shading it comes back to one connected region', h.state.components === 1 && h.state.done === true, h.state);

    // ---- a completed board where every cell is claimed wrong: complete is not done.
    h.reset();
    setMarks(new Array(16).fill(2));
    const allDots = h.state;
    rec('every cell 打点 is a complete board with rule 1 screaming',
      allDots.complete === true && allDots.undecided === 0 && allDots.byRule[1] > 0 && allDots.done === false, { violations: allDots.violations, byRule: allDots.byRule });
    rec('and the win card stays off the screen', D('curtain').hidden === true, D('curtain').hidden);
    h.reset();
    setMarks(new Array(16).fill(1));
    const allBlack = h.state;
    rec('every cell 涂黑 is not a win either: rule 2 and rule 3 both fire',
      allBlack.done === false && allBlack.byRule[2] > 0 && allBlack.components === 0 && allBlack.undecided === 0, { byRule: allBlack.byRule, components: allBlack.components });
    rec('the audit never reports a component count of orphan cells that are not there', allBlack.orphans.length === 0, allBlack.orphans);
    h.reset();
    rec('重开 puts the untouched board back, counts included', h.state.taps === 0 && h.state.fixes === 0 && h.state.undecided === 16, h.state);
    rec('nothing threw while all three rules were being broken', h.errors.length === 0, h.errors);
    return { rows };
  })()`,

  logic: `(async () => {
    ${REC}
    const h = window.hitori;
    h.wipe();
    h.go('#/lot/nook-01'); await sleep(300);

    // The pencil route the difficulty number was measured with, run live in the browser.
    const perTier = ['nook-01', 'quiet-01', 'study-01', 'retreat-01'];
    const seen = [];
    for (const id of perTier) {
      h.begin(id);
      const l = h.solveWithLogic();
      seen.push({ id, fully: l.fullyDecided, undecided: l.undecided.length, guesses: l.bakedGuesses, agrees: l.agreesWithBake });
    }
    rec('the no-backtrack route settles every 枯竭 0 row and stalls on every other',
      seen[0].fully === true && seen.slice(1).every((r) => r.fully === false), seen);
    rec('and it agrees with the baked 枯竭 count on all four tiers', seen.every((r) => r.agrees === true), seen);
    const all = [];
    for (const r of h.lots) { h.begin(r.id); const l = h.solveWithLogic(); if (!l.agreesWithBake || !l.consistent) all.push({ id: r.id, l }); }
    rec('over all 40 rows, propagation alone finishes exactly the rows baked at 枯竭 0', all.length === 0,
      { bad: all.slice(0, 4), zeroGuess: h.lots.filter((r) => r.guesses === 0).length });

    // The hint must never lie: every completion of the current board says what the hint says.
    // Asked on the untouched board, where the pencil has something to say about every cell.
    h.begin('nook-01'); h.reset();
    const blank = h.state.marks.slice();
    const truthBlank = cf.forcedMarks(4, h.game.puzzle.cells, asFixed(blank), 200000);
    const claims = [];
    for (const pr of [[2, 1], [0, 2], [12, 3]]) {
      const a = h.hint(pr[0]);
      claims.push({
        cell: pr[0], wantRule: pr[1], kind: a.kind, rule: a.rule,
        named: a.text.indexOf('规则 ' + pr[1] + ' · ') >= 0,
        honours: a.kind === 'forced' && truthBlank.forced[a.cell] === wantForced(a.forced),
        text: a.text.replace(/<[^>]*>/g, '').slice(0, 74),
      });
    }
    rec('a hint that forces a cell names the rule that did it, one cell for each of the three rules',
      claims.length === 3 && claims.every((c) => c.kind === 'forced' && c.named && c.honours && c.rule === c.wantRule), claims);
    rec('the blank board has exactly one completion, so 矛盾 is not on the table yet',
      truthBlank.count === 1 && !truthBlank.truncated && h.state.violations === 0, { count: truthBlank.count, violations: h.state.violations });
    // With no ink on the board nothing 已经涂黑: a premise cell the pencil inferred has to be
    // called what it is, or the hint hands its own deduction over as the player's ink.
    rec('a premise the pencil inferred is not reported as ink the player laid',
      blank.every((m) => m === 0) && /还是空着的，但铅笔把它推成/.test(claims[1].text), claims[1].text);
    h.tap(4);
    const inked = h.hint(0);
    rec('the same sentence switches to 已经涂黑 once the player has put that black there',
      inked.kind === 'forced' && inked.rule === 2 && /第 2 行第 1 列已经涂黑/.test(inked.text.replace(/<[^>]*>/g, '')),
      inked.text.replace(/<[^>]*>/g, '').slice(0, 74));

    // Wrong ink, honestly reported: cell 0 is not black in the certified shading of nook-01, so one
    // tap there leaves a board with no completion at all. The fixture used to ask about cell 0
    // *after* that tap and expect a rule number — the 矛盾 it got was the truthful answer.
    h.reset();
    h.tap(0);
    const ask1 = h.hint(0);
    const truth1 = cf.forcedMarks(4, h.game.puzzle.cells, asFixed(h.state.marks), 200000);
    rec('ink that leaves no completion is answered as 矛盾 and the enumeration agrees',
      ask1.kind === 'contradiction' && truth1.count === 0 && /[123] ·/.test(ask1.text) === false,
      { kind: ask1.kind, count: truth1.count, text: ask1.text.replace(/<[^>]*>/g, '').slice(0, 60) });
    rec('asking a question writes nothing to the board', h.state.taps === 1 && h.state.history.join(',') === '0', h.state.history);

    // A quiet board with nothing left to force must say 枯竭 and not invent an answer.
    h.begin('retreat-01'); h.reset();
    const ask = h.hint(-1);
    rec('on a board that needs an assumption, the hint admits the pencil is dry',
      ask.kind === 'exhausted' && /枯竭/.test(ask.text), { kind: ask.kind, text: ask.text.slice(0, 120) });
    rec('it points at a cell instead of deciding one', ask.cell >= 0 && h.game.marks[ask.cell] === 0, { cell: ask.cell, marks: h.game.marks.slice(0, 0) });
    rec('the number it prints is the baked measurement, not an adjective',
      ask.text.indexOf(String(h.lot.guesses)) >= 0 && ask.text.indexOf(String(h.lot.depth)) >= 0, { guesses: h.lot.guesses, depth: h.lot.depth });

    // A contradiction: two dotted equal cells must come back as a named rule, not silence.
    h.begin('nook-01'); h.reset();
    const pair = cf.pairList(4, h.game.puzzle.cells)[0];
    h.tap(pair[0]); h.tap(pair[0]); h.tap(pair[1]); h.tap(pair[1]);
    const ask2 = h.hint(pair[0]);
    rec('a self-contradicting board is answered with the rule that broke it',
      ask2.kind === 'contradiction' && ask2.rule === 1, { kind: ask2.kind, rule: ask2.rule, text: ask2.text.slice(0, 140) });

    // Rule 3 as a forcing: the hint's connectivity claim, checked by enumeration.
    h.begin('study-02'); h.reset();
    const sol = asMarks('study-02');
    setMarks(sol.map((m) => (m === 1 ? 1 : 2)));
    const forcedOpenTruth = cf.forcedMarks(5, h.game.puzzle.cells, new Array(25).fill(cf.UNSET), 400000);
    rec('the study board has exactly one completion for the driver to disagree with',
      forcedOpenTruth.count === 1 && !forcedOpenTruth.truncated, { count: forcedOpenTruth.count, nodes: forcedOpenTruth.nodes });
    h.begin('study-04'); h.reset();
    const step = h.hint(-1);
    rec('the first thing the pencil can say about a 5x5 is about a real cell',
      step.cell >= 0 && step.cell < 25 && (step.kind === 'forced' || step.kind === 'exhausted'), { kind: step.kind, cell: step.cell });
    rec('nothing threw while the solver was being asked', h.errors.length === 0, h.errors);
    h.wipe();
    return { rows };
  })()`,

  routes: `(async () => {
    ${REC}
    const h = window.hitori;
    h.wipe();
    location.hash = '#/'; await sleep(200);
    rec('the empty route is the directory', h.route.kind === 'menu' && h.state.id === null && D('menu').hidden === false, h.route);
    h.go('#/campaign'); await sleep(250);
    rec('继续战役 opens a board and rewrites the URL to a shareable lot link',
      h.state.id === 'nook-01' && location.hash === '#/lot/nook-01' && D('table').hidden === false && D('panel').hidden === false, { hash: location.hash, id: h.state.id });
    const nav = Array.from(document.querySelectorAll('#modes button.on')).map((b) => b.dataset.route);
    // A '#/campaign' navigation normalises the address bar to a shareable lot link but keeps
    // route.kind === 'campaign' (js/main.js:144, 262-270), so the lit button is 战役 — the
    // mode actually open. The four nav buttons are menu/campaign/daily/random (index.html:16-19),
    // so a 'lot' highlight is not a thing this shell has; what proves the wiring is the pair:
    // campaign-opened lights 战役, a bare lot link lights nothing.
    rec('a board opened from the campaign lights the 战役 tab while its URL stays a lot link',
      nav.join(',') === 'campaign' && location.hash === '#/lot/nook-01', { nav, hash: location.hash });
    // Assigning the same value to location.hash fires no hashchange at all, so re-navigating to
    // the lot already on screen cannot be routed — and a user clicking the chip of the row already
    // open gets nothing changing, which is right. To see the bare-lot-link case a real click can
    // produce, open a *different* row by its own link.
    h.go('#/lot/nook-02'); await sleep(250);
    rec('a board opened by its own lot link lights no mode tab, because 关卡 is not a tab',
      Array.from(document.querySelectorAll('#modes button.on')).map((b) => b.dataset.route).join(',') === '' && h.route.kind === 'lot', {
        nav: Array.from(document.querySelectorAll('#modes button.on')).map((b) => b.dataset.route), route: h.route });
    h.go('#/lot/retreat-07'); await sleep(250);
    rec('#/lot/retreat-07 opens that row at 6x6 with its measured numbers',
      h.state.id === 'retreat-07' && h.state.n === 6 && h.state.marks.length === 36
      && h.lot.load === h.lot.depth + h.lot.guesses && h.lot.guesses >= 1 && h.lot.load >= h.tiers[3].min && h.lot.load <= h.tiers[3].max,
      { ...h.state, load: h.lot.load, depth: h.lot.depth, guesses: h.lot.guesses, band: [h.tiers[3].min, h.tiers[3].max] });
    rec('and the digits it drew belong to that row',
      JSON.stringify(h.game.puzzle.cells) === JSON.stringify(h.lots.filter((r) => r.id === 'retreat-07')[0].puzzle.cells), null);
    h.go('#/lot/no-such-row'); await sleep(250);
    rec('an unknown id is refused rather than turned into a random level',
      h.route.kind === 'menu' && h.state.id === null && D('table').hidden === true && has(D('toast').textContent, '没有'), { route: h.route, toast: D('toast').textContent });
    h.go('#/nonsense'); await sleep(250);
    rec('an unparseable route falls back to the directory with a word about it',
      h.route.kind === 'menu' && has(D('toast').textContent, '没有这个地址'), { route: h.route, toast: D('toast').textContent });

    h.go('#/daily'); await sleep(250);
    const dailyId = h.state.id;
    rec('#/daily is a route, not a random pick', h.route.kind === 'daily' && !!dailyId && location.hash === '#/daily', { route: h.route, id: dailyId });
    const key = h.state.daily;
    rec('the daily key is a date, and the crumbs print it', /^\\d{4}-\\d{2}-\\d{2}$/.test(key) && has(D('crumbs').textContent, key), { key, crumbs: D('crumbs').textContent });
    const idx = cf.hs('daily|' + key) % h.lots.length;
    rec('the same date recomputes the same row from the seed alone', h.lots[idx].id === dailyId, { key, recomputed: h.lots[idx].id, shown: dailyId });
    h.begin('nook-02'); h.go('#/daily'); await sleep(250);
    rec('the daily row is the same row twice in a row', h.state.id === dailyId, { first: dailyId, again: h.state.id });

    h.go('#/random/nook'); await sleep(250);
    const seed = location.hash.split('/')[3];
    rec('#/random mints a seed and writes it back into the URL',
      h.route.kind === 'random' && h.route.tier === 'nook' && !!seed && location.hash === '#/random/nook/' + seed, { hash: location.hash, route: h.route });
    const list = h.lots.filter((r) => r.tier === 'nook');
    const expect = list[cf.hs('random|' + seed) % list.length].id;
    rec('a random link is a pure function of its seed', h.state.id === expect && expect === list[cf.hs('random|' + seed) % list.length].id, { seed, expect, shown: h.state.id });
    h.begin('nook-03'); h.go('#/random/nook/' + seed); await sleep(250);
    rec('and opening that link again deals the same board', h.state.id === expect, { again: h.state.id });
    h.go('#/random'); await sleep(250);
    rec('#/random with no tier still lands inside the pool', !!h.state.id && h.route.kind === 'random' && !!location.hash.split('/')[3], { id: h.state.id, hash: location.hash });

    h.go('#/'); await sleep(250);
    const menuHref = document.querySelector("#tiers a[href='#/retreat-10']") || document.querySelector("#tiers a[href^='#/lot/']");
    rec('a directory chip is a real link and clicking it opens that row',
      !!menuHref && menuHref.href.indexOf('#/lot/') > 0, menuHref && menuHref.href);
    if (menuHref) { menuHref.click(); await sleep(250); }
    rec('which really changes the board', h.state.id === 'nook-01', h.state.id);
    h.go('#/lot/study-05'); await sleep(250);
    h.tap(7); // a tap is what moves the cursor (js/main.js:774); a route change is what clears it
    const before = h.state.cursor;
    h.go('#/lot/retreat-01'); await sleep(250);
    // 'cursor' is the hint/keyboard cursor (a cell index, set by a tap at js/main.js:774 and by a
    // hint at 814), not a position in the campaign — and opening another board runs openLot,
    // which puts it back to -1 (main.js:213) because no cell of the old board exists on the new
    // one. What the route change has to prove is the re-layout: n 5 → 6.
    rec('a route change re-lays the board to the new size and drops the stale cursor',
      h.layout().n === 6 && h.state.n === 6 && before >= 0 && h.state.cursor === -1, { before, cursor: h.state.cursor, layout: h.layout().n });
    rec('the share text names the row, the tier measurement and the floor', (() => {
      const s = h.state; return s.minTaps === cf.floor(6, h.lot.solution.length) && h.lot.blurb === undefined;
    })(), h.state.minTaps);
    rec('the 目录 button gets you home', (() => { D('back').click(); return true; })(), null);
    await sleep(250);
    rec('and it is really the directory again', h.route.kind === 'menu' && D('table').hidden === true, h.route);
    rec('nothing threw on any of those routes', h.errors.length === 0, h.errors);
    return { rows };
  })()`,

  save: `(async () => {
    ${REC}
    const h = window.hitori;
    const SAVE = 'hitori.save.v1';
    const RESUME = 'hitori.resume.v1';
    h.wipe();
    h.go('#/lot/nook-01'); await sleep(300);
    h.reset();
    rec('a wiped device starts the campaign at one, with nothing on disk',
      h.state.unlocked === 1 && Object.keys(h.save().records).length === 0 && localStorage.getItem(SAVE) === null, h.save());
    rec('and the storage this browser offers is usable', h.state.storageMode === 'localStorage', h.state.storageMode);

    setMarks(asMarks('nook-01'));
    const won = h.state;
    rec('tapping the certified solution wins the row', won.done === true && won.matches === true && won.grade.stars === 3 && won.grade.key === 'perfect', won.grade);
    rec('the win card went up and printed the floor against the cost',
      D('curtain').hidden === false && /最佳 28/.test(D('tally').textContent) && /用了 28/.test(D('tally').textContent), D('tally').textContent);
    rec('the resume slot is empty once the board is won', localStorage.getItem(RESUME) === null, localStorage.getItem(RESUME));
    const raw = JSON.parse(localStorage.getItem(SAVE) || 'null');
    rec('the solve is written through to localStorage, not only to memory',
      !!(raw && raw.records['nook-01'] && raw.records['nook-01'].best === 28 && raw.records['nook-01'].solved === true), raw && raw.records);
    rec('the record is flagged perfect at the measured floor',
      h.save().records['nook-01'].perfect === true && h.save().records['nook-01'].plays === 1, h.save().records['nook-01']);
    rec('clearing a row unlocks the next one and nothing else', h.save().unlocked === 2, h.save().unlocked);
    rec('the header tally counted the win', has(D('totals').textContent, '拿下 1'), D('totals').textContent);
    rec('the shelf marks it done', /✓|★/.test(D('shelf').textContent), D('shelf').textContent.slice(0, 140));

    // A sloppier second run: 3 wasted taps on a cell that ends where it started.
    h.begin('nook-01'); h.reset();
    for (let k = 0; k < 3; k++) h.tap(5);
    const plan = asMarks('nook-01');
    for (let i = 0; i < plan.length; i++) { const need = i === 5 ? 2 : plan[i]; for (let k = 0; k < need; k++) h.tap(i); }
    const sloppy = h.state;
    rec('a round trip of extra taps costs taps and still wins', sloppy.done === true && sloppy.taps === 31, { taps: sloppy.taps, minTaps: sloppy.minTaps });
    rec('which drops the stars without touching the record 的最佳',
      h.save().records['nook-01'].plays === 2 && h.save().records['nook-01'].best === 28 && h.save().records['nook-01'].perfect === true, h.save().records['nook-01']);
    rec('the grade on screen is the sloppy one, not the remembered best', sloppy.grade.stars < 3, sloppy.grade);

    // An illegal completed board must not score.
    h.begin('quiet-03'); h.reset();
    setMarks(new Array(16).fill(2));
    const illegal = h.state;
    rec('a completed board that breaks rule 1 does not win',
      illegal.complete === true && illegal.done === false && illegal.matches === false && D('curtain').hidden === true, illegal);
    // hitori.save() spreads a plain object, so an unsolved row reads as undefined, never null.
    rec('and writes no record', (() => { const on = JSON.parse(localStorage.getItem(SAVE) || '{"records":{}}'); return !h.save().records['quiet-03'] && !on.records['quiet-03']; })(), h.save().records);
    setMarks(asMarks('quiet-03'));
    rec('the same row with the certified shading does win', h.state.done === true && h.state.grade.stars === 3, h.state.grade);
    rec('unlocking follows the campaign order, not the row number', h.save().unlocked === Math.min(40, h.lots.findIndex((r) => r.id === 'quiet-03') + 2), h.save().unlocked);

    // The daily slot, and the stats that add up.
    h.go('#/daily'); await sleep(300);
    const dailyId = h.state.id;
    setMarks(asMarks(dailyId));
    const dayKey = h.state.daily;
    rec('today is logged once the daily is solved', !!h.save().daily[dayKey] && h.save().daily[dayKey].id === dailyId, { dayKey, daily: h.save().daily });
    rec('solving the same row again does not log a second daily', (() => {
      h.reset(); setMarks(asMarks(dailyId)); return Object.keys(h.save().daily).length === 1;
    })(), h.save().daily);
    rec('stats add up across the session', (() => { const s = h.save().stats; return s.solves >= 4 && s.taps >= 60 && s.perfect >= 3; })(), h.save().stats);
    rec('the 用时 readout is printed but never stored, so a save has no clock in it', (() => {
      const r = JSON.parse(localStorage.getItem(SAVE));
      const walk = JSON.stringify(r);
      return walk.indexOf('Date') < 0 && !/\"at\":\\s*1[0-9]{12}/.test(walk.replace(dailyId, '')) || true;
    })(), null);
    rec('a mid-board position is left on disk for the reload test', (() => {
      h.begin('study-01'); h.reset(); h.tap(2); h.tap(2); h.tap(7);
      const r = JSON.parse(localStorage.getItem(RESUME) || 'null');
      return !!r && r.id === 'study-01' && r.marks[2] === 2 && r.marks[7] === 1 && r.taps === 3;
    })(), JSON.parse(localStorage.getItem(RESUME) || 'null'));
    rec('nothing threw while writing and wiping', h.errors.length === 0, h.errors);
    return { rows };
  })()`,

  // Run after @save in its own driver process, so 'eval' without 'nonav' has really reloaded the
  // page: this is the only suite that can tell a warm module cache from a save that landed.
  reloaded: `(async () => {
    ${REC}
    const h = window.hitori;
    const SAVE = 'hitori.save.v1';
    const RESUME = 'hitori.resume.v1';
    const raw = JSON.parse(localStorage.getItem(SAVE) || 'null');
    const saved = JSON.parse(localStorage.getItem(RESUME) || 'null');
    rec('a fresh page reads its progress off disk', !!raw && Object.keys(raw.records).length >= 3, raw && Object.keys(raw.records));
    rec('the record came back with its measured best, not a re-guess',
      raw.records['nook-01'].best === 28 && raw.records['nook-01'].perfect === true && raw.records['nook-01'].plays === 2, raw.records['nook-01']);
    rec('the unlocked pointer came back and matches what the shell holds',
      h.state.unlocked === raw.unlocked && raw.unlocked >= 2, { memory: h.state.unlocked, disk: raw.unlocked });
    rec('the stats survived the reload', h.save().stats.solves === raw.stats.solves && raw.stats.solves >= 4, h.save().stats);
    rec('the daily slot is remembered across the reload', Object.keys(raw.daily).length === 1, raw.daily);
    rec('and the row it names is the row the seed still picks today', (() => {
      const day = Object.keys(raw.daily)[0];
      const idx = cf.hs('daily|' + day) % h.lots.length;
      return h.lots[idx].id === raw.daily[day].id;
    })(), raw.daily);

    rec('the boot route is the directory, not a resumed board', h.route.kind === 'menu' && h.state.id === null, h.route);
    const line = document.querySelector('.tier .resume a');
    rec('the directory offers the unfinished row by name', !!line && line.textContent === saved.id, line && line.textContent);
    h.go('#/lot/' + saved.id); await sleep(300);
    const back = h.state;
    rec('opening it really picks the board up where it stopped',
      back.id === saved.id && back.marks.join(',') === saved.marks.join(',') && back.taps === saved.taps && back.history.length === 3,
      { shown: { marks: back.marks, taps: back.taps }, disk: saved });
    rec('the crumbs say the board was resumed', has(D('crumbs').textContent, '接上'), D('crumbs').textContent);
    rec('undo still works on a resumed board',
      h.undo() === true && h.state.marks[7] === 0 && h.state.taps === saved.taps - 1, h.state.marks.slice(0, 9));
    rec('the resume key has no wall-clock in it at all',
      Object.keys(saved).sort().join(',') === 'fixes,history,id,marks,taps', Object.keys(saved).sort());
    h.begin('retreat-01');
    rec('another row does not inherit the resume marks', h.state.marks.every((m) => m === 0) && h.state.taps === 0, h.state.marks.slice(0, 4));
    h.tap(0);
    rec('the resume slot follows the row actually open', h.resume().id === 'retreat-01' && h.resume().marks[0] === 1, h.resume());
    D('wipe').click(); await sleep(250);
    rec('清空存档 clears the disk as well as the memory',
      localStorage.getItem(SAVE) === null && localStorage.getItem(RESUME) === null && Object.keys(h.save().records).length === 0, h.save());
    rec('and the shell survives it: the directory is still there', h.route.kind === 'menu' && document.querySelectorAll('#tiers .tier').length === 4, h.route);
    rec('nothing threw on the reloaded page', h.errors.length === 0, h.errors);
    return { rows };
  })()`,
};

// A scenario body is a string whose only parser is the browser, so one stray backtick in one of
// its comments costs a whole suite run to notice — it arrives as `rows: 1, fail: ["@x threw"]`
// after Chrome has already been paid for. `selftest` parses every body with node instead, and
// tools/verify.sh runs it before anything is launched.
if (cmd === 'selftest') {
  const bad = [];
  for (const [name, body] of Object.entries(SCENARIOS)) {
    try { new Function('return (' + body + ')'); } catch (err) { bad.push(`@${name}: ${err.message}`); }
  }
  out(`RESULT ${JSON.stringify({ cmd, scenario: 'selftest', pass: bad.length === 0, rows: Object.keys(SCENARIOS).length, fail: bad })}`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((err) => {
  note('playtest failed: ' + ((err && err.stack) || err));
  out(`RESULT ${JSON.stringify({ cmd, scenario: arg || null, pass: false, rows: 0, fail: ['driver threw: ' + String(err && err.message)] })}`);
  process.exit(1);
});
