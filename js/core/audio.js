// Sound. One AudioContext, created lazily on the first gesture, and a mute that is not a lie.
//
// What "真静音" means here, because the cheap version is a trap: setting the master gain to 0 is
// still mixing — the context keeps running, oscillators keep being allocated, and a phone keeps
// paying for a sound nobody can hear. So while muted:
//
//   * `voices()` proves nothing new is scheduled: every emitter returns 0 before touching
//     `createOscillator`, and the refusal is counted in `blocked()` instead;
//   * the context itself is `suspend()`ed, so the audio thread stops;
//   * unmuting `resume()`s it and the next tap is the first sound again.
//
// The counters exist so a test can assert the behaviour rather than the string: `node --check`
// cannot tell a mute from a gain node, and neither can a screenshot.
//
// Pure module: no DOM at import time, and node (no AudioContext) degrades to a silent no-op —
// that is what keeps js/core/* importable by the load sweep and the unit suites.

const NOTES = {
  shade: [{ f: 190, to: 92, d: 0.11, type: 'sine', g: 0.5 }],
  dot: [{ f: 640, to: 610, d: 0.055, type: 'triangle', g: 0.28 }],
  clear: [{ f: 330, to: 300, d: 0.06, type: 'sine', g: 0.22 }],
  clash: [{ f: 220, to: 205, d: 0.16, type: 'sawtooth', g: 0.2 },
    { f: 233, to: 214, d: 0.16, type: 'sawtooth', g: 0.14, at: 0.02 }],
  hint: [{ f: 880, to: 870, d: 0.09, type: 'sine', g: 0.2 }],
  // 五声音阶下行：水被切开之后合上。
  win: [{ f: 880, to: 872, d: 0.16, g: 0.26 }, { f: 784, to: 776, d: 0.16, g: 0.24, at: 0.1 },
    { f: 659, to: 652, d: 0.18, g: 0.22, at: 0.2 }, { f: 587, to: 580, d: 0.22, g: 0.2, at: 0.3 },
    { f: 440, to: 434, d: 0.42, g: 0.24, at: 0.42 }],
  undo: [{ f: 420, to: 470, d: 0.07, type: 'sine', g: 0.2 }],
};

export function createAudio(global = typeof globalThis !== 'undefined' ? globalThis : {}) {
  const AC = global.AudioContext || global.webkitAudioContext || null;
  let ctx = null;
  let master = null;
  let muted = false;
  let voices = 0;
  let blocked = 0;
  let suspended = false;

  function supported() {
    return !!AC;
  }

  // Only ever called from a gesture path (a tap, a key, a button): a context built before the
  // first user action starts *suspended* in every real browser and would queue sounds forever.
  function ensure() {
    if (muted) {
      blocked += 1;
      return null;
    }
    if (!AC) return null;
    if (!ctx) {
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
      } catch (err) {
        ctx = null;
        blocked += 1;
        return null;
      }
    }
    if (ctx.state === 'suspended' && !suspended) {
      // A browser (or an interrupted phone call) paused it; only our own mute may keep it down.
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
    return ctx;
  }

  function play(spec) {
    const c = ensure();
    if (!c) return 0;
    const t0 = c.currentTime + (spec.at || 0);
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = spec.type || 'sine';
    osc.frequency.setValueAtTime(spec.f, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, spec.to || spec.f), t0 + spec.d);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(spec.g || 0.25, t0 + Math.min(0.02, spec.d * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.d);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + spec.d + 0.02);
    voices += 1;
    return 1;
  }

  function emit(name) {
    const spec = NOTES[name];
    if (!spec) return 0;
    let n = 0;
    for (const s of spec) n += play(s);
    return n;
  }

  return {
    supported,
    tap(mark) {
      return emit(mark === 1 ? 'shade' : mark === 2 ? 'dot' : 'clear');
    },
    clash() { return emit('clash'); },
    hint() { return emit('hint'); },
    undo() { return emit('undo'); },
    win() { return emit('win'); },

    // The mute itself: no new oscillator, and the thread goes quiet.
    setMuted(next) {
      muted = !!next;
      if (muted) {
        if (ctx && ctx.state === 'running') {
          suspended = true;
          const p = ctx.suspend();
          if (p && p.catch) p.catch(() => {});
        }
      } else if (ctx) {
        suspended = false;
        const p = ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
      return muted;
    },
    muted: () => muted,
    // 暂停不是静音：声音要真的停下来，但恢复后仍然有声。
    suspend() {
      if (!ctx || ctx.state !== 'running') return false;
      suspended = true;
      const p = ctx.suspend();
      if (p && p.catch) p.catch(() => {});
      return true;
    },
    resume() {
      if (!ctx || muted) return false;
      suspended = false;
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {});
      return true;
    },
    // What a gate asserts on: allocation counts, not intentions.
    stats: () => ({ supported: !!AC, hasContext: !!ctx, state: ctx ? ctx.state : 'none', voices, blocked, muted }),
    reset: () => { voices = 0; blocked = 0; },
  };
}
