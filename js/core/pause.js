// 暂停的那只表，和唯一的那道门。
//
// 为什么它住在 core 而不是留在 js/main.js：这个仓里只有「暂停」这一件事的正确性**关于时间**，
// 而关于时间的东西若只写在壳里，就只能靠眼睛看——没法在 node 里断言，因为壳要 DOM。
// 所以状态机（openedAt / paused / pauseStarted / pausedFor）与算术（表上被摘掉多少毫秒）
// 搬进这里，**时钟是注入的**：页面递进来 Date.now，node 套件递进来一只假表，自己手动摇。
// 于是「暂停真停表」这件事第一次可以在 node 里被量，而不是被相信。
//
// 三条性质，每一条都能在 node 里断言（test/pause.test.mjs 就是这三条的尺子）：
//
//   1. 暂停期间计时不前进。elapsedMs() = now − openedAt − pausedMs()，而 pausedMs() 里含着
//      **正在进行的那一段**暂停（实时算），所以暂停期间 elapsedMs() 是一个常数，与墙上时间无关。
//   2. 暂停期间输入被拒。blocked() 是唯一的那道门：壳在每一次改动盘面之前都问它，
//      问到了「已暂停」就直接返回，动词（tap / undo / 提示）根本没有机会被调用。
//   3. 恢复后接着走。resume() 把结束的那一段暂停**记进** pausedFor（只记一次），
//      于是恢复后表接着走：暂停前用掉的不丢，暂停的那段一秒也不算。
//
// 三个键名（`hitori.save.v1` / `hitori.resume.v1` / `hitori.settings.v1`）与本模块无关：
// 暂停不落盘——关掉页面再回来，那一盘是从续局键接着的，不是从暂停接着的。

// 门上的话：壳原来分三处各写一句，措辞不同但意思一样。这里收成一处，
// 键是动作名（tap / undo / hint / restart），值是给玩家看的那句话。
export const PAUSE_WORDS = {
  tap: '已暂停：按「继续」或 P 再落子',
  undo: '已暂停：按「继续」或 P 再回退',
  hint: '已暂停：先按「继续」或 P 再问题',
  restart: '已暂停：按「继续」或 P 再重开',
};

// `now` 是注入的时钟（毫秒）。默认那一只是真的 Date.now；测试递进来的是假表。
export function createPauseClock({ now = () => Date.now() } = {}) {
  let openedAt = now();
  let paused = false;
  let pauseStarted = 0;
  let pausedFor = 0; // ms taken out of the clock since the board opened

  const clock = {
    get openedAt() { return openedAt; },
    get paused() { return paused; },
    get pauseStarted() { return pauseStarted; },
    get pausedFor() { return pausedFor; },

    // 新的盘：计时从 0 开始，暂停欠账一笔勾销（「一盘新的一局」不是「接着上一局算」）。
    open() {
      openedAt = now();
      paused = false;
      pauseStarted = 0;
      pausedFor = 0;
      return clock;
    },

    // 按下暂停：记下这一刻。表从这里开始不走。
    pause() {
      if (paused) return false;
      paused = true;
      pauseStarted = now();
      return true;
    },

    // 恢复：把刚才那一段从表上摘掉（只摘一次），表从这一刻接着走。
    resume() {
      if (!paused) return false;
      pausedFor += Math.max(0, now() - pauseStarted);
      pauseStarted = 0;
      paused = false;
      return true;
    },

    // 表上被摘掉的毫秒：已经结束的那几段，加上正在进行的那一段（实时算，所以暂停中它也在长）。
    pausedMs() {
      return pausedFor + (paused ? Math.max(0, now() - pauseStarted) : 0);
    },

    // 玩家真的花在这盘上的时间。暂停期间它是一个常数：now 涨多少，pausedMs() 就涨多少。
    elapsedMs() {
      return Math.max(0, now() - openedAt - clock.pausedMs());
    },

    elapsed() {
      return Math.floor(clock.elapsedMs() / 1000);
    },

    // 唯一的那道门。返回空串 = 放行；返回一句话 = 这次动作被暂停挡住，壳要把这句话说给玩家听。
    blocked(action) {
      if (!paused) return '';
      return PAUSE_WORDS[action] || '已暂停：按「继续」或 P 再继续';
    },
  };

  return clock;
}
