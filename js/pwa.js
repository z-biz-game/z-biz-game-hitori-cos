// Service-worker registration, kept out of index.html so the load sweep (which executes the
// module entry in node with DOM stubs) actually sees it run.
//
// Two rules this file exists to enforce:
//
//   * file:// never registers. A SW has no origin to scope to there, Chrome rejects it, and the
//     rejection used to surface as an uncaught error on the console — which is exactly what the
//     browser gate treats as a failure.
//   * a failed registration is a *degradation*, not an error. Offline stops working; the game
//     does not.
//
// The URL is resolved against `import.meta.url`, not against the document: Pages serves this repo
// under /z-biz-game-hitori-cos/, and a root-relative '/sw.js' 404s there while it works locally —
// the exact shape of bug this repo already got bitten by once.
export function registerServiceWorker() {
  const info = { registered: false, reason: '', scope: '' };
  try {
    if (typeof location === 'undefined' || location.protocol === 'file:') {
      info.reason = 'file://';
      return info;
    }
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      info.reason = 'unsupported';
      return info;
    }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      info.reason = 'insecure-context';
      return info;
    }
    const url = new URL('../sw.js', import.meta.url);
    navigator.serviceWorker.register(url.href, { scope: new URL('./', url).href })
      .then((reg) => { info.registered = true; info.scope = reg.scope; })
      .catch(() => { info.reason = 'rejected'; });
    info.reason = 'pending';
  } catch (err) {
    info.reason = 'threw';
  }
  return info;
}
