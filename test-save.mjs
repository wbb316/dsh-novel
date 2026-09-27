/**
 * 本地验证**写盘路径** —— 全程在临时小说里跑，跑完把整个目录删掉，
 * 绝不碰你真实的小说数据。
 *
 * 覆盖：
 *   新格式（大纲.txt / 世界观.txt / 人物卡.txt / 角色.json / chapters\第NNN章-标题.txt）
 *   + 纯文本（写 .txt 时自动抹掉 markdown 记号）
 *   + **老格式兼容**（outline.md 那套照样读、而且改写回原文件）
 *   + 角色增删改 / 关系 / 章节改名删除 / 危险写操作拦截
 *
 * 跑法：  cd D:\dsh-novel-plugin ; node test-save.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import * as mod from './lib/index.js'
import { API_ROUTES, createNovel, scanNovel, novelRoot } from './lib/index.js'

let failed = 0
function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

// 顺便把工具也注册出来，后面直接用工具跑一遍（工具和 API 是两条独立的路）
const tools = {}
mod.apply({
  reflect: {
    get: (n, d) => (n === 'tools' ? { register: (t) => (tools[t.name] = t) } : d)
  }
})

const ROOT = novelRoot()
const TEMP = '__自测临时小说__'
const LEGACY = '__自测老格式__'
const tempDir = path.join(ROOT, TEMP)
const legacyDir = path.join(ROOT, LEGACY)

/** 调路由（GET 直接跑；POST 喂一个假的请求流） */
async function call(method, routePath, { url, body } = {}) {
  const route = API_ROUTES.find((r) => r.path === routePath)
  if (!route) throw new Error('没有这条路由：' + routePath)
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
  let req = { method, url: url || routePath }
  if (method === 'POST') {
    const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8')
    req = {
      ...req,
      on(event, cb) {
        if (event === 'data') cb(payload)
        if (event === 'end') cb()
        return this
      }
    }
  }
  await route.handler(req, res)
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  return { status, json, raw: text }
}

/** 测试过程中在根目录里建的东西，一起清掉 */
const extra = []
function cleanup() {
  for (const d of [tempDir, legacyDir, ...extra.map((n) => path.join(ROOT, n))]) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true })
  }
}
cleanup()

try {
  console.log('── 1. 新建小说（新格式） ──')
  {
    const { status, json } = await call('POST', '/novel/api/novel', {
      body: { name: TEMP, intro: '一个用来测试的小说' }
    })
    ok('HTTP 200', status === 200, `实际 ${status}`)
    ok('ok:true', json?.ok === true, json?.message || '')
    ok('目录建好了', fs.existsSync(tempDir))
    ok('章节目录建好了', fs.existsSync(path.join(tempDir, 'chapters')))
    for (const f of ['大纲.txt', '世界观.txt', '人物卡.txt', '角色.json']) {
      ok(`生成 ${f}`, fs.existsSync(path.join(tempDir, f)))
    }
    ok('没有生成老的 .md 名字', !fs.existsSync(path.join(tempDir, 'outline.md')))

    const outline = fs.readFileSync(path.join(tempDir, '大纲.txt'), 'utf8')
    ok('大纲里写了一句话简介', outline.includes('一个用来测试的小说'))
    ok('大纲是纯文本（没有 # 和 **）', !/[#*]/.test(outline), JSON.stringify(outline.match(/[#*]/g) || []))

    const s = scanNovel(TEMP)
    ok(
      'scanNovel 报的是中文名',
      s.settings.map((x) => x.file).join(',') === '大纲.txt,世界观.txt,人物卡.txt',
      s.settings.map((x) => x.file).join(',')
    )
    ok(
      '设定带中文标签',
      s.settings.map((x) => x.label).join(',') === '大纲,世界观,人物卡（生成）',
      s.settings.map((x) => x.label).join(',')
    )
    ok('人物卡标了 generated', s.settings.find((x) => x.kind === 'castText')?.generated === true)
    ok('角色数据文件名报了', s.castDataFile === '角色.json', s.castDataFile)
  }

  console.log('\n── 2. 重名不让建 / 空书名不让建 ──')
  {
    const dup = await call('POST', '/novel/api/novel', { body: { name: TEMP } })
    ok('重名 → 400', dup.status === 400, `实际 ${dup.status}`)
    ok('提示说已有', String(dup.json?.message || '').includes('已经有'), dup.json?.message)
    const empty = await call('POST', '/novel/api/novel', { body: { name: '   ' } })
    ok('空书名 → 400', empty.status === 400, empty.json?.message)
  }

  console.log('\n── 3. 加角色 + 拉关系（API ops） ──')
  {
    const { status, json } = await call('POST', '/novel/api/cast', {
      body: {
        novel: TEMP,
        ops: {
          addCharacters: [
            { name: '苏晚', role: '主角', age: '17', tags: ['文学社', '毒舌'], desc: '嘴硬心软' },
            { name: '林知夏', role: '配角', desc: '学妹' }
          ]
        }
      }
    })
    ok('HTTP 200', status === 200, `实际 ${status}`)
    ok('ok:true', json?.ok === true, json?.message)
    ok('摘要对', json?.summary === '2 个角色 · 0 条关系', json?.summary)
    ok('有操作日志', Array.isArray(json?.log) && json.log.length === 2, (json?.log || []).join(' / '))
    ok('返回了人物卡文件名', json?.files?.text === '人物卡.txt', JSON.stringify(json?.files))

    const { json: j2 } = await call('POST', '/novel/api/cast', {
      body: {
        novel: TEMP,
        ops: { addRelations: [{ from: '苏晚', to: '林知夏', type: '暗恋（单向）', note: '不敢说出口' }] }
      }
    })
    ok('加关系成功', j2?.cast?.relations?.length === 1, j2?.summary)

    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, '角色.json'), 'utf8'))
    ok('角色.json 落盘', onDisk.characters.length === 2 && onDisk.relations.length === 1)
    ok('关系里存的是 id', onDisk.relations[0].from === onDisk.characters[0].id, onDisk.relations[0].from)

    const txt = fs.readFileSync(path.join(tempDir, '人物卡.txt'), 'utf8')
    ok('人物卡.txt 自动同步', txt.includes('【苏晚】 主角') && txt.includes('暗恋（单向）'))
    ok('人物卡有「关系总表」', txt.includes('关系总表'))
    ok('人物卡写了最后同步时间', txt.includes('最后同步：'))
    ok('人物卡是纯文本', !/[#*`|]/.test(txt.replace(/※/g, '')), JSON.stringify(txt.match(/[#*`|]/g) || []))
    ok('人物卡提醒别手改', txt.includes('手改会在下次同步时被覆盖'))
  }

  console.log('\n── 4. 改角色 / 删角色连带关系 ──')
  {
    const { json } = await call('POST', '/novel/api/cast', {
      body: { novel: TEMP, ops: { updateCharacters: [{ name: '苏晚', role: '反派', age: '18' }] } }
    })
    ok('按名字改成功', json?.cast?.characters?.[0]?.role === '反派', json?.cast?.characters?.[0]?.role)
    ok('人物卡跟着更新', fs.readFileSync(path.join(tempDir, '人物卡.txt'), 'utf8').includes('【苏晚】 反派'))

    const bad = await call('POST', '/novel/api/cast', {
      body: { novel: TEMP, ops: { updateCharacters: [{ name: '查无此人', age: '1' }] } }
    })
    ok('改不存在的人 → 400', bad.status === 400)
    ok('错误里列出可选角色', String(bad.json?.message || '').includes('现有角色'), String(bad.json?.message || '').slice(0, 36))

    const ghost = await call('POST', '/novel/api/cast', { body: { novel: '__不存在的书__', ops: {} } })
    ok('往不存在的小说写角色 → 400', ghost.status === 400, String(ghost.json?.message || '').slice(0, 20))
    ok('没顺手建出目录', !fs.existsSync(path.join(ROOT, '__不存在的书__')))
  }

  console.log('\n── 5. 工具的写法也能用（novel_cast） ──')
  {
    const read = await tools.novel_cast.execute({ novel: TEMP })
    ok('只读调用成功', String(read.text).includes('苏晚'), String(read.text).slice(0, 28).replace(/\n/g, ' '))

    const added = await tools.novel_cast.execute({
      novel: TEMP,
      addCharacters: [{ name: '周晓', role: '配角', tags: ['损友'], desc: '爱喝汽水' }],
      addRelations: [{ from: '周晓', to: '苏晚', type: '青梅竹马', note: '唯一知道她秘密的人' }]
    })
    ok('工具加角色+关系成功', String(added.text).includes('新增角色「周晓」'), String(added.text).split('\n')[0])
    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, '角色.json'), 'utf8'))
    ok(
      '盘上 3 个角色 2 条关系',
      onDisk.characters.length === 3 && onDisk.relations.length === 2,
      `${onDisk.characters.length}/${onDisk.relations.length}`
    )

    let threw = ''
    try {
      await tools.novel_cast.execute({ novel: TEMP, updateCharacters: [{ name: '没这人', age: '1' }] })
    } catch (e) {
      threw = String(e.message)
    }
    ok('指错人会报错并列出可选', threw.includes('现有角色'), threw.slice(0, 36))

    const removed = await tools.novel_cast.execute({ novel: TEMP, removeCharacters: ['苏晚'] })
    ok('删角色连带关系', String(removed.text).includes('连带'), String(removed.text).split('\n')[0])
    const after = JSON.parse(fs.readFileSync(path.join(tempDir, '角色.json'), 'utf8'))
    ok(
      '盘上剩 2 个角色 0 条关系',
      after.characters.length === 2 && after.relations.length === 0,
      `${after.characters.length}/${after.relations.length}`
    )
  }

  console.log('\n── 6. 读角色表（GET） ──')
  {
    const { status, json } = await call('GET', '/novel/api/cast', {
      url: '/novel/api/cast?novel=' + encodeURIComponent(TEMP)
    })
    ok('HTTP 200', status === 200)
    ok('exists:true', json?.exists === true)
    ok('带人物卡文本预览', typeof json?.text === 'string' && json.text.includes('人物卡'))
    ok('摘要对', json?.summary === '2 个角色 · 0 条关系', json?.summary)
  }

  console.log('\n── 7. 存设定（大纲.txt，自动转纯文本） ──')
  {
    const { status, json } = await call('POST', '/novel/api/save', {
      body: { novel: TEMP, file: '大纲', text: '# 新大纲\n\n**第一幕**：练习开始\n\n> 备注：别写崩\n' }
    })
    ok('HTTP 200', status === 200, json?.message)
    ok('解析到了大纲', json?.file === '大纲.txt' && json?.kind === 'outline', `${json?.file}/${json?.kind}`)
    ok('标了 plain', json?.plain === true)
    const onDisk = fs.readFileSync(path.join(tempDir, '大纲.txt'), 'utf8')
    ok(
      'markdown 记号被抹掉',
      !onDisk.includes('#') && !onDisk.includes('**') && !onDisk.includes('> '),
      JSON.stringify(onDisk.slice(0, 26))
    )
    ok('内容还在', onDisk.includes('新大纲') && onDisk.includes('第一幕：练习开始') && onDisk.includes('备注：别写崩'))
  }

  console.log('\n── 8. 存章节（走 novel_save_chapter 工具） ──')
  {
    const before = fs.readdirSync(path.join(tempDir, 'chapters')).length
    const out = await tools.novel_save_chapter.execute({
      novel: TEMP,
      title: '测试章',
      content: '# 第1章 测试\n\n**正文**……\n'
    })
    ok('工具存盘成功', String(out.text).includes('已保存'), out.text)
    ok('文件名是 .txt', String(out.text).includes('第001章-测试章.txt'), out.text)
    const files = fs.readdirSync(path.join(tempDir, 'chapters'))
    ok('章节数 +1', files.length === before + 1, `${before} → ${files.length}`)
    const body = fs.readFileSync(path.join(tempDir, 'chapters', '第001章-测试章.txt'), 'utf8')
    ok('章节正文也是纯文本', !/[#*]/.test(body), JSON.stringify(body.slice(0, 22)))

    const { json: list } = await call('GET', '/novel/api/list')
    const me = list.novels.find((n) => n.name === TEMP)
    ok('list 里 chapterCount=1', me?.chapterCount === 1, String(me?.chapterCount))
    ok('list 里带角色统计', me?.cast?.characters === 2, JSON.stringify(me?.cast))
  }

  console.log('\n── 8b. 章节改名 / 删除（.txt 也要保住扩展名） ──')
  {
    const chapterDir = path.join(tempDir, 'chapters')

    const r1 = await call('POST', '/novel/api/chapter', {
      body: { novel: TEMP, file: '第001章-测试章.txt', action: 'rename', title: '改过的标题' }
    })
    ok('改名 200', r1.status === 200, r1.json?.message)
    ok('编号和 .txt 都保住', r1.json?.renamed === '第001章-改过的标题.txt', r1.json?.renamed)
    ok('老文件没了', !fs.existsSync(path.join(chapterDir, '第001章-测试章.txt')))
    ok('新文件在', fs.existsSync(path.join(chapterDir, '第001章-改过的标题.txt')))

    const r2 = await call('POST', '/novel/api/chapter', {
      body: { novel: TEMP, file: '第001章-改过的标题.txt', action: 'rename', title: 'a/b:c*d' }
    })
    ok('非法字符被清掉', r2.json?.renamed === '第001章-abcd.txt', r2.json?.renamed)

    const empty = await call('POST', '/novel/api/chapter', {
      body: { novel: TEMP, file: '第001章-abcd.txt', action: 'rename', title: '   ' }
    })
    ok('空标题 → 400', empty.status === 400, empty.json?.message)

    const miss = await call('POST', '/novel/api/chapter', {
      body: { novel: TEMP, file: '第099章-没有这章.txt', action: 'delete' }
    })
    ok('删不存在的 → 400', miss.status === 400, String(miss.json?.message || '').slice(0, 18))

    const evil = await call('POST', '/novel/api/chapter', {
      body: { novel: TEMP, file: '../../evil.txt', action: 'delete' }
    })
    ok('目录穿越 → 400', evil.status === 400)
    ok('真文件没被误删', fs.existsSync(path.join(chapterDir, '第001章-abcd.txt')))
    ok('外面没生成东西', !fs.existsSync(path.join(ROOT, 'evil.txt')))

    const exe = await call('POST', '/novel/api/chapter', {
      body: { novel: TEMP, file: '第001章-abcd.exe', action: 'delete' }
    })
    ok('非 .txt/.md → 400', exe.status === 400, exe.json?.message)

    const weird = await call('POST', '/novel/api/chapter', {
      body: { novel: TEMP, file: '第001章-abcd.txt', action: 'explode' }
    })
    ok('未知操作 → 400', weird.status === 400, String(weird.json?.message || '').slice(0, 18))

    fs.writeFileSync(path.join(chapterDir, '第001章-占位.txt'), '占位', 'utf8')
    const dup = await call('POST', '/novel/api/chapter', {
      body: { novel: TEMP, file: '第001章-abcd.txt', action: 'rename', title: '占位' }
    })
    ok('会撞名 → 400', dup.status === 400, String(dup.json?.message || '').slice(0, 18))
    fs.unlinkSync(path.join(chapterDir, '第001章-占位.txt'))

    const del = await call('POST', '/novel/api/chapter', {
      body: { novel: TEMP, file: '第001章-abcd.txt', action: 'delete' }
    })
    ok('删除 200', del.status === 200, del.json?.message)
    ok('文件真没了', !fs.existsSync(path.join(chapterDir, '第001章-abcd.txt')))
    ok('返回的章节数归 0', del.json?.novelState?.chapterCount === 0, String(del.json?.novelState?.chapterCount))
  }

  console.log('\n── 9. 危险写操作要拦住 ──')
  {
    const md = await call('POST', '/novel/api/save', { body: { novel: TEMP, file: '人物卡.txt', text: '想手改' } })
    ok('手改人物卡 → 400', md.status === 400, String(md.json?.message || '').slice(0, 24))

    const cj = await call('POST', '/novel/api/save', { body: { novel: TEMP, file: '角色.json', text: '{}' } })
    ok('手改角色.json → 400', cj.status === 400)

    const other = await call('POST', '/novel/api/save', { body: { novel: TEMP, file: 'hack.exe', text: 'x' } })
    ok('章节名不规范 → 400', other.status === 400, String(other.json?.message || '').slice(0, 26))
    ok('确实没写进 chapters', !fs.existsSync(path.join(tempDir, 'chapters', 'hack.exe.txt')))

    const evil = await call('POST', '/novel/api/save', { body: { novel: TEMP, file: '..\\..\\evil.txt', text: 'x' } })
    ok('目录穿越 → 400', evil.status === 400, String(evil.json?.message || '').slice(0, 26))
    ok('外面确实没生成文件', !fs.existsSync(path.join(ROOT, 'evil.txt')))

    const nobook = await call('POST', '/novel/api/save', { body: { file: '大纲', text: 'x' } })
    ok('缺 novel → 400', nobook.status === 400)

    const nofile = await call('POST', '/novel/api/save', { body: { novel: TEMP } })
    ok('缺 file → 400', nofile.status === 400, nofile.json?.message)
  }

  console.log('\n── 10. 老项目保护：手写人物卡会被先备份 ──')
  {
    const legacy2 = '__自测老项目__'
    const dir = path.join(ROOT, legacy2)
    fs.mkdirSync(dir, { recursive: true })
    const handmade = '人物卡（我手写的）\n\n苏晚：嘴硬心软\n'
    fs.writeFileSync(path.join(dir, 'characters.md'), handmade, 'utf8')
    extra.push(legacy2)

    const got = await call('GET', '/novel/api/cast', { url: '/novel/api/cast?novel=' + encodeURIComponent(legacy2) })
    ok('legacyMd 标记为 true', got.json?.legacyMd === true, String(got.json?.legacyMd))
    ok('json 还不存在', got.json?.exists === false)

    const saved = await call('POST', '/novel/api/cast', {
      body: { novel: legacy2, ops: { addCharacters: [{ name: '苏晚' }] } }
    })
    ok('保存成功', saved.json?.ok === true, saved.json?.message)
    ok('旧文件备份成 .bak', fs.existsSync(path.join(dir, 'characters.md.bak')))
    ok('备份内容 = 手写原文', fs.readFileSync(path.join(dir, 'characters.md.bak'), 'utf8') === handmade)
    ok('警告里说明备份了', (saved.json?.warnings || []).some((w) => w.includes('.bak')), (saved.json?.warnings || []).join('；'))
    ok('数据源沿用老名字 characters.json', fs.existsSync(path.join(dir, 'characters.json')))
    ok('人物卡写回老文件名', fs.readFileSync(path.join(dir, 'characters.md'), 'utf8').includes('【苏晚】'))
  }

  console.log('\n── 11. 老格式项目：读得到、写回原文件、不强行改名 ──')
  {
    fs.mkdirSync(path.join(legacyDir, 'chapters'), { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'outline.md'), '# 老大纲\n\n## 一句话\n老的\n', 'utf8')
    fs.writeFileSync(path.join(legacyDir, 'world.md'), '# 老世界观\n', 'utf8')
    fs.writeFileSync(path.join(legacyDir, 'chapters', '第001章-老章.md'), '# 第1章 老章\n\n老的正文\n', 'utf8')

    const s = scanNovel(LEGACY)
    ok('章节读到了（.md）', s.chapters.map((c) => c.file).join(',') === '第001章-老章.md', s.chapters.map((c) => c.file).join(','))
    ok('章号解析正确', s.chapters[0].no === 1 && s.chapters[0].title === '老章', `${s.chapters[0].no}/${s.chapters[0].title}`)
    ok('设定报的是老文件名', s.settings.map((x) => x.file).join(',') === 'outline.md,world.md', s.settings.map((x) => x.file).join(','))
    ok('但标签还是中文的', s.settings.map((x) => x.label).join(',') === '大纲,世界观', s.settings.map((x) => x.label).join(','))

    const read = await call('GET', '/novel/api/read', {
      url: '/novel/api/read?novel=' + encodeURIComponent(LEGACY) + '&file=' + encodeURIComponent('大纲')
    })
    ok('用「大纲」这个别名也能读到', read.json?.file === 'outline.md', String(read.json?.file))
    ok('读到了内容', String(read.json?.text || '').includes('老大纲'))

    const readCh = await call('GET', '/novel/api/read', {
      url: '/novel/api/read?novel=' + encodeURIComponent(LEGACY) + '&file=' + encodeURIComponent('第001章-老章')
    })
    ok(
      '章节不带扩展名也能读',
      readCh.json?.file === 'chapters\\第001章-老章.md' || readCh.json?.file === 'chapters/第001章-老章.md',
      String(readCh.json?.file)
    )

    const saved = await call('POST', '/novel/api/save', {
      body: { novel: LEGACY, file: '大纲', text: '# 改过的老大纲\n' }
    })
    ok('写回的是老文件', saved.json?.file === 'outline.md', String(saved.json?.file))
    ok('.md 不转纯文本（保持 markdown）', saved.json?.plain === false)
    ok('老文件内容改了', fs.readFileSync(path.join(legacyDir, 'outline.md'), 'utf8').includes('改过的老大纲'))
    ok('没有偷偷生成 大纲.txt', !fs.existsSync(path.join(legacyDir, '大纲.txt')))

    const out = await tools.novel_save_chapter.execute({ novel: LEGACY, title: '新的一章', content: '# 第2章 新的一章\n' })
    ok('老项目里新章节用新格式 (.txt)', fs.existsSync(path.join(legacyDir, 'chapters', '第002章-新的一章.txt')), String(out.text))
    ok('老章节还在', fs.existsSync(path.join(legacyDir, 'chapters', '第001章-老章.md')))
    const mixed = scanNovel(LEGACY)
    ok('新旧章节一起列出来', mixed.chapterCount === 2, String(mixed.chapterCount))
    ok('章号没串', mixed.chapters.map((c) => c.no).join(',') === '1,2', mixed.chapters.map((c) => c.no).join(','))

    const ren = await call('POST', '/novel/api/chapter', {
      body: { novel: LEGACY, file: '第001章-老章.md', action: 'rename', title: '老章改名' }
    })
    ok('老 .md 章节改名后还是 .md', ren.json?.renamed === '第001章-老章改名.md', ren.json?.renamed)
  }

  console.log('\n── 12. createNovel 的边界 ──')
  {
    const before = new Set(fs.readdirSync(ROOT))
    let threw = ''
    try {
      createNovel('..\\..\\跑出去了', '')
    } catch (e) {
      threw = String(e.message)
    }
    const added = fs.readdirSync(ROOT).filter((n) => !before.has(n))
    extra.push(...added)
    ok('没在根目录之外建东西', !fs.existsSync(path.join(ROOT, '..', '跑出去了')))
    ok(
      '新增的东西都在根目录内',
      added.every((n) => path.resolve(ROOT, n).startsWith(path.resolve(ROOT) + path.sep)),
      added.join(',')
    )
    ok('首尾的点被清掉了', added.every((n) => !/^\.|\.$/.test(n)), added.join(',') || threw)
    ok(
      '只有符号的书名被拒',
      (() => {
        try {
          createNovel('...', '')
          return false
        } catch {
          return true
        }
      })()
    )
  }
  console.log('\n── 13. 小说改名 / 删除（删除 = 进回收站） ──')
  {
    const SRC = '__自测要改名的书__'
    const NEWNAME = '__自测改过名的书__'
    await call('POST', '/novel/api/novel', { body: { name: SRC, intro: '要被改名的' } })
    extra.push(SRC)
    fs.writeFileSync(path.join(ROOT, SRC, 'chapters', '第001章-第一章.txt'), '第一章正文\n', 'utf8')
    fs.writeFileSync(path.join(ROOT, SRC, 'chapters', '第002章-第二章.txt'), '第二章正文\n', 'utf8')

    const renamed = await call('POST', '/novel/api/novel', {
      body: { action: 'rename', name: SRC, newName: NEWNAME }
    })
    extra.push(NEWNAME)
    ok('改名 200', renamed.status === 200, renamed.json?.message)
    ok('返回新名字', renamed.json?.renamed === NEWNAME, renamed.json?.renamed)
    ok('老目录没了', !fs.existsSync(path.join(ROOT, SRC)))
    ok('新目录在', fs.existsSync(path.join(ROOT, NEWNAME)))
    ok('章节一起搬过去了', fs.existsSync(path.join(ROOT, NEWNAME, 'chapters', '第001章-第一章.txt')))
    ok('设定也一起搬过去了', fs.existsSync(path.join(ROOT, NEWNAME, '大纲.txt')))
    ok('返回了新状态', renamed.json?.novel?.chapterCount === 2, String(renamed.json?.novel?.chapterCount))

    const dupName = await call('POST', '/novel/api/novel', {
      body: { action: 'rename', name: NEWNAME, newName: TEMP }
    })
    ok('改成已存在的名字 → 400', dupName.status === 400, String(dupName.json?.message || '').slice(0, 22))

    const badName = await call('POST', '/novel/api/novel', {
      body: { action: 'rename', name: NEWNAME, newName: '...' }
    })
    ok('新名字只有符号 → 400', badName.status === 400, String(badName.json?.message || '').slice(0, 22))

    const ghost = await call('POST', '/novel/api/novel', {
      body: { action: 'rename', name: '__根本没有这本__', newName: '随便' }
    })
    ok('改不存在的 → 400', ghost.status === 400)

    const weird = await call('POST', '/novel/api/novel', { body: { action: '爆炸', name: NEWNAME } })
    ok('未知 action → 400', weird.status === 400, String(weird.json?.message || '').slice(0, 20))

    // 删除 → 进回收站
    const del = await call('POST', '/novel/api/novel', { body: { action: 'delete', name: NEWNAME } })
    ok('删除 200', del.status === 200, del.json?.message)
    ok('返回 recoverable', del.json?.recoverable === true)
    ok('说了挪到哪', String(del.json?.movedTo || '').indexOf('.dsh-novel-trash') >= 0, String(del.json?.movedTo))
    ok('原目录不见了', !fs.existsSync(path.join(ROOT, NEWNAME)))
    ok('回收站里有一份', fs.existsSync(path.join(ROOT, del.json.movedTo)))
    ok('章节还在回收站里（真能捞回来）', fs.existsSync(path.join(ROOT, del.json.movedTo, 'chapters', '第001章-第一章.txt')))

    const list = (await call('GET', '/novel/api/list')).json
    ok('回收站不被当成一本小说', !list.novels.some((n) => n.name.startsWith('.')), list.novels.map((n) => n.name).join(','))
    ok('被删的那本不在列表里', !list.novels.some((n) => n.name === NEWNAME))
  }

  console.log('\n── 14. 章节拖拽排序（重新编号） ──')
  {
    const dir = path.join(tempDir, 'chapters')
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f))
    for (const [i, t] of [[1, '甲'], [2, '乙'], [3, '丙']]) {
      fs.writeFileSync(path.join(dir, `第00${i}章-${t}.txt`), `第${i}章 ${t} 的正文\n`, 'utf8')
    }
    ok('先有 3 章', fs.readdirSync(dir).length === 3, fs.readdirSync(dir).join(','))

    const order = ['第003章-丙.txt', '第001章-甲.txt', '第002章-乙.txt']
    const r = await call('POST', '/novel/api/chapter', { body: { novel: TEMP, action: 'reorder', order } })
    ok('重排 200', r.status === 200, r.json?.message)
    ok(
      '返回的新顺序对',
      (r.json?.order || []).join(',') === '第001章-丙.txt,第002章-甲.txt,第003章-乙.txt',
      (r.json?.order || []).join(',')
    )
    ok('丙变成第1章', fs.existsSync(path.join(dir, '第001章-丙.txt')))
    ok('甲变成第2章', fs.existsSync(path.join(dir, '第002章-甲.txt')))
    ok('乙变成第3章', fs.existsSync(path.join(dir, '第003章-乙.txt')))
    ok('没有残留临时文件', !fs.readdirSync(dir).some((f) => f.indexOf('.tmp-') === 0), fs.readdirSync(dir).join(','))
    ok('内容跟着文件走（没串）', fs.readFileSync(path.join(dir, '第001章-丙.txt'), 'utf8').indexOf('丙 的正文') >= 0)
    const st = scanNovel(TEMP)
    ok('章号按文件名算', st.chapters.map((c) => c.no).join(',') === '1,2,3', st.chapters.map((c) => c.no).join(','))
    ok('标题还是原标题', st.chapters.map((c) => c.title).join(',') === '丙,甲,乙', st.chapters.map((c) => c.title).join(','))

    // 互换两章：考验两阶段改名（A→B、B→A 不能互相撞）
    const swap = ['第002章-甲.txt', '第001章-丙.txt', '第003章-乙.txt']
    const r2 = await call('POST', '/novel/api/chapter', { body: { novel: TEMP, action: 'reorder', order: swap } })
    ok('互换两章也能成', r2.status === 200, r2.json?.message)
    ok('互换后内容没丢', fs.readFileSync(path.join(dir, '第001章-甲.txt'), 'utf8').indexOf('甲 的正文') >= 0)
    ok('互换后丙在第2章', fs.readFileSync(path.join(dir, '第002章-丙.txt'), 'utf8').indexOf('丙 的正文') >= 0)

    const fewer = await call('POST', '/novel/api/chapter', {
      body: { novel: TEMP, action: 'reorder', order: ['第001章-甲.txt'] }
    })
    ok('章数对不上 → 400', fewer.status === 400, String(fewer.json?.message || '').slice(0, 24))

    const fake = await call('POST', '/novel/api/chapter', {
      body: { novel: TEMP, action: 'reorder', order: ['第001章-甲.txt', '第002章-丙.txt', '第999章-根本没这章.txt'] }
    })
    ok('有不存在的章 → 400', fake.status === 400, String(fake.json?.message || '').slice(0, 24))

    const dup = await call('POST', '/novel/api/chapter', {
      body: { novel: TEMP, action: 'reorder', order: ['第001章-甲.txt', '第001章-甲.txt', '第002章-丙.txt'] }
    })
    ok('有重复 → 400', dup.status === 400, String(dup.json?.message || '').slice(0, 24))

    const sameOrder = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()
    const same = await call('POST', '/novel/api/chapter', { body: { novel: TEMP, action: 'reorder', order: sameOrder } })
    ok('顺序没变时快捷返回 same', same.json?.same === true, JSON.stringify(same.json?.same))

    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.txt'))) fs.unlinkSync(path.join(dir, f))
  }
} finally {
  cleanup()
  console.log('\n🧹 已清理临时小说：' + TEMP + ' / ' + LEGACY)
  ok('临时目录删干净了', !fs.existsSync(tempDir) && !fs.existsSync(legacyDir))
  ok(
    '根目录里只剩你真正的小说',
    fs.readdirSync(ROOT).every((n) => !n.startsWith('__自测')),
    fs.readdirSync(ROOT).join(',')
  )
}

console.log(failed === 0 ? '\n✅ 写盘路径验证通过（真建真删）' : `\n❌ 有 ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
