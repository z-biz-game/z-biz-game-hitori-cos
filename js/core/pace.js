// The animation clock, kept out of the view so a node test can drive it at 30, 60 and 120 Hz.
//
// Why a module and not a line in js/view.js: the old pulse read `performance.now() % 1100`, which
// is wall-clock — so it was already frame-rate *independent*, but it was wrong in a different way.
// A sawtooth on absolute time starts mid-cycle, so pressing 提示 jumped the ring to a random size
// and alpha, and the wrap made it snap back every 1.1 s. The fix is a clock that *accumulates the
// frame interval* from the moment the animation began: `dt = now - last`, summed. Then the phase
// is a function of "how long has this hint been on screen", which is what the player is reading.
//
// Two properties, both assertable without a browser:
//   * rate independence — after the same amount of wall time, `elapsed` is the same number of
//     milliseconds whether frames arrived every 33.3 ms or every 8.3 ms;
//   * hitch resistance — one `MAX_FRAME_MS` clamp per tick, so a backgrounded tab that comes back
//     with a 4-second gap animates a frame's worth of motion instead of teleporting the ring.
//     The clamp is only for hitches: 120 Hz is 8.3 ms and 30 Hz is 33.3 ms, both far under it.

export const MAX_FRAME_MS = 100;

export function createPace() {
  let last = -1;
  let elapsed = 0;
  let frames = 0;
  let clamped = 0;
  let dt = 0;

  return {
    // `now` is a millisecond timestamp — the one requestAnimationFrame hands you, or
    // performance.now(). The first tick establishes the origin and reports dt 0.
    tick(now) {
      const t = Number(now);
      if (!Number.isFinite(t)) return { dt: 0, elapsed, frames, clamped };
      if (last < 0) {
        last = t;
        dt = 0;
      } else {
        let delta = t - last; // 帧间隔：这一帧走了多少毫秒，全部积分由它算
        last = t;
        if (!(delta > 0)) delta = 0; // a clock that went backwards (or a duplicate ts) costs nothing
        if (delta > MAX_FRAME_MS) {
          clamped += 1;
          delta = MAX_FRAME_MS;
        }
        dt = delta;
      }
      elapsed += dt;
      frames += 1;
      return { dt, elapsed, frames, clamped };
    },
    reset() {
      last = -1;
      elapsed = 0;
      frames = 0;
      clamped = 0;
      dt = 0;
    },
    get elapsed() { return elapsed; },
    get dt() { return dt; },
    get frames() { return frames; },
    get clamped() { return clamped; },
  };
}

// 0..1 around a period, from the integrated clock (never from absolute time — see above).
export function phase(ms, periodMs) {
  if (!(periodMs > 0)) return 0;
  const p = (ms % periodMs) / periodMs;
  return p < 0 ? p + 1 : p;
}

// A round trip 0 → 1 → 0 with no snap at the seam, which is what a breathing ring needs; the raw
// sawtooth is what made the old one jump.
export function breath(p) {
  return (1 - Math.cos(p * Math.PI * 2)) / 2;
}

// 0 → 1 over `totalMs`, clamped at both ends: for a one-shot (a ring that expands and stops).
export function progress(ms, totalMs) {
  if (!(totalMs > 0)) return 1;
  return Math.max(0, Math.min(1, ms / totalMs));
}

export function easeOut(p) {
  return 1 - Math.pow(1 - Math.max(0, Math.min(1, p)), 3);
}
