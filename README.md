# 一乘 · 抽刀断水 HITORI（零猜测唯一解推理）

一个浏览器原生的 hitori：盘面上一半的数字被遮住，剩下的数字每行每列都不重样，黑格互不相邻，
白格连成一片。**40 盘全部在构建期生成并逐格复核过唯一解**，浏览器不生成、不搜索、不回溯；
提示说的是这一盘题面上「铅笔下一步能推出什么」，不是答案。

难度不是形容词。每一盘的 `枯竭 N 次 / 假设 M 层` 是 `js/core/solve.js` 在那道题面上跑出来的
实测值，四档的排序键是这个负荷（`load = 枯竭 + 假设`），而 `band` 是量完之后回填的选择目标。

## 快速开始

```bash
npm start                 # http://127.0.0.1:5256/  零依赖静态服务器（5256 是 npm start 传进去的；`node server.cjs` 裸跑落 5173）
npm run check             # 每个源文件 node --check + 七个页面场景体能否解析
npm test                  # 5 个 node 套件，66 条断言（引擎层）
npm run unit              # 同一批 test/*.test.mjs 逐个跑，一个文件一个结论（红了知道是哪个文件）
npm run doctest           # 文档里每一个现值都在代码/工具上重算一遍（154 项 = 144 条等式 + 10 条 unpinned）
npm run sabotage          # 破坏试验台账：把每类谎写回代码，验闸会点名变红
npm run bake              # 重新出题：生成 → 三条复核 → 写 js/data/lots.js
npm run audit             # 只核已发布的 40 盘：唯一解、复核强度、负荷分布、档级文案
npm run loads             # 生成器能产出哪些负荷：4 档 × 3000 个种子的直方图（2026-09-27 本机约 20s；耗时随机器与负载漂，不是闸的期望）
npm run verify            # 就是下面那条 bash tools/verify.sh，一个入口一个结论
bash tools/verify.sh      # 门禁：node 套件 + doctest + 破坏试验台账 + 一个真 headless Chrome 跑 9 个场景、196 条断言
```

`tools/verify.sh` 支持三种收窄方式，改哪一段就跑那一段：

```bash
SCENARIOS="pointer" bash tools/verify.sh                       # 只跑一个场景
SKIP_UNIT=1 SCENARIOS="boot" bash tools/verify.sh              # 只跑浏览器
CDP_PORT=9367 bash tools/verify.sh                             # 9365 被占时换到自己的空闲口
BASE_URL=https://…/z-biz-game-hitori-cos/ bash tools/verify.sh # 对已部署产物跑同一套断言
```

端口是这个仓自己的：HTTP 5256 / CDP 9365。

## 玩法

一次点击循环一格：`未涂 → 涂黑 → 打点 → 未涂`。打点是「这一格我确定留着」的记号，
它不改变规则判定，只把你已经推出来的结论钉在盘上。

- 键盘：`c` 聚焦棋盘，方向键移动光标，`Enter` / `空格` 敲当前格，`u` 回退，`r` 重开，`h` 提示。
- 战役按 `load` 从小到大走完 40 盘；另有今日一题与随机一盘。
- 进度与纪录只写在本机的 `localStorage`：纪录在 `js/core/storage.js` 的键 `hitori.save.v1`，
  没下完的那一盘在 `js/main.js` 的键 `hitori.resume.v1`，没有服务端。

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
| 星级 | `main.js` 的 `grade()`：`over = taps − 最佳`，`over <= 0 && fixes === 0` 才是三乘 |

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
最后那一列「独立复核耗时」是那一台机器那一轮的读数，随负载漂，不进任何闸的期望；
前面四列（种子数、唯一解率、落带率、出货负荷）是结构数字，`tools/doctest.mjs` 会把 bake 重跑一遍逐格对表。

| 档 | n | 出题种子数 | 唯一解率 | 落进 band | 出货的负荷 | 独立复核耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| 一隅 nook | 4×4 | 34 | 100.0% | 29.4% | `0 ×10 盘` | ≤ 11 ms |
| 静室 quiet | 4×4 | 15 | 100.0% | 66.7% | `2 ×10 盘` | ≤ 2 ms |
| 书房 study | 5×5 | 38 | 100.0% | 26.3% | `4 ×10 盘` | ≤ 36 ms |
| 隐修 retreat | 6×6 | 113 | 100.0% | **8.8%** | `6 ×9 盘 · 10 ×1 盘` | ≤ 49 ms |

「落进 band」这一列是**每个档要试多少个种子才凑得够 10 盘**：分子恒为 10（`PER_TIER`），
分母是抽到第 10 盘为止的种子数，所以 8.8% 读作「113 次才凑够 10 盘」，不是「113 盘里 10 盘能用」。
`隐修` 那 8.8% 是这架梯子真正的成本：`npm run loads` 在 3000 个种子里量到 2707 个 `too-easy`
（90.2% 的 6×6 盘枯竭不够），落进 band 的只有 287 盘。唯一解率四档都是 100%，
因为没过第 1、3 关的盘根本不会进候选。

**出货负荷那一列是多重集，不是区间。** 上一版这里写的是 `6-10`，而 10 盘里 9 盘是 6、
只有 1 盘是 10——一个区间把「这一档最难的一盘」说成了「这一档的难度范围」。同一句话也印在选档卡片
和货架标题上（`js/data/lots.js` 的 `blurb`），所以现在三处都写盘数：

```
6×6 · 枯竭 3 次 ×9 盘 · 5 次 ×1 盘 · 假设 3 层 ×9 盘 · 5 层 ×1 盘
```

规则是「每个值带着自己的盘数，永远不写 min-max」，由 `js/core/library.js` 的 `spreadText()` 渲染，
`tools/bake.mjs` 自己另写一遍生成 `blurb`，`tools/audit-lots.mjs` 拿行重算并逐字比对，
`@boot` 与 `@taps` 再在页面里从 `window.hitori.lots` 独立重算第三次——
两种写法必须拼出同一个字符串，而且打印出来的盘数加起来必须等于这一档真实存在的盘数
（`@boot` 断言 `×N 盘` 之和 `=== rows`，否则「写了 9+2 盘却只有 10 盘」也能蒙过子串检查）。

`node tools/load-audit.mjs` 量的是生成器**能**产出哪些负荷，不看 band 收不收（4 档 × 3000 个种子，
11 893 盘有负荷读数）：

| 档 | band | 实测到的负荷（`值×盘数`） |
| --- | --- | --- |
| nook | 0..0 | `0×690 2×1549 4×597 5×2 6×134 8×11` |
| quiet | 2..2 | `0×655 2×1521 4×614 5×2 6×141 8×14 10×1` |
| study | 4..5 | `0×666 2×1607 4×523 5×4 6×134 7×1 8×27 10×5 11×1` |
| retreat | 6..12 | `0×605 2×1501 4×601 6×204 7×2 8×56 9×1 10×22 11×1 12×1` |

三条要如实说的读法：

- **band 的上界基本是装饰。** `隐修` 落进 band 的 287/3000 盘里，6 : 7 : 8 : 9 : 10 : 11 : 12 =
  204 : 2 : 56 : 1 : 22 : 1 : 1——抽到 10 盘就停的出货器，交付的就是负荷 6（出货 9/10 盘都是 6）。
  `书房` 的 5 也是同一件事：3000 个种子里有 4 盘负荷 5，而烘焙试的 38 个种子里一盘都没碰到，
  于是出货 10 盘全是 4。生成器没有「越难越优先」的机制，band 写多宽都不改变采样率。
- **负荷几乎恒等于 2 × 枯竭。** 11 893 盘里奇数负荷只有 14 盘，落进 band 的盘里「假设 ≠ 枯竭」
  的正好是那 8 盘（`书房` 4 盘 + `隐修` 4 盘，都是 假设 2 · 枯竭 3 这一类）。
  `load = 枯竭 + 假设` 是两个读数之和，把它拆开打印仍然有意义，只是别把它读成两个独立指标。
- **九成 6×6 的盘是「枯竭不够」。** `隐修` 的 3000 个种子里 `too-easy` 占 2707，
  这就是上面那行「落进 band 8.8%」的另一面。
- **`npm run loads` 会红**：如果出货 40 盘里某个负荷值在同档 3000 个种子里一次都量不到，
  说明数据文件和这架梯子已经不是同一个游戏了。

墙上时间只进报告，不进数据行：`js/data/lots.js` 里没有任何 `ms` 字段，两次 bake 的行区逐字节相同
（`diff <(sed -n '/export const LOTS/,$p' …)` 前后一致），否则换台机器重新烘焙就会把仓库弄脏。

## 门禁

`bash tools/verify.sh` 一条命令一个结论，顺序是固定的：

1. `test/*.test.mjs` 五个 node 套件 + `tools/audit-lots.mjs`（已发布 40 盘的独立核对）先跑；
   **引擎红着就不启动浏览器**。
2. `node tools/doctest.mjs`：本文件与 `DESIGN.md` 里印出去的每一个现值，都在代码或同一个工具的重算上
   比一遍（题面行、bake 报告、`npm run loads` 的直方图、断言条数、端口、引用行号、台账）。它是纯逻辑闸，
   不起浏览器，所以本地与 CI 跑的是同一条命令。
   - 文档引用这一腿有两道。**范围**那道要求每一条 `文件:行号` 落在真实文件的行数内、且被指的那几行整段
     不许是空行——在界内不等于指到了代码：中间插了几行之后那个行号指的可能是空行。**锚点**那道要求被指的
     那几行真的坐着它点名的那个标识符，认**整词**不认子串：子串口径比它替掉的手抄锚点表更弱，`band` 会命中
     `bands`、`OPEN` 会命中 `MUST_OPEN`，于是引用真的漂到邻行那天读出来的是绿。样式表里那种带 `.` 的选择器
     落点仍走子串（它没有同名的长标识符可以蹭，硬套整词只会让这一格去核一个本不存在的东西）——两处口径
     不同是设计，不是漏。
   - 两道各自带一把自证的刀，都 AND 进既有断言，所以本闸的条数一格没动。截前缀那把从本闸的锚点里现挑一个
     「是子串但不是整词」的靶子，挑不出来就当场红——口径退回子串的那一天正是所有候选都「过」的那一天；
     空行那把的靶子从本闸自己那份文件里现量，写死行号会在有人填了那一行那天停止测试。
   - 四腿牙跑在 `_scratch/` 下的**同名副本**里（盘上的仓一字未动，副本基线 `rows: 154 fail: 0`）：把整词
     退回子串、把空行那道删掉、把 `make.js` 那句注释里的 `band` 写成 `bands`、把一条裸引用指到副本里现量
     出的空行——每一腿只红它对应的那一条并且点名，复原后回到全绿，判词 `TEETH_OK` 记在
     `_tmp-hitori-word-teeth.log`。
   - 这条腿没覆盖什么：不带名字的裸引用只有范围与空行两道，拿不到锚点；一条引用指向**同文件里另一行非空**
     的代码，这一腿看不见（台账 K7 那把只证明「把引用挪到会红的地方」，不证明每句话都被核过）。
3. `node tools/sabotage.mjs`：破坏试验台账（下面单独一节）。每一把刀都必须让那道闸**点名**变红才算数，
   而它自己要求干净树——本地有未提交的改动就 rc 2 拒跑，这是正确行为而不是坏了。也是纯逻辑，本地与 CI
   同一条命令。
4. `node tools/playtest.mjs selftest`：把七个页面场景体逐个 `new Function()` 解析一遍
   （`@motion` 与 `@pointer` 是 node 侧的驱动函数，不在字符串里，由 `node --check` 覆盖）。
   场景体是字符串形式的页面代码，一个未转义的引号会伪装成「页面没起来」，所以这一关在启动 Chrome 之前。
5. 起一个本仓静态服务器 + 一个 headless Chrome（还是那一对号：HTTP 5256 / CDP 9365，独立临时 profile）。
   起跑前先量端口归属：`:9365` 上已经有人应答 DevTools 就直接退出码 2，而不是拿**别人**的浏览器
   跑完 196 条再报绿——这一条是这次加的，因为一次泄漏的 headless Chrome 让预检在毫秒级就"通过"，
   于是服务器还没 `listen()` 就被 curl，红灯写成了一句假的「nothing served」。跑 `BASE_URL` 形态时
   这一条照样量（脚本仍然起自己的 Chrome），`:5256` 那条只在本地量。
   预检随后证明被测字节确实是本仓的 `index.html`（失败时把本次服务器写的日志和监听者一起打出来），
   再等 `window.hitori` 出现。
6. 九个场景各跑一遍，只认驱动最后一行的 `RESULT <json>`；没有 `RESULT` 等于「没跑」，不算绿。
   控制台脏（`[EXCEPTION]` / error / warning）也算红，即使断言全过。
7. 收尾证明它自己没留东西：Chrome 退出、临时 profile 删除，否则算红。
8. 最后把每一个场景**实测的条数**与下面那张表的「断言数」逐格比对（`SCENARIOS=` 收窄时只比跑过的那几格，
   但至少要比一格，且九格全跑时必须比满九格）——条数掉了而场景仍然"通过"，是这个仓最容易漏的一种红。

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

**URL 形态**：门禁要跑三遍，因为生产是 Pages 的 `/<repo>/` 前缀形态，而前缀形态是最容易悄悄坏掉的那个。

```bash
bash tools/verify.sh                                                       # 根形态
BASE_URL=http://127.0.0.1:5257/z-biz-game-hitori-cos/ bash tools/verify.sh # Pages 的前缀形态
BASE_URL=https://z-biz-game.github.io/z-biz-game-hitori-cos/ bash tools/verify.sh  # 已上线的产物
```

前缀形态用一个把仓库放到 `/z-biz-game-hitori-cos/` 路径下的静态服务器跑
（`server.cjs` 会把目录 URL 解析到该目录的 `index.html`，和 Pages 一致）。三种形态各 196 条；
第三种跑的是线上字节，所以只能在部署落地之后跑——push 之前先跑前两种，push 之后再跑第三种。

## 破坏试验台账

`tools/sabotage.mjs` 里不另存一份刀：**下面这张表就是它的全部刀源**。一行一把刀，8 列 = 刀号、
这一刀把哪一类谎写回原处、打的是哪个文件、针（必须在那个文件里恰好命中一次，台账行自己不算）、
改成、必须点名的那条断言、跑的那道闸、实测 rc。这一张表共 9 把刀，覆盖 8 类已经写在文档里的谎：
表格逐格现值、场景条数表、引擎与独立复核的合计、星级口径、缺席类断言、file:NN 引用锚点、
接线（复现步骤必须点齐每一道闸）、数据行本身。

一把刀算「证过」要三条同时成立：闸的退出码非 0、日志里有一行 FAIL、**并且那一行把第 6 列的断言
原文写出来**——只比退出码的话，磁盘满、拼错的命令、起不来的浏览器都能把台账刷成一片绿。第 7 列
只允许纯逻辑闸：浏览器腿要起 Chrome，而刀打的文件可能与它无关，那种红不属于这一本。下刀之后还原
用的是最开始读进内存的那份字节（`writeFileSync`），不叫 `git`，所以别人未提交的改动不会被顺手吞掉。

最后一列是**实测 rc**，不是愿望：跑之前写 `?`，`node tools/sabotage.mjs` 把这一轮真读到的退出码
盖回去。台账第一件事是要求干净树——树不干净时「绿」不知道是谁撑的，它直接 rc 2 拒跑。盖完戳之后
再跑一遍应当一个字节都不动，CI 用 `git diff --exit-code` 钉这一步。

| 刀 | 这一刀把哪一类谎写回原处 | 文件 | 针 | 改成 | 必须点名的断言 | 命令 | 实测 rc |
| --- | --- | --- | --- | --- | --- | --- | --- |
| K1 | bake 表逐格：把隐修那一档的出题种子数写回 112 | README.md | 6×6 \| 113 \| 100.0% | 6×6 \| 112 \| 100.0% | D2 retreat 行：尺寸 / 出题种子数 / 唯一解率 / 落带率 / 出货负荷 逐格 == bake 现在报的 | node tools/doctest.mjs | 1 |
| K2 | 负荷表逐格：把隐修 band 内直方图的 6×204 写成 6×205 | README.md | 6×204 7×2 8×56 | 6×205 7×2 8×56 | D3 retreat 档：band 与直方图逐格 == make.js 的 TIERS 现值与 load-audit 现在的打印 | node tools/doctest.mjs | 1 |
| K3 | 场景条数表：把 @save 那一格的断言数写成 24 | README.md | 23 \| 存档写入、续局、纪录 | 24 \| 存档写入、续局、纪录 | D5e 文档表与 verify.sh 的 EXPECTS 逐格相同（脚本与文档不许有两个数） | node tools/doctest.mjs | 1 |
| K4 | 引擎合计：把 minTaps 的「一个点两下」写成三下，出货行上的地板价当场对不上 | js/core/game.js | return lot.solution.length + 2 * (total - lot.solution.length); | return lot.solution.length + 3 * (total - lot.solution.length); | D4c audit-lots 独立核对 40 盘绿 | node tools/doctest.mjs | 1 |
| K5 | 星级口径：把旧写法写回文档那一句 | README.md | 才是三乘 | 才是三乘 旧口径是 taps === minTaps | D7f 文档的星级那句逐处写的都是 over <= 0 && fixes === 0，没有写成 taps === minTaps | node tools/doctest.mjs | 1 |
| K6 | 缺席类：让页面文件真的 import 生成器（这一类不许只靠「扫不到就绿」） | js/main.js | import { connectivity } from './core/rules.js'; | import { connectivity } from './core/rules.js'; import { TIERS } from './core/make.js'; | D7m 页面文件（main.js + view.js）的 import 解析到 N 条，其中没有一条来自生成器（make.js / brute.js） | node tools/doctest.mjs | 1 |
| K7 | file:NN 锚点：把 grid.js 的行号引用挪到不含 OPEN 的那几行 | DESIGN.md | js/core/grid.js:16-18 | js/core/grid.js:120-122 | D8b js/core/grid.js 的行号引用真指着 OPEN | node tools/doctest.mjs | 1 |
| K8 | 接线：把台账从 DESIGN §13 的复现步骤里抹掉（照着复现的人就再也跑不到它） | DESIGN.md | node tools/sabotage.mjs | # 复现步骤里没有这一条 | D9h DESIGN §13 的复现块里有这两道新闸的命令（照别人抄的复现步骤必须包含全部闸） | node tools/doctest.mjs | 1 |
| K9 | 数据行本身：把 nook-15 的 load 写成 1，而它的枯竭+假设是 0 | js/data/lots.js | "load":0,"seed":"bake-nook-15" | "load":1,"seed":"bake-nook-15" | 而 假设+枯竭= | node tools/audit-lots.mjs | 1 |

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
js/core/library.js    战役顺序、随机一盘、今日一题、统计、难度句子的拼法（spreadText）
js/core/storage.js    纪录那一个 localStorage 键，带 localStorage 会抛异常的防护（续局在 js/main.js 的另一个键）
js/data/lots.js       40 盘烘焙产物：题面、解、实测难度、复核方式
js/view.js            canvas 渲染、命中、提示环、减少动态效果
js/main.js            路由、面板、胜利卡、键盘层、window.hitori 测试桥
tools/bake.mjs        出题管线（三条复核 + 报告）
tools/audit-lots.mjs  已发布 40 盘的独立核对（无浏览器，CI 用）
tools/load-audit.mjs  负荷能从哪儿被生成出来：band 内外的直方图 + 出货值的可达性（会红）
tools/doctest.mjs     文档现值的对表闸：本文件与 DESIGN 印出去的每一个数，在代码、数据行或同一个工具的重算上比一遍
tools/sabotage.mjs    破坏试验台账：把每类谎写回原处，验闸会不会点名变红，再把读到的退出码盖回本文件那张表
tools/harness.mjs     node 套件的断言小工具
tools/playtest.mjs    CDP 驱动 + 九个场景 + 页面侧第二意见（CF_BODY）
tools/verify.sh       一条命令一个结论
electron/main.cjs     桌面壳，复用 server.cjs
tools/assemble-site.sh  部署产物的唯一清单（pages.yml 与本地闸调同一支）
tools/deploy-set.mjs  部署集闸：检查即将上传的那份产物
tools/deploy-set-selftest.mjs  部署集闸的阴性自证（每一类断言当场打红一次）
```

## 许可

MIT，见 `LICENSE`。

## 上线的到底是哪一批文件

这个仓没有打包器：站点=一次文件拷贝。以前「拷哪些」写在 `pages.yml` 的 `run:` 里（手抄的几行
`cp`）。本地 `index.html` 直读仓库根，永远自洽；线上却按那份清单拷，于是页面后来引用的
`manifest.webmanifest`、`sw.js`、`icons/*` 可能一个都没上去——线上 404，而仓里的引擎测试与
真浏览器闸全绿，因为它们跑的都是仓库根，没有任何一步在「按清单拷」的那个环境下加载过页面。

现在清单只有一份，住在 `tools/assemble-site.sh`：CI 调它拷 `_site`，本地闸调它拷临时目录，
然后**对拷出来的产物**提要求（`tools/deploy-set.mjs`）：

- **W 清单与页面同源**：`pages.yml` 里必须真有 `run: bash tools/assemble-site.sh <dir>` 这一行，
  `ci.yml` 里必须真有 `run: node tools/deploy-set.mjs`。认的是调用那一行，不是文件里出现过这个
  路径——注释里本来就会写它，只 grep 字符串会被一句散文喂绿。
- **R 引用可达**：引用不靠手打名单。从 `index.html` 的 `href/src` 出发，凡解析出来是 `.js`/`.css`
  的就把那一站也扫一遍（CSS 的 `url()`、JS 去掉注释后的 `'./…'` 字面量、`new URL(x, base)` 的两种
  基、`navigator.serviceWorker.register`、`scope`），`manifest` 的 icons/screenshots/shortcuts 各自
  的 `src` 也算引用。取径上读不到的那一站本身就是红（读不到＝这一站根本没扫）。每条引用都必须在
  产物里且非 0 字节；绝对路径单列一条红，因为 Pages 挂在 `/<repo>/` 前缀下会跳出去。
- **P 位图不许说谎**：`manifest` 声明的 `sizes` 必须等于 PNG IHDR 的真实宽高——文件图标读文件头，
  内联成 base64 的图标先解码再读同一段。后一条不是可选项：图标可能住在清单里而不是盘上的 `.png`
  （有的仓另有一条"零二进制文件"的承诺，那条只约束"有没有 .png 这个文件"）；如果 P 段只筛文件名，
  声明写 512 而真图 192 就一路放行。
- **钉住两个数**：R 段实际检查的路径条数（`28`）与这一次跑的断言条数（`46`），两个数
  都钉在 `tools/deploy-set.mjs` 顶部的那对常量里。没改页面却掉了，说明解析断了；删掉一张图标会同时
  少一条 R10 与那张的 P1/P2，所以两个数一起钉，断言条数能漂就是闸在缩水的信号。这一节故意只写数值、
  不写那对常量的名字，也不写别仓文档闸的编号：有的仓的文档闸会拿"文档里出现过的同名标识号"回数它
  自己的条数，还有的会把文档里点到的每个组编号逐个核对"这一轮真的发过"——两道闸共用一个名字，
  或者在本仓的文档里出现一个本仓没有的组编号，打红的都是不相干的那一边。

`tools/deploy-set-selftest.mjs` 是这两颗钉的阳性证明：它把仓库复制到临时目录，照着每一类断言
各下一刀（X1 清单不收位图目录 / X2 模块边改名 / X3 CSS 写绝对路径 / X4 `start_url` 绝对 /
X5 删光 >=512 图标 / X6 少一个必填字段 / X7 声明尺寸与真图不符 / X8 workflow 不调脚本 /
X9 CI 不跑闸 / X10 是阴性对照——往入口 JS 追加一行只写在注释里的假路径，闸必须仍然绿、条数仍然
`28`、断言仍然 `46`；X11 og:image 退回相对路径 / X12 og:image 的前缀指向别的 slug /
X13 内联位图谎报尺寸——只在有靶子时下：X11/X12 要页面上那句 og:image，X13 要清单里真有一段 base64
图标，没有就打印 SKIP；反过来 X1 没有位图目录可砍时改砍 css，P 段一位都不核时台架直接报靶子不够），
要求每一刀都让闸**点名**变红。靶子从 `DEPLOY_SET_DUMP=1`
的出处表现挑（取径真的会读的那支 JS / 那一张 CSS，不写死某一个仓的入口名），所以页面改了、仓与仓
不同，台架跟着走。

`node tools/deploy-set.mjs` 与 `node tools/deploy-set-selftest.mjs` 就是 CI 跑的那两条命令本身
（package.json 里的 `deploy-set` / `deploy-set:selftest` 只是同一支脚本的 npm 入口）；本仓的整闸在 `tools/verify.sh` 的 `=== deploy-set ===` 那一段也各跑一次。它们红的时候并进本仓那条出口的退出码——这一条是这么证的：
把 ci.yml 里那行 `run: node tools/deploy-set.mjs` 砍掉，本仓整闸必须点名红且退出码非 0。
所以「本地全绿、线上 404 自己的 manifest / sw.js / 图标」这一类坏法在本地就会红。

