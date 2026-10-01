// 一乘 · 抽刀断水 — offline shell.
//
// 口径只有一条：**同源子资源一律网络优先，网络失败才退缓存**。
// 手写的 VERSION 号 + cache-first 会把 js/css 永久钉死在旧版：出新 HTML 配旧 view.js，
// 页面看起来"偶尔不对"，而任何静态检查看得出来的一切都是绿的。VERSION 在这里只用来
// 分代清理旧缓存，不用来决定要不要问网络。
//
// file:// 下这段整体不执行（js/pwa.js 里挡），注册失败也从不抛到页面上去。

const VERSION = 'hitori-v1';
const SHELL = [
  './',
  './index.html',
  './css/game.css',
  './js/main.js',
  './manifest.webmanifest',
];
const ASSETS = [
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './assets/img/tile-paper.png',
  './assets/img/tile-ink.png',
  './assets/img/board-table.png',
  './assets/img/ripple.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // 逐条 add 而不是一把 addAll：一条 404 会让整个 install 失败，于是这个版本永远装不上，
    // 而 404 的往往正是某一条资产路径——宁可留下"这条没缓存"，不要"什么都缓存不了"。
    const all = SHELL.concat(ASSETS);
    const failed = [];
    for (const url of all) {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        failed.push(url);
      }
    }
    self.__shellFailures = failed;
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function sameOrigin(url) {
  try {
    return new URL(url, self.location).origin === self.location.origin;
  } catch (err) {
    return false;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !sameOrigin(req.url)) return;
  const url = new URL(req.url);
  // 数据请求（POST 分享、api）与跨源一律不碰；这里只管同源 GET。
  if (url.pathname.endsWith('/sw.js')) return;
  event.respondWith((async () => {
    let fresh = null;
    try {
      fresh = await fetch(req);
    } catch (err) {
      fresh = null; // 离线，或者服务器拒了 —— 下面退缓存
    }
    if (fresh && fresh.ok) {
      const cache = await caches.open(VERSION);
      await cache.put(req, fresh.clone());
      return fresh;
    }
    if (fresh) return fresh; // 404/500 也照原样交给页面，别拿缓存冒充 200
    const hit = await caches.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    return new Response('离线，且这一条没有缓存：' + url.pathname, {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  })());
});
