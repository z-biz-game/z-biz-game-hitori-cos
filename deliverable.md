# 一乘 · 抽刀断水 HITORI — 交付报告

## 摘要

| 字段 | 值 |
|---|---|
| **App 名称** | 一乘 · 抽刀断水 HITORI |
| 英文名 / 路由 | HITORI · `#/menu`、`#/campaign`、`#/daily`、`#/lot/<id>`、`#/random/<tier>/<seed>` |
| 玩法一句话 | 每格三态循环（未涂 → 涂黑 → 打点 → 未涂）：每行每列不得留下两个相等的未涂数字，涂黑格不得正交相邻，未涂格必须连成一片 |
| 难度口径 | 唯一解由两套互不相干的代码在烘焙期逐格复核；难度栏印的是实测的「推理枯竭次数」，不是形容词 |
| 测试钩子 | `window.hitori`（`version` `engine` `lots` `tiers` `tap` `undo` `reset` `pause` `mute` `toggleFullscreen` `fullscreen` `learn` `audio` `hint` `logic` `solutionMarks` `point` `hit` `sample` `pixels` `layout` `reducedMotion` `animating` `pulse` `readout` `rules` `save` `resume` `decode` `wipe`） |
| 关卡 | 40 盘（4 档 × 10：nook / quiet / study / retreat，题面 4×4 / 5×5 / 6×6），`js/data/lots.js`，构建期由 `tools/bake.mjs` 生成并三路复证 |
| 依赖 | `dependencies` 0 个、`devDependencies` 0 个（`node -e` 实测，见下） |
| 二进制资产 | 17 张位图（`icons/` 10 + `assets/img/` 7），无音频、无字体 |
| node 断言 | 87 条，9 个套件，fail 0（另有文档腿 `tools/doctest.mjs` 154 项 fail 0；破坏试验台账 9 把刀逐把点名变红） |
| 浏览器断言 | 196 条，9 段（@boot 24 / @taps 20 / @rules 25 / @logic 16 / @routes 23 / @save 23 / @reloaded 17 / @motion 11 / @pointer 37），fail 0 |
| 验收命令 | `npm run check` · `npm test` · `node tools/doctest.mjs` · `node tools/sabotage.mjs` · `node tools/deploy-set.mjs` · `bash tools/verify.sh` |

依赖与资产的机器可判定检查（等价于组织审计里的两行）：

```bash
$ node -e 'const p=require("./package.json");const d=p.dependencies||{},v=p.devDependencies||{};
  process.stdout.write(Object.keys(d).length+Object.keys(v).length===0?"ok":JSON.stringify({d,v}))'
ok
$ git ls-files | grep -cE '\.(png|jpg|jpeg|mp3|wav|woff2?|ttf|svg)$'
17
```

---

## 基线 → 本次提交

| | 提交 | 说明 |
|---|---|---|
| 基线 | `17ca4fc` | 「merge: 有机并线（两侧内容合入；重叠块按最新权威裁，非重叠两侧都留）」 |
| 本次修复 | `ed845ce` | 修并线造成的硬伤 + 把文档/闸的实数钉跟到实数 |
| 本交付物 | 本文件所在提交 | 只增这一个文件 |

并线把两侧拼在一起时留了 7 处硬伤。这轮把它们逐条收掉，并把并线带进来的文档/闸失配一并对齐。

---

## 改动表：旧代码错在哪 → 新代码为什么对

| # | 旧代码错在哪 | 新代码为什么对 |
|---|---|---|
| 1 | `js/main.js` 里两份 `toggleFullscreen`（第 864 行无参版、第 1344 行带 `root` 版）。**ES module 的顶层作用域里同名函数声明是 SyntaxError**，实测 `node --check` 直接报 `Identifier 'toggleFullscreen' has already been declared` ⇒ 整个 `js/main.js` 根本不加载 ⇒ 页面只剩一个空壳，**整局不可玩** | 删掉无参那份，只留带 `root` 的一份，并给它一个默认值 `root = fsRoot()`。能力取两边并集：三套 API 前缀的探测（`fsRequest`）、Esc 退出后的状态回写（`fullscreenchange`）、以及两句「为什么没成」的话（按不动的按钮要说话，不能悄悄什么都不发生） |
| 2 | 接线重复：`el.fullscreen.addEventListener('click', () => toggleFullscreen())` 与文件末尾 `bindFullscreen` 各接一次，键盘 `f` 也接了两次 ⇒ 一次点击进出各一次，**净效果是「按了没反应」** | 接线只留 `bindFullscreen` 一处；点击与 `f` 键都走它。`window.hitori.toggleFullscreen` 改成 `() => toggleFullscreen(fsRoot())`，测试桥与按钮走同一条路 |
| 3 | 页面有**两颗全屏按钮**：导航里 `#btn-fullscreen`、HUD 里 `#fullscreen`。导航那颗归路由管，HUD 那颗与静音、玩法并排——同一件事两个入口 | 删掉导航那颗（`index.html` 的 nav 里现在只有 战役 / 今日 / 随机），`bootFullscreen()` 改从 `el` 表取按钮。`el` 表是这张页面的 id 唯一清单，从表里取就不会再绑到一颗不存在的按钮上 |
| 4 | `js/core/storage.js` 读档那行是 `raw = ls && globalThis.localStorage.getItem(KEY);` —— `ls` 在这个作用域**根本没有定义** ⇒ 每次读档先抛一次 ReferenceError，又被这行 try/catch 吞掉 ⇒ `raw` 恒为 null ⇒ **每次读档都当空档**，玩家存的纪录被一次又一次清空 | 换回本地侧那套两段式解码（`cleanRecord` / `cleanRecords` / `cleanDaily` / `cleanStats` / `decode`），版本门折进 `decode`（缺 `v` 的老档照读），`load()` 改回 `storage() ? localStorage.getItem(KEY) : null` |
| 5 | `index.html` 的 `<head>` 拼了两份（远端那份带绝对 URL 的 `og:image` 与 `twitter:card=summary`，本地那份带图标 / apple-touch-icon / manifest / 移动端 meta）；`manifest.webmanifest` 与 `sw.js` 也各拼两份 | `<head>` 整份取本地侧那一份（图标、manifest、`og:*`、`twitter:*` 都齐），`og:image` 用**绝对 URL** 指向 `assets/img/og-cover.png`（部署集闸 R7 要求绝对 URL 且那张图在产物里），`twitter:image` 保持**相对** `assets/img/og-cover.png`（这样资产闸的本地引用遍历才扫得到它）。`manifest.webmanifest` 与 `sw.js` 整份取本地侧（清单完整：4 个带 `purpose` 的图标、5 条 SHELL + 7 条 ASSETS 预缓存） |
| 6 | `test/` 里四个 `node:test` 套件（assets / audio / pace / storage）用 node 自带的 TAP 输出，**不打印仓内约定的那一行 `rows: N fail: M`** ⇒ 文档里的「M 条断言」只数到一半的套件（5 个套件 66 条，实际是 9 个套件 87 条） | `tools/harness.mjs` 加一个 `tapSuite(nodeTest, after)` 适配器，把两族接到同一行上（条数口径不变：一条 `test()` 算一条断言）。文档与闸的实数钉随实数走：套件数 5→9、引擎断言 66→87 条 |
| 7 | `package.json` 的 `"test": "node --test test/"` 在 Node 22 上把 `test/` 当**模块**执行 ⇒ `MODULE_NOT_FOUND` ⇒ `npm test` 一步就红，而 `.github/workflows/ci.yml` 第 29 行正是跑 `npm test` ⇒ CI 是红的 | 改成 `"test": "npm run unit"`（仓里本来就有的那条逐文件跑法，`tools/verify.sh` 走的就是它）。一条命令一个结论，且与闸同一条路 |

### 改钉一览（钉的是实数，强度不变）

| 钉 | 旧 | 新 | 为什么变 |
|---|---|---|---|
| `tools/deploy-set.mjs` `EXPECT_CHECKS` | 28 | 50 | head / manifest / sw.js 换成完整那份后，被检查的仓内路径从 35 条变成 50 条 |
| `tools/deploy-set.mjs` `EXPECT_ROWS` | 47 | 72 | 同上，闸自己跑的断言条数 |
| `tools/doctest.mjs` 套件数 | 5 | 9 | 并线带进来 4 个 `node:test` 套件 |
| `tools/doctest.mjs` `test/` 目录 `.mjs` 数 | 6 | 10 | 9 个套件 + `fixtures.mjs` |
| `tools/doctest.mjs` localStorage 键数 | 2 | 3 | 并线带进来的静音持久化 `hitori.settings.v1` 是真实功能（远端侧根本没有声音子系统） |
| `DESIGN.md` 行号锚点 | `css/game.css:57` | `css/game.css:83` | `.menu { display: grid; … }` 那行真的挪了（并线把 CSS 块拼了两份） |

闸的**断言一条没改、强度一条没降**：D4a 仍然要求「每个套件这一趟全绿且报出自己的条数」，D4b 仍然要求「文档写的套件数与条数 == 实跑」，D7g 仍然要求「代码里的键集合 == 文档里的键集合」，D8b 仍然要求「文档钉的那一行真的坐着那个符号」。

---

## 真实文件清单

本轮实际改动的文件（`ed845ce`）：

| 文件 | 作用 | 由谁验证 |
|---|---|---|
| `js/main.js` | 路由、DOM 接线、存档写入、`window.hitori` 测试桥 | `@boot` 24 条 + `@pointer` 37 条；`node --check`（ESM 语法门） |
| `js/core/storage.js` | 纪录存档的两段式解码（坏一条只丢那一条） | `test/storage.test.mjs` 5 条；`@save` 23 条 + `@reloaded` 17 条 |
| `index.html` | 壳：head（图标 / manifest / og / twitter）、顶栏、画布、HUD、面板 | `test/assets.test.mjs` 6 条（每个 href/src 都在盘上）；`@boot` |
| `manifest.webmanifest` | PWA 清单：4 个带 `purpose` 的图标 + shortcuts | `test/assets.test.mjs` `manifest icons are real PNGs whose declared sizes match their IHDR`；部署集闸 R3 / R5 |
| `sw.js` | 离线预缓存（SHELL 5 条 + ASSETS 7 条） | `test/assets.test.mjs` `the service worker precache list is entirely on disk`；部署集闸 R10 |
| `tools/harness.mjs` | 套件的断言小工具 + 本轮新增的 `tapSuite` 适配器 | 每个 node 套件的 `rows: N fail: M` 行（文档腿 D4a/D4b 就是读这一行） |
| `test/assets.test.mjs` / `test/audio.test.mjs` / `test/pace.test.mjs` / `test/storage.test.mjs` | 四个 `node:test` 套件 | 各自的 `rows:` 行 + 文档腿 D4a/D4b |
| `tools/doctest.mjs` | 文档现值的对表闸（154 项） | 自身末行 `rows: 154 fail: 0` |
| `tools/deploy-set.mjs` | 部署集闸（产物清单 / manifest / og / CI 接线） | 自身 `rows: 72 fail: 0` + `deploy-set-selftest.mjs` rc=0 |
| `package.json` | 脚本与零依赖声明 | `npm test`（CI 第 29 行）、`npm run check` |
| `README.md` / `DESIGN.md` | 键的个数、套件数、断言数、行号锚点 | 文档腿 154 项 + 破坏试验台账 9 把刀 |

未改动但被本轮引用（写出来是为了说明它们**由谁验证**）：

| 文件 | 作用 | 由谁验证 |
|---|---|---|
| `js/core/grid.js` `rules.js` `solve.js` `make.js` `brute.js` `game.js` | 纯规则层：题面校验、三条规则、铅笔路、生成器、全枚举复核、一局状态机 | 五个手写套件 `test/{brute,game,make,rules,solve}.test.mjs`（12 + 13 + 9 + 16 + 16 = 66 条） |
| `js/core/library.js` `rng.js` | 题库查询（战役 / 今日 / 随机 / id / `stats()`）与种子哈希 | `tools/doctest.mjs` 的 D3 段（各档 band 与直方图逐格重算）+ `@routes` 23 条 |
| `js/core/audio.js` `js/core/pace.js` | 声音子系统与帧时钟 | `test/audio.test.mjs` 5 条、`test/pace.test.mjs` 5 条 |
| `js/view.js` | canvas 渲染、命中、提示环、减少动态效果 | `@pointer` 37 条（真 `Input.dispatchMouseEvent`）、`@motion` 11 条 |
| `js/data/lots.js` | 40 盘烘焙产物 | `node tools/audit-lots.mjs`（`rows: 40 fail: 0`）+ 台账 K9 那把刀 |
| `tools/playtest.mjs` | 零依赖 CDP 驱动 + 九个场景 | `tools/verify.sh` 每段打印的 `rows: N fail: []` |
| `tools/verify.sh` | 一条命令一个结论 | 自身末行 `=== ALL GREEN ===` |
| `tools/sabotage.mjs` | 破坏试验台账 | 自身 `rows: 9 fail: 0` |
| `tools/bake.mjs` `tools/load-audit.mjs` | 出题管线与负荷可达性 | `npm run bake` / `npm run loads`（CI 跑） |
| `server.cjs` `electron/main.cjs` | 零依赖静态服务器 / 桌面壳 | 服务器：`verify.sh` 的 web root 轮询 + `@boot`；桌面壳：只有 `npm run check` 的语法门（见「需人接手」） |
| `icons/` 10 张 + `assets/img/` 7 张 | 图标、apple-touch-icon、og 封面、棋盘与瓦片位图 | `test/assets.test.mjs` 的 IHDR 尺寸核对（真 PNG、宽高与声明一致、≥512 一张、≥180 一张） |

---

## 删行审计

本轮**没有删掉任何功能**。逐条列出被删掉的代码行，以及它们为什么不是功能：

| 删掉的行 | 在哪 | 为什么不是功能 |
|---|---|---|
| `function toggleFullscreen() { … }`（无参那份，约 15 行） | `js/main.js` | 与保留的那份同名同职责，是并线拼出来的**第二套实现**；它的三句提示话已折进保留的那份，能力没丢 |
| `el.fullscreen.addEventListener('click', () => toggleFullscreen());` | `js/main.js` | 与 `bindFullscreen` 重复的接线；绑定保留在 `bindFullscreen` 一处 |
| 键盘分支 `if (k === 'f') { … toggleFullscreen(); … }` | `js/main.js` | 同上，`f` 键由 `bindFullscreen` 接（含 `fullscreenchange` 回写） |
| `document.getElementById("btn-fullscreen")` | `js/main.js` | 换成 `el.fullscreen`（el 表是页面的 id 唯一清单） |
| `<button … id="btn-fullscreen">全屏</button>` | `index.html` | 重复入口：HUD 里那颗 `#fullscreen` 还在，功能是同一件 |
| `<link rel="icon" href="data:,">` 与远端那份 head 里的重复 meta | `index.html` | 远端那份 head 被本地那份整体替换（本地那份的图标链更全，且 `og:image` 是绝对 URL） |
| `function recordNum(v)` / `function sanitizeRecord(r)` / `function sanitizeRecords(p)` | `js/core/storage.js` | 并线带进来的**另一套解码**（错值一律退成默认值 ⇒ 坏记录一条也丢不掉，与 `test/storage.test.mjs` 的口径正好相反）；已换回验收认的那一套 |
| `ls &&` 里的 `ls` | `js/core/storage.js` | 悬空变量（该作用域没有定义） |

逐文件增删行数（`git diff --numstat HEAD~1 HEAD`）：

```
5/4    DESIGN.md          6/5    README.md          20/9   index.html
94/42  js/core/storage.js 39/34  js/main.js         20/21  manifest.webmanifest
1/1    package.json       86/48  sw.js
6/1    test/{assets,audio,pace,storage}.test.mjs
2/2    tools/deploy-set.mjs  12/8 tools/doctest.mjs  21/0 tools/harness.mjs
```

---

## 验收命令原样输出

```bash
$ bash tools/verify.sh
=== node suites ===
--- test/assets.test.mjs
--- test/audio.test.mjs
--- test/brute.test.mjs
--- test/game.test.mjs
--- test/make.test.mjs
--- test/pace.test.mjs
--- test/rules.test.mjs
--- test/solve.test.mjs
--- test/storage.test.mjs
--- js/data/lots.js
rows: 40 tiers: 4 unique ids: 40
rows: 40 fail: 0
=== doctest ===
合计 154 项，0 项失败
rows: 154 fail: 0
=== sabotage ledger ===
红 ✓ K1 rc=1 点名 2 行 · D2 retreat 行：尺寸 / 出题种子数 / 唯一解率 / 落带率 / 出货负荷 逐格
红 ✓ K2 rc=1 点名 2 行 · D3 retreat 档：band 与直方图逐格 == make.js 的 TIERS 现值
红 ✓ K3 rc=1 点名 2 行 · D5e 文档表与 verify.sh 的 EXPECTS 逐格相同（脚本与文档不许有两个数）
红 ✓ K4 rc=1 点名 2 行 · D4c audit-lots 独立核对 40 盘绿
红 ✓ K5 rc=1 点名 2 行 · D7f 文档的星级那句逐处写的都是 over <= 0 && fixes === 0，没有写
红 ✓ K6 rc=1 点名 2 行 · D7m 页面文件（main.js + view.js）的 import 解析到 N 条，其中
红 ✓ K7 rc=1 点名 2 行 · D8b js/core/grid.js 的行号引用真指着 OPEN
红 ✓ K8 rc=1 点名 2 行 · D9h DESIGN §13 的复现块里有这两道新闸的命令（照别人抄的复现步骤必须包含全部闸
红 ✓ K9 rc=1 点名 1 行 · 而 假设+枯竭=
合计 9 把刀：9 把点名变红，0 把不合格
rows: 9 fail: 0
RC=0
ledger rc=0（读回 0）· 台账 9 把 / README 9 行 · fail=0
=== deploy-set ===
部署集：50 条引用（含 4 张位图尺寸核对），失败 0 项
rows: 72 fail: 0
DS_SELFTEST rc=0（0=每一刀都按预期发力、阴性对照按预期不发力）
=== scenario bodies ===
RESULT {"cmd":"selftest","scenario":"selftest","pass":true,"rows":7,"fail":[]}
boot: hitori ready at http://127.0.0.1:5256/
=== @boot ===      rows: 24 fail: []
=== @taps ===     rows: 20 fail: []
=== @rules ===    rows: 25 fail: []
=== @logic ===    rows: 16 fail: []
=== @routes ===   rows: 23 fail: []
=== @save ===     rows: 23 fail: []
=== @reloaded === rows: 17 fail: []
=== @motion ===   rows: 11 fail: []
=== @pointer ===  rows: 37 fail: []
=== browser assertions: 196 ===
=== console ===
console lines: 0
=== chrome exited, temp profile gone ===
=== count table: 9/9 格逐格对上（实测合计 196 / 表中合计 196）===
=== ALL GREEN ===
VERIFY_RC=0
```

逐条命令的退出码：

| 命令 | 退出码 | 实数 |
|---|---|---|
| `npm run check` | 0 | 每个源文件 `node --check` + 场景体解析 |
| `npm test` | 0 | 9 个套件共 **87 条**断言，fail 0 |
| `node tools/doctest.mjs` | 0 | **154 项**，0 失败 |
| `node tools/sabotage.mjs` | 0 | **9 把刀**，9 把点名变红 |
| `node tools/deploy-set.mjs` | 0 | **50 条引用** / **72 行**，失败 0 项 |
| `node tools/deploy-set-selftest.mjs` | 0 | 每一刀都按预期发力 |
| `bash tools/verify.sh` | **0** | node 侧 87 + 154 + 9 + 72，浏览器侧 **196 条**，9/9 格对上 |

---

## 行为变化需知会

1. **全屏按钮只剩一颗**，位置在 HUD 那一排（与静音、玩法并排）。原来顶部导航里也有一个「全屏」，页面上出现两颗同功能按钮、点一下进出各一次等于没反应。现在导航只剩 战役 / 今日 / 随机 三个路由。
2. **`npm test` 现在能跑**（此前在 Node 22 上是 `MODULE_NOT_FOUND`，CI 的第 29 步是红的）。跑法与 `npm run unit` 相同：逐个文件跑，一个文件一个结论。
3. **存档解码口径换回「坏一条只丢那一条」**。并线那版把坏字段一律退成默认值（`best` 变 0、`plays` 变 0），等于把玩家的坏数据悄悄改写成 0；现在坏记录真的会被丢掉，其余记录原样留下。
4. **静音开关会持久化**（`hitori.settings.v1`，并线带进来的功能，此前文档没写）。刷新页面后静音状态保留；此前它是纯会话态。
5. **localStorage 键从 2 个变 3 个**：`hitori.save.v1`（纪录）、`hitori.resume.v1`（续局）、`hitori.settings.v1`（静音）。文档（README 与 DESIGN）已按三个键改写。

---

## 未实现 / 需人接手

| 事项 | 现状 | 需要谁 |
|---|---|---|
| 桌面壳 `electron/main.cjs` | 只过了 `npm run check` 的语法门，运行期没有自动化验收 | 需要人手工跑一次 Electron 外壳 |
| iOS Safari 的全屏 | 浏览器系统手势管，网页按不到那个开关。按钮会自己说一句话而不是假装成功（全屏按钮在支持判断为假时自己隐藏） | 已知平台限制，无人可接 |
| `og:image` 用绝对 URL | 部署集闸 R7 要求绝对 URL 且那张图在产物里；本地开发时预览到的是线上那张封面 | 已知取舍，无人可接 |
| 三种 URL 形态各跑一遍 | 整闸跑的是**根形态**；前缀形态（Pages 的 `/<repo>/`）与线上产物形态需要各自起服务再跑一次 `BASE_URL=… bash tools/verify.sh` | 需要有 Pages 访问权的机器跑那两遍 |

---

## 基线归因记录

用 `git worktree add --detach /tmp/hitori-pre 17ca4fc` 建了合并前基线，在**同一套闸**上跑，结果如下：

| 检查 | 基线（`17ca4fc`） | 本次（`ed845ce` + 本文件） | 判定 |
|---|---|---|---|
| `node --check js/main.js` | `SyntaxError: Identifier 'toggleFullscreen' has already been declared` | 解析通过 | **并线造成**：整局不可玩 |
| `node tools/doctest.mjs` | 154 项，**5 项失败**（D4a / D4b ×2 / D7g / D8b） | 154 项，0 失败 | **并线造成**（两侧套件数与文档数字对不上） |
| `node tools/deploy-set.mjs` | 35 条引用 / 54 行，2 项失败（钉 28 / 47） | 50 条引用 / 72 行，0 失败 | **并线造成**（head/清单拼两份 ⇒ 引用集合变了） |
| `npm test` | `MODULE_NOT_FOUND`（`node --test test/`） | 9 个套件 87 条 fail 0 | **本来就坏**（两侧 `package.json` 同一份脚本，不是并线造成） |

五条 doctest 红与基线逐字相同 ⇒ 本轮没有引入任何新的红；它们本来就红，是并线把两侧的套件数、键数、行号钉搅在一起带进来的。

基线 worktree `/tmp/hitori-pre` 已用 `git worktree remove --force` 清掉。
