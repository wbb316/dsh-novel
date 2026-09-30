# dsh-novel 🖋️

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.1%2B-4d6bfe.svg)](https://github.com/deepseek-ai)
[![seats](https://img.shields.io/badge/panel-native%20seats-7e57c2.svg)](#-原生席位小说面板)
[![tests](https://img.shields.io/badge/tests-1367%20assertions-success.svg)](#-开发和自测不启动-dsh不占端口)
[![release](https://img.shields.io/github/v/release/wbb316/dsh-novel?label=release&color=success)](https://github.com/wbb316/dsh-novel/releases)

DSH 插件：**小说创作台**。管你的小说项目（大纲 / 世界观 / 角色 & 关系 / 章节），
一半给 agent 用（`novel_*` 工具），一半给人用（宿主原生席位「小说」面板）。

它解决的是**写长篇时的实际麻烦**：设定和人物关系要随手能改、换个小说回来还记得读到哪、
点一下就让 AI 带着大纲和角色关系接着写、边写边看它流出来的字。

这是「自己做插件」的练手项目，所以代码里到处是注释，踩过的坑也都记在下面 —— 下次写别的插件直接抄。

---

## 🚀 安装

```powershell
# 从 GitHub 装（本插件是纯 JS，不需要构建步骤）
dsh plugin --profile web add github:wbb316/dsh-novel

# 装完重启一次
dsh web
```

**更新**：再跑一遍同样的命令即可（不带版本号就是默认分支上最新的）。
每个版本改了什么、有没有坑要躲，都在 [**Releases**](https://github.com/wbb316/dsh-novel/releases) 里。

**前置条件**

| | 说明 |
|---|---|
| DSH | **`0.2.0-rc.1` 或更高**（面板挂在宿主原生席位上）；老宿主仍可用，面板会退回 dsh-better-sidebar 页签 |
| Node | `>= 20` |
| [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | **可选**——只有「宿主没有原生席位」的老版本才需要它 |

<details>
<summary>本地开发（改完立刻生效）</summary>

```powershell
git clone https://github.com/wbb316/dsh-novel.git D:\dsh\plugins\dsh-novel-plugin
dsh plugin --profile web add link:D:/dsh/plugins/dsh-novel-plugin
```
`link:` 装的是软链，**源码改了就是改了**：客户端半（`lib/client.js`）刷新浏览器即可，宿主半（`lib/index.js` 等）要重启 `dsh web`。

</details>

---

## ✨ 面板能干什么

**🎬 一键续写 + 流式直播**：点「✍️ 写下一章」就把请求发进会话；模型正在写的字实时显示在面板里
（章节正文是当工具参数流出来的，所以从半截 JSON 里把 `content` 抠出来显示），写完自动刷出新章节。

**📝 开书向导（单独一页）**：点「＋ 新建」不是弹个小框、也不挤在列表下面，而是**整页切换**成向导 ——
基本 / 主角 / 世界观 / 大纲 / 进阶 五个折叠区，一页滚动，**任何字段都能留空**（先开书、再慢慢补）。
4 套模板（校园恋爱 / 都市异能 / 悬疑 / 空白）点一下**只补空着的字段**，绝不覆盖你已经写的；
点「创建这本书」一次性落盘：`设定.json` + 角色表（主角进"重要"档，外貌/想要/弱点/秘密拼进 `desc`）
+ `世界观.txt`（舞台/规则/禁忌/名词表）+ `大纲.txt`（三幕 + 灵感池）+ 剧情表的全书纲领
（可选顺手建一个空的第一章）。填了一半不想填了，点「✨ 让 AI 帮我补全」把这张表丢进对话，
缺的我替你定 —— 走的就是「写下一章」那条"写进输入框"的路。

**⚙️ 设定页能改 `设定.json`**：类型 / 基调 / 视角 / 每章目标字数 / 主线 / 结局 / 标签 / 备注
用**表单**改（跟向导同一套字段），想手改原文点「直接改 JSON」切过去；多写的键保存时会被丢掉。

**📚 小说库**：记住「你正在写哪本」+「每本读到哪一章」；书名那行点开就是列表（搜索 / 排序 / 进度 / 上次看到）；
可以就地改名、删除（**删除 = 移到回收站**，不是真删）。

**👥 角色 & 关系**：角色分**重要 / 不重要**两档，页面上就是两个入口（「重要的角色（N）」「不重要的角色（N）」），
点哪个看哪个 —— 连带只显示**跟这一档有关**的关系。**剧情里出现过的每个人都该在这儿**：带名字的路人也记，
放「不重要」并标明身份（比如「路人」）；头像可以是 **emoji / 姓氏**，也可以**上传图片**
（图片存进 `头像\` 目录，`角色.json` 里只记路径）；关系**可选**，用「从谁 → 什么关系 → 到谁」；
**关系图自动按亲疏摆位**（力导向：关系多的居中、关系近的挨着），节点还能手动拖。

**✏️ 改角色名 = 全文替换（唯一会动你正文的操作，所以格外小心）**：
在名字框里改了名字**不会直接生效**，会先弹一段确认，把「会改哪几个文件、各几处」列给你看
（先算再问）；点确定才动，而且**先把原件整份备份到 `_改名备份\<时间>\`** 再替换。
替换范围：大纲 / 世界观 / 所有章节正文 / 剧情表里的标题和备注；`人物卡.txt`、`剧情.txt` 是生成的，
不直接改（会跟着重新生成）。**只有一个字的名字不做全文替换**（「晓」出现在「晓得」里太正常了，盲替换会毁句子），
这种情况只改角色表并在确认框里说明。刚点「＋ 新角色」**还没保存**的角色直接改就行（正文里不可能有它）。

**📋 剧情（任务栏）**：把大纲拆成一条条**情节点**，按卷分组；每个情节点可以**挂 0~N 章**
（一个剧情写好幾章），**一章也能挂好几个情节点**；点 ☐/☑ **手动标记写完**，
另外宿主会按「挂的章节都有正文」算出**自动已写**（手勾优先，把正文删了自动那勾会自己掉）；
每卷还能写一段**纲领**（这一卷这十几章往哪走）。情节点里可以勾「出场角色」——
没记过的名字就地「＋ 记成路人」。点「✍️ 写下一章」时会**自动带上还没写的情节点 + 本卷纲领**。

**✍️ 章节自己也能写**：点「＋ 新章节」建个空章节，直接在面板里写正文（Ctrl+S 保存，
`.txt` 按纯文本存）；改名、删除、**按住拖动排序**（松手自动重新编号）都在同一行。
**分卷**：点「＋ 新建卷」分卷，章节按卷分组显示，**把章节拖到别的卷标题上就挪进那一卷**，卷能改名 / 删（删 = 整卷进回收站）。

**📂 保存位置可配置**：小说存哪个目录由你定，**目录不存在会自动创建**。

**⇪ 老格式一键迁移**：老项目（`outline.md` 那套）在设定页会提示，点一下转成新格式，
**原件搬进 `_旧格式备份\`**，不删。

**⬇ 导出**：点「⬇ 导出」选格式 —— `设定集.txt`（大纲 + 世界观 + 人物卡 + 章节清单）、
**EPUB**（能直接丢进阅读器，卷 = 分组）、**Word**（卷 = 标题 1，章 = 标题 2）。
EPUB/DOCX 是**自己写的 ZIP 打包器**（只用 Node 内置 `zlib`，零依赖）。

---

## 📁 目录结构

**每部小说就是一个文件夹**。正文和设定都是**纯文本**（双击记事本就能改），
只有"结构化的东西"才是 json —— 角色关系、剧情表都是数据，不是散文：

```
D:\dsh-novel\我的第一本小说\
├── 大纲.txt          人写、AI 读（随手写的散文/灵感）
├── 世界观.txt        人写、AI 读
├── 设定.json         数据源：类型 / 基调 / 视角 / 每章目标字数 / 主线 / 结局（面板「设定」页在改它）
├── 人物卡.txt        自动生成，给人/AI 看的镜像（别手改）
├── 角色.json         数据源：角色（分重要/不重要）+ 关系（面板「角色」页在改它）
├── 剧情.json         数据源：情节点 + 挂的章节 + 手勾状态 + 卷纲领（面板「剧情」页在改它）
├── 剧情.txt          自动生成，给人/AI 看的镜像（别手改）
└── chapters\
    ├── 第001章-开场.txt
    └── 第002章-第一次见面.txt
```

**为什么元信息也要 json**：类型 / 基调 / 视角 / 每章目标字数 / 主线 / 结局这几样是**机器要读**的
（写下一章时得知道"这本书是什么调子、一章大概多长"）。塞进 `大纲.txt` 那种散文里，agent 只能靠猜；
而把大纲改成结构化又违背"大纲就是你随手写散文的地方"。所以：**json 归 json，txt 一概不碰**。

**为什么角色关系不也用 txt**：只有结构化了，面板才能给你下拉选人、画关系图、
拦住「指向不存在的角色」。`人物卡.txt` 是渲染出来给你和 AI 读的镜像。

### 🕰️ 老格式照样能用（不会强行搬家）

老项目用 `outline.md` / `world.md` / `characters.md` / `characters.json` / `第NNN章-xxx.md`。规则：

- **读**：新旧名字、中英文、带不带扩展名都认（`大纲` / `outline` / `outline.md` 等价）
- **写**：改写已存在的文件就写回**它原来的名字**，不会偷偷生成一个 `大纲.txt`
- **新建**：新文件一律新格式；而且**整部小说要么全老名、要么全新名**，不混搭
- **纯文本**：写 `.txt` 时自动抹掉 markdown 记号（`#`、`**`、`>`）；`.md` 则原样保留

### 📂 小说存哪儿也能改

面板页脚「📁 小说保存位置」：填个路径，**目录不存在会自动创建**。
配置存在 `~/.dsh-novel/config.json`（跟 dsh-wechat 的 `~/.dsh-wechat/config.json` 一个路子）。

优先级：**环境变量 `DSH_NOVEL_ROOT` > 配置文件 > 默认 `D:\dsh-novel`**。
设了环境变量就以它为准（面板会明确告诉你改不动、以及为什么）。

```
D:\dsh\plugins\dsh-novel-plugin\
├── package.json              双面声明：宿主半（main / dsh.bundle）+ 客户端半（exports["./client"] / dsh.client）
├── cordis.patch.yml          把插件插进 DSH 的插件树
├── lib\
│   ├── index.js              宿主半：5 个 agent 工具 + 8 条浏览器 API（零 import）
│   ├── cast.js               角色/关系纯函数层：校验、增删改、渲染纯文本人物卡
│   ├── stream.js             流式缓冲：把模型增量帧折成"正在写的字" + 半截 JSON 抠字段
│   └── client.js             客户端半：「小说」面板（手写 createElement + SVG，无构建）
├── test-cast.mjs             角色/关系纯函数
├── test-stream.mjs           流式缓冲纯逻辑
├── test-config.mjs           保存位置（临时配置文件 + 临时目录，绝不碰真实配置）
├── test-library.mjs          小说库记忆纯逻辑（走 client.js 的 __test 后门）
├── test-schema.mjs           工具 schema + 只读工具真跑
├── test-api.mjs              浏览器 API（假 req/res 打真路由；只读 + 错误路径）
├── test-cordis.mjs           真 cordis 生命周期（动态注入 webServer 那条路径）
├── test-save.mjs             写盘路径（新格式 + 老格式兼容 + 改名删除 + 真建真删）
├── test-client.mjs           客户端半（迷你 React 递归渲染 + fetch 桩打真路由）
├── test-manifest.mjs         清单不变式：两个 inject 不许写混、peer/engines 声明齐
├── test-setup.mjs            开书向导的宿主半：设定.json 读写 + 一次性落盘 + 别把老项目带偏
└── probe-client-bundle.mjs   只读探针：算 rev 去问跑着的 DSH 要客户端 bundle
```

（可用环境变量 `DSH_NOVEL_ROOT` 换根目录，测试就靠它做隔离。）

---

## 🔧 它被装到哪个 profile

`dsh plugin add` 做的是两件事，出问题时可以手工改回来：

```
C:\Users\<你>\.dsh\profiles\<profile>\package.json
  dependencies        : "dsh-novel": "github:wbb316/dsh-novel"   ← 或者 link:D:/dsh/plugins/dsh-novel-plugin
  dsh.profile.bundles : 末尾加 "dsh-novel"
```

---

## 🤖 给 agent 的 5 个工具

| 工具 | 干什么 |
|---|---|
| `novel_list` | 列出所有小说 + 章节 + 角色数 |
| `novel_read` | 读设定（`设定.json`）/ 大纲 / 世界观 / 人物卡 / 某一章正文 |
| `novel_context` | **一次取全「续写下一章」所需上下文**（设定 + 大纲 + 世界观 + 角色关系 + 最近 N 章） |
| `novel_save_chapter` | 存盘，文件名自动编号 `第NNN章-标题.txt` |
| `novel_cast` | 读 / 增删改**角色与人物关系**；不传操作参数就是只读 |

`novel_cast` 的用法（关系两端写角色名或 id 都行）：

```jsonc
{ "novel": "我的第一本小说",
  "addCharacters":    [{ "name": "小李", "role": "配角", "tags": ["损友"] }],
  "updateCharacters": [{ "name": "小林", "role": "主角", "desc": "嘴硬心软" }],
  "removeCharacters": ["某个便当角色"],
  "addRelations":     [{ "from": "小李", "to": "小林", "type": "青梅竹马", "note": "唯一知道她秘密的人" }],
  "removeRelations":  [{ "from": "小李", "to": "小林", "type": "青梅竹马" }]
}
```

删角色会**连带删掉跟他有关的关系**；指错人会报错并列出可选角色（让模型能自我纠正）。

## 🌐 给面板的浏览器 API

挂在 GUI 的 webServer 上（做法抄 dsh-wechat 的 `/wechat/api/*`）：

| 路由 | 说明 |
|---|---|
| `GET  /novel/api/list` | 小说 + 章节 + 卷 + 设定文件 + 角色数 |
| `GET  /novel/api/read?novel=&file=` | 读一章正文 / 一个设定文件（卷里的章用 `卷名/文件名`）；`file=设定` 读设定，**没有这个文件也算正常**（返回默认值 + `exists:false`） |
| `GET  /novel/api/cast?novel=` | 读角色表（带 warnings / legacyMd / 图片头像地址） |
| `POST /novel/api/cast` | `{novel, cast}` 整表保存 / `{novel, ops}` 增量改 / **`{novel, rename:{from,to}, dryRun}` 改角色名**（dryRun 只统计；真改会先备份到 `_改名备份\` 再全文替换） |
| `GET  /novel/api/avatar?novel=&id=` | **图片头像**出图（没图 404，带正确 Content-Type） |
| `POST /novel/api/avatar` | 上传头像 `{novel, id, dataUrl}` / 去掉 `{action:'remove'}` |
| `POST /novel/api/save` | 存 `大纲.txt` / `世界观.txt` / `chapters\*.txt`；**`file=设定` 存设定**（`{settings:{…}}` 走对象入口，`{text:'{…}'}` 走文本入口，坏 JSON 会被拦住并说清原因） |
| `GET  /novel/api/stream?session=` | **流式输出**：正在写的字 + 预览类型（chapter/text/reasoning） |
| `POST /novel/api/chapter` | 章节 `create`（空章节，可带 `volume`）/ `rename` / `delete` / `reorder`（重新编号 + 挪卷） |
| `POST /novel/api/volume` | 卷 `create` / `rename` / `delete`（删卷 = 整卷进回收站） |
| `GET  /novel/api/plot?novel=` | **剧情表** + 进度（含"自动已写"判定）+ 章节/卷/角色（面板一次拿全） |
| `POST /novel/api/plot` | 整表保存剧情（同时渲染 `剧情.txt`） |
| `POST /novel/api/migrate` | 老格式一键迁移（原件搬进 `_旧格式备份\`） |
| `POST /novel/api/export` | 导出 `设定集.txt` / **EPUB** / **Word**（`{format}`） |
| `POST /novel/api/novel` | 小说 `create` / `rename` / `delete`（删除 = 移到回收站） |

⚠️ 路由是**按路径**注册的：`/novel/api/cast` 的 GET 和 POST 是**同一条路由**，
方法在 handler 里按 `req.method` 分。分成两条会抛 `duplicate exact route`，整个 API 全废（真踩过）。

写路径都带目录穿越校验；`characters.md` / `characters.json` 不给直接写（生成物 / 请走角色页）。

## 🪟 原生席位「小说」面板

面板挂在**宿主自带的席位系统**上，不依赖任何第三方插件（0.12.0 起）：

```js
// 左侧栏那一行：list 席位，要 id
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
  { name: "sidebar.panellist", id: "dsh-novel", order: 60, label: () => "小说" }, NovelPanelIcon))
// 主区页面：keyed 席位，key 要和上面的 id 对齐
ctx.slots.inject("main", () => ctx.slots.register(
  { name: "main", key: "dsh-novel" }, NovelPanelPage))
```

几个刻意的选择：

- **用 `ctx.slots.inject` 而不是直接 register**：`inject` 只在「席位真被声明」后才回调。
  宿主没有这个席位（比如老版本）→ 面板只是不出现，**绝不会把插件的加载搞崩**。
- **图标必须带 `data-dsh-panel-entry="dsh-novel"`**：那是宿主认的身份锚点，皮肤靠它定位这一行。
- **老宿主有回退**：没有 `ctx.slots` 时退回 `dsh-better-sidebar` 的右侧栏页签。
  但那个回退是**机会主义**的 —— `betterSidebar` **没有**写进 `dsh.client.inject`，
  所以那个插件卸了、没装，都不影响本插件加载。
- 面板页用 `NovelPanelPage` 包一层 `.dn_page`（撑满主区）再渲染 `NovelPanel` 本体。
- **两边 inject 写的不是同一种东西**：`package.json` → `dsh.client.inject` 写**包 id**
  （`@deepseek-ai/dsh-client-ui-renderer` / `-layout` / `-conversation`）；
  客户端半里 `exports.inject` 写**服务名**（`["slots"]`）。详见踩坑第 4 条。

功能（无论走哪条路都一样）：
- **✍️ 写下一章**：点一下就把续写请求**直接发进当前会话**（不用回去打字）：
  - 输入框是空的 → 替你填好并发送（`setDraft` + `submit('queue')`，agent 正忙就排队、不打断）
  - 输入框里已经有你打的字 → **只追加、绝不覆盖**，并提醒你按 Enter
  - 拿不到 conversation 服务 → 明确提示"直接在聊天里说"（全程 try/catch，不炸面板）
- **✍️ 直播间**：模型正在写的字**流式显示**在面板里（0.4 秒追一次）
  - 章节正文是当工具参数流出来的 → 从半截 JSON 里把 `content` 抠出来显示（这才是用户想看的）
  - 正文还没开始就先显示"🤔 正在想…"（reasoning），后两类自动降级
  - **写完后自动刷新章节列表** —— 新章不用手点就冒出来
- **章节**页：列出章节、点开看正文、默认跟着最新一章走（手动点旧章就停下不再跟随）
  - **✏️ 改名**：保留「第NNN章」编号，只换标题
  - **🗑️ 删除**：删前确认
- **📚 小说库（换小说不用重新找）**：面板记住「你正在写哪本」+「每本读到哪一章」
  - 书名那行点一下 → 展开列表：搜索 + 排序（最近在写 / 最近打开 / 名称）
  - 每本显示进度：`2 章 · 角色 1 人 · 2 小时前写过` + `上次看到：第2章 第一次见面…`
  - 切书再切回来会**回到那一章**；刷新浏览器、重开 DSH 也一样
  - 打开的那本被删掉 → 回落 + 明确告诉你为什么，不静默乱跳
  - 记忆按**小说库根目录**分组：换了小说库，两边互不干扰
  - 存 `localStorage`（键 `dsh-novel:library`）→ **刷新即生效，不用重启**；
    代价是**不跨设备**（手机上打开是另一套记忆）
- **自动刷新（5 档，可配置）**：面板可见时静默查一次，隐藏就停；**指纹没变就不重渲染**（不闪）
  | 档位 | 列表刷新 | 直播 | 说明 |
  |---|---|---|---|
  | 实时（默认） | 3 秒 | 0.4 秒 | 最跟手，请求最多 |
  | 普通 | 10 秒 | 2 秒 | 请求约 1/5 |
  | 省电 | 30 秒 | 不直播 | 只偶尔查一下 |
  | 关闭 | 不轮询 | 不直播 | 自己点「刷新」 |
  | 自定义 | 1–3600 秒 | 0–3600 秒 | 自己填；直播填 `0` = 不直播，最小 `0.2` 秒 |

  存在浏览器 `localStorage`（键 `dsh-novel:poll`；自定义的两个数值在 `dsh-novel:pollCustom`）
  → **改完立刻生效，不用重启 DSH**。自定义档会额外显示「**· 生效：** 列表 x 秒 · 直播 y 秒」——
  你填了 `0`（被夹到 1）或填了垃圾值（当不直播）都能一眼看出来；
  没有 localStorage（隐私模式）或存的值不合法就自动回落到「实时」。
- **设定页**：大纲 / 世界观**可编辑**（Ctrl+S 保存）；人物卡只读（它是生成的）
- **角色页**：
  - 角色列表 + 增删改（名字 / 定位 / 年龄 / 标签 / 简介）
  - **关系编辑**：从谁 → 什么关系 → 到谁，还能写备注
  - **🕸️ 关系图**：手写 SVG，角色摆成圈、关系连线带箭头和关系名；
    互指的两人两条线自动错开；点圆点切换选中的人（可折叠）
  - 保存后自动把 `characters.json` 渲染成人物卡 md 给 agent 读
  - 老项目（只有手写 md）会**先备份成 `.bak` 再接管**，并在界面上说明
- **＋ 新建小说**：书名 + 一句话简介 → 生成四份模板，直接进设定页开始设计

---

## 🧪 开发和自测（**不启动 DSH、不占端口**）

```powershell
cd D:\dsh\plugins\dsh-novel-plugin
node test-cast.mjs        # 角色/关系纯函数：脏数据、指错人、渲染纯文本人物卡
node test-bom.mjs         # BOM 守卫：仓库里不许有 BOM + 用户文件带 BOM 也要能读
node test-stream.mjs      # 流式缓冲：帧折叠、半截 JSON 抠字符串、preview 降级
node test-config.mjs      # 保存位置：自动建目录、夹取、环境变量优先、坏配置兜底
node test-library.mjs     # 小说库记忆（纯逻辑）：记住/回落/按库分组/坏数据/不跨设备
node test-schema.mjs      # 工具的 JSON Schema 是否合法 + 只读工具真跑一遍
node test-api.mjs         # 假 req/res 打真路由（只读 + 400 错误路径）
node test-cordis.mjs      # 真 cordis：先给 tools、后给 webServer，验证注入钩子会自己触发
node test-save.mjs        # 写盘全链路（临时小说里真建真删：新建/角色/存稿/改名/删除）
node test-volume.mjs      # 卷 / 章：跨卷挪动、卷名排序（第一卷<第二卷<第十卷）、删卷进回收站
node test-avatar.mjs      # 图片头像：上传/出图/换格式/删除/坏输入/脏数据
node test-ebook.mjs       # EPUB / DOCX：自写 readZip 往返比对 + w:t 必须在 w:r 里
node test-client.mjs      # 迷你 React 挂载面板（含子组件），fetch 桩打到真路由
node test-manifest.mjs    # 清单不变式：dsh.client.inject 写包、exports.inject 写服务名，别混
node test-setup.mjs       # 开书向导宿主半：设定.json 读写 + 一次性落盘 + 老项目不被带偏
```

目前 **1367 项断言全绿**。**你的小说文件永远不会被改**，但要说清楚各自在哪跑：

| 测试 | 在哪跑 | 会留下什么 |
|---|---|---|
| `test-save.mjs` | **你的真实小说库里**（只建 `__自测*` 临时作品） | 什么也不留 —— 跑完连它挪进回收站的那几份一起清，并有断言守着 |
| `test-api.mjs` | 同上，但只做 GET 和注定 400 的写请求 | 无 |
| `test-bom.mjs` | 仓库自己 + 临时小说根目录 | 无（整目录删掉）；它会**照原样复刻 dsh web 启动那一步**，BOM 一出现就红 |
| `test-volume.mjs` / `test-avatar.mjs` / `test-ebook.mjs` | 系统临时目录 | 无（整目录删掉）—— 卷、图片头像、EPUB/DOCX 都在这三个里 |
| `test-plot.mjs` | 系统临时目录 | 无 —— **剧情表**（情节点、挂章节、手勾 vs 自动、卷纲领） |
| `test-rename.mjs` | 系统临时目录 | 无 —— **改角色名**（dry-run 统计 / 备份 / 全文替换 / 单字名字不替换） |
| `test-client.mjs` / `test-config.mjs` | 系统临时目录 / 临时配置文件 | 无（整目录删掉） |
| `test-manifest.mjs` | **只读仓库自己的文件**（`package.json` + `lib/client.js`） | 无 —— 连临时目录都不用建 |
| `test-setup.mjs` | **你的真实小说库里**（只建两本 `__自测开书_*` 临时书） | 无（连它建的那两本一起删，跑完还有断言检查删干净了） |

> 早期版本这里踩过一次：`test-save` 把临时作品"删除"进真实回收站，清理却只删了原路径，
> 连跑几次就在用户回收站里堆了一堆垃圾。现在 `cleanup()` 会清自己的回收站条目，
> 并断言"回收站里没有留下测试垃圾"。

三个关键技巧：

1. **`test-cordis.mjs` 用 DSH 自带的真 cordis**，把「先只有 tools → 插件加载 → 之后 webServer
   才出现 → 注入钩子自动挂上路由」这个平时只有重启才看得到的时序在本地跑通。
2. **`test-client.mjs` 里的 fetch 桩**：面板以为自己在浏览器 fetch，其实请求转发给了
   `lib/index.js` 里**真实的**路由 handler → 「面板 → API → 磁盘文件」整条链路真跑一遍。
3. **迷你 React 会递归渲染子组件**，槽位 key = 「位置 + 组件类型名」（类型变了就重新挂载，
   跟真 React 一致——不然 hooks 会被张冠李戴，我就被这个坑过）。
   还有一条同类的：真 `React.createElement` 会把子节点**同时**放进参数和 `props.children`，
   桩也必须照做 —— 少这一条，组件里写 `props.children` 的代码在测试里会**凭空消失**
   （生产环境却是好的）。这种"测试比实现更严"的假红最费时间。

只想看看某个插件的客户端 bundle 有没有被服务端认出来：

```powershell
node probe-client-bundle.mjs dsh-novel D:\dsh\plugins\dsh-novel-plugin\lib\client.js
# rev 是文件字节的 sha1 前 12 位，200 = 服务端手里就是这份
```

---

## ⚠️ 踩坑清单（血泪）

1. **插件里绝对不要 `import` 任何 `@deepseek-ai/*` 包。**
   peerDependencies，`link:` 安装时 Node 从物理路径往上找不到 → `ERR_MODULE_NOT_FOUND`。
   `ctx.tools.register(普通对象)` 就够用；**相对路径 import 自己写的文件没问题**。
2. **普通对象工具的 schema 必须是原始 JSON Schema。**
   `properties.x.required = true` 会报 `schema.properties.text.required is not supported on type "string"`。
   正确：`{ type:'object', properties:{...}, required:['x'], additionalProperties:false }`；
   `array` + `items` 嵌套对象也支持。
3. **客户端半不用打包、不用 JSX。** 交付格式就是
   `window.__ModuleLoader__.load({ id, factory:(require)=>{...} })`，
   `require("react")` 由宿主提供，`react.createElement` 手写即可。
4. **两个 `inject` 不是一回事，v0.12.0 在这里栽过一次：**
   - `package.json` 的 **`dsh.client.inject`** = **包 id**，管"加载 / 排序"。
     ⚠️ **这一条我写错过，2026-09-30 晚更正**：我曾断言"inject 里的包必须有客户端半，
     否则插件整个不跑"，还把 `@deepseek-ai/dsh-client-ui-slots`（纯库）当反例写在这儿。
     后来在真机上扫了一圈 —— **已有 7 个正常工作的插件**（better-sidebar / wechat / at-file
     和家族那几个 UI 插件）同样把纯库写进 inject，它们都好好的；读宿主
     `dsh-client-modules` 也印证了：唯一会**真的抛错**的路径是 `initialBundleSnapshot()`,
     即**声明了 `dsh.client` 的包**读不到 bundle 文件时抛 `MissingClientBundleError`
     （启动审计里会大声报出来）。列一个没有客户端半的包不在这条路径上，最多是"这条依赖
     永远满足不了" ⇒ 那是 **⚠️ 无害但没意义**，不是 🛑。我的检查器已按这个改。
     要用 slot 服务，就得让**提供者**（`slots` 来自 `@deepseek-ai/dsh-client-ui-renderer`，
     ui-slots 的 README 原话：*"ui-renderer 将其用于 `ctx.slots.inject`"*）在加载列表里，
     而不是 ui-slots 这个纯库。
   - 客户端半里 `exports.inject` = **服务名**（`["slots"]` / `["slots","locale"]`），管"等服务起来"。
     **v0.12.0 那次事故最可疑的是这一处**（我当时把两处都写成了包 id）——不过两处是一起改的，
     所以"究竟是哪一处让面板消失"**没有定论**；按契约，服务名这处写错是明确的违规。
   判断依据永远去**读一个已经在跑的同类插件**，别凭字段名猜。
5. **webServer 不能写进顶层 `export const inject`**，那会拖住整个插件（工具一起等）；
   要动态注入：`ctx.inject(['webServer'], (c) => c.get('webServer').register(route))`。
6. **一个路径只能注册一条路由**（`registerApi` 里我加了防重复的自我保护）。
7. **自定义路由不受 0.1.5 的 web 认证（401）保护** —— 认证只挂在 `/` 和 `/api/*` 上。
8. **热更新不对称**：
   - 客户端半 `lib/client.js` 改了 → 服务端重算 rev，**刷新浏览器即可**
   - 宿主半 `lib/index.js` / `cast.js` 改了 → **必须重启 `dsh web`**
9. **面板里写「保存」别用闭包里的旧 state** 去算下一个 state
   （用 `setX(v => ...)` 函数式更新），否则连续操作会互相覆盖。
10. **要"蹭"别的插件的服务**（比如把消息发进对话输入框），就
    `ctx.get('服务名')` + 每一步判空 + 全程 try/catch，**拿不到就明确降级提示**，
    绝不让自己的面板崩掉。参照实现：`dsh-better-sidebar/src/client/conversation-draft.ts`。
11. **想看"正在写的字"，DSH 0.1.5 已经没有 `assistant/chunk` 事件了** ——
    要订阅内存帧 `ctx.on('agent/assistant-stream')`，自己把 start/chunk/end 折起来
    （0.1.2 的做法在 0.1.5 上拿不到任何东西）。
12. **章节正文通常是当工具参数流出来的**：chunk 类型是 `tool-call-delta`（字段 `argumentsDelta`），
    **不是** `text-delta`。只盯 text-delta 的话，直播间里只会看到"好的，我这就写"。
    要从小到大拼接 `argumentsDelta` 再从**半截 JSON** 里抠 `content`（转义符随时会断在中途）。
13. **轮询要"指纹化"**：定时器每次拿到数据先比指纹/版本号，没变就原样返回旧 state
    （`setX(s => s)`），否则界面会每 3 秒白闪一次。
14. **写盘类测试必须自己先清场**：有一次测试往真实根目录写了垃圾目录，下一次再跑时
    "文件已存在"直接绕过了新加的守卫，我差点以为守卫生效了。
    所以 `test-save` 开头就清、结尾再清，还断言"根目录里只剩你真正的小说"。
15. **改文件格式时，"读"和"写"要分开想**：读要尽量宽容（新旧名、中英文、带不带扩展名都认），
    写要认准目标（改哪个文件就写回哪个名字）。混在一起想，就会忍不住给用户偷偷搬家。
16. **"删除"的测试要连"挪到哪"一起清**：本插件的删除是**移到回收站**，
    所以测试光删原路径不够 —— 回收站会越跑越脏。清理逻辑要对准"我产生了哪些副作用"，
    而不是"我原本打算删哪个路径"。
17. **UI 功能必须有一条"入口真的在界面上"的断言**：📁 保存位置那次，宿主接口 + 组件都写好了，
    就是忘了把按钮挂上去 —— 功能等于不存在，而所有测试都是绿的。现在每个新入口都有一条
    `ok('标题栏有 📁 按钮', …)`。
18. **文本文件开头千万别有 UTF-8 BOM**（`EF BB BF`）。`JSON.parse` **不认 BOM**，
    `JSON.parse('\uFEFF{}')` 直接抛 `SyntaxError: Unexpected token '\uFEFF'`。
    真踩过两次：
    - **插件自己的 `package.json` 被带 BOM 保存** → dsh web 启动时
      `loadProfileDirectory` 里那句 `JSON.parse(readFileSync(pkg,'utf8'))` 抛错 →
      `composeProfile` 阶段就退出 → **3080 根本没监听**。症状只是"网页打不开"，
      跟插件八竿子打不着，能查半天。
    - 用户拿**记事本**改了一下 `角色.json` / `~/.dsh-novel/config.json` → 插件读的时候就炸。

    谁写的 BOM：**PowerShell 5.1 的 `Set-Content -Encoding UTF8` / `Out-File`、记事本的
    「另存为 UTF-8」都会加**（VS Code 默认不加；仓库里放了 `.editorconfig` 写着 `charset = utf-8`）。
    所以规矩是两头堵：读进来的文本一律过 `lib/text.js` 的 `stripBom()`；
    仓库里用 `test-bom.mjs` 盯着（它连 DSH 启动那一步都照原样复刻了）。

    ⚠️ **这台机器上的 shell 就是 Windows PowerShell 5.1**（`$PSVersionTable.PSVersion` =
    `5.1.26100`）—— 也就是说 "`Set-Content` 会加 BOM" 不是历史知识，是这里随时会发生的事。
    要写文件就用写文件工具或 `node`，别用 `Set-Content` / `Out-File` / `>`。

    DSH 那一侧的加固也做了（不只是在插件里躲）：`D:\tools\dsh-app-boot-bom-patch\`
    给 `dsh-app-boot` 打了个补丁，让它读 profile / bundle 的 `package.json` 时自己剥 BOM ——
    **别人**用记事本写出来的插件也不会再把整个 web 打挂。升级 dsh 后重跑一次 `apply.mjs`。
19. **"我的测试全绿"和"外部工具能打开"是两件事。** 导 DOCX 那次：自己写的 ZIP 能解开、
    XML well-formed、90 项断言全过 —— 结果**真 Word 直接打不开**，因为 `<w:t>` 没包在
    `<w:r>` 里（非法 OOXML，但在 XML 层面完全合法，解压工具也看不出）。
    教训是两条：① **能拿外部标准工具验的，就别只信自己的测试**（EPUB 用 `epubcheck`，
    DOCX 用真 Word，BOM 用"照原样复刻启动那一步"）；
    ② **把外部工具抓到的坑写回测试** —— 现在 `test-ebook.mjs` 里有
    "每个 `w:t`/`w:br` 都必须在 `w:r` 里"，而且我特意把修复撤掉跑过一遍，确认它是**红的**。
20. **改完一件事，要回头 grep 一遍"所有提到它的地方"。** 这个毛病我犯了至少三次：
    - README 的「还没做」列表：功能做完了没划掉，用户截图来问
    - 断言数：新加了几条测试没同步，badge 和正文都是旧的
    - **v0.11.0 的 Release 正文**：修复只写进了新的 v0.11.1，
      旧那页还挂着"没跑 epubcheck / 没在真 Word 里打开过 docx" —— 而那个版本的 docx
      恰恰是坏的，等于在原地埋雷

    新增/修正的东西**总是**分布在不同地方：README、Release 正文、踩坑清单、测试表、
    `package.json` 描述。规矩：**改完立刻 `grep` 关键词（数字、功能名、"还没做"）扫一遍**，
    别只改你正在看的那一处。
21. **Release 正文是写给"陌生人"的，不是写给自己看的日记。** 第一版 v0.11.1 的说明里
    写了"我原来 90 项断言全绿""用你真实那本《学妹》验的""我把修复撤掉跑过一遍"——
    用户一句话点破：*"这个读起来怪怪的，不像给别人读的。"*
    规矩：Release / README 首页这类**外人先看到的地方**，只用"这个版本改了什么、
    对你有什么影响、你怎么自己验"三件事说话；
    "我踩了什么坑、我测试怎么写的"留给**踩坑清单**（那里本来就是日记体，反而合适）。
    另外：**先想清楚这段文字是给谁看的**，再动笔。
22. **面板别挂在第三方插件上 —— 0.2.0 起宿主自己就有席位系统。** 老写法是借
    `ctx.betterSidebar.registerTab()` 往右侧栏塞页签，代价是：那个插件一卸，面板就没了；
    它的 peer 范围一变，连宿主升级都会被它拦住（这次升级真的被拦过一次）。
    新写法是宿主的 `ctx.slots`：`inject("sidebar.panellist")` 拿左侧栏那一行、
    `inject("main")` 拿主区页面。三条经验：
    - **用 `slots.inject` 而不是直接 `register`**：inject 的回调只在席位被声明后才跑，
      宿主没这个席位就只是面板不出现，**不会让插件加载失败**（注释里原话：*a shell that never
      declares it leaves the panel simply absent instead of failing boot*）。
    - **list 席位要 `id`、keyed 席位要 `key`，而且 key 要和左侧栏那条的 id 对齐**；
      直接 register 一个没声明的席位会抛 `slot "X" is not declared`。
    - **"机会主义回退"不能写进 `dsh.client.inject`**：那个字段是**加载 / 排序声明** ——
      写进去就等于告诉宿主"我依赖它"，而回退路要的恰恰是"没它也能跑"（更正：我原来在这里
      写成"硬依赖，等不到就整个客户端半不加载"，那句跟第 4 条的更正一起作废）。
      想让老三方侧栏当回退，就用 `ctx.get("betterSidebar")` 去试探，别写进 inject。
23. **升级宿主前，先跑"启动闸门"预检。** 0.2.0 起宿主启动时会读每个 bundle 的
    `peerDependencies`：只要有一个 `@deepseek-ai/dsh*` 的范围不满足当前版本，
    `loadProfileDirectory` 就 **throw，Web 服务根本没机会监听**（症状又是"网页打不开"，
    和当年那个 BOM 事故一模一样的体感）。所以本插件现在**主动声明**了 peer 范围 +
    `dsh.engines.dsh`：与其"靠兼容性侥幸活着"，不如让宿主在装错版本时**明确拦住**。
24. **同一个 tick 里连改两个字段，闭包里的旧 state 会把前一个吃掉。** 开书向导里我一开始写
    `set({ ...d, name: v })`（`d` 是本次 render 的 state）—— 测试里连着设「书名 + 简介」，
    **书名就没了**：两次 `onChange` 都攥着同一个旧 `d`，后一次把前一次覆盖掉。真人粘贴、
    连着点模板同样会中招，而且界面上完全看不出来。
    规矩：**凡是"基于当前 state 算下一个 state"，一律用函数式更新** `set((prev) => ({ ...prev, x: v }))`。
    （这个 bug 是测试先抓到的 —— 它值得为它写一条断言。）
25. **往 `LAYOUT` 里加文件之前，先想清楚 `isLegacyProject()` 会怎么判。** `设定.json` 我本来想直接
    加进 `LAYOUT`（那里是"新名 ↔ 老名"对照表）。但 `isLegacyProject()` 的逻辑是
    "**只要发现任何一个老名字存在，整本书就按老格式走**"，而 `pickFile()` 会去
    `path.join(dir, spec.old)` —— `设定.json` 没有老英文名，塞进去的结果是**每一本新书都被判成老项目**，
    大纲转头去读根本不存在的 `outline.md`。最后它做成了独立的固定文件名，在别名分支前单独拦一道，
    并且专门写了一条断言盯着："有 设定.json 的书，大纲仍解析到 大纲.txt"。

---

## 🔍 怎么自己验证 EPUB / Word

导出的 `.epub` / `.docx` 是插件**自己写的 ZIP 打包器**打的，所以值得亲自验一遍
（v0.11.0 就是这么翻的车：docx 里的 `<w:t>` 没包在 `<w:r>` 里 —— ZIP 解压正常、
XML well-formed、自动断言全绿，**但 Word 弹"Word 在试图打开文件时遇到错误"**）；
所以导出格式的规矩是：**能拿外部工具验的，就别只信自己的测试**（见踩坑第 19 条）。

```powershell
# 1) EPUB：用 W3C 官方的 epubcheck（要 Java 11+）
#    下载： https://github.com/w3c/epubcheck/releases  （解开就能用）
java -jar epubcheck.jar "D:\dsh-novel\我的小说\我的小说.epub"
# 期望： No errors or warnings detected.

# 2) DOCX：用你机器上真的 Word 打开（隐藏窗口，不改文件）
$w = New-Object -ComObject Word.Application
$w.Visible = $false; $w.DisplayAlerts = 0
$d = $w.Documents.Open("D:\dsh-novel\我的小说\我的小说.docx", $false, $true, $false)
"$($d.Paragraphs.Count) 段 / $($d.ComputeStatistics(2)) 页"
$d.Close(0); $w.Quit()
```

最省事的办法：**直接双击**。EPUB 丢进任何阅读器（微信读书 / Calibre / Thorium），
DOCX 双击用 Word 或 WPS 打开 —— 能翻页、标题有层级、没有 `#` `**` 这种记号，就是对的。

---

## 🚧 还没做

- 多设备同步（小说库记忆现在存在浏览器本地，手机上打开是另一套）

> v0.13.0 加了**开书向导**（整页 / 五个折叠区 / 4 套只补空位的模板 / 「✨ 让 AI 帮我补全」）
> 和机器可读的 **`设定.json`**（类型 / 基调 / 视角 / 每章目标字数 / 主线 / 结局），
> 设定页能用表单改，`novel_context` 续写时会先把它读给你听。
> v0.12.0 把面板从**第三方侧栏**迁到了**宿主原生席位**（左侧栏一行 + 主区页面，不再依赖
> dsh-better-sidebar），并主动声明了 peer 范围 + `dsh.engines.dsh`，让宿主能在版本不匹配时拦住。
> 更早的 v0.11.0 做完：卷 / 章、关系图自动布局（力导向）、图片头像、EPUB / Word 导出。
> 见 [Releases](https://github.com/wbb316/dsh-novel/releases)。
