/**
 * dsh-novel —— 小说创作台（v0.4，宿主侧）
 *
 * 目录约定：
 *   D:\dsh-novel\<书名>\
 *     ├── outline.md        大纲        （人可改）
 *     ├── characters.json   角色 & 关系（数据源，人可改）
 *     ├── characters.md     人物卡      （**生成物**，别手改）
 *     ├── world.md          世界观      （人可改）
 *     └── chapters\第001章-xxx.md
 *
 * 工具：
 *   novel_list          列出所有小说 + 章节
 *   novel_read          读某个设定文件 / 某一章正文
 *   novel_context       一次取出「续写下一章」所需的全部上下文（大纲+人物+设定+最近N章）
 *   novel_save_chapter  把写好的章节存盘（文件名自动编号）
 *   novel_cast          读 / 增删改角色与人物关系（数据源 characters.json，自动同步 characters.md）
 *
 * 浏览器 API（给右侧栏「小说」面板用）：
 *   GET  /novel/api/list                 列出所有小说 + 章节 + 有哪些设定文件
 *   GET  /novel/api/read?novel=&file=    读一章正文 / 一个设定文件
 *   GET  /novel/api/cast?novel=          读角色表
 *   POST /novel/api/cast                 {novel, cast} 整表替换 或 {novel, ops} 增量改
 *   POST /novel/api/save                 {novel, file, text} 存设定文件 / 章节
 *   POST /novel/api/novel                {name, intro?} 新建小说（建目录 + 三份模板）
 *
 * ⚠️ 血泪经验（都踩过）：
 *
 * 1) 插件**不要 import 任何 `@deepseek-ai/*` 宿主包**（peerDependencies，
 *    link 安装时 Node 从物理路径往上找 → ERR_MODULE_NOT_FOUND）。
 *    `ctx.tools.register(...)` 直接接受**普通对象**。相对路径 import 自己的文件没问题。
 *
 * 2) 普通对象里的 `parameters` / `output.schema` 必须是**原始 JSON Schema**：
 *       ✗ spec : { properties: { x: { type:'string', required:true } } }
 *       ✓ raw  : { type:'object', properties: { x: { type:'string' } }, required:['x'] }
 *
 * 3) 改完代码先跑本地测试（不启动 DSH、不占端口）：
 *    test-schema / test-cast / test-api / test-cordis / test-client / test-save
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptyCast, parseCastJson, normalizeCast, applyCastOps, renderCastText, castSummary } from './cast.js'
import { createStreamBuffer } from './stream.js'
import { readText, readJson, parseJsonText } from './text.js'
import { buildEpub, buildDocx } from './ebook.js'

/**
 * 流式输出缓冲（模块级单例：路由读它，事件订阅往里写）。
 * 宿主侧 `agent/assistant-stream` 帧 → 攒成"正在写的字" → /novel/api/stream 给面板轮询。
 */
const streamBuffer = createStreamBuffer()

/** 文本型工具的共用输出契约：execute 返回 { text }，render 转成文本块 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '返回给模型的文本' }
    },
    required: ['text'],
    additionalProperties: false
  },
  render: (_args, value) => [{ type: 'text', text: String((value && value.text) ?? '') }]
}

// ─────────────────── 保存位置（可配置） ───────────────────
/**
 * 小说存哪儿，三层优先级（前面的赢）：
 *   1. 环境变量 `DSH_NOVEL_ROOT`（给测试和高级用户；设了就锁死，面板改不动）
 *   2. 配置文件 `~/.dsh-novel/config.json`（面板里改，**目录不存在会自动创建**）
 *   3. 默认 `D:\dsh-novel`
 *
 * 配置文件的位置跟生态惯例一致（dsh-wechat 用的是 `~/.dsh-wechat/config.json`）。
 * 测试可以用 `DSH_NOVEL_CONFIG` 把它指到临时目录，免得碰用户真实配置。
 */
const DEFAULT_ROOT = 'D:\\dsh-novel'
const CONFIG_FILE = process.env.DSH_NOVEL_CONFIG || path.join(os.homedir(), '.dsh-novel', 'config.json')

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {}
    const raw = readJson(CONFIG_FILE) // 记事本改过的 config.json 可能带 BOM，readJson 会去掉
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {} // 配置文件坏了就当没有，绝不拖垮插件
  }
}

function saveConfig(patch) {
  const next = Object.assign(loadConfig(), patch)
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/** 存下来的自定义根目录（没配就是 undefined） */
let savedRoot = loadConfig().root

/** 环境变量里的根目录（空串当没设） */
function envRoot() {
  const v = process.env.DSH_NOVEL_ROOT
  return v && String(v).trim() ? String(v).trim() : ''
}

/** 当前生效的小说根目录 */
function novelRoot() {
  const e = envRoot()
  if (e) return path.resolve(e)
  if (savedRoot && String(savedRoot).trim()) return path.resolve(String(savedRoot).trim())
  return DEFAULT_ROOT
}

/** 根目录的完整状态（面板靠它解释"为什么是这个路径"） */
function rootInfo() {
  const e = envRoot()
  const root = novelRoot()
  const fromConfig = !e && savedRoot && String(savedRoot).trim()
  return {
    root,
    source: e ? 'env' : fromConfig ? 'config' : 'default',
    sourceLabel: e ? '环境变量 DSH_NOVEL_ROOT' : fromConfig ? '面板设置' : '默认位置',
    exists: fs.existsSync(root),
    canEdit: !e,
    configFile: CONFIG_FILE,
    saved: savedRoot || null,
    env: e || null
  }
}

/** 改根目录：不存在就**自动创建**；返回新状态（带 created 标记） */
function setRoot(input) {
  if (envRoot()) {
    throw new Error(
      '环境变量 DSH_NOVEL_ROOT 优先级更高（' + envRoot() + '）—— 用面板改不生效，要去掉那个环境变量才行'
    )
  }
  const raw = String(input || '').trim()
  if (!raw) throw new Error('路径不能为空')
  const abs = path.resolve(raw)
  let created = false
  if (fs.existsSync(abs)) {
    if (!fs.statSync(abs).isDirectory()) throw new Error('这个路径已经是一个文件了，请换一个目录')
  } else {
    fs.mkdirSync(abs, { recursive: true }) // ← 「没有目录就自动创建」
    created = true
  }
  savedRoot = abs
  saveConfig({ root: abs })
  return Object.assign({ created }, rootInfo())
}

/** 是不是一本小说的目录（以 . 开头的是内部目录，比如回收站） */
function isNovelDir(d) {
  return d.isDirectory() && !d.name.startsWith('.')
}

/** 列出所有小说项目及其章节 */
function listNovels() {
  const root = novelRoot()
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(isNovelDir)
    .map((d) => {
      const dir = path.join(root, d.name)
      return { name: d.name, dir, chapters: readChapters(dir) }
    })
}

/** 读某部小说里的一个文件（带目录穿越校验） */
function readNovelFile(novelName, relative) {
  const { target } = safeResolve(novelName, relative)
  if (!fs.existsSync(target)) throw new Error(`文件不存在：${relative}`)
  return readText(target)
}

// ─────────────────── 文件布局（新中文名 + 老英文名都认） ───────────────────
/**
 * 每部小说就是**一个文件夹**，里面固定这么几样东西：
 *
 *   <书名>\
 *     ├── 大纲.txt        人写、AI 读（纯文本）
 *     ├── 世界观.txt      人写、AI 读（纯文本）
 *     ├── 人物卡.txt      自动生成，给人/AI 看的镜像
 *     ├── 角色.json       数据源：角色 + 关系（面板「角色」页在改它）
 *     └── chapters\第NNN章-标题.txt
 *
 * 老项目用的是 `outline.md` / `world.md` / `characters.md` / `characters.json`
 * 和 `第NNN章-xxx.md` —— **照旧能读、也照旧写回原文件**（只为新文件用新名字）。
 */
const LAYOUT = {
  outline: { now: '大纲.txt', old: 'outline.md', label: '大纲' },
  world: { now: '世界观.txt', old: 'world.md', label: '世界观' },
  castText: { now: '人物卡.txt', old: 'characters.md', label: '人物卡（生成）', generated: true },
  castData: { now: '角色.json', old: 'characters.json', label: '角色数据', data: true }
}
/** 章节的扩展名（新旧都认；新建一律 .txt） */
const CHAPTER_EXT = '.txt'
const CHAPTER_OLD_EXT = '.md'
const CHAPTERS = 'chapters'
const chapterRe = /\.(txt|md)$/i

// ─────────────────── 卷（chapters 下的子目录） ───────────────────
/**
 * 卷就是 `chapters\` 下的一个**子目录**：
 *
 *   chapters\第001章-开场.txt                   ← 未分卷（平铺）
 *   chapters\第一卷 恋爱练习\第002章-x.txt        ← 第一卷里的第 2 章
 *
 * 规矩：
 * - **章节号是全局连续的**（第002章 不会因为进了第一卷就变成第001章）——
 *   这样删/挪章节时不会互相撞名，也让"第几章"始终唯一。
 * - 对外一律用 **id** 说话：`第一卷 恋爱练习/第002章-x.txt`（`/` 分隔，跨平台一致）。
 * - **老项目（全平铺）什么都不用改**：拿到的 id 就是原来那串文件名。
 */
const ID_SEP = '/' // id 里的分隔符固定用 `/`（磁盘上该用什么由 path.join 负责）

/** id → { volume, name }；允许卷名里再套一层（volume 就是最后一段之前的所有东西） */
function splitChapterId(id) {
  const s = String(id || '').replace(/\\/g, ID_SEP)
  const i = s.lastIndexOf(ID_SEP)
  return i < 0 ? { volume: '', name: s } : { volume: s.slice(0, i), name: s.slice(i + 1) }
}

/** id → 磁盘上的绝对路径 */
function chapterPath(base, id) {
  const { volume, name } = splitChapterId(id)
  return path.join(base, CHAPTERS, ...(volume ? [volume] : []), name)
}

/**
 * 卷的排序键：能从「第N卷 / 第N部 / 第N篇」里抠出号就用号（**阿拉伯数字和中文数字都认**），
 * 抠不出来（比如卷名就叫「恋爱练习」）就排在有号的后面、彼此按名字比。
 *
 * 为什么要自己抠：单纯 localeCompare 会把「第一卷」排到「第2卷」后面（汉字的次序很反直觉），
 * 而写网文的人几乎一定是「第一卷 / 第二卷 / ……」这么写的。
 */
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/** 把「十 / 十一 / 二十 / 二十三」这种中文数字转成阿拉伯数字（只处理 1~99，够用了） */
function cnNumber(s) {
  if (/^\d+$/.test(s)) return Number(s)
  if (s === '十') return 10
  let m = /^十([一二三四五六七八九])$/.exec(s)
  if (m) return 10 + CN_NUM[m[1]]
  m = /^([一二三四五六七八九])十([一二三四五六七八九])?$/.exec(s)
  if (m) return CN_NUM[m[1]] * 10 + (m[2] ? CN_NUM[m[2]] : 0)
  return CN_NUM[s] ?? null
}

function volumeRank(name) {
  const m = /^第\s*(\d+|[一二三四五六七八九十两]+)\s*[卷部篇]/.exec(String(name).trim())
  const n = m ? cnNumber(m[1]) : null
  return n === null ? Number.MAX_SAFE_INTEGER : n
}

/** 卷名排序：先按卷号，同号（或都没号）再按名字（数字感知） */
function compareVolume(a, b) {
  const ra = volumeRank(a)
  const rb = volumeRank(b)
  if (ra !== rb) return ra - rb
  try {
    return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true })
  } catch {
    return a < b ? -1 : a > b ? 1 : 0
  }
}

/** 这部小说有哪些卷（只认非隐藏的一级子目录 —— 回收站之类都带点，不算卷） */
function listVolumes(base) {
  const d = path.join(base, CHAPTERS)
  if (!fs.existsSync(d)) return []
  try {
    return fs
      .readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(compareVolume)
  } catch {
    return []
  }
}

/** 这个文件实际该用哪个名字：已存在的名字优先；都没有就看项目是新是老 */
function pickFile(dir, spec, legacyProject) {
  if (fs.existsSync(path.join(dir, spec.now))) return spec.now
  if (fs.existsSync(path.join(dir, spec.old))) return spec.old
  return legacyProject ? spec.old : spec.now
}

/**
 * 这是一部老格式的项目吗？—— 只要四样里**任何一个**用的是老名字，就整部按老名字走。
 * 免得出现「人物卡叫 characters.md、角色数据却叫 角色.json」这种混搭。
 */
function isLegacyProject(dir) {
  return Object.values(LAYOUT).some((spec) => fs.existsSync(path.join(dir, spec.old)))
}

/** 这部小说里，四样文件各自实际叫什么 */
function layoutOf(dir) {
  const legacy = isLegacyProject(dir)
  return {
    legacyProject: legacy,
    outline: pickFile(dir, LAYOUT.outline, legacy),
    world: pickFile(dir, LAYOUT.world, legacy),
    castText: pickFile(dir, LAYOUT.castText, legacy),
    castData: pickFile(dir, LAYOUT.castData, legacy)
  }
}

/**
 * 章节列表（含卷）：返回**相对 chapters 的 id**，卷用 `/` 连。
 * 顺序 = 未分卷的在前（按文件名），然后按卷名（数字感知）排、卷内再按文件名排。
 * 老项目（全平铺）拿到的就是原来那串文件名。
 */
function readChapters(dir) {
  const d = path.join(dir, CHAPTERS)
  if (!fs.existsSync(d)) return []
  const out = []
  const walk = (sub, prefix) => {
    let entries
    try {
      entries = fs.readdirSync(sub, { withFileTypes: true })
    } catch {
      return
    }
    const files = []
    const dirs = []
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) dirs.push(e.name) // 点开头的（回收站临时名之类）不算卷
        continue
      }
      if (chapterRe.test(e.name)) files.push(e.name)
    }
    for (const f of files.sort()) out.push(prefix + f)
    for (const name of dirs.sort(compareVolume)) walk(path.join(sub, name), prefix + name + ID_SEP)
  }
  walk(d, '')
  return out
}

/** 下一个该用的章节号 = 现有最大的号 +1（删过中间几章也不会撞号） */
function nextChapterNo(base) {
  const ids = readChapters(base)
  let max = 0
  for (const id of ids) {
    const m = /^第(\d+)章/.exec(splitChapterId(id).name)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return Math.max(max + 1, ids.length + 1)
}

/**
 * 把 markdown 抹成纯文本 —— 只为 `.txt` 文件用。
 * 目标是"记事本打开就像一本小说"，所以去掉 `#`、`**`、`>` 这类记号，但**保留行结构**。
 */
function toPlainText(md) {
  return String(md ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      let s = line
      s = s.replace(/^\s{0,3}#{1,6}\s+/, '') // 标题记号
      s = s.replace(/^\s{0,3}>\s?/, '') // 引用记号
      s = s.replace(/^\s{0,3}([-*_])\s*\1\s*\1[-*_\s]*$/, '') // 分隔线
      s = s.replace(/\*\*([^*]+)\*\*/g, '$1') // 粗体
      s = s.replace(/__([^_]+)__/g, '$1')
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2') // 斜体
      s = s.replace(/`([^`]+)`/g, '$1') // 行内代码
      return s
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // 连续空行压一压
    .replace(/\s+$/, '') + '\n'
}

/** 校验小说名 / 相对路径，防止越出当前的小说根目录 */
function safeResolve(novelName, relative) {
  const root = path.resolve(novelRoot())
  const base = path.resolve(root, String(novelName || ''))
  const target = path.resolve(base, String(relative || ''))
  if (base === root || !base.startsWith(root + path.sep)) throw new Error('非法的小说名')
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('非法路径（越出小说目录）')
  return { base, target }
}

/**
 * 把"用户/模型写的文件名"解析成真实文件。
 *
 * 认这些写法（大小写随意、带不带扩展名都行）：
 *   大纲 / outline / outline.md / 大纲.txt      → 大纲
 *   世界观 / 设定 / world / world.md            → 世界观
 *   人物卡 / characters / characters.md         → 人物卡（生成物）
 *   角色 / 角色表 / cast / 角色.json             → 角色数据（json）
 *   其他 → 当成 chapters\ 下的章节名（可以不带扩展名）
 */
function resolveFileArg(dir, raw) {
  const f = String(raw || '').trim().replace(/\\/g, ID_SEP)
  if (!f) throw new Error('缺少 file 参数')
  // 允许「卷名/章节名」这一种带目录的写法；再深就不认了（这不是文件浏览器）
  const parts = f.split(ID_SEP).filter((s) => s !== '')
  if (!parts.length || parts.some((s) => s === '.' || s === '..')) throw new Error(`路径不合法：${raw}`)
  const base = parts[parts.length - 1]
  const volume = parts.slice(0, -1).join(ID_SEP)
  const lower = base.toLowerCase()
  const legacy = isLegacyProject(dir)
  /** 章节的两种表示：id（给面板/工具，`/` 分隔）和 file（磁盘路径） */
  const chap = (name) => ({
    kind: 'chapter',
    id: volume ? volume + ID_SEP + name : name,
    file: path.join(CHAPTERS, ...(volume ? [volume] : []), name)
  })

  // 1) 精确命中新旧文件名
  for (const kind of Object.keys(LAYOUT)) {
    const spec = LAYOUT[kind]
    if (base === spec.now || lower === spec.old.toLowerCase()) {
      const name = pickFile(dir, spec, legacy)
      return { kind, id: name, file: name }
    }
  }

  // 2) 别名
  const stem = lower.replace(/\.(txt|md|json)$/, '')
  const alias =
    { outline: 'outline', 大纲: 'outline', world: 'world', 世界观: 'world', 设定: 'world' }[stem] ||
    (lower.endsWith('.json')
      ? { 角色: 'castData', 角色表: 'castData', characters: 'castData', cast: 'castData' }[stem]
      : { 人物卡: 'castText', characters: 'castText' }[stem])
  if (alias) {
    const name = pickFile(dir, LAYOUT[alias], legacy)
    return { kind: alias, id: name, file: name }
  }

  // 3) 剩下的当成章节
  if (chapterRe.test(base)) return chap(base)
  for (const ext of [CHAPTER_EXT, CHAPTER_OLD_EXT]) {
    const candidate = (volume ? volume + ID_SEP : '') + base + ext
    if (fs.existsSync(chapterPath(dir, candidate))) return chap(base + ext)
  }
  return chap(base + CHAPTER_EXT)
}

/** 时间戳（写进「人物卡.txt」的"最后同步"） */
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 读角色表：坏文件也不炸，返回 {cast, warnings, exists, legacyMd} */
function readCast(novelName) {
  const { base } = safeResolve(novelName, '')
  const L = layoutOf(base)
  const dataFile = path.join(base, L.castData)
  const textFile = path.join(base, L.castText)
  const textExists = fs.existsSync(textFile)
  if (!fs.existsSync(dataFile)) {
    // 老项目：只有手写的 characters.md，还没有 json
    return { cast: emptyCast(), warnings: [], exists: false, legacyMd: textExists }
  }
  const parsed = parseCastJson(readText(dataFile))
  return { ...parsed, exists: true, legacyMd: false }
}

/**
 * 写角色表：JSON 为准，顺手把「人物卡.txt」同步出来。
 *
 * ⚠️ 数据保护：如果之前只有**手写的**人物卡（没有 json），
 *    第一次写会把它覆盖 —— 所以先备份成 `<原名>.bak`。
 */
function writeCast(novelName, input) {
  const { base } = safeResolve(novelName, '')
  const { cast, warnings } = normalizeCast(input)
  fs.mkdirSync(base, { recursive: true })

  const L = layoutOf(base)
  const dataFile = path.join(base, L.castData)
  const textFile = path.join(base, L.castText)
  if (!fs.existsSync(dataFile) && fs.existsSync(textFile)) {
    const bak = textFile + '.bak'
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(textFile, bak)
      warnings.push(`检测到旧的手写 ${L.castText}，已备份为 ${L.castText}.bak 再覆盖`)
    } else {
      warnings.push(`旧的手写 ${L.castText} 已有 .bak 备份，本次直接覆盖`)
    }
  }

  fs.writeFileSync(dataFile, JSON.stringify(cast, null, 2) + '\n', 'utf8')
  const text = renderCastText(cast, { stamp: stamp() })
  fs.writeFileSync(textFile, text, 'utf8')
  return { cast, text, warnings, files: { data: L.castData, text: L.castText } }
}

/**
 * 人物卡的文本：优先「人物卡.txt / characters.md」；
 * 没有它但有 json 就现渲染一份（老项目 / 只存了 json 的情况）
 */
function castTextFor(novelName) {
  const { base } = safeResolve(novelName, '')
  const L = layoutOf(base)
  const textFile = path.join(base, L.castText)
  if (fs.existsSync(textFile)) return readText(textFile)
  const dataFile = path.join(base, L.castData)
  if (fs.existsSync(dataFile)) return renderCastText(parseCastJson(readText(dataFile)).cast)
  return ''
}

// ─────────────────── 头像图片（可选，存成文件） ───────────────────
/**
 * 头像有两条路：
 *   · `avatar`      1~4 个字符（emoji / 姓氏）—— 纯文本，永远都在，是兜底
 *   · `avatarFile`  图片文件（`头像\c1.png`）—— 有图片就用图片
 *
 * 为什么图片不塞进 `角色.json` 的 base64：那个文件是**留着给人用记事本改的**，
 * 塞了图片就变成几十 KB 的乱码，人就再也不敢碰它了。所以图片单独放 `头像\`，
 * json 里只记一个路径。
 */
const AVATAR_DIR = '头像'
const AVATAR_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const AVATAR_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}
const AVATAR_MAX = 2 * 1024 * 1024 // 2MB —— 头像而已，够了

/** 某个角色的头像文件（按 id 找，扩展名不限）；没有就 null */
function avatarFileOf(base, id) {
  const safeId = String(id || '').replace(/[\\/:*?"<>|]/g, '')
  if (!safeId) return null
  for (const ext of AVATAR_EXT) {
    const file = path.join(base, AVATAR_DIR, safeId + ext)
    if (fs.existsSync(file)) return { file, rel: AVATAR_DIR + '/' + safeId + ext }
  }
  return null
}

/** 存头像：dataURL → `头像\<id>.<ext>`，顺手把 角色.json 里的 avatarFile 写好 */
function saveAvatar(novelName, idOrName, dataUrl) {
  const { base } = safeResolve(novelName, '')
  if (!fs.existsSync(base)) throw new Error(`找不到小说：${novelName}`)
  const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(String(dataUrl || ''))
  if (!m) throw new Error('头像要传 data:image/...;base64,... 这种 dataURL')
  const mime = m[1].toLowerCase().trim()
  const ext = AVATAR_MIME[mime]
  if (!ext) throw new Error('只认 png / jpg / webp / gif，收到的是：' + mime)
  const buf = Buffer.from(m[2], 'base64')
  if (!buf.length) throw new Error('图片是空的')
  if (buf.length > AVATAR_MAX) {
    throw new Error(`图片太大了（${Math.round(buf.length / 1024)} KB，上限 ${AVATAR_MAX / 1024 / 1024} MB）`)
  }

  const { cast } = readCast(novelName)
  const who = cast.characters.find((c) => c.id === idOrName) || cast.characters.find((c) => c.name === idOrName)
  if (!who) throw new Error(`找不到角色：${idOrName}`)
  const dir = path.join(base, AVATAR_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, who.id + ext)
  const old = avatarFileOf(base, who.id)
  if (old && old.file !== target) fs.rmSync(old.file, { force: true }) // 换了格式别留两张
  fs.writeFileSync(target, buf)
  who.avatarFile = AVATAR_DIR + '/' + who.id + ext
  writeCast(novelName, cast)
  return { novel: novelName, id: who.id, avatarFile: who.avatarFile, bytes: buf.length, novelState: scanNovel(novelName) }
}

/** 删头像：图片删掉、avatarFile 清空（`avatar` 那个 emoji 字段不动，会自动兜底） */
function removeAvatar(novelName, idOrName) {
  const { base } = safeResolve(novelName, '')
  if (!fs.existsSync(base)) throw new Error(`找不到小说：${novelName}`)
  const { cast } = readCast(novelName)
  const who = cast.characters.find((c) => c.id === idOrName) || cast.characters.find((c) => c.name === idOrName)
  if (!who) throw new Error(`找不到角色：${idOrName}`)
  const old = avatarFileOf(base, who.id)
  if (old) fs.rmSync(old.file, { force: true })
  who.avatarFile = ''
  writeCast(novelName, cast)
  return { novel: novelName, id: who.id, removed: !!old, novelState: scanNovel(novelName) }
}

/** 角色 → 出图地址（只有真存了图片的才给；客户端拿不到就退回 emoji） */
function avatarsOf(novelName, cast) {
  const out = {}
  try {
    const { base } = safeResolve(novelName, '')
    for (const c of (cast && cast.characters) || []) {
      const hit = avatarFileOf(base, c.id)
      if (!hit) continue
      let v = 0
      try {
        v = Math.round(fs.statSync(hit.file).mtimeMs)
      } catch {
        /* 刚被删掉就算了 */
      }
      out[c.id] =
        '/novel/api/avatar?novel=' + encodeURIComponent(novelName) + '&id=' + encodeURIComponent(c.id) + '&v=' + v
    }
  } catch {
    /* 小说不在了就返回空表 */
  }
  return out
}

/** 新建小说：建目录 + 三份模板 */
function createNovel(name, intro) {  // 清掉非法字符，并去掉首尾的点和空白（"....跑出去了" 这种）
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60)
  if (!clean) throw new Error('书名不能为空（也不能只有符号）')
  const { base } = safeResolve(clean, '')
  if (fs.existsSync(base)) throw new Error(`已经有一部叫《${clean}》的小说了`)
  fs.mkdirSync(path.join(base, CHAPTERS), { recursive: true })

  const oneLine = String(intro || '').trim()
  // 模板一律**纯文本**（双击记事本就能改，没有 # 和 ** 干扰）
  fs.writeFileSync(
    path.join(base, LAYOUT.outline.now),
    [
      `《${clean}》— 大纲`,
      '',
      '一、一句话简介',
      '　' + (oneLine || '（还没想好。写一句「谁，在什么处境下，想要什么」就够了）'),
      '',
      '二、主要人物',
      '　（在右侧栏「角色」页添加角色和关系，这里可以留空）',
      '',
      '三、故事走向',
      '　1. ',
      '　2. ',
      '　3. ',
      '',
      '四、结尾想要的感觉',
      '　',
      '',
      ''
    ].join('\n'),
    'utf8'
  )
  fs.writeFileSync(
    path.join(base, LAYOUT.world.now),
    [
      `《${clean}》— 世界观 / 设定`,
      '',
      '一、舞台',
      '　时代 / 地点：',
      '　气氛：',
      '',
      '二、规则',
      '　（现实向就写「无超自然要素」；有设定就写清代价和限制）',
      '',
      '三、名词表',
      '　名词 —— 含义',
      '　',
      '',
      ''
    ].join('\n'),
    'utf8'
  )
  const written = writeCast(clean, emptyCast())
  return {
    name: clean,
    files: [LAYOUT.outline.now, LAYOUT.world.now, written.files.text, written.files.data],
    castText: written.text.length > 0
  }
}

/** 清书名：抹掉非法字符和首尾的点/空白 */
function cleanName(input) {
  return String(input || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60)
}

/** 小说改名：整个文件夹改名 */
function renameNovel(oldName, rawNew) {
  const from = String(oldName || '').trim()
  if (!from) throw new Error('缺少小说名')
  const to = cleanName(rawNew)
  if (!to) throw new Error('新书名不能为空（也不能只有符号）')
  if (to === from) return { from, renamed: from, same: true, novel: scanNovel(from) }

  const { base: fromDir } = safeResolve(from, '')
  if (!fs.existsSync(fromDir)) throw new Error(`找不到小说：${from}`)
  const { base: toDir } = safeResolve(to, '')
  if (fs.existsSync(toDir)) throw new Error(`已经有一部叫《${to}》的小说了`)
  fs.renameSync(fromDir, toDir) // 整个文件夹搬过去，章节和设定一起走
  return { from, renamed: to, novel: scanNovel(to) }
}

/** 回收站目录（以 . 开头，不会被当小说列出来） */
const TRASH_DIR = '.dsh-novel-trash';

/** 把某个东西挪进回收站（返回相对小说库的路径）。删除一律走这里，不真删。 */
function moveToTrash(absPath, label) {
  const trashRoot = path.join(novelRoot(), TRASH_DIR);
  fs.mkdirSync(trashRoot, { recursive: true });
  const base = `${label}-${stamp().replace(/[: ]/g, '-')}`;
  let dest = path.join(trashRoot, base);
  let n = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(trashRoot, `${base}-${n}`);
    n += 1;
  }
  fs.renameSync(absPath, dest);
  return path.relative(novelRoot(), dest);
}

/**
 * 小说"删除"：**移到回收站**，不是 rm -rf。
 * 你以为你在删，其实只是挪到 `<小说库>\.dsh-novel-trash\<名字>-<时间>\`，手工还能捞回来。
 */
function deleteNovel(name) {
  const target = String(name || '').trim()
  if (!target) throw new Error('缺少小说名')
  const { base: dir } = safeResolve(target, '')
  if (!fs.existsSync(dir)) throw new Error(`找不到小说：${target}`)
  return { deleted: target, movedTo: moveToTrash(dir, target), recoverable: true }
}

/** 卷名清洗：去掉 Windows 非法字符；开头结尾的点和空白也去掉（不然会变成"隐藏目录"被跳过） */
function cleanVolumeName(raw) {
  return String(raw ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 40)
}

/** 新建一卷（先建个空目录当壳，章节再放进来）；不传 volume 就是平铺，别调这个 */
function createVolume(novelName, rawName) {
  const { base } = safeResolve(novelName, '')
  if (!fs.existsSync(base)) throw new Error(`找不到小说：${novelName}`)
  const name = cleanVolumeName(rawName)
  if (!name) throw new Error('卷名不能为空')
  const dir = path.join(base, CHAPTERS, name)
  if (fs.existsSync(dir)) throw new Error(`已经有「${name}」这一卷了`)
  fs.mkdirSync(dir, { recursive: true })
  return { novel: novelName, volume: name, novelState: scanNovel(novelName) }
}

/** 卷改名：整个目录改名。章节号是全局的，所以里面的章节一个字都不用动 */
function renameVolume(novelName, rawFrom, rawTo) {
  const { base } = safeResolve(novelName, '')
  if (!fs.existsSync(base)) throw new Error(`找不到小说：${novelName}`)
  const from = cleanVolumeName(rawFrom)
  const to = cleanVolumeName(rawTo)
  if (!from || !to) throw new Error('卷名不能为空')
  if (from === to) return { novel: novelName, volume: to, same: true, novelState: scanNovel(novelName) }
  const src = path.join(base, CHAPTERS, from)
  const dst = path.join(base, CHAPTERS, to)
  if (!fs.existsSync(src)) throw new Error(`找不到这一卷：${from}`)
  if (fs.existsSync(dst)) throw new Error(`已经有「${to}」这一卷了`)
  fs.renameSync(src, dst)
  return { novel: novelName, volume: to, from, novelState: scanNovel(novelName) }
}

/** 删卷 = **整卷挪进回收站**（跟删章节一个规矩：可恢复） */
function deleteVolume(novelName, rawName) {
  const { base } = safeResolve(novelName, '')
  if (!fs.existsSync(base)) throw new Error(`找不到小说：${novelName}`)
  const name = cleanVolumeName(rawName)
  const dir = path.join(base, CHAPTERS, name)
  if (!name || !fs.existsSync(dir)) throw new Error(`找不到这一卷：${rawName}`)
  const movedTo = moveToTrash(dir, `${novelName}__${name}`)
  return { novel: novelName, deletedVolume: name, movedTo, recoverable: true, novelState: scanNovel(novelName) }
}

/** 新建一章（空章节）：给出标题 + 一个只有标题行的骨架，正文留给面板/agent 写 */
function createChapter(novelName, rawTitle, volume) {
  const { base } = safeResolve(novelName, '')
  if (!fs.existsSync(base)) throw new Error(`找不到小说：${novelName}`)
  const title = String(rawTitle || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 60)
  if (!title) throw new Error('章节标题不能为空')
  const vol = cleanVolumeName(volume) // 空 = 未分卷
  const no = nextChapterNo(base)
  const name = `第${String(no).padStart(3, '0')}章-${title}${CHAPTER_EXT}`
  const id = vol ? vol + ID_SEP + name : name
  const target = chapterPath(base, id)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) throw new Error(`已经有「${name}」了`)
  // 骨架：第一行标题，然后空一行等正文（和 novel_save_chapter 的约定一致）
  fs.writeFileSync(target, `第${no}章 ${title}\n\n`, 'utf8')
  return { novel: novelName, created: id, volume: vol, novelState: scanNovel(novelName) }
}

/**
 * 老格式一键迁移：把 outline.md 那套换成新格式，**原件搬进 `_旧格式备份\`**。
 * - 已存在的新名字不覆盖（跳过并记下来）
 * - 章节：.md → .txt（抹掉 markdown 记号），编号和标题不动
 * - 角色：有 json 就用 json 重新渲染人物卡（手写那份 md 直接进备份）
 */
function migrateNovel(novelName) {
  const { base } = safeResolve(novelName, '')
  if (!fs.existsSync(base)) throw new Error(`找不到小说：${novelName}`)
  const backupDir = path.join(base, '_旧格式备份')
  const changed = []
  const skipped = []

  const backup = (name) => {
    fs.mkdirSync(backupDir, { recursive: true })
    const src = path.join(base, name)
    const dst = path.join(backupDir, name)
    if (fs.existsSync(dst)) fs.rmSync(dst, { force: true })
    fs.renameSync(src, dst)
  }

  // 1) 角色数据（先做，人物卡要用它重新渲染）
  const L0 = layoutOf(base)
  let castCastData = null
  if (!fs.existsSync(path.join(base, LAYOUT.castData.now)) && fs.existsSync(path.join(base, LAYOUT.castData.old))) {
    const parsed = parseCastJson(readText(path.join(base, LAYOUT.castData.old)))
    if (parsed.cast.characters.length || parsed.cast.relations.length) {
      fs.writeFileSync(
        path.join(base, LAYOUT.castData.now),
        JSON.stringify(parsed.cast, null, 2) + '\n',
        'utf8'
      )
      castCastData = parsed.cast
      changed.push(LAYOUT.castData.old + ' → ' + LAYOUT.castData.now)
    }
    backup(LAYOUT.castData.old)
  }

  // 2) 大纲 / 世界观：纯文本化
  for (const key of ['outline', 'world']) {
    const spec = LAYOUT[key]
    const nowPath = path.join(base, spec.now)
    const oldPath = path.join(base, spec.old)
    if (fs.existsSync(nowPath)) {
      if (fs.existsSync(oldPath)) skipped.push(spec.old + '（已有 ' + spec.now + '，没动它）')
      continue
    }
    if (!fs.existsSync(oldPath)) continue
    fs.writeFileSync(nowPath, toPlainText(readText(oldPath)), 'utf8')
    backup(spec.old)
    changed.push(spec.old + ' → ' + spec.now)
  }

  // 3) 人物卡
  {
    const spec = LAYOUT.castText
    const nowPath = path.join(base, spec.now)
    const oldPath = path.join(base, spec.old)
    if (!fs.existsSync(nowPath) && fs.existsSync(oldPath)) {
      if (castCastData) {
        fs.writeFileSync(nowPath, renderCastText(castCastData, { stamp: stamp() }), 'utf8')
        changed.push(spec.old + ' → ' + spec.now + '（按角色数据重新生成）')
      } else {
        fs.writeFileSync(nowPath, toPlainText(readText(oldPath)), 'utf8')
        changed.push(spec.old + ' → ' + spec.now)
      }
      backup(spec.old)
    } else if (fs.existsSync(oldPath)) {
      backup(spec.old)
      skipped.push(spec.old + '（已有 ' + spec.now + '，旧文件只做了备份）')
    }
  }

  // 4) 章节：.md → .txt（在卷里的就地在那一卷里改名，不动卷结构）
  for (const f of readChapters(base).filter((x) => /\.md$/i.test(x))) {
    const { volume, name } = splitChapterId(f)
    const nextName = name.replace(/\.md$/i, '') + CHAPTER_EXT
    const nextId = volume ? volume + ID_SEP + nextName : nextName
    if (fs.existsSync(chapterPath(base, nextId))) {
      skipped.push(f + '（已有 ' + nextName + '）')
      continue
    }
    fs.writeFileSync(chapterPath(base, nextId), toPlainText(readText(chapterPath(base, f))), 'utf8')
    const dstDir = path.join(backupDir, CHAPTERS, ...(volume ? [volume] : []))
    fs.mkdirSync(dstDir, { recursive: true })
    fs.renameSync(chapterPath(base, f), path.join(dstDir, name))
    changed.push(f + ' → ' + nextId)
  }

  return {
    novel: novelName,
    changed,
    skipped,
    backupDir: changed.length ? path.basename(backupDir) : '',
    novelState: scanNovel(novelName)
  }
}

/**
 * 导出：`txt` = 设定集.txt（纯文本，人看/给 AI 看）
 *       `epub` / `docx` = 真正的电子书文件，写在小说目录下。
 *
 * 电子书里的结构：**卷 → 章**（卷名当分组标题），前面带上大纲/世界观/人物卡做卷首。
 * 章节正文开头那行「第N章 标题」会被去掉（标题已经单独给电子书了，不然会重复一遍）。
 */
function exportNovel(novelName, format) {
  const { base } = safeResolve(novelName, '')
  if (!fs.existsSync(base)) throw new Error(`找不到小说：${novelName}`)
  const L = layoutOf(base)
  const s = scanNovel(novelName)
  const fmt = String(format || 'txt').toLowerCase()

  const readIf = (rel) => {
    try {
      return readText(path.join(base, rel)).replace(/\s+$/, '')
    } catch {
      return ''
    }
  }

  // ── 电子书（EPUB / Word）──
  if (fmt === 'epub' || fmt === 'docx') {
    const chapters = s.chapters.map((c) => ({
      title: c.title,
      volume: c.volume,
      // 第一行通常是「第N章 标题」，电子书自己有标题，去掉免得重复
      text: readText(chapterPath(base, c.file)).replace(/^\s*第\d+章[^\n]*\n+/, '')
    }))
    const frontMatter = [
      { title: '大纲', text: readIf(L.outline) },
      { title: '世界观', text: readIf(L.world) },
      { title: '人物卡', text: readIf(L.castText) }
    ].filter((f) => f.text)
    const book = { title: novelName, author: 'DSH 小说创作台', language: 'zh-CN', chapters, frontMatter }
    const buf = fmt === 'epub' ? buildEpub(book) : buildDocx(book)
    const file = novelName + (fmt === 'epub' ? '.epub' : '.docx')
    fs.writeFileSync(path.join(base, file), buf)
    return { novel: novelName, format: fmt, file, bytes: buf.length, chapters: chapters.length }
  }

  // ── 设定集.txt ──
  const lines = []
  lines.push('《' + novelName + '》设定集')
  lines.push('导出时间：' + stamp())
  lines.push('')
  lines.push('════ 一、大纲 ════')
  lines.push(readIf(L.outline) || '（还没有大纲）')
  lines.push('')
  lines.push('════ 二、世界观 ════')
  lines.push(readIf(L.world) || '（还没有世界观）')
  lines.push('')
  lines.push('════ 三、角色与人物关系 ════')
  lines.push(readIf(L.castText) || '（还没有角色）')
  lines.push('')
  lines.push('════ 四、章节清单 ════')
  if (!s.chapters.length) {
    lines.push('（还没有章节）')
  } else {
    const wordsOf = (c) => Math.max(1, Math.round(c.size / 3))
    if (s.volumes.length) lines.push('（分 ' + s.volumes.length + ' 卷：' + s.volumes.join(' / ') + '）')
    let curVol = '\u0000还没打印过任何卷标题'
    for (const c of s.chapters) {
      if (c.volume !== curVol) {
        curVol = c.volume
        lines.push('')
        lines.push(curVol ? '── ' + curVol + ' ──' : '── 未分卷 ──')
      }
      lines.push('第' + c.no + '章 ' + c.title + '  ——  ' + wordsOf(c) + ' 字')
    }
    const words = s.chapters.reduce((n, c) => n + wordsOf(c), 0)
    lines.push('')
    lines.push('共 ' + s.chapters.length + ' 章' + (s.volumes.length ? '（' + s.volumes.length + ' 卷）' : '') + '，约 ' + words + ' 字')
  }
  lines.push('')

  const file = '设定集.txt'
  fs.writeFileSync(path.join(base, file), lines.join('\n'), 'utf8')
  return { novel: novelName, file, bytes: fs.statSync(path.join(base, file)).size, chapters: s.chapters.length }
}

/**
 * 章节重排：按给的顺序把文件重新编号（第001章、第002章 …）。
 *
 * 顺序里给的 id **可以带卷前缀**：id 的卷名和它现在所在的卷不一样，就等于「把它挪到那一卷」。
 * 所以面板上把一章拖进/拖出某一卷，走的就是这个接口。
 */
function reorderChapters(novelName, order) {
  const { base } = safeResolve(novelName, '')
  if (!fs.existsSync(base)) throw new Error(`找不到小说：${novelName}`)
  const existing = readChapters(base)
  const wanted = (Array.isArray(order) ? order : []).map((f) => String(f || '').trim().replace(/\\/g, ID_SEP))

  if (wanted.length !== existing.length) {
    throw new Error(`顺序里给了 ${wanted.length} 章，磁盘上有 ${existing.length} 章 —— 对不上`)
  }
  // 认的是**文件名**：卷前缀可以随便改（那就是"挪卷"），文件本身必须真实存在
  const nowOf = new Map()
  for (const id of existing) nowOf.set(splitChapterId(id).name, id)
  if (nowOf.size !== existing.length) throw new Error('有重名的章节（文件名一样），没法排序')
  const seen = new Set()
  for (const f of wanted) {
    const name = splitChapterId(f).name
    if (!nowOf.has(name)) throw new Error(`磁盘上没有这一章：${f}`)
    if (seen.has(name)) throw new Error(`顺序里有重复：${f}`)
    seen.add(name)
  }
  if (wanted.join('|') === existing.join('|')) {
    return { novel: novelName, order: wanted, same: true, novelState: scanNovel(novelName) }
  }

  // 先把每一章"从哪来、到哪去"算清楚，再动磁盘
  const plan = wanted.map((f, i) => {
    const cur = nowOf.get(splitChapterId(f).name) // 现在在哪
    const { volume, name } = splitChapterId(f) // 要挪到哪一卷
    const ext = /\.md$/i.test(name) ? CHAPTER_OLD_EXT : CHAPTER_EXT
    const stem = name.replace(/\.(txt|md)$/i, '')
    const title = stem.replace(/^第\d+章[-_—\s]*/, '') || stem
    const next = `第${String(i + 1).padStart(3, '0')}章-${title}${ext}`
    const dir = path.join(base, CHAPTERS, ...(volume ? [volume] : []))
    return { cur, dir, next, id: volume ? volume + ID_SEP + next : next }
  })

  // 两阶段改名：先全挪到临时名，避免 A→B、B→A 互相撞车
  // （临时名用 .tmp 后缀，不会被当成章节；挪卷就是从这里跨目录 rename 过去的）
  const tmpPath = (id, i) => path.join(path.dirname(chapterPath(base, id)), `.tmp-${i}.tmp`)
  plan.forEach((p, i) => fs.renameSync(chapterPath(base, p.cur), tmpPath(p.cur, i)))
  plan.forEach((p, i) => {
    fs.mkdirSync(p.dir, { recursive: true })
    fs.renameSync(tmpPath(p.cur, i), path.join(p.dir, p.next))
  })
  return { novel: novelName, order: plan.map((p) => p.id), novelState: scanNovel(novelName) }
}

/** 读请求体（POST 用，自己实现，不 import 任何东西） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体太大（>4MB）'))
        req.destroy?.()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(parseJsonText(text))
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON：${(err && err.message) || err}`))
      }
    })
    req.on('error', reject)
  })
}

/** 工具 1：列出小说 + 章节 */
function buildNovelListTool() {
  return {
    name: 'novel_list',
    description:
      '列出本机小说创作目录下的所有小说项目及其章节列表。当用户提到"我的小说 / 写作 / 章节 / 大纲"时使用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    async execute() {
      const novels = listNovels()
      if (novels.length === 0) return { text: `目录 ${novelRoot()} 下暂无小说项目。` }
      const body = novels
        .map((n) => {
          const head = `《${n.name}》—— ${n.chapters.length} 章`
          const list = n.chapters.map((c, i) => `  ${i + 1}. ${c.replace(/\.(txt|md)$/i, '')}`).join('\n')
          return list ? `${head}\n${list}` : head
        })
        .join('\n\n')
      return { text: `共 ${novels.length} 部小说（${novelRoot()}）：\n\n${body}` }
    }
  }
}

/** 工具 2：读设定文件或某一章正文 */
function buildNovelReadTool() {
  return {
    name: 'novel_read',
    description:
      '读取某部小说的设定文件（大纲 / 世界观 / 人物卡）或某一章正文。写新章节之前，应先用它读取上下文。',
    parameters: {
      type: 'object',
      properties: {
        novel: { type: 'string', description: '小说名（文件夹名），先用 novel_list 查' },
        file: {
          type: 'string',
          description:
            '要读的文件：大纲 / 世界观 / 人物卡 / 角色，或章节名（如 第001章-xxx，可以不带扩展名；只给文件名会自动到 chapters\\ 下找）'
        }
      },
      required: ['novel', 'file'],
      additionalProperties: false
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const novel = String(args.novel)
      const { base } = safeResolve(novel, '')
      const hit = resolveFileArg(base, args.file)
      const content = readNovelFile(novel, hit.file)
      return { text: `【${novel} / ${hit.file}】\n\n${content}` }
    }
  }
}

/** 工具 3：一次取出「续写下一章」所需的全部上下文 */
function buildNovelContextTool() {
  return {
    name: 'novel_context',
    description:
      '一次性取出续写下一章所需的全部上下文：大纲、世界观、角色与人物关系、以及最近 N 章的正文。用户说"写下一章 / 续写"时先调用它。',
    parameters: {
      type: 'object',
      properties: {
        novel: { type: 'string', description: '小说名（文件夹名）' },
        recent: { type: 'integer', description: '附带最近几章的正文，默认 1' }
      },
      required: ['novel'],
      additionalProperties: false
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const novel = String(args.novel)
      const found = listNovels().find((n) => n.name === novel)
      if (!found) throw new Error(`找不到小说：${novel}`)
      const recent = Number.isInteger(args.recent) && args.recent > 0 ? args.recent : 1
      const { base } = safeResolve(novel, '')
      const L = layoutOf(base)

      const parts = []
      for (const key of ['outline', 'world']) {
        try {
          parts.push(`===== ${L[key]} =====\n${readNovelFile(novel, L[key])}`)
        } catch {
          /* 缺哪个就跳过 */
        }
      }
      const castText = castTextFor(novel)
      if (castText) parts.push(`===== ${L.castText}（角色 & 人物关系） =====\n${castText}`)
      for (const c of found.chapters.slice(-recent)) {
        parts.push(`===== ${CHAPTERS}/${c} =====\n${readNovelFile(novel, path.join(CHAPTERS, c))}`)
      }
      const nextNo = String(found.chapters.length + 1).padStart(3, '0')
      parts.push(`（以上为上下文。请续写「第${nextNo}章」，写完后调用 novel_save_chapter 保存。）`)
      return { text: parts.join('\n\n') }
    }
  }
}

/** 工具 4：保存一章（文件名自动编号） */
function buildNovelSaveChapterTool() {
  return {
    name: 'novel_save_chapter',
    description:
      '把写好的章节正文保存到小说目录的 chapters\\ 下，文件名自动编号为「第NNN章-标题.txt」。' +
      '**正文请写纯文本**（不要 markdown 的 # 标题、** 加粗、表格竖线 —— 这是给记事本看的成品小说）；' +
      '第一行写「第N章 标题」，然后空一行再写正文。章节写完后调用它存盘。' +
      '如果这部小说分了卷，可以用 volume 指定放进哪一卷（卷名要和面板里显示的一致；不传就是未分卷）。',
    parameters: {
      type: 'object',
      properties: {
        novel: { type: 'string', description: '小说名（文件夹名）' },
        title: { type: 'string', description: '章节标题（不含"第N章"前缀）' },
        content: { type: 'string', description: '章节正文（纯文本；万一带了 markdown 记号，存盘时会自动抹掉）' },
        volume: { type: 'string', description: '卷名（可选）。只有分了卷的小说才需要；不传 = 未分卷' }
      },
      required: ['novel', 'title', 'content'],
      additionalProperties: false
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const novel = String(args.novel)
      const root = path.resolve(novelRoot())
      const dir = path.resolve(root, novel)
      if (dir === root || !dir.startsWith(root + path.sep)) {
        throw new Error('非法路径（越出小说目录）')
      }
      if (!fs.existsSync(dir)) throw new Error(`找不到小说：${novel}`)

      const vol = cleanVolumeName(args.volume)
      const no = String(nextChapterNo(dir)).padStart(3, '0')
      const safeTitle = String(args.title).replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60) || '无题'
      const name = `第${no}章-${safeTitle}${CHAPTER_EXT}`
      const id = vol ? vol + ID_SEP + name : name
      const target = chapterPath(dir, id)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, toPlainText(args.content), 'utf8')
      return { text: `✅ 已保存：${CHAPTERS}\\${name.replace(/\//g, '\\')}${vol ? '（第 ' + vol + ' 卷）' : ''}（当前共 ${readChapters(dir).length} 章）` }
    }
  }
}

/** 工具 5：读 / 改角色与人物关系（数据源「角色.json」，顺手同步「人物卡.txt」） */
function buildNovelCastTool() {
  const charProps = {
    id: { type: 'string', description: '角色 id（如 c1）。新增时可省略，会自动编号' },
    name: { type: 'string', description: '角色名。改已有角色时可用它代替 id' },
    role: { type: 'string', description: '定位：主角 / 配角 / 反派 / 路人' },
    age: { type: 'string', description: '年龄（随便写）' },
    tags: { type: 'array', items: { type: 'string' }, description: '标签，如 ["文学社","毒舌"]' },
    desc: { type: 'string', description: '一两句简介' },
    avatar: { type: 'string', description: '头像：1~4 个字符（emoji 或姓氏），会画在关系图的圆点上' }
  }
  return {
    name: 'novel_cast',
    description:
      '读或改某部小说的角色与人物关系（数据源是同目录的「角色.json」，改完自动同步「人物卡.txt」）。' +
      '**不传任何操作参数 → 只读**；要改就传 addCharacters / updateCharacters / removeCharacters / addRelations / removeRelations。' +
      '关系两端写角色名或 id 都行。用户说"加个角色 / 改人设 / 他俩是什么关系"时用它。',
    parameters: {
      type: 'object',
      properties: {
        novel: { type: 'string', description: '小说名（文件夹名）' },
        addCharacters: {
          type: 'array',
          description: '新增角色；如果同名角色已存在，则视为更新它',
          items: {
            type: 'object',
            properties: charProps,
            required: ['name'],
            additionalProperties: false
          }
        },
        updateCharacters: {
          type: 'array',
          description: '改已有角色，用 id 或 name 指定是谁',
          items: { type: 'object', properties: charProps, additionalProperties: false }
        },
        removeCharacters: {
          type: 'array',
          description: '删角色（会连带删掉跟他有关的关系）。写 id 或名字',
          items: { type: 'string' }
        },
        addRelations: {
          type: 'array',
          description: '加人物关系。from/to 写角色名或 id；type 是关系名（如"暗恋（单向）""闺蜜""兄妹"）',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: '关系的起点角色' },
              to: { type: 'string', description: '关系的终点角色' },
              type: { type: 'string', description: '关系名' },
              note: { type: 'string', description: '备注' }
            },
            required: ['from', 'to'],
            additionalProperties: false
          }
        },
        removeRelations: {
          type: 'array',
          description: '删关系。type 省略则删这两点之间的全部关系',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              type: { type: 'string' }
            },
            required: ['from', 'to'],
            additionalProperties: false
          }
        }
      },
      required: ['novel'],
      additionalProperties: false
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const novel = String(args.novel)
      if (!listNovels().some((n) => n.name === novel)) throw new Error(`找不到小说：${novel}`)

      const ops = {}
      for (const k of ['addCharacters', 'updateCharacters', 'removeCharacters', 'addRelations', 'removeRelations']) {
        if (args[k] !== undefined) ops[k] = args[k]
      }

      const current = readCast(novel)
      if (Object.keys(ops).length === 0) {
        const warn = current.warnings.length ? `\n\n⚠️ 数据问题：${current.warnings.join('；')}` : ''
        return { text: `【${novel}】${castSummary(current.cast)}\n\n${renderCastText(current.cast)}${warn}` }
      }

      const applied = applyCastOps(current.cast, ops) // 指错人 → 抛错，让模型看到可选角色
      const saved = writeCast(novel, applied.cast)
      const warn = saved.warnings.length ? `\n⚠️ 数据问题：${saved.warnings.join('；')}` : ''
      return {
        text: `✅ ${novel}：${applied.log.join('；')}\n现在 ${castSummary(saved.cast)}，人物卡已同步。${warn}`
      }
    }
  }
}

// ─────────────────── 浏览器 API（右侧栏面板的数据源） ───────────────────
/**
 * 注册到 GUI 的 webServer 上（做法照抄 dsh-wechat 的 /wechat/api/*）：
 *
 *   webServer.register({ kind: 'exact' | 'prefix', path, handler(req, res) })
 *
 * 两个坑：
 *  1) webServer 要等 web 启动完成才存在，所以必须用**动态注入**
 *     `ctx.inject(['webServer'], (c) => ...)`；写进顶层 `export const inject`
 *     会把整个插件（含 4 个工具）一起拖住。
 *  2) 自定义路由**不受** 0.1.5 的 web 认证（401）保护——认证只挂在
 *     `/`（首页）和 `/api/*`（RPC）上。所以 /novel/api/* 浏览器可直接 fetch。
 */

/** 扫描一部小说：章节（含序号/大小/时间）+ 存在哪些设定文件 */
function scanNovel(name) {
  const dir = path.resolve(novelRoot(), name)
  const chaptersDir = path.join(dir, 'chapters')
  const chapters = []
  if (fs.existsSync(chaptersDir)) {
    let position = 0
    for (const file of readChapters(dir)) {
      position += 1
      let size = 0
      let mtime = 0
      try {
        const st = fs.statSync(path.join(chaptersDir, file))
        size = st.size
        mtime = st.mtimeMs
      } catch {
        /* 文件刚被删就跳过元信息 */
      }
      // 章号优先信文件名里的「第NNN章」（删掉中间某章后不会张冠李戴），
      // 没有编号的老文件才退回按顺序编号
      const { volume, name } = splitChapterId(file)
      const numbered = /^第(\d+)章/.exec(name)
      const stem = name.replace(/\.(txt|md)$/i, '')
      chapters.push({
        file, // id：在卷里的写成「第一卷 恋爱练习/第003章-x.txt」
        volume, // '' = 未分卷（老项目全都是这样）
        name, // 纯文件名（不带卷）
        title: stem.replace(/^第\d+章[-_—\s]*/, '') || stem,
        no: numbered ? Number(numbered[1]) : position,
        size,
        mtime
      })
    }
  }
  const L = layoutOf(dir)
  return {
    name,
    chapterCount: chapters.length,
    chapters,
    volumes: listVolumes(dir), // 卷（含还没放章节的空卷），顺序就是显示顺序
    // 设定文件按「实际叫什么」报给面板，面板就能显示对的中文名
    settings: ['outline', 'world', 'castText']
      .filter((k) => fs.existsSync(path.join(dir, L[k])))
      .map((k) => ({ kind: k, file: L[k], label: LAYOUT[k].label, generated: !!LAYOUT[k].generated })),
    castDataFile: L.castData,
    legacy: L.legacyProject,   // 还是老格式（outline.md 那套）吗
    wordCount: chapters.reduce((n, c) => n + c.size, 0),
    cast: (() => {
      try {
        const { cast, legacyMd } = readCast(name)
        return { characters: cast.characters.length, relations: cast.relations.length, legacy: !!legacyMd }
      } catch {
        return { characters: 0, relations: 0, legacy: false }
      }
    })()
  }
}

/** 写之前先确认这部小说真的存在（免得手滑建出一堆空目录） */
function assertNovelExists(novelName) {
  const { base } = safeResolve(novelName, '')
  if (!fs.existsSync(base)) throw new Error(`找不到小说：${novelName}`)
  return base
}

/** 统一 JSON 响应（和 dsh-wechat 的 sendJson 同款） */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** 发二进制（头像图片用）—— 单独一个，因为 sendJson 只会发 JSON */
function sendBytes(res, status, buf, mime) {
  res.statusCode = status
  res.setHeader('Content-Type', mime || 'application/octet-stream')
  res.setHeader('Cache-Control', 'no-store')
  res.end(buf)
}

/** POST 路由的统一壳子：解 body → 干活 → 统一出错格式 */
function post(route, fn) {
  return {
    kind: 'exact',
    path: route,
    async handler(req, res) {
      try {
        const body = await readBody(req)
        const out = await fn(body || {})
        sendJson(res, 200, { ok: true, ...out })
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String((err && err.message) || err) })
      }
    }
  }
}

/**
 * 路由表（纯数据 + 纯函数，便于本地测试：直接喂假 req/res 就能跑）。
 * handler 不依赖 ctx，所以整张表可以脱离 DSH 单测。
 */
const API_ROUTES = [
  {
    kind: 'exact',
    path: '/novel/api/list',
    handler(_req, res) {
      try {
        const root = novelRoot()
        const novels = fs.existsSync(root)
          ? fs
              .readdirSync(root, { withFileTypes: true })
              .filter(isNovelDir)
              .map((d) => scanNovel(d.name))
          : []
        sendJson(res, 200, { ok: true, root, novels })
      } catch (err) {
        sendJson(res, 500, { ok: false, message: String((err && err.message) || err) })
      }
    }
  },
  {
    kind: 'exact',
    path: '/novel/api/read',
    handler(req, res) {
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        const novel = url.searchParams.get('novel') || ''
        const raw = url.searchParams.get('file') || ''
        if (!novel || !raw) {
          sendJson(res, 400, { ok: false, message: '缺少 novel / file 参数' })
          return
        }
        const { base } = safeResolve(novel, '')
        const hit = resolveFileArg(base, raw)
        sendJson(res, 200, { ok: true, novel, id: hit.id, file: hit.file, kind: hit.kind, text: readNovelFile(novel, hit.file) })
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String((err && err.message) || err) })
      }
    }
  },
  // /novel/api/cast：GET = 读，POST = 写（整表替换 cast / 增量改 ops），两种都顺手同步 characters.md
  //
  // ⚠️ 一个路径只能注册一条路由！webserver 的路由表是「按路径」匹配的
  //    （`new Map()`，重复注册直接抛 duplicate exact route），
  //    所以 GET/POST 必须在 handler 里按 req.method 自己分。
  {
    kind: 'exact',
    path: '/novel/api/cast',
    async handler(req, res) {
      const method = String(req.method || 'GET').toUpperCase()
      try {
        if (method === 'POST') {
          const body = (await readBody(req)) || {}
          const novel = String(body.novel || '').trim()
          if (!novel) throw new Error('缺少 novel 参数')
          assertNovelExists(novel)
          let result
          const log = []
          if (body.ops && typeof body.ops === 'object') {
            const current = readCast(novel)
            const applied = applyCastOps(current.cast, body.ops)
            result = writeCast(novel, applied.cast)
            log.push(...applied.log)
          } else if (body.cast && typeof body.cast === 'object') {
            result = writeCast(novel, body.cast)
            log.push('已按面板内容整体保存角色表')
          } else {
            const current = readCast(novel)
            result = writeCast(novel, current.cast)
            log.push('只同步了 characters.md')
          }
          sendJson(res, 200, {
            ok: true,
            novel,
            cast: result.cast,
            avatars: avatarsOf(novel, result.cast),
            warnings: result.warnings,
            log,
            summary: castSummary(result.cast),
            text: result.text,
            files: result.files
          })
          return
        }

        const url = new URL(req.url || '/', 'http://localhost')
        const novel = url.searchParams.get('novel') || ''
        if (!novel) throw new Error('缺少 novel 参数')
        const { cast, warnings, exists, legacyMd } = readCast(novel)
        sendJson(res, 200, {
          ok: true,
          novel,
          cast,
          // 有图片头像的角色 → 出图地址（带 mtime 当版本号，换图立刻生效不用手动刷缓存）
          avatars: avatarsOf(novel, cast),
          warnings,
          exists,
          legacyMd: !!legacyMd,
          summary: castSummary(cast),
          text: renderCastText(cast, { stamp: exists ? '（当前文件）' : '' })
        })
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String((err && err.message) || err) })
      }
    }
  },
  // 头像图片：GET 出图（没图就 404），POST 上传（dataURL）/ 删除
  {
    kind: 'exact',
    path: '/novel/api/avatar',
    async handler(req, res) {
      const method = String(req.method || 'GET').toUpperCase()
      try {
        if (method === 'POST') {
          const body = (await readBody(req)) || {}
          const novel = String(body.novel || '').trim()
          if (!novel) throw new Error('缺少 novel 参数')
          const out =
            String(body.action || '') === 'remove'
              ? removeAvatar(novel, body.id)
              : saveAvatar(novel, body.id, body.dataUrl)
          sendJson(res, 200, { ok: true, ...out })
          return
        }
        const url = new URL(req.url || '/', 'http://localhost')
        const novel = url.searchParams.get('novel') || ''
        const id = url.searchParams.get('id') || ''
        const { base } = safeResolve(novel, '')
        const hit = avatarFileOf(base, id)
        if (!hit) {
          sendJson(res, 404, { ok: false, message: '这个角色还没有图片头像' })
          return
        }
        const ext = path.extname(hit.file).toLowerCase()
        const mime =
          ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
        sendBytes(res, 200, fs.readFileSync(hit.file), mime)
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String((err && err.message) || err) })
      }
    }
  },
  // 存设定文件 / 章节正文
  post('/novel/api/save', (body) => {
    const novel = String(body.novel || '').trim()
    if (!novel) throw new Error('缺少 novel 参数')
    const base = assertNovelExists(novel)
    const hit = resolveFileArg(base, body.file)
    if (hit.kind === 'castText') {
      throw new Error('人物卡是自动生成的，请在「角色」页改，或让 agent 调用 novel_cast')
    }
    if (hit.kind === 'castData') throw new Error('角色数据请走「角色」页（会自动校验关系）')
    if (hit.kind === 'chapter') {
      const exists = fs.existsSync(path.join(base, hit.file))
      // 新章节必须守着「第NNN章-标题.txt」的命名；已存在的可以随便改内容
      if (!exists && !/^第\d+章/.test(path.basename(hit.file))) {
        throw new Error(`章节名要像「第001章-标题${CHAPTER_EXT}」：${path.basename(hit.file)}`)
      }
    }
    const { target } = safeResolve(novel, hit.file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // .txt 写成**纯文本**（抹掉 markdown 记号）；老 .md 保持原样
    const raw = String(body.text ?? '')
    const text = /\.txt$/i.test(hit.file) ? toPlainText(raw) : raw
    fs.writeFileSync(target, text, 'utf8')
    const st = fs.statSync(target)
    return { novel, file: hit.file, kind: hit.kind, plain: /\.txt$/i.test(hit.file), bytes: st.size, savedAt: st.mtimeMs }
  }),
  // 流式输出：轮询这个接口拿"正在写的字"
  {
    kind: 'exact',
    path: '/novel/api/stream',
    handler(req, res) {
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        const session = url.searchParams.get('session') || '';
        const live = streamBuffer.forSession(session);
        sendJson(res, 200, {
          ok: true,
          ...live,
          // 诊断用：0 说明 agent/assistant-stream 事件压根没来（而不是面板的问题）
          framesSeen: streamBuffer.totalFrames(),
          sessions: streamBuffer.size()
        });
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String((err && err.message) || err) });
      }
    }
  },
  // 章节改名 / 删除
  post('/novel/api/chapter', (body) => {
    const novel = String(body.novel || '').trim()
    if (!novel) throw new Error('缺少 novel 参数')
    const action = String(body.action || '').trim()
    // 重排不需要指定某一章（order 就是全部章节），所以放在 file 校验之前
    if (action === 'reorder') return reorderChapters(novel, body.order)
    if (action === 'create') return createChapter(novel, body.title, body.volume)
    const { base } = safeResolve(novel, '')
    // 认「卷名/章节名」这种 id（卷里的章节），同时挡住目录穿越；老项目传的就是纯文件名
    const hit = resolveFileArg(base, body.file)
    if (hit.kind !== 'chapter') throw new Error('只能操作 chapters 下的 .txt / .md')
    const id = hit.id
    const { volume, name } = splitChapterId(id)
    const { target } = safeResolve(novel, hit.file)
    if (!fs.existsSync(target)) throw new Error(`找不到这一章：${id}`)

    if (action === 'delete') {
      // 章节也是一样：挪进回收站，不真删
      const movedTo = moveToTrash(target, `${novel}__${name.replace(/\.(txt|md)$/i, '')}`)
      return { novel, deleted: id, movedTo, recoverable: true, novelState: scanNovel(novel) }
    }

    if (action === 'rename') {
      const ext = /\.md$/i.test(name) ? CHAPTER_OLD_EXT : CHAPTER_EXT // 老 .md 就还是 .md
      const stem = name.replace(/\.(txt|md)$/i, '')
      const numbered = /^第(\d+)章/.exec(stem)
      // 没编号的老文件 → 按它在列表里的顺序补一个号
      let no = numbered ? Number(numbered[1]) : 0
      if (!no) {
        const idx = scanNovel(novel).chapters.findIndex((c) => c.file === id)
        no = idx >= 0 ? idx + 1 : 1
      }
      const safe = String(body.title || '')
        .replace(/[\\/:*?"<>|]/g, '')
        .trim()
        .slice(0, 60)
      if (!safe) throw new Error('新标题不能为空')
      const nextName = `第${String(no).padStart(3, '0')}章-${safe}${ext}`
      if (nextName === name) return { novel, renamed: id, same: true, novelState: scanNovel(novel) }
      const nextId = volume ? volume + ID_SEP + nextName : nextName
      const { target: nextTarget } = safeResolve(novel, path.join(CHAPTERS, ...(volume ? [volume] : []), nextName))
      if (fs.existsSync(nextTarget)) throw new Error(`已经有「${nextName}」了`)
      fs.renameSync(target, nextTarget)
      return { novel, renamed: nextId, from: id, novelState: scanNovel(novel) }
    }

    throw new Error(`不认识的操作：${action}（只支持 rename / delete）`)
  }),
  // 卷：新建 / 改名 / 删除（删除 = 整卷挪进回收站，跟删章节一个规矩）
  post('/novel/api/volume', (body) => {
    const novel = String(body.novel || '').trim()
    if (!novel) throw new Error('缺少 novel 参数')
    const action = String(body.action || '').trim()
    if (action === 'create') return createVolume(novel, body.name)
    if (action === 'rename') return renameVolume(novel, body.from, body.name ?? body.to)
    if (action === 'delete') return deleteVolume(novel, body.name ?? body.from)
    throw new Error(`不认识的操作：${action}（只支持 create / rename / delete）`)
  }),
  // 老格式一键迁移 / 导出（format: txt / epub / docx）
  post('/novel/api/migrate', (body) => migrateNovel(body.novel)),
  post('/novel/api/export', (body) => exportNovel(body.novel, body.format)),
  // 保存位置：GET 读当前状态，POST 改（目录不存在会自动创建）
  {
    kind: 'exact',
    path: '/novel/api/config',
    async handler(req, res) {
      const method = String(req.method || 'GET').toUpperCase();
      try {
        if (method === 'POST') {
          const body = (await readBody(req)) || {};
          sendJson(res, 200, { ok: true, ...setRoot(body.root) });
          return;
        }
        sendJson(res, 200, { ok: true, ...rootInfo() });
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String((err && err.message) || err), ...rootInfo() });
      }
    }
  },
  // 小说：新建 / 改名 / 删除（删除 = 移到回收站，不是真删）
  post('/novel/api/novel', (body) => {
    const action = String(body.action || 'create')
    if (action === 'rename') return renameNovel(body.name, body.newName)
    if (action === 'delete') return deleteNovel(body.name)
    if (action !== 'create') throw new Error(`不认识的操作：${action}（只支持 create / rename / delete）`)
    const created = createNovel(body.name, body.intro)
    return { novel: scanNovel(created.name), created: created.name, files: created.files }
  })
]

/** 把路由表挂到 webServer 上；返回注册条数（便于自检 / 测试） */
function registerApi(webServer) {
  if (!webServer || typeof webServer.register !== 'function') return 0
  const seen = new Set()
  let n = 0
  for (const route of API_ROUTES) {
    const key = `${route.kind} ${route.path}`
    // 自我防护：同一路径注册两条会抛 duplicate，整个 API 就全废了（踩过）
    if (seen.has(key)) {
      throw new Error(`[dsh-novel] 路由重复：${key} —— 同一路径只能一条，GET/POST 在 handler 里按 method 分`)
    }
    seen.add(key)
    webServer.register(route)
    n += 1
  }
  return n
}

// ─────────────────────────── 插件声明 ───────────────────────────
export const name = 'dsh-novel'
export const inject = ['tools']

// 给本地测试用（test-api.mjs 直接喂假 req/res 调这些）
export {
  API_ROUTES,
  scanNovel,
  registerApi,
  readCast,
  writeCast,
  createNovel,
  renameNovel,
  deleteNovel,
  reorderChapters,
  createChapter,
  readChapters,
  createVolume,
  renameVolume,
  deleteVolume,
  listVolumes,
  splitChapterId,
  chapterPath,
  nextChapterNo,
  migrateNovel,
  exportNovel,
  TRASH_DIR,
  castTextFor,
  streamBuffer,
  novelRoot,
  rootInfo,
  setRoot,
  DEFAULT_ROOT,
  CONFIG_FILE
}

export function apply(ctx) {
  // 流式输出：订阅模型的增量帧（不注入 agent 服务也能收事件）
  if (typeof ctx.on === 'function') {
    ctx.on('agent/assistant-stream', (payload) => {
      const first = streamBuffer.totalFrames() === 0;
      streamBuffer.onFrame(payload);
      if (first) console.log('[dsh-novel] 收到第一帧 assistant-stream —— 流式输出可用');
    });
  } else {
    console.log('[dsh-novel] ctx.on 不可用，流式输出关闭');
  }

  const tools = ctx.reflect.get('tools', false)
  if (tools === undefined) {
    console.log('[dsh-novel] tools 服务不可用，跳过注册')
  } else {
    tools.register(buildNovelListTool())
    tools.register(buildNovelReadTool())
    tools.register(buildNovelContextTool())
    tools.register(buildNovelSaveChapterTool())
    tools.register(buildNovelCastTool())
    console.log(
      '[dsh-novel] 已注册工具：novel_list / novel_read / novel_context / novel_save_chapter / novel_cast'
    )
  }

  // 浏览器 API：等 webServer 就绪再挂（动态注入，不拖住上面的工具）
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (httpCtx) => {
      const webServer =
        (typeof httpCtx.get === 'function' ? httpCtx.get('webServer') : undefined) ??
        (httpCtx.reflect ? httpCtx.reflect.get('webServer', false) : undefined)
      if (!webServer) {
        console.log('[dsh-novel] webServer 服务不可用，浏览器 API 未注册')
        return
      }
      const n = registerApi(webServer)
      console.log(
        `[dsh-novel] 已注册浏览器 API（${n} 条）：/novel/api/list、/read、/cast、/save、/novel`
      )
    })
  }
}
