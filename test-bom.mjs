/**
 * 本地验证「BOM 不能有」——不启动 DSH、不占端口。
 *
 * 为什么值得单独测：
 *   Windows 上「记事本另存为 UTF-8」和 PowerShell 5.1 的
 *   `Set-Content -Encoding UTF8` / `Out-File` 都会给文件开头加 `EF BB BF`。
 *   而 `JSON.parse` **不认 BOM**。踩过的两次：
 *
 *   1) 插件自己的 package.json 被写进 BOM
 *      → dsh web 启动时 loadProfileDirectory 里 `JSON.parse(readFileSync(pkg,'utf8'))` 抛
 *        `SyntaxError: Unexpected token '\uFEFF'` → composeProfile 阶段就退出
 *        → **3080 根本没监听**。表面症状只是"网页打不开"，跟插件八竿子打不着。
 *   2) 用户拿记事本改了一下 `角色.json` / `~/.dsh-novel/config.json`
 *      → 插件读的时候同样炸。
 *
 *   所以这里盯两头：**仓库里不许有 BOM**（第 1、2 节），
 *   **用户数据带 BOM 也得能读**（第 3~5 节）。
 *
 * 全程跑在一个临时小说根目录里（DSH_NOVEL_ROOT / DSH_NOVEL_CONFIG 指过去），跑完删掉。
 *
 * 跑法：  cd D:\dsh-novel-plugin ; node test-bom.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let failed = 0
function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BOM_BYTES = [0xef, 0xbb, 0xbf]
const BOM_CHAR = '\ufeff'

/** 文件开头是不是 UTF-8 BOM（看原始字节，不看解码后的字符） */
function hasBom(file) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(3)
  const n = fs.readSync(fd, buf, 0, 3, 0)
  fs.closeSync(fd)
  return n === 3 && buf[0] === BOM_BYTES[0] && buf[1] === BOM_BYTES[1] && buf[2] === BOM_BYTES[2]
}

/** 写一个「带 BOM 的文件」，模拟记事本 / PowerShell 5.1 的产出 */
function writeBomFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([Buffer.from(BOM_BYTES), Buffer.from(text, 'utf8')]))
}

// ─────────────── 1. 仓库体检：一个 BOM 都不许有 ───────────────
console.log('── 1. 仓库体检（含 package.json） ──')
const SKIP_DIRS = new Set(['node_modules', '.git', 'data'])
const scanned = []
const offenders = []
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      walk(path.join(dir, ent.name))
      continue
    }
    const full = path.join(dir, ent.name)
    scanned.push(full)
    if (hasBom(full)) offenders.push(path.relative(HERE, full))
  }
}
walk(HERE)

ok('扫到了文件（不是空跑）', scanned.length >= 15, `实际 ${scanned.length} 个`)
ok('一个带 BOM 的文件都没有', offenders.length === 0, offenders.join(', ') || '干净')

// 2. 复刻 DSH 启动时那一步：这一步抛错 = 3080 不监听
console.log('\n── 2. 复刻 DSH 的启动解析 ──')
{
  const pkgPath = path.join(HERE, 'package.json')
  let pkg = null
  let err = ''
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) // ← dsh-app-boot/lib/index.js:851 就是这么读的
  } catch (e) {
    err = String((e && e.message) || e)
  }
  ok('JSON.parse(readFileSync(package.json, "utf8")) 不抛错', pkg !== null, err)
  ok('能读到 name', pkg && pkg.name === 'dsh-novel', pkg && pkg.name)
  ok('能读到 dsh.bundle.patch', !!(pkg && pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch))
  // 反面对照：证明了「为什么非要这条断言」——BOM 真的会让 JSON.parse 炸
  let bomThrows = false
  try {
    JSON.parse(BOM_CHAR + '{}')
  } catch {
    bomThrows = true
  }
  ok('对照：BOM + JSON.parse 确实会炸（所以这坑是真的）', bomThrows)
}

// ─────────────── 3. text.js 单元：读的东西自动去 BOM ───────────────
console.log('\n── 3. lib/text.js ──')
const { stripBom, readText, readJson, parseJsonText } = await import('./lib/text.js')
{
  ok('stripBom 去掉开头的 BOM', stripBom(BOM_CHAR + 'abc') === 'abc')
  ok('stripBom 不动没有 BOM 的文本', stripBom('abc') === 'abc')
  ok('stripBom 只去开头一个，正文里的 \uFEFF 保留', stripBom(BOM_CHAR + 'a' + BOM_CHAR + 'b') === 'a' + BOM_CHAR + 'b')
  ok('stripBom 容忍非字符串（undefined / null / 数字）', stripBom(undefined) === undefined && stripBom(null) === null && stripBom(7) === 7)
  ok('stripBom 容忍空串', stripBom('') === '')
  ok('parseJsonText 吃带 BOM 的 JSON', parseJsonText(BOM_CHAR + '{"a":1}').a === 1)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-novel-bom-unit-'))
  const jsonFile = path.join(tmp, 'x.json')
  const txtFile = path.join(tmp, 'x.txt')
  writeBomFile(jsonFile, '{"ok":true}\n')
  writeBomFile(txtFile, '你好\n')
  ok('readJson 吃带 BOM 的文件', readJson(jsonFile).ok === true)
  ok('readText 吃带 BOM 的文件', readText(txtFile) === '你好\n')
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ─────────────── 4. 用户数据带 BOM 也要能读（真插件、临时根目录） ───────────────
console.log('\n── 4. 用户文件带 BOM（临时小说根目录） ──')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-novel-bom-'))
const ROOT = path.join(TMP, 'library')
process.env.DSH_NOVEL_ROOT = ROOT
process.env.DSH_NOVEL_CONFIG = path.join(TMP, 'config.json')
fs.mkdirSync(ROOT, { recursive: true })

const { API_ROUTES, readCast, writeCast, castTextFor, scanNovel, createChapter } = await import('./lib/index.js')

const { parseCastJson } = await import('./lib/cast.js')
ok(
  'parseCastJson 吃带 BOM 的 角色.json 文本',
  parseCastJson(BOM_CHAR + '{"characters":[{"id":"c1","name":"苏晚"}]}').cast.characters[0].name === '苏晚'
)

const NOVEL = 'BOM 测试书'
const dir = path.join(ROOT, NOVEL)
writeBomFile(
  path.join(dir, '角色.json'),
  JSON.stringify({ version: 1, characters: [{ id: 'c1', name: '苏晚', role: '主角' }], relations: [] }, null, 2) + '\n'
)
writeBomFile(path.join(dir, '大纲.txt'), '第 5 条被苏晚撕掉了。\n')
writeBomFile(path.join(dir, 'chapters', '第001章-带BOM的一章.txt'), '第1章 带BOM的一章\n\n「你也带 BOM？」\n')

{
  const { cast, warnings } = readCast(NOVEL)
  ok('readCast：带 BOM 的角色.json 读得出来', cast.characters.length === 1 && cast.characters[0].name === '苏晚')
  ok('readCast：没有多余的警告', warnings.length === 0, warnings.join(' / '))

  const text = castTextFor(NOVEL)
  ok('castTextFor：人物卡里没有残留的 BOM 字符', !text.includes(BOM_CHAR) && text.includes('苏晚'))

  const info = scanNovel(NOVEL)
  ok('scanNovel：章节认得出来', info.chapters.length === 1, `实际 ${info.chapters.length}`)
}

// 5. 走真路由：/novel/api/read + /novel/api/cast
console.log('\n── 5. 真路由读带 BOM 的文件 ──')
async function callApi(routePath, { method = 'GET', url } = {}) {
  const route = API_ROUTES.find((r) => r.path === routePath)
  if (!route) throw new Error('没有这条路由：' + routePath)
  let status = 0
  let body = ''
  await route.handler(
    { url: url || routePath, method },
    {
      setHeader() {},
      end(c) {
        body = c ?? ''
      },
      set statusCode(v) {
        status = v
      },
      get statusCode() {
        return status
      }
    }
  )
  return { status, body, json: (() => { try { return JSON.parse(body) } catch { return null } })() }
}

{
  const q = (s) => encodeURIComponent(s)
  const outline = await callApi('/novel/api/read', { url: `/novel/api/read?novel=${q(NOVEL)}&file=${q('大纲.txt')}` })
  ok('GET /novel/api/read（大纲.txt 带 BOM）HTTP 200', outline.status === 200, `实际 ${outline.status}`)
  ok('返回的正文不含 BOM 字符', outline.json && !String(outline.json.text).includes(BOM_CHAR))
  ok('正文内容完整', outline.json && String(outline.json.text).includes('撕掉'), String(outline.json && outline.json.text).slice(0, 24))

  const chapter = await callApi('/novel/api/read', { url: `/novel/api/read?novel=${q(NOVEL)}&file=${q('第001章-带BOM的一章.txt')}` })
  ok('GET /novel/api/read（章节带 BOM）HTTP 200', chapter.status === 200, `实际 ${chapter.status}`)
  ok('章节正文不以 BOM 开头', chapter.json && !String(chapter.json.text).startsWith(BOM_CHAR))
  ok('章节正文读全了', chapter.json && String(chapter.json.text).includes('你也带 BOM'))

  const castRes = await callApi('/novel/api/cast', { url: `/novel/api/cast?novel=${q(NOVEL)}` })
  ok('GET /novel/api/cast（角色.json 带 BOM）HTTP 200', castRes.status === 200, `实际 ${castRes.status}`)
  ok('ok:true 且角色读出来了', castRes.json && castRes.json.ok === true && castRes.json.cast.characters.length === 1)
}

// ─────────────── 6. 我们写出去的文件，一个 BOM 都不带 ───────────────
console.log('\n── 6. 写盘不带 BOM ──')
{
  writeCast(NOVEL, { version: 1, characters: [{ id: 'c1', name: '苏晚', role: '主角' }], relations: [] })
  ok('writeCast 写的 角色.json 不带 BOM', !hasBom(path.join(dir, '角色.json')))
  ok('writeCast 写的 人物卡.txt 不带 BOM', !hasBom(path.join(dir, '人物卡.txt')))

  const ch = createChapter(NOVEL, '新写的')
  const chFile = path.join(dir, 'chapters', ch.created)
  ok('createChapter 写的章节不带 BOM', fs.existsSync(chFile) && !hasBom(chFile), ch.created)
}

// 收拾现场（临时目录，不在真实小说库里）
fs.rmSync(TMP, { recursive: true, force: true })

console.log(failed === 0 ? '\n✅ BOM 相关全部通过' : `\n❌ 有 ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
