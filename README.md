# dsh-novel 🖋️

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-0.1.5%2B-4d6bfe.svg)](https://github.com/deepseek-ai)
[![sidebar](https://img.shields.io/badge/needs-dsh--better--sidebar-7e57c2.svg)](https://github.com/omdsh-dev/DSH-better-sidebar)
[![tests](https://img.shields.io/badge/tests-686%20assertions-success.svg)](#-开发和自测不启动-dsh不占端口)

DSH 插件：**小说创作台**。管你的小说项目（大纲 / 世界观 / 角色 & 关系 / 章节），
一半给 agent 用（`novel_*` 工具），一半给人用（右侧栏「小说」面板）。

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

**前置条件**

| | 说明 |
|---|---|
| DSH | `0.1.5` 或更高（用到了 `agent/assistant-stream` 流式帧） |
| Node | `>= 20` |
| [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 侧栏面板的容器；**不装的话工具照常可用，只是没有面板** |

<details>
<summary>本地开发（改完立刻生效）</summary>

```powershell
git clone https://github.com/wbb316/dsh-novel.git D:\dsh-novel-plugin
dsh plugin --profile web add link:D:/dsh-novel-plugin
```
`link:` 装的是软链，**源码改了就是改了**：客户端半（`lib/client.js`）刷新浏览器即可，宿主半（`lib/index.js` 等）要重启 `dsh web`。

</details>

---

## ✨ 面板能干什么

**🎬 一键续写 + 流式直播**：点「✍️ 写下一章」就把请求发进会话；模型正在写的字实时显示在面板里
（章节正文是当工具参数流出来的，所以从半截 JSON 里把 `content` 抠出来显示），写完自动刷出新章节。

**📚 小说库**：记住「你正在写哪本」+「每本读到哪一章」；书名那行点开就是列表（搜索 / 排序 / 进度 / 上次看到）；
可以就地改名、删除（**删除 = 移到回收站**，不是真删）。

**👥 角色 & 关系**：角色卡增删改，关系用「从谁 → 什么关系 → 到谁」，**关系图可以拖**，位置记在本地。

**📂 保存位置可配置**：小说存哪个目录由你定，**目录不存在会自动创建**。

---

## 📁 目录结构

**每部小说就是一个文件夹**。正文和设定都是**纯文本**（双击记事本就能改），
只有角色关系是结构化数据 —— 因为关系是数据，不是散文：

```
D:\dsh-novel\我的第一本小说\
├── 大纲.txt          人写、AI 读
├── 世界观.txt        人写、AI 读
├── 人物卡.txt        自动生成，给人/AI 看的镜像（别手改）
├── 角色.json         数据源：角色 + 关系（面板「角色」页在改它）
└── chapters\
    ├── 第001章-开场.txt
    └── 第002章-第一次见面.txt
```

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
D:\dsh-novel-plugin\
├── package.json              双面声明：宿主半（main / dsh.bundle）+ 客户端半（exports["./client"] / dsh.client）
├── cordis.patch.yml          把插件插进 DSH 的插件树
├── lib\
│   ├── index.js              宿主半：5 个 agent 工具 + 8 条浏览器 API（零 import）
│   ├── cast.js               角色/关系纯函数层：校验、增删改、渲染纯文本人物卡
│   ├── stream.js             流式缓冲：把模型增量帧折成"正在写的字" + 半截 JSON 抠字段
│   └── client.js             客户端半：右侧栏「小说」面板（手写 createElement + SVG，无构建）
├── test-cast.mjs             角色/关系纯函数
├── test-stream.mjs           流式缓冲纯逻辑
├── test-config.mjs           保存位置（临时配置文件 + 临时目录，绝不碰真实配置）
├── test-library.mjs          小说库记忆纯逻辑（走 client.js 的 __test 后门）
├── test-schema.mjs           工具 schema + 只读工具真跑
├── test-api.mjs              浏览器 API（假 req/res 打真路由；只读 + 错误路径）
├── test-cordis.mjs           真 cordis 生命周期（动态注入 webServer 那条路径）
├── test-save.mjs             写盘路径（新格式 + 老格式兼容 + 改名删除 + 真建真删）
├── test-client.mjs           客户端半（迷你 React 递归渲染 + fetch 桩打真路由）
└── probe-client-bundle.mjs   只读探针：算 rev 去问跑着的 DSH 要客户端 bundle
```

（可用环境变量 `DSH_NOVEL_ROOT` 换根目录，测试就靠它做隔离。）

---

## 🔧 它被装到哪个 profile

`dsh plugin add` 做的是两件事，出问题时可以手工改回来：

```
C:\Users\<你>\.dsh\profiles\<profile>\package.json
  dependencies        : "dsh-novel": "github:wbb316/dsh-novel"   ← 或者 link:D:/dsh-novel-plugin
  dsh.profile.bundles : 末尾加 "dsh-novel"
```

---

## 🤖 给 agent 的 5 个工具

| 工具 | 干什么 |
|---|---|
| `novel_list` | 列出所有小说 + 章节 + 角色数 |
| `novel_read` | 读大纲 / 世界观 / 人物卡 / 某一章正文 |
| `novel_context` | **一次取全「续写下一章」所需上下文**（大纲 + 世界观 + 角色关系 + 最近 N 章） |
| `novel_save_chapter` | 存盘，文件名自动编号 `第NNN章-标题.md` |
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
| `GET  /novel/api/list` | 小说 + 章节 + 设定文件 + 角色数 |
| `GET  /novel/api/read?novel=&file=` | 读一章正文 / 一个设定文件 |
| `GET  /novel/api/cast?novel=` | 读角色表（带 warnings / legacyMd 标记） |
| `POST /novel/api/cast` | `{novel, cast}` 整表保存，或 `{novel, ops}` 增量改 |
| `POST /novel/api/save` | 存 `outline.md` / `world.md` / `chapters\*.md` |
| `GET  /novel/api/stream?session=` | **流式输出**：正在写的字 + 预览类型（chapter/text/reasoning） |
| `POST /novel/api/chapter` | 章节 `rename` / `delete` |
| `POST /novel/api/novel` | 新建小说（建目录 + 四份模板） |

⚠️ 路由是**按路径**注册的：`/novel/api/cast` 的 GET 和 POST 是**同一条路由**，
方法在 handler 里按 `req.method` 分。分成两条会抛 `duplicate exact route`，整个 API 全废（真踩过）。

写路径都带目录穿越校验；`characters.md` / `characters.json` 不给直接写（生成物 / 请走角色页）。

## 🪟 右侧栏「小说」面板

借 `dsh-better-sidebar` 的 `ctx.betterSidebar.registerTab({id,title,order,single,component})` 注册：

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
cd D:\dsh-novel-plugin
node test-cast.mjs        # 角色/关系纯函数：脏数据、指错人、渲染纯文本人物卡
node test-stream.mjs      # 流式缓冲：帧折叠、半截 JSON 抠字符串、preview 降级
node test-config.mjs      # 保存位置：自动建目录、夹取、环境变量优先、坏配置兜底
node test-library.mjs     # 小说库记忆（纯逻辑）：记住/回落/按库分组/坏数据/不跨设备
node test-schema.mjs      # 工具的 JSON Schema 是否合法 + 只读工具真跑一遍
node test-api.mjs         # 假 req/res 打真路由（只读 + 400 错误路径）
node test-cordis.mjs      # 真 cordis：先给 tools、后给 webServer，验证注入钩子会自己触发
node test-save.mjs        # 写盘全链路（临时小说里真建真删：新建/角色/存稿/改名/删除）
node test-client.mjs      # 迷你 React 挂载面板（含子组件），fetch 桩打到真路由
```

目前 **599 项断言全绿**，且**不碰你的真实数据**：

- `test-save.mjs` / `test-client.mjs` 都把 `DSH_NOVEL_ROOT` 指到一个**临时目录**，跑完删掉
- `test-api.mjs` 只做 GET 和注定 400 的写请求

三个关键技巧：

1. **`test-cordis.mjs` 用 DSH 自带的真 cordis**，把「先只有 tools → 插件加载 → 之后 webServer
   才出现 → 注入钩子自动挂上路由」这个平时只有重启才看得到的时序在本地跑通。
2. **`test-client.mjs` 里的 fetch 桩**：面板以为自己在浏览器 fetch，其实请求转发给了
   `lib/index.js` 里**真实的**路由 handler → 「面板 → API → 磁盘文件」整条链路真跑一遍。
3. **迷你 React 会递归渲染子组件**，槽位 key = 「位置 + 组件类型名」（类型变了就重新挂载，
   跟真 React 一致——不然 hooks 会被张冠李戴，我就被这个坑过）。

只想看看某个插件的客户端 bundle 有没有被服务端认出来：

```powershell
node probe-client-bundle.mjs dsh-novel D:\dsh-novel-plugin\lib\client.js
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
4. **`dsh.client.inject`（客户端包 id，管加载顺序）** 和客户端 **`exports.inject`（服务名）**
   不是一回事，别混。
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

---

## 🚧 还没做

- 章节的新建（空章节）/ 拖拽排序
- 关系图的手动拖拽布局（现在是自动摆圈）
- 角色头像 / 导出设定集
- 面板里直接改章节正文（现在正文由 agent 写，面板只看）
- 老格式一键迁移（现在**只兼容、不搬家** —— 想搬随时说）
