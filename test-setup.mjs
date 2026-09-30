/**
 * 本地验证**开书向导的宿主半** —— 全程在临时小说里跑，跑完整目录删掉，
 * 绝不碰你真实的小说数据。
 *
 * 覆盖：
 *   1) 向后兼容：老的两参数 createNovel(name, intro) 行为不变（不落 设定.json）
 *   2) 完整 payload：设定.json / 角色（主角富字段拼 desc + tags）/ 世界观 / 大纲（三幕+灵感池）
 *      / 剧情.json 的全书纲领 / 可选第一章
 *   3) 设定.json 的读写通道（没有文件算正常、字段白名单、坏 JSON 报错、对象与文本两种入口）
 *   4) 设定.json 的存在**没有**把新书误判成老格式（这是最阴的坑）
 *
 * 跑法：  cd D:\dsh\plugins\dsh-novel-plugin ; node test-setup.mjs
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

/** 调真路由（GET 直接跑；POST 喂一个假的请求流） */
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
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
      on(event, cb) {
        if (event === 'data') cb(payload)
        if (event === 'end') cb()
        return req
      }
    }
  }
  await route.handler(req, res)
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { status, json }
}

const ROOT = novelRoot()
const PLAIN = '__自测开书_空payload__'
const FULL = '__自测开书_满payload__'
const dirs = [path.join(ROOT, PLAIN), path.join(ROOT, FULL)]

/** 清理：把本次用到的临时小说全删掉（它们是本脚本自己建的） */
function cleanup() {
  for (const d of dirs) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true })
  }
}

cleanup()
console.log(`临时小说根目录：${ROOT}\n`)

try {
  // ───────────────────────── 1) 向后兼容 ─────────────────────────
  console.log('── 1. 老的两参数调用：行为必须和以前一样 ──')
  const plainOut = createNovel(PLAIN, '一句话简介：练习而已')
  const plainDir = path.join(ROOT, PLAIN)
  const plainFiles = fs.readdirSync(plainDir)
  ok('建出了目录', fs.existsSync(plainDir))
  ok('大纲.txt 在', fs.existsSync(path.join(plainDir, '大纲.txt')))
  ok('世界观.txt 在', fs.existsSync(path.join(plainDir, '世界观.txt')))
  ok('角色.json + 人物卡.txt 在', fs.existsSync(path.join(plainDir, '角色.json')) && fs.existsSync(path.join(plainDir, '人物卡.txt')))
  ok('chapters\\ 建出来了', fs.existsSync(path.join(plainDir, 'chapters')))
  ok('**没有** 设定.json（空 payload 不该多出空文件）', !fs.existsSync(path.join(plainDir, '设定.json')))
  ok('目录里就这 5 样 + chapters', plainFiles.length === 5, plainFiles.join(' / '))
  const plainOutline = fs.readFileSync(path.join(plainDir, '大纲.txt'), 'utf8')
  ok('一句话简介写进大纲了', plainOutline.includes('一句话简介：练习而已'))
  ok('大纲模板没被搞乱（还有"故事走向"）', plainOutline.includes('三、故事走向') && plainOutline.includes('四、结尾想要的感觉'))
  ok('返回的 files 与旧版一致（4 个）', Array.isArray(plainOut.files) && plainOut.files.length === 4, JSON.stringify(plainOut.files))

  // ───────────────────────── 2) 完整 payload ─────────────────────────
  console.log('\n── 2. 开书向导：一次把该写的都写了 ──')
  const created = await call('POST', '/novel/api/novel', {
    body: {
      action: 'create',
      name: FULL,
      intro: '（这句会被 settings.logline 盖掉）',
      settings: {
        genre: '校园恋爱',
        tone: '甜中带涩',
        pov: '第三人称',
        chapterChars: 3000,
        logline: '高三的苏晚为了克服恋爱恐惧，找人假装恋爱。',
        ending: '两个人在毕业那天承认这不是练习。',
        tags: ['校园', '假装情侣'],
        note: '每章至少一个笑点',
        多写的键: '应该被丢掉'
      },
      hero: {
        name: '苏晚',
        gender: '女',
        age: '17',
        identity: '高三·文学社',
        look: '黑长直，总把校服袖口卷起来',
        traits: ['嘴硬', '心软', '拖延'],
        want: '学会喜欢一个人而不逃跑',
        fear: '被看穿她在假装',
        secret: '她其实早就写过一封没寄出的信',
        speech: '嘴硬，紧张时会叫对方全名'
      },
      supporting: [{ name: '林知夏', role: '配角', tier: '重要', desc: '同桌，被拉来当练习对象' }],
      world: { era: '现代', place: '南方小城·重点高中', rules: '无超自然要素', taboo: '不许在文学社提"恋爱"两个字', glossary: ['练习守则 —— 五条规矩，第 5 条被撕掉了'] },
      acts: ['第一幕：契约成立，两人开始练习', '第二幕：练习越界，谁先动心谁输', '第三幕：误会、雨天、真心话'],
      inspiration: '雨天的伞下\n守则第 5 条到底写了什么',
      withFirstChapter: true
    }
  })
  ok('路由返回 ok', created.json && created.json.ok === true, JSON.stringify(created.json).slice(0, 120))
  ok('返回里带了创建出的书名', created.json && created.json.created === FULL)
  ok('返回里报告了角色数（2 个）', created.json && created.json.characters === 2, String(created.json && created.json.characters))
  ok('返回里报告了写了设定', created.json && created.json.hasSettings === true)

  const fullDir = path.join(ROOT, FULL)
  const settingsPath = path.join(fullDir, '设定.json')
  ok('设定.json 落盘了', fs.existsSync(settingsPath))
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  ok('类型/基调/视角/每章字数都对', settings.genre === '校园恋爱' && settings.tone === '甜中带涩' && settings.pov === '第三人称' && settings.chapterChars === 3000)
  ok('主线用了 settings.logline（不是 intro）', settings.logline.includes('恋爱恐惧'))
  ok('结局写进去了', settings.ending.includes('毕业那天'))
  ok('tags 数组保留', Array.isArray(settings.tags) && settings.tags.length === 2)
  ok('**白名单生效**：多写的键被丢掉', settings['多写的键'] === undefined)
  ok('有 updatedAt 时间戳', typeof settings.updatedAt === 'string' && settings.updatedAt.length >= 10, settings.updatedAt)

  const cast = JSON.parse(fs.readFileSync(path.join(fullDir, '角色.json'), 'utf8'))
  const hero = cast.characters.find((c) => c.name === '苏晚')
  const mate = cast.characters.find((c) => c.name === '林知夏')
  ok('主角进表了', !!hero)
  ok('主角 role=主角 / tier=重要', hero && hero.role === '主角' && hero.tier === '重要', hero ? `${hero.role}/${hero.tier}` : '')
  ok('主角 age 保留', hero && hero.age === '17')
  ok('富字段被拼进 desc（身份/想要/怕/秘密/说话风格）',
    !!hero && ['身份：', '外貌：', '想要：', '怕 / 弱点：', '秘密：', '说话风格：'].every((k) => hero.desc.includes(k)),
    hero ? hero.desc.replace(/\n/g, ' | ').slice(0, 90) : '')
  ok('身份与性格进了 tags', !!hero && hero.tags.includes('高三·文学社') && hero.tags.includes('嘴硬'), hero ? JSON.stringify(hero.tags) : '')
  ok('配角也在表里', !!mate && mate.role === '配角')
  const castText = fs.readFileSync(path.join(fullDir, '人物卡.txt'), 'utf8')
  ok('人物卡重新渲染过（含主角名）', castText.includes('苏晚'))

  const world = fs.readFileSync(path.join(fullDir, '世界观.txt'), 'utf8')
  ok('世界观：时代与地点', world.includes('现代') && world.includes('南方小城'))
  ok('世界观：规则', world.includes('无超自然要素'))
  ok('世界观：禁忌', world.includes('第 5 条被撕掉了'))
  ok('世界观：名词表', world.includes('练习守则'))

  const outline = fs.readFileSync(path.join(fullDir, '大纲.txt'), 'utf8')
  ok('大纲：三幕都写进「故事走向」', outline.includes('第一幕：契约成立') && outline.includes('第三幕：误会'))
  ok('大纲：灵感池在，而且标明"不算大纲"', outline.includes('灵感池') && outline.includes('不算大纲') && outline.includes('守则第 5 条'))
  ok('大纲：截止到"结尾想要的感觉"都还在', outline.includes('四、结尾想要的感觉'))

  const plot = JSON.parse(fs.readFileSync(path.join(fullDir, '剧情.json'), 'utf8'))
  const arc = plot.arcs && plot.arcs['']
  ok('剧情.json：三幕变成"全书纲领"', typeof arc === 'string' && arc.includes('第一幕') && arc.includes('第三幕'), String(arc).slice(0, 60))
  const chapters = fs.readdirSync(path.join(fullDir, 'chapters'))
  ok('可选：第一章空稿建出来了', chapters.length === 1 && chapters[0].startsWith('第001章'), chapters.join(','))
  ok('第一章骨架是「第1章 未命名」+ 空行', fs.readFileSync(path.join(fullDir, 'chapters', chapters[0]), 'utf8').trim() === '第1章 未命名')

  // ───────────────────────── 2b) 工具也读得到设定 ─────────────────────────
  console.log('\n── 2b. novel_context：续写上下文里必须带上 设定.json ──')
  {
    const tools = {}
    mod.apply({
      reflect: {
        get: (n, d) => (n === 'tools' ? { register: (t) => (tools[t.name] = t) } : d)
      }
    })
    const ctxTool = tools.novel_context
    ok('拿到了 novel_context 工具', !!ctxTool)
    const out = await ctxTool.execute({ novel: FULL, recent: 1 })
    const text = String(out.text || '')
    ok('上下文里带了设定段', text.indexOf('设定.json（这本书是什么）') >= 0)
    ok(
      '类型 / 每章字数都在（写下一章时有准星）',
      text.indexOf('类型：校园恋爱') >= 0 && text.indexOf('每章目标字数：3000') >= 0,
      text.split('\n').slice(0, 3).join(' | ')
    )
    ok('结局 / 终点也在', text.indexOf('结局 / 终点：') >= 0)
    ok('大纲 / 世界观 / 角色照旧都在', text.indexOf('苏晚') >= 0 && text.indexOf('=====') >= 0)
    const readTool = tools.novel_read
    const readOut = await readTool.execute({ novel: FULL, file: '设定' })
    ok('novel_read file=设定 能读出 JSON', String(readOut.text).indexOf('校园恋爱') >= 0)
  }

  // ───────────────────────── 3) 设定读写通道 ─────────────────────────
  console.log('\n── 3. 设定.json 的读写通道 ──')
  const readNoFile = await call('GET', '/novel/api/read', { url: `/novel/api/read?novel=${encodeURIComponent(PLAIN)}&file=${encodeURIComponent('设定')}` })
  ok('没文件也算正常（不报错）', readNoFile.json && readNoFile.json.ok === true)
  ok('没文件时 exists=false + 给默认值', readNoFile.json.exists === false && readNoFile.json.settings && readNoFile.json.settings.genre === '')
  ok('裸词「设定」指的是 设定.json', readNoFile.json.kind === 'settings' && readNoFile.json.file === '设定.json')

  const readWorld = await call('GET', '/novel/api/read', { url: `/novel/api/read?novel=${encodeURIComponent(PLAIN)}&file=${encodeURIComponent('世界观')}` })
  ok('「世界观」仍然解析到世界观（没被设定抢走）', readWorld.json.kind === 'world', readWorld.json.file)

  const saved = await call('POST', '/novel/api/save', {
    body: { novel: PLAIN, file: '设定.json', settings: { genre: '  悬疑推理  ', chapterChars: '-5', tags: [' a ', '', 'b'], 野键: 1 } }
  })
  ok('保存成功', saved.json && saved.json.ok === true, JSON.stringify(saved.json).slice(0, 100))
  ok('字符串被 trim', saved.json.settings.genre === '悬疑推理')
  ok('非法 chapterChars 归零', saved.json.settings.chapterChars === 0)
  ok('tags 洗过（去空、trim）', JSON.stringify(saved.json.settings.tags) === '["a","b"]')
  ok('野键被丢掉', saved.json.settings['野键'] === undefined)

  const readBack = await call('GET', '/novel/api/read', { url: `/novel/api/read?novel=${encodeURIComponent(PLAIN)}&file=${encodeURIComponent('设定.json')}` })
  ok('读回来一致', readBack.json.exists === true && readBack.json.settings.genre === '悬疑推理')
  ok('text 是格式化好的 JSON（人也能看）', typeof readBack.json.text === 'string' && readBack.json.text.includes('"genre": "悬疑推理"'))

  const byText = await call('POST', '/novel/api/save', {
    body: { novel: PLAIN, file: '设定', text: '{"genre":"都市异能","chapterChars":2500}' }
  })
  ok('文本入口也能存（设定页走这条）', byText.json && byText.json.ok === true && byText.json.settings.genre === '都市异能')

  const broken = await call('POST', '/novel/api/save', {
    body: { novel: PLAIN, file: '设定.json', text: '{这不是 JSON' }
  })
  ok('坏 JSON 会被拦住并说清原因', broken.json && broken.json.ok === false && /JSON/.test(broken.json.message), String(broken.json && broken.json.message).slice(0, 60))

  // ───────────────────────── 4) 最阴的坑：别把新书误判成老格式 ─────────────────────────
  console.log('\n── 4. 设定.json 不许把新书带成"老格式" ──')
  const outlineHit = await call('GET', '/novel/api/read', { url: `/novel/api/read?novel=${encodeURIComponent(FULL)}&file=${encodeURIComponent('大纲')}` })
  ok('有 设定.json 的书，大纲仍解析到 大纲.txt（不是 outline.md）', outlineHit.json.file === '大纲.txt', outlineHit.json.file)
  const castHit = await call('GET', '/novel/api/read', { url: `/novel/api/read?novel=${encodeURIComponent(FULL)}&file=${encodeURIComponent('人物卡')}` })
  ok('人物卡仍解析到 人物卡.txt', castHit.json.file === '人物卡.txt', castHit.json.file)
  const state = scanNovel(FULL)
  ok('scanNovel 仍是新格式（legacy=false）', state.legacy === false || state.legacy === undefined, JSON.stringify(state.legacy))
} finally {
  cleanup()
}

console.log('\n── 清理 ──')
ok('临时小说都删干净了', dirs.every((d) => !fs.existsSync(d)))

if (failed) {
  console.log(`\n❌ 有 ${failed} 项失败`)
  process.exit(1)
}
console.log('\n✅ 开书向导（宿主半）验证通过')
