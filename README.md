# 一乘 · 抽刀断水 HITORI（零猜测唯一解推理）

一个浏览器原生的 hitori：盘面上一半的数字被遮住，剩下的数字每行每列都不重样，黑格互不相邻，
白格连成一片。**40 盘全部在构建期生成并逐格复核过唯一解**，浏览器不生成、不搜索、不回溯；
提示说的是这一盘题面上「铅笔下一步能推出什么」，不是答案。

难度不是形容词。每一盘的 `枯竭 N 次 / 假设 M 层` 是 `js/core/solve.js` 在那道题面上跑出来的
实测值，四档的排序键是这个负荷（`load = 枯竭 + 假设`），而 `band` 是量完之后回填的选择目标。

## 快速开始

```bash
npm start                 # http://127.0.0.1:5256/  零依赖静态服务器
npm run check             # 每个源文件 node --check + 九个浏览器场景体能否解析
npm test                  # 5 个 node 套件，66 条断言（引擎层）
npm run bake              # 重新出题：生成 → 三条复核 → 写 js/data/lots.js
npm run audit             # 只核已发布的 40 盘：唯一解、复核强度、负荷、档级文案
bash tools/verify.sh      # 门禁：node 套件 + 一个真 headless Chrome 跑 9 个场景、196 条断言
```

`tools/verify.sh` 支持三种收窄方式，改哪一段就跑那一段：

```bash
SCENARIOS="pointer" bash tools/verify.sh                       # 只跑一个场景
SKIP_UNIT=1 SCENARIOS="boot" bash tools/verify.sh              # 只跑浏览器
BASE_URL=https://…/z-biz-game-hitori-cos/ bash tools/verify.sh # 对已部署产物跑同一套断言
```

端口是这个仓自己的：HTTP 5256 / CDP 9365。

## 玩法

一次点击循环一格：`未涂 → 涂黑 → 打点 → 未涂`。打点是「这一格我确定留着」的记号，
它不改变规则判定，只把你已经推出来的结论钉在盘上。

- 键盘：`c` 聚焦棋盘，方向键移动光标，`Enter` / `空格` 敲当前格，`u` 回退，`r` 重开，`h` 提示。
- 战役按 `load` 从小到大走完 40 盘；另有今日一题与随机一盘。
- 进度与纪录只写在本机的 `localStorage`（键 `hitori.save.v1`），没有服务端。

## 三条规则（提示只会说这些）

1. 每行每列不得出现两个相等的**未涂**数字（打点也算未涂）。
2. 任意两个涂黑格不得正交相邻。
3. 所有未涂格必须正交连通。

一条规则一个颜色：规则 1 红、规则 2 紫、规则 3 青，不共用。三色各自对应面板上编号的那条规则，
所以「哪里红了」和「违反了哪一条」是同一个问题。

## 屏上的每个数字是谁算出来的

`js/core/rules.js` 的 `audit()` 一次算完，面板、颜色、提示、结算读的都是它，没有第二套口径：

| 屏上 | 出处 |
| --- | --- |
| 冲突 / 三色环 | `audit().violations`、`byRule[1..3]` |
| 禁涂（青点） | `audit().forcedOpen`——规则 2 的推论，不是答案 |
| 未涂 / 黑数 / 打点 | `audit().undecided`、`shadedOf(marks)`、`marks` |
| 最佳 N 下 | `game.js` 的 `minTaps(lot) = 黑格数 + 2 × 非黑格数`，由这一盘自己黑几个格子算出 |
| 星级 | `main.js` 的 `grade()`：`taps === minTaps && fixes === 0` 才是三乘 |

`fixes` 数的是「把一块干净的盘踩进报警」的那一下。也就是说：一次点到地板价、中途没踩过报警，
才拿三颗星；顺序不对（先涂黑再补点）会多付修错，即使总下数一模一样。

## 唯一解是怎么证的

`tools/bake.mjs` 里，一盘要同时过三关才进 `js/data/lots.js`：

1. 生成器自己的**完整枚举**报 `solutionCount === 1`（`solve(p, { limit: 2, nodeLimit })`，
   撞到节点上限的盘直接以 `truncated` 拒收，不会降级发布）；
2. 把序列化之后的这一盘重解一遍，`solutionCount / depth / guesses` 必须逐字复现；
3. 另一套写法的 `js/core/brute.js` 独立再核一次，**逐格**比对而不是比个数。

第三条的强度按盘面大小分档，而且写在了数据行上（`row.brute = { mode, subsets }`）：

| 档 | 尺寸 | 第三条复核 | 子集数 |
| --- | --- | --- | --- |
| 一隅 nook / 静室 quiet | 4×4 | 全枚举 | 65 536 |
| 书房 study | 5×5 | 抽样 | 22 614–22 623 |
| 隐修 retreat | 6×6 | 抽样 | 27 807 |

4×4 的两档是唯一解被**穷尽**证明的部分；5×5 与 6×6 的第三关是围绕已知解的抽样反证，
完整证明由第 1 关的枚举承担。这条差别同时写在游戏内「这一盘的数字从哪来」一段里，不藏。

## 难度是量出来的

`node tools/bake.mjs` 的报告（本机，2026-09-27，40 盘写盘与上一次烘焙逐字节相同）：

| 档 | n | 出题种子数 | 唯一解率 | 落进 band | 独立复核耗时 |
| --- | --- | --- | --- | --- | --- |
| 一隅 nook | 4×4 | 34 | 100.0% | 29.4% | ≤ 11 ms |
| 静室 quiet | 4×4 | 15 | 100.0% | 66.7% | ≤ 2 ms |
| 书房 study | 5×5 | 38 | 100.0% | 26.3% | ≤ 36 ms |
| 隐修 retreat | 6×6 | 113 | 100.0% | **8.8%** | ≤ 49 ms |

`隐修` 那 8.8% 是这架梯子真正的成本：6×6 上一半以上的盘要么枯竭不够（`too-easy: 103`），
要么掉出 `load 6-10` 之外，要试 113 个种子才凑得够 10 盘。唯一解率四档都是 100%，
因为没过第 1、3 关的盘根本不会进候选。

墙上时间只进报告，不进数据行：`js/data/lots.js` 里没有任何 `ms` 字段，两次 bake 的产物逐字节相同
（`md5 js/data/lots.js` 前后一致），否则换台机器重新烘焙就会把仓库弄脏。

## 门禁

`bash tools/verify.sh` 一条命令一个结论，顺序是固定的：

1. `test/*.test.mjs` 五个 node 套件 + `tools/audit-lots.mjs`（已发布 40 盘的独立核对）先跑；
   **引擎红着就不启动浏览器**。
2. `node tools/playtest.mjs selftest`：把九个场景体逐个 `new Function()` 解析一遍。
   场景体是字符串形式的页面代码，一个未转义的引号会伪装成「页面没起来」，所以这一关在启动 Chrome 之前。
3. 起一个本仓静态服务器 + 一个 headless Chrome（独立临时 profile，CDP 9365），
   预检先证明被测字节确实是本仓的 `index.html`，再等 `window.hitori` 出现。
4. 九个场景各跑一遍，只认驱动最后一行的 `RESULT <json>`；没有 `RESULT` 等于「没跑」，不算绿。
   控制台脏（`[EXCEPTION]` / error / warning）也算红，即使断言全过。
5. 收尾证明它自己没留东西：Chrome 退出、临时 profile 删除，否则算红。

| 场景 | 断言数 | 盯的是什么 |
| --- | --- | --- |
| `@boot` | 24 | 首屏、目录、菜单文案与烘焙行对得上 |
| `@taps` | 20 | 三态循环、计费、回退、结算 |
| `@rules` | 25 | 三条规则各自的颜色、`forcedOpen`、孤儿格 |
| `@logic` | 16 | 铅笔路不回溯、枯竭/假设、提示措辞归属 |
| `@routes` | 23 | 战役/今日/随机/深链四条路的落地状态 |
| `@save` | 23 | 存档写入、续局、纪录 |
| `@reloaded` | 17 | 重新导航之后从磁盘读出进度（不是同一个 document） |
| `@motion` | 11 | 减少动态效果下提示环仍然会到期 |
| `@pointer` | 37 | 真鼠标与真键盘：命中盒、面板按钮、胜利卡、键盘层 |

合计 196 条浏览器断言 + 66 条引擎断言。`@pointer` 全部由 Chrome 生成的输入事件驱动，
不调 `window.hitori` 的方法，所以它测的是 `js/view.js` 的指针-格子接线和 CSS 给的命中盒。

**URL 形态**：门禁要跑两遍，因为生产是 Pages 的 `/<repo>/` 前缀形态。

```bash
bash tools/verify.sh                                                    # 根形态
BASE_URL=http://127.0.0.1:5257/z-biz-game-hitori-cos/ bash tools/verify.sh  # 前缀形态
```

前缀形态用一个把仓库放到 `/z-biz-game-hitori-cos/` 路径下的静态服务器跑
（`server.cjs` 会把目录 URL 解析到该目录的 `index.html`，和 Pages 一致）。两种形态各 196 条。

## 目录

```
index.html            三块区域：目录 / 棋盘 / 面板
css/game.css          布局与配色；每个 [hidden] 区都有自己的 display 规则
js/core/grid.js       OPEN / SHADED / DOT 三态与题面校验
js/core/rules.js      三条规则 + audit()，屏上数字的唯一出处
js/core/solve.js      不回溯的铅笔路：facts() + propagate()，也是提示的唯一来源
js/core/make.js       生成器：种解、删数字、量难度（只在构建期跑）
js/core/brute.js      第二套独立代码：全枚举与抽样（只在构建期和测试里跑）
js/core/game.js       一局的状态机：tap / undo / reset / minTaps / grade 的原料
js/core/library.js    战役顺序、随机一盘、今日一题、统计
js/core/storage.js    一个 localStorage 键，带 localStorage 会抛异常的防护
js/data/lots.js       40 盘烘焙产物：题面、解、实测难度、复核方式
js/view.js            canvas 渲染、命中、提示环、减少动态效果
js/main.js            路由、面板、胜利卡、键盘层、window.hitori 测试桥
tools/bake.mjs        出题管线（三条复核 + 报告）
tools/audit-lots.mjs  已发布 40 盘的独立核对（无浏览器，CI 用）
tools/harness.mjs     node 套件的断言小工具
tools/playtest.mjs    CDP 驱动 + 九个场景 + 页面侧第二意见（CF_BODY）
tools/verify.sh       一条命令一个结论
electron/main.cjs     桌面壳，复用 server.cjs
```

## 许可

MIT，见 `LICENSE`。
