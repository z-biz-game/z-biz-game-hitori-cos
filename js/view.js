// Pixels and gestures for 一乘. Nothing in this file decides a rule: js/core/rules.js is the
// only place a violation is computed and js/core/game.js is the only place a tap changes a
// mark. The view is *told* which cells break which rule and paints what it is handed, so a
// disagreement between the board and the test suite is impossible by construction — there is
// no second copy of the rules in here to drift.
//
// Three things this file is responsible for:
//
//   * the cycle is one finger deep. A pointerdown on a cell asks the shell to tap it; there is
//     no long-press, no right-click and no modifier mode, because 未涂 → 涂黑 → 打点 has to
//     work on a phone with one thumb.
//   * geometry is measured from the canvas's own box and mapped back out through `point(i)`, so
//     an automated finger presses where a cell actually is rather than where these constants
//     happen to suggest.
//   * the palette is duplicated from css/game.css on purpose. A canvas cannot read a CSS
//     custom property at draw time without a getComputedStyle round trip per cell, and the
//     rule colours have to be legible on a light tile *and* on the dark table. The two lists
//     are asserted against each other by tools/playtest.mjs's @pointer/@motion suites.

const PAD = 12;
const MIN_CELL = 26;

// css/game.css tokens, spelled out for the canvas context.
const C = {
  face: '#171a20',
  line: '#2b3038',
  tile: '#dcd7ca',
  tile2: '#c7c1b2',
  digit: '#22262d',
  shade: '#101216',
  shadeDigit: '#4b5563',
  dot: '#7b8494',
  forced: 'rgba(120, 128, 143, 0.55)',
  rule1: '#d7695f',
  rule2: '#a98bd8',
  rule3: '#5fbccf',
  focus: '#86c7e0',
  win: '#57c98a',
  dim: '#9d9a93',
};
const MONO = 'ui-monospace, "SFMono-Regular", Menlo, monospace';

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function prefersReduced() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (err) {
    return false;
  }
}

const HINT_MS = 2400;

export function createView(canvas, handlers = {}) {
  // `willReadFrequently` because tools/playtest.mjs reads the bitmap back to prove a tap
  // actually paints and that each rule colour lands where the audit says it does; without the
  // hint Chrome logs a warning per readback, which would drown the console-clean assertion in
  // the browser gate.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let state = {
    n: 0, cells: [], marks: [], r1: [], r2: [], orphans: [], forced: [],
    cursor: -1, hint: -1, done: false,
  };
  let geom = { cell: MIN_CELL, x0: 0, y0: 0, w: 240, h: 240 };
  let hintUntil = 0;
  let raf = 0;
  let hintTimer = 0;
  let cssW = 0;
  let cssH = 0;

  // One source of truth for drawing and for hit testing: a square board, centred, cells as
  // large as the canvas box allows. Recomputed on every render, which is also how a rotation
  // or a panel reflow gets picked up.
  function layout() {
    const n = state.n || 4;
    cssW = Math.max(240, Math.round(canvas.clientWidth || canvas.getBoundingClientRect().width || 320));
    cssH = cssW;
    const cell = Math.max(MIN_CELL, Math.floor((cssW - 2 * PAD) / n));
    const grid = cell * n;
    geom = {
      cell,
      x0: Math.round((cssW - grid) / 2),
      y0: Math.round((cssH - grid) / 2),
      w: cssW,
      h: cssH,
      n,
    };
  }

  function measureBox() {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    // 显示盒子的"方"交给 CSS（`#board { width:100%; aspect-ratio:1/1 }`），这里只写位图尺寸。
    // 原来的 `canvas.style.height = ...` 是在 ResizeObserver 的回调里去改它自己观察的那个盒子：
    // 回调 → 盒子变 → 回调再进一次，Chromium 对这种"一帧内消化不完"的回路抛一条
    // "ResizeObserver loop completed with undelivered notifications."，它经 window 的 error 事件
    // 进入 js/main.js:909 的采集器，于是 `nothing threw` 那批断言在 GitHub runner 上红了 9 条
    // （本机 900×860 永远复现不出来——同一条 notice 只在忙机器上出现）。
    // 位图同值也跳过赋值：同值写入照样清空位图并重置上下文，而 draw() 之后有显式 clearRect。
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function rectOf(i) {
    const n = geom.n;
    const { cell, x0, y0 } = geom;
    return { x: x0 + (i % n) * cell, y: y0 + Math.floor(i / n) * cell, s: cell };
  }

  function centreOf(i) {
    const r = rectOf(i);
    return { x: r.x + r.s / 2, y: r.y + r.s / 2 };
  }

  function drawTile(i) {
    const r = rectOf(i);
    const inset = Math.max(1, Math.round(r.s * 0.04));
    const mark = state.marks[i] || 0;
    if (mark === 1) {
      // 涂黑: the cell is gone, so the digit recedes into the black rather than being erased —
      // a player has to be able to read back what they shaded.
      ctx.fillStyle = C.shade;
      roundRect(ctx, r.x + inset, r.y + inset, r.s - inset * 2, r.s - inset * 2, 3);
      ctx.fill();
      ctx.fillStyle = C.shadeDigit;
    } else {
      const g = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.s);
      g.addColorStop(0, C.tile);
      g.addColorStop(1, C.tile2);
      ctx.fillStyle = g;
      roundRect(ctx, r.x + inset, r.y + inset, r.s - inset * 2, r.s - inset * 2, 3);
      ctx.fill();
      ctx.fillStyle = C.digit;
    }
    ctx.font = `600 ${Math.max(11, Math.round(r.s * 0.44))}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(state.cells[i] ?? ''), r.x + r.s / 2, r.y + r.s / 2 + 1);

    if (mark === 2) {
      // 打点: "this one stays open", a circle drawn round the digit the way it is done on paper.
      ctx.strokeStyle = C.dot;
      ctx.lineWidth = Math.max(1.4, r.s * 0.055);
      ctx.beginPath();
      ctx.arc(r.x + r.s / 2, r.y + r.s / 2, r.s * 0.36, 0, Math.PI * 2);
      ctx.stroke();
    } else if (mark === 0 && state.forced.indexOf(i) >= 0) {
      // Rule 2 already decided this one may not be black. A faint dot in the corner: a hint
      // about what the rules already did, never an answer written in for the player.
      ctx.fillStyle = C.forced;
      ctx.beginPath();
      ctx.arc(r.x + r.s * 0.78, r.y + r.s * 0.22, Math.max(1.6, r.s * 0.07), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function outline(i, colour, dashed) {
    const r = rectOf(i);
    const inset = Math.max(2, Math.round(r.s * 0.08));
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(2, r.s * 0.06);
    if (dashed) ctx.setLineDash([4, 3]);
    roundRect(ctx, r.x + inset, r.y + inset, r.s - inset * 2, r.s - inset * 2, 3);
    ctx.stroke();
    ctx.restore();
  }

  function link(i, j, colour) {
    const a = centreOf(i);
    const b = centreOf(j);
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(2, geom.cell * 0.07);
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    layout();
    measureBox();
    const { w, h } = geom;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.face;
    roundRect(ctx, 0.5, 0.5, w - 1, h - 1, 8);
    ctx.fill();

    const n = geom.n;
    if (!state.cells.length) return;

    for (let i = 0; i < n * n; i++) drawTile(i);

    // grid lines last, so a violation ring never reads as a cell border
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    for (let k = 0; k <= n; k++) {
      ctx.beginPath();
      ctx.moveTo(geom.x0 + k * geom.cell + 0.5, geom.y0);
      ctx.lineTo(geom.x0 + k * geom.cell + 0.5, geom.y0 + n * geom.cell);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(geom.x0, geom.y0 + k * geom.cell + 0.5);
      ctx.lineTo(geom.x0 + n * geom.cell, geom.y0 + k * geom.cell + 0.5);
      ctx.stroke();
    }
    ctx.strokeStyle = state.done ? C.win : '#8d8672';
    ctx.lineWidth = 2;
    ctx.strokeRect(geom.x0 - 1, geom.y0 - 1, n * geom.cell + 2, n * geom.cell + 2);

    // One colour per rule number: 1 red, 2 violet, 3 cyan. Never shared, so a red ring can only
    // ever mean "two equal digits you both claimed open".
    for (const pair of state.r1) link(pair[0], pair[1], C.rule1);
    for (const pair of state.r1) outline(pair[0], C.rule1, false);
    for (const pair of state.r2) link(pair[0], pair[1], C.rule2);
    for (const pair of state.r2) outline(pair[0], C.rule2, false);
    for (const i of state.orphans) outline(i, C.rule3, true);

    if (state.cursor >= 0 && state.cursor < n * n) outline(state.cursor, C.focus, false);
    if (state.hint >= 0 && state.hint < n * n) {
      const t = prefersReduced() ? 0.5 : ((performance.now() % 1100) / 1100);
      const grow = (0.12 + t * 0.1) * geom.cell;
      const r = rectOf(state.hint);
      ctx.save();
      ctx.strokeStyle = C.focus;
      ctx.globalAlpha = prefersReduced() ? 0.95 : (0.95 - t * 0.5);
      ctx.lineWidth = 2.5;
      roundRect(ctx, r.x - grow, r.y - grow, r.s + grow * 2, r.s + grow * 2, 6);
      ctx.stroke();
      ctx.restore();
    }
  }

  function step() {
    if (state.hint < 0) return false;
    if (performance.now() < hintUntil) return true;
    state.hint = -1;
    return false;
  }

  function frame() {
    // Re-arming before deciding left this running forever: `step()` says when the pulse is over,
    // and the loop kept its next frame anyway, so animating() stayed true and a phone paid for
    // frames after the hint had expired. The last draw is not optional either — without it the
    // expired ring stays painted on a board that no longer has a hint.
    if (!step()) {
      raf = 0;
      draw();
      return;
    }
    raf = requestAnimationFrame(frame);
    draw();
  }

  function startLoop() {
    if (raf || prefersReduced()) return; // a still image is the same information, less motion
    raf = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function render(next) {
    state = Object.assign({}, state, next || {});
    draw();
  }

  // client pixels -> cell index, -1 for a gutter or a margin (costs nothing, changes nothing)
  function hit(clientX, clientY) {
    if (!state.n) return -1;
    const box = canvas.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    const { cell, x0, y0 } = geom;
    const cx = Math.floor((x - x0) / cell);
    const cy = Math.floor((y - y0) / cell);
    if (cx < 0 || cy < 0 || cx >= state.n || cy >= state.n) return -1;
    return cy * state.n + cx;
  }

  // ...and the reverse: client coordinates of a cell centre, which is what
  // `Input.dispatchMouseEvent` wants. `inside` lets a test aim deliberately at nothing.
  function point(i) {
    if (i < 0 || i >= state.n * state.n) return null;
    const box = canvas.getBoundingClientRect();
    const c = centreOf(i);
    return { x: Math.round(box.left + c.x), y: Math.round(box.top + c.y), i };
  }

  function onTap(ev) {
    const i = hit(ev.clientX, ev.clientY);
    if (handlers.tap) handlers.tap(i, ev);
  }

  canvas.addEventListener('pointerdown', onTap);
  window.addEventListener('resize', () => render());

  // The canvas box is decided by CSS and a `window` resize does not always follow it (a phone
  // rotating, the panel reflowing, a devtools split). The hit test maps client pixels through
  // geometry measured from that box, so measuring late means tapping the wrong cell. Guarded,
  // because `node --check` also loads this file.
  if (typeof ResizeObserver === 'function') {
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) { first = false; return; } // the initial callback is the layout we already measured
      render();
    });
    ro.observe(canvas);
  }

  return {
    render,
    draw,
    hit,
    point,
    onTapEvent: onTap,
    layout: () => ({ ...geom }),
    showHint(i) {
      state.hint = i;
      hintUntil = performance.now() + HINT_MS;
      draw();
      startLoop();
      clearTimeout(hintTimer);
      hintTimer = 0;
      // Under 减少动态效果 startLoop() declines to run, so nothing is left to notice the deadline —
      // the still path has to expire the highlight on the same clock by itself. Otherwise "less
      // motion" silently means "this cell is ringed forever", which is different information.
      if (!raf) hintTimer = setTimeout(() => {
        hintTimer = 0;
        if (state.hint !== i) return;
        state.hint = -1;
        draw();
      }, HINT_MS);
    },
    clearHint() {
      clearTimeout(hintTimer);
      hintTimer = 0;
      stopLoop();
      state.hint = -1;
    },
    // What the bitmap actually says about one cell: mean luminance plus the three rule hues.
    // The box deliberately covers almost the whole cell, because a violation ring is drawn at the
    // cell edge and a rule-3 orphan is marked only by that ring — sampling the middle alone would
    // read "no cyan" on a cell the audit calls an orphan.
    sample(i) {
      const r = rectOf(i);
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const x = Math.round((r.x + r.s * 0.05) * dpr);
      const y = Math.round((r.y + r.s * 0.05) * dpr);
      const w = Math.max(1, Math.round(r.s * 0.9 * dpr));
      const d = ctx.getImageData(x, y, w, w).data;
      let lum = 0; let red = 0; let vio = 0; let cya = 0; let dark = 0;
      for (let k = 0; k < d.length; k += 4) {
        const cr = d[k]; const cg = d[k + 1]; const cb = d[k + 2];
        lum += (cr * 3 + cg * 4 + cb) / 8;
        if (cr > 150 && cg < 130 && cb < 130) red++;
        if (cr > 130 && cb > 170 && cg < 160) vio++;
        if (cb > 170 && cg > 140 && cr < 140) cya++;
        if ((cr * 3 + cg * 4 + cb) / 8 < 60) dark++;
      }
      const px = d.length / 4;
      return {
        lum: Math.round(lum / px),
        red: Math.round(red / px * 100),
        violet: Math.round(vio / px * 100),
        cyan: Math.round(cya / px * 100),
        dark: Math.round(dark / px * 100),
      };
    },
    pixelsHash() {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i + 2 < d.length; i += 4 * 617) sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) % 2147483647;
      return sum;
    },
    painted() {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++;
      return n;
    },
    animating() { return !!raf; },
    reducedMotion: prefersReduced,
    get state() { return state; },
    get size() { return { cssW, cssH, cell: geom.cell }; },
    destroy() {
      stopLoop();
      clearTimeout(hintTimer);
      hintTimer = 0;
      canvas.removeEventListener('pointerdown', onTap);
    },
  };
}
