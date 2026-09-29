/**
 * 本地验证「改角色名（会动正文）」——不启动 DSH、不占端口。
 *
 * 这是插件里**唯一会批量改你正文**的功能，所以规矩定得死：
 *   1. **先算再问**：dryRun 只统计"改几个文件、几处"，一个字节都不动
 *   2. **先备份再改**：原件整份复制到 `<小说>\_改名备份\<时间>\`，然后才替换
 *   3. **不碰生成物**：人物卡.txt / 剧情.txt 不直接替换（会自己重新生成）
 *   4. **剧情.json 的标题和备注跟着改**（不然剧情里还写着旧名）
 *   5. **单个字的名字不做全文替换**（「晓」出现在「晓得」里太正常了）
 *
 * 全程跑在临时小说根目录里，跑完删掉 —— 绝不碰你真实的小说。
 *
 * 跑法：  cd D:\dsh-novel-plugin ; node test-rename.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failed = 0
function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-novel-rename-'))
const ROOT = path.join(TMP, 'library')
process.env.DSH_NOVEL_ROOT = ROOT
process.env.DSH_NOVEL_CONFIG = path.join(TMP, 'config.json')
fs.mkdirSync(ROOT, { recursive: true })

const { API_ROUTES, createNovel, createChapter, writeCast, renameCharacter, RENAME_BACKUP, writePlot, readCast } =
  await import('./lib/index.js')

async function call(routePath, { method = 'GET', url, body } = {}) {
  const route = API_ROUTES.find((r) => r.path === routePath)
  if (!route) throw new Error('没有这条路由：' + routePath)
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  const req = {
    url: url || routePath,
    method,
    on(ev, fn) {
      if (ev === 'data') {
        if (payload) fn(payload)
        return req
      }
      if (ev === 'end') {
        fn()
        return req
      }
      return req
    },
    destroy() {}
  }
  let status = 0
  let text = ''
  const res = {
    setHeader() {},
    end(c) {
      text = c ?? ''
    },
    set statusCode(v) {
      status = v
    },
    get statusCode() {
      return status
    }
  }
  await route.handler(req, res)
  return { status, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

const NOVEL = '改名测试书'
createNovel(NOVEL)
const base = path.join(ROOT, NOVEL)
writeCast(NOVEL, {
  version: 1,
  characters: [
    { id: 'c1', name: '周晓', role: '配角', tier: '重要' },
    { id: 'c2', name: '苏晚', role: '主角', tier: '重要' }
  ],
  relations: [{ from: 'c1', to: 'c2', type: '损友' }]
})
createChapter(NOVEL, '第一话')
createChapter(NOVEL, '第二话')
// 正文里放上旧名（`createChapter` 只给骨架，这里补正文）
const chapters = fs.readdirSync(path.join(base, 'chapters')).sort()
fs.writeFileSync(
  path.join(base, 'chapters', chapters[0]),
  '第1章 第一话\n\n周晓把汽水拍在桌上。「晓得啦。」她说。周晓又说了一遍。\n',
  'utf8'
)
fs.writeFileSync(path.join(base, 'chapters', chapters[1]), '第2章 第二话\n\n苏晚看着周晓。\n', 'utf8')
fs.writeFileSync(path.join(base, '大纲.txt'), '一句话简介：周晓是文学社社长。\n\n第二章周晓登场。\n', 'utf8')
fs.writeFileSync(path.join(base, '世界观.txt'), '周晓所在的文学社在旧教学楼。\n', 'utf8')
writePlot(NOVEL, { arcs: { '': '周晓线' }, beats: [{ id: 'b1', title: '周晓登场', volume: '', chapters: [], cast: ['c1'], done: false, note: '周晓的第一次出场' }] })

// ─────────────── 1. dry-run：只算不动 ───────────────
console.log('── 1. dry-run（一个字节都不许动） ──')
{
  const snap = (p) => fs.readFileSync(path.join(base, p), 'utf8')
  const before = { o: snap('大纲.txt'), w: snap('世界观.txt'), c: snap(path.join('chapters', chapters[0])) }
  const d = await call('/novel/api/cast', { method: 'POST', body: { novel: NOVEL, rename: { from: '周晓', to: '周晓晓' }, dryRun: true } })
  ok('dry-run 200', d.status === 200, `实际 ${d.status} ${d.json && d.json.message}`)
  ok('说了能替换', d.json.canReplace === true)
  ok('统计了文件数', d.json.fileCount === 5, JSON.stringify(d.json.files))
  ok('统计了处数', d.json.total === 8, JSON.stringify(d.json.files))
  ok('逐文件有明细', d.json.files.every((f) => f.file && typeof f.count === 'number'), JSON.stringify(d.json.files))
  ok('文件一个字没动', snap('大纲.txt') === before.o && snap('世界观.txt') === before.w && snap(path.join('chapters', chapters[0])) === before.c)
  ok('角色名也还没改', readCast(NOVEL).cast.characters[0].name === '周晓')
  ok('还没建备份目录', !fs.existsSync(path.join(base, RENAME_BACKUP)))
}

// ─────────────── 2. 真改：备份 + 替换 + 角色表 ───────────────
console.log('\n── 2. 真改 ──')
{
  const r = renameCharacter(NOVEL, '周晓', '周晓晓')
  ok('返回了备份路径', !!r.backupDir && r.backupDir.startsWith(RENAME_BACKUP), r.backupDir)
  ok('备份真的存在', fs.existsSync(path.join(base, r.backupDir)))
  ok('备份里是**原件**（旧名字还在）', fs.readFileSync(path.join(base, r.backupDir, '大纲.txt'), 'utf8').includes('周晓'))

  ok('大纲换了', fs.readFileSync(path.join(base, '大纲.txt'), 'utf8').includes('周晓晓') && !fs.readFileSync(path.join(base, '大纲.txt'), 'utf8').includes('周晓是'))
  ok('世界观换了', fs.readFileSync(path.join(base, '世界观.txt'), 'utf8').includes('周晓晓所在的文学社'))
  const ch0 = fs.readFileSync(path.join(base, 'chapters', chapters[0]), 'utf8')
  ok('章节正文换了（多处都换）', (ch0.match(/周晓晓/g) || []).length === 2, String((ch0.match(/周晓晓/g) || []).length))
  ok('只换整个名字：正文里的「晓得啦」没被改坏', ch0.includes('晓得啦'), ch0)
  ok('备份里章节也是原件', fs.readFileSync(path.join(base, r.backupDir, 'chapters', chapters[0]), 'utf8').includes('周晓把汽水'))

  const cast = readCast(NOVEL).cast
  ok('角色名改了', cast.characters[0].name === '周晓晓')
  ok('关系没受影响（关系用的是 id）', cast.relations.length === 1 && cast.relations[0].from === 'c1')
  ok('人物卡.txt 跟着重新生成了', fs.readFileSync(path.join(base, '人物卡.txt'), 'utf8').includes('【周晓晓】'))

  const pj = JSON.parse(fs.readFileSync(path.join(base, '剧情.json'), 'utf8'))
  ok('剧情.json 的标题跟着改了', pj.beats[0].title === '周晓晓登场', pj.beats[0].title)
  ok('剧情.json 的备注也跟着改了', pj.beats[0].note === '周晓晓的第一次出场', pj.beats[0].note)
  ok('剧情.json 的出场角色还是 id（没被名字替换搞坏）', pj.beats[0].cast[0] === 'c1')
  ok('剧情.txt 重新渲染后是新名字', fs.readFileSync(path.join(base, '剧情.txt'), 'utf8').includes('周晓晓登场'))
  ok('备份里没有生成物（只备份真改过的文件）', !fs.existsSync(path.join(base, r.backupDir, '人物卡.txt')) && !fs.existsSync(path.join(base, r.backupDir, '剧情.txt')))
}

// ─────────────── 3. 中文词的坑：单字名字不做全文替换 ───────────────
console.log('\n── 3. 单字名字（危险的那类） ──')
{
  const chBefore = fs.readFileSync(path.join(base, 'chapters', chapters[1]), 'utf8')
  const d = renameCharacter(NOVEL, '苏晚', '苏', { dryRun: true })
  ok('dry-run 说不能替换', d.canReplace === false)
  ok('并说明了原因', d.note.includes('一个字'), d.note)
  ok('统计是 0（不做全文替换）', d.total === 0 && d.fileCount === 0)

  const r = renameCharacter(NOVEL, '苏晚', '苏')
  ok('角色表改了', readCast(NOVEL).cast.characters[1].name === '苏')
  ok('正文**没被动**（「苏晚」还在）', fs.readFileSync(path.join(base, 'chapters', chapters[1]), 'utf8') === chBefore)
  ok('也没建备份（因为没改正文）', r.backupDir === '')

  // 注：把名字改回来方便后面看
  renameCharacter(NOVEL, '苏', '苏晚')
  ok('改回来也没问题', readCast(NOVEL).cast.characters[1].name === '苏晚')
}

// ─────────────── 4. 各种不该发生的情况 ───────────────
console.log('\n── 4. 坏输入 ──')
{
  const errs = []
  const grab = (fn) => {
    try {
      fn()
      return ''
    } catch (e) {
      return String(e.message)
    }
  }
  errs.push(grab(() => renameCharacter(NOVEL, '查无此人', '新名')))
  errs.push(grab(() => renameCharacter(NOVEL, '周晓晓', '苏晚')))
  errs.push(grab(() => renameCharacter(NOVEL, '周晓晓', '周晓晓')))
  errs.push(grab(() => renameCharacter(NOVEL, '周晓晓', '   ')))
  ok('找不到角色 → 报错', /找不到角色/.test(errs[0]), errs[0])
  ok('重名 → 报错', /已经有一个角色叫/.test(errs[1]), errs[1])
  ok('新旧同名 → 报错', /一样/.test(errs[2]), errs[2])
  ok('新名空白 → 报错', /都要有/.test(errs[3]), errs[3])

  const r404 = await call('/novel/api/cast', { method: 'POST', body: { novel: '没有这本书', rename: { from: 'a', to: 'b' } } })
  ok('小说不存在 → 400', r404.status === 400, `实际 ${r404.status}`)
  const r500 = await call('/novel/api/cast', { method: 'POST', body: { novel: NOVEL, rename: { from: '没有这个人', to: 'b' } } })
  ok('角色不存在 → 400 且说清楚', r500.status === 400 && /找不到角色/.test(r500.json.message), r500.json && r500.json.message)
}

// ─────────────── 5. 普通保存不受影响 ───────────────
console.log('\n── 5. 没传 rename 时还是老样子 ──')
{
  const r = await call('/novel/api/cast', { method: 'POST', body: { novel: NOVEL, ops: { addCharacters: [{ name: '路人甲', role: '路人' }] } } })
  ok('普通增加角色照旧 200', r.status === 200 && r.json.cast.characters.length === 3, `实际 ${r.status}`)
  ok('新角色自动进「不重要」', r.json.cast.characters.find((c) => c.name === '路人甲').tier === '不重要')
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('\n🧹 临时小说根目录已删掉：' + TMP)
console.log(failed === 0 ? '\n✅ 改角色名（含全文替换）全部通过' : `\n❌ 有 ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
