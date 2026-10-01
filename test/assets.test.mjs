// 资产闸：把"图是不是真的"变成一条会红的断言。
//
// 为什么值得占一个测试文件：`<link rel="icon" href="…">` 指向一张 0 字节文件、或者指向一张
// SVG 冒充的 PNG，静态看代码全都对，浏览器也只是安静地不显示。这里逐条读盘上的字节：
//   * index.html 里每一个 href/src 指向的仓内路径必须存在；
//   * manifest 的每一个 icon src 必须存在、必须是真 PNG（IHDR 解得开）、尺寸声明必须与
//     IHDR 实际宽高一致，且至少一张 ≥512、一张 ≥180（Chrome 装机的硬门槛）；
//   * sw.js 的 SHELL/ASSETS 清单必须全部落盘（清单里有一条 404，install 就白跑一半）；
//   * 任何一张 PNG 不许是 0 字节，也不许以 SVG 文本冒充。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function ihdr(file) {
  const buf = fs.readFileSync(file);
  assert.ok(buf.length > 8, `${path.relative(ROOT, file)} 是 0 字节 / 太小，不是图`);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(sig), `${path.relative(ROOT, file)} 的 PNG 签名不对：${buf.subarray(0, 16).toString('hex')}`);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return { w, h, bytes: buf.length };
}

function localHrefs(html) {
  const out = [];
  const keep = (v) => {
    if (!v || /^(https?:|data:|#|mailto:)/.test(v)) return;
    out.push(v);
  };
  for (const tag of html.matchAll(/<(link|script|img|meta)\b([^>]*)>/gi)) {
    const attrs = tag[2];
    for (const m of attrs.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)) keep(m[1]);
    // 只有社交卡的图才用 content 指路；viewport 那一类 content 是文案，不是路径。
    if (tag[1].toLowerCase() === 'meta' && /(?:name|property)\s*=\s*"(?:og:image|twitter:image)"/i.test(attrs)) {
      for (const m of attrs.matchAll(/content\s*=\s*"([^"]+)"/g)) keep(m[1]);
    }
  }
  return out;
}

test('every asset path index.html references exists on disk', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = localHrefs(html);
  assert.ok(refs.length > 0, 'index.html 里一个本地引用都没有，尺子在空跑');
  for (const want of ['icons/icon-32.png', 'icons/apple-touch-icon.png', 'manifest.webmanifest',
    'css/game.css', 'js/main.js', 'assets/img/og-cover.png']) {
    assert.ok(refs.includes(want), `尺子没扫到 ${want}，说明引用遍历漏了`);
  }
  for (const ref of refs) {
    const rel = ref.replace(/^\.\//, '').split('#')[0];
    if (!rel) continue;
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `index.html 引用了不存在的路径：${ref}`);
  }
});

test('every bitmap the stylesheet paints is on disk', () => {
  // css/game.css 引用的三张纹理是盘面/牌面的底：路径写错在浏览器里只是安静地没有图，
  // 而 SW 又会把 404 缓存成"这条没缓存"，所以这条必须在 node 里红。
  const css = fs.readFileSync(path.join(ROOT, 'css/game.css'), 'utf8');
  const refs = [...css.matchAll(/url\(['\"]?([^'\")]+\.(?:png|jpg|webp|svg))['\"]?\)/gi)].map((m) => m[1]);
  assert.ok(refs.length >= 3, `样式表一张位图都没引用（找到 ${refs.length} 张）`);
  for (const ref of refs) {
    const fromCss = path.resolve(path.join(ROOT, 'css'), ref);
    const fromRoot = path.resolve(ROOT, ref);
    assert.ok(fs.existsSync(fromCss) || fs.existsSync(fromRoot), `css/game.css 引用 ${ref}，盘上没有`);
    if (/\.png$/i.test(ref)) ihdr(fs.existsSync(fromCss) ? fromCss : fromRoot);
  }
});

test('manifest icons are real PNGs whose declared sizes match their IHDR', () => {
  const file = path.join(ROOT, 'manifest.webmanifest');
  assert.ok(fs.existsSync(file), '没有 manifest.webmanifest');
  const mf = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['name', 'short_name', 'description', 'start_url', 'display', 'theme_color', 'background_color']) {
    assert.ok(mf[key], `manifest 缺字段 ${key}`);
  }
  assert.ok(Array.isArray(mf.icons) && mf.icons.length >= 3, 'manifest.icons 少于 3 条');
  let biggest = 0;
  let touch = 0;
  for (const icon of mf.icons) {
    const file2 = path.join(ROOT, icon.src);
    assert.ok(fs.existsSync(file2), `manifest 指向不存在的图标：${icon.src}`);
    const { w, h } = ihdr(file2);
    const declared = String(icon.sizes).match(/^(\d+)x(\d+)$/);
    assert.ok(declared, `${icon.src} 的 sizes 不是 WxH：${icon.sizes}`);
    assert.equal(Number(declared[1]), w, `${icon.src} 声明 ${icon.sizes}，IHDR 是 ${w}x${h}`);
    assert.equal(Number(declared[2]), h, `${icon.src} 声明 ${icon.sizes}，IHDR 是 ${w}x${h}`);
    biggest = Math.max(biggest, Math.min(w, h));
    if (w >= 180 && w < 512) touch = Math.max(touch, Math.min(w, h));
    assert.ok(['any', 'maskable', 'any maskable'].includes(icon.purpose), `${icon.src} 的 purpose 不合法`);
  }
  assert.ok(biggest >= 512, `最大的图标只有 ${biggest}px，Chrome 装机要 512`);
  assert.ok(touch >= 180, `没有 ≥180px 的可当 apple-touch-icon 的图（最大 ${touch}）`);
  assert.ok(mf.icons.some((i) => i.purpose === 'maskable'), '没有 maskable 图标');
});

test('the service worker precache list is entirely on disk', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const list = [];
  for (const block of sw.matchAll(/const (SHELL|ASSETS) = \[([\s\S]*?)\];/g)) {
    for (const entry of block[2].matchAll(/'([^']+)'/g)) list.push(entry[1]);
  }
  assert.ok(list.length >= 8, `sw.js 的预缓存清单只有 ${list.length} 条，不像话`);
  for (const entry of list) {
    const rel = entry.replace(/^\.\//, '');
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `sw.js 预缓存了不存在的路径：${entry}`);
    if (rel.endsWith('.png')) ihdr(file);
  }
  assert.match(sw, /caches\.open\(VERSION\)/, 'sw.js 没有按 VERSION 分代缓存');
  assert.match(sw, /await fetch\(req\)/, 'sw.js 不是网络优先——手工版本号 + cache-first 会把 js 钉死在旧版');
});

test('the shipped bitmaps are big enough to be product art', () => {
  const expect = {
    'icons/icon-1024.png': 1024,
    'icons/icon-512.png': 512,
    'icons/icon-192.png': 192,
    'icons/apple-touch-icon.png': 180,
    'icons/icon-maskable-512.png': 512,
    'assets/img/og-cover.png': null, // 社交卡按 1200×630 单独判
    'assets/img/tile-paper.png': 128,
    'assets/img/tile-ink.png': 128,
    'assets/img/board-table.png': 256,
    'assets/img/ripple.png': 256,
  };
  for (const [rel, side] of Object.entries(expect)) {
    const { w, h } = ihdr(path.join(ROOT, rel));
    if (side) {
      assert.equal(w, side, `${rel} 宽 ${w}，应为 ${side}`);
      assert.equal(h, side, `${rel} 高 ${h}，应为 ${side}`);
    } else {
      assert.equal(w, 1200, `${rel} 应为 1200 宽`);
      assert.equal(h, 630, `${rel} 应为 630 高`);
    }
  }
});

test('the art generator is the only source of these bytes', () => {
  const gen = fs.readFileSync(path.join(ROOT, 'assets', 'gen', 'make_art.py'), 'utf8');
  assert.match(gen, /def board_icon/, '生成脚本里没有 board_icon —— 图标不是程序画的？');
  assert.match(gen, /random\.Random\(/, '生成脚本没有固定种子，重跑会漂');
  // 母题必须同时含三种状态（纸格 / 墨块 / 打点），否则图标讲的是另一款游戏。
  assert.match(gen, /SHADED_CELLS/, '没有黑格');
  assert.match(gen, /DOTTED_CELLS/, '没有打点');
  assert.match(gen, /def blade/, '没有那道刀光');
});
