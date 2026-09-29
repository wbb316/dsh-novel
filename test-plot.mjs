/**
 * 本地验证「剧情」——不启动 DSH、不占端口。
 *
 * 磁盘规矩：
 *   <小说>\剧情.json   数据：情节点 + 挂的章节 + 手勾状态 + 卷纲领
 *   <小说>\剧情.txt    从 json 渲染出来的镜像（给人 / 给 AI 看）
 *   <小说>\大纲.txt    不归它管 —— 那是你随手写散文的地方
 *
 * 三条核心规则：
 *   1. 情节点 ↔ 章节是**多对多**：一个情节点可挂 0~N 章，一章也能挂好几个情节点
 *   2. `done` 只记**手动**勾的；「自动已写」= 挂的章节**都有正文**（现算，不落盘）
 *   3. 手勾优先，自动不会覆盖手动；把正文删了，自动那勾会自己掉
 *
 * 全程跑在临时小说根目录里，跑完删掉。
 *
 * 跑法：  cd D:\dsh-novel-plugin ; node test-plot.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failed = 0
function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-novel-plot-'))
const ROOT = path.join(TMP, 'library')
process.env.DSH_NOVEL_ROOT = ROOT
process.env.DSH_NOVEL_CONFIG = path.join(TMP, 'config.json')
fs.mkdirSync(ROOT, { recursive: true })

const {
  API_ROUTES,
  createNovel,
  createChapter,
  writeCast,
  readPlot,
  writePlot,
  plotStateFor
} = await import('./lib/index.js')
const {
  normalizePlot,
  applyPlotOps,
  beatAutoDone,
  beatDone,
  plotProgress,
  renderPlotText,
  emptyPlot
} = await import('./lib/plot.js')

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

// ─────────────── 1. 洗数据：脏了也不炸 ───────────────
console.log('── 1. normalizePlot（脏数据不炸，记警告） ──')
{
  ok('空输入 → 空表', normalizePlot(undefined).plot.beats.length === 0)
  ok('空表结构对', JSON.stringify(emptyPlot()) === '{"version":1,"arcs":{},"beats":[]}')
  const bad = normalizePlot({ beats: '不是数组' })
  ok('beats 不是数组 → 忽略 + 警告', bad.plot.beats.length === 0 && bad.warnings.length === 1, bad.warnings[0])
  const mixed = normalizePlot({
    arcs: { '第一卷 恋爱练习': '  往哪走  ' },
    beats: [null, { title: '' }, { title: '甲' }, { id: 'b1', title: '乙' }, { id: 'b1', title: '丙' }]
  })
  ok('非对象/没标题的跳过', mixed.plot.beats.length === 3, String(mixed.plot.beats.length))
  ok('id 重复会被改掉', new Set(mixed.plot.beats.map((b) => b.id)).size === 3, mixed.plot.beats.map((b) => b.id).join(','))
  ok('有警告', mixed.warnings.length >= 2, mixed.warnings.join(' / '))
  ok('卷纲领 trim 了', mixed.plot.arcs['第一卷 恋爱练习'] === '往哪走')
}

// ─────────────── 2. 多对多 + ops ───────────────
console.log('\n── 2. 多对多 & applyPlotOps ──')
{
  let p = emptyPlot()
  let r = applyPlotOps(p, {
    addBeats: [
      { title: '第3章 契约：两人约定「只是练习」', volume: '第一卷 恋爱练习', chapters: ['第003章-契约.txt'], cast: ['c1', 'c2'] },
      { title: '第4章 第一次约会（调研）', volume: '第一卷 恋爱练习', chapters: ['第004章-a.txt', '第005章-b.txt'] }
    ]
  })
  ok('加了两个情节点', r.plot.beats.length === 2, r.log.join(' / '))
  ok('一个情节点可以挂两章（一个剧情写好几章）', r.plot.beats[1].chapters.length === 2, r.plot.beats[1].chapters.join(','))
  ok('新 id 自动编', r.plot.beats[0].id === 'b1' && r.plot.beats[1].id === 'b2', r.plot.beats.map((b) => b.id).join(','))

  r = applyPlotOps(r.plot, { linkChapters: [{ beat: 'b1', chapters: ['第006章-c.txt'] }] })
  ok('link 是追加', r.plot.beats[0].chapters.length === 2)
  r = applyPlotOps(r.plot, { linkChapters: [{ beat: 'b1', chapters: ['第006章-c.txt'] }] })
  ok('重复挂同一章不会重复', r.plot.beats[0].chapters.length === 2)
  r = applyPlotOps(r.plot, { unlinkChapters: [{ beat: 'b1', chapters: ['第006章-c.txt'] }] })
  ok('unlink 卸得掉', r.plot.beats[0].chapters.length === 1, r.plot.beats[0].chapters.join(','))

  r = applyPlotOps(r.plot, { updateBeats: [{ id: 'b2', note: '书店 + 天台' }] })
  ok('update 改备注', r.plot.beats[1].note === '书店 + 天台')

  r = applyPlotOps(r.plot, { arc: { '第一卷 恋爱练习': '练习开始越界', '': '全书纲领' } })
  ok('卷纲领能存', r.plot.arcs['第一卷 恋爱练习'] === '练习开始越界' && r.plot.arcs[''] === '全书纲领')

  r = applyPlotOps(r.plot, { toggle: ['b1'] })
  ok('toggle 手动勾上', r.plot.beats[0].done === true)
  r = applyPlotOps(r.plot, { toggle: ['b1'] })
  ok('再 toggle 取消', r.plot.beats[0].done === false)

  r = applyPlotOps(r.plot, { removeBeats: ['b2'] })
  ok('删得掉', r.plot.beats.length === 1 && r.plot.beats[0].id === 'b1')

  let err = ''
  try {
    applyPlotOps(r.plot, { updateBeats: [{ title: '查无此点' }] })
  } catch (e) {
    err = String(e.message)
  }
  ok('改不存在的报错（并列出有哪些）', /找不到要改的情节点/.test(err) && /第3章/.test(err), err.slice(0, 40))
}

// ─────────────── 3. 自动勾选 vs 手勾 ───────────────
console.log('\n── 3. 自动勾选 / 手勾 ──')
{
  const beat = { id: 'b1', title: '甲', chapters: ['a.txt', 'b.txt'], done: false }
  ok('没挂章节 → 不算自动完成', beatAutoDone({ chapters: [] }, {}) === false)
  ok('挂的章节都有正文 → 自动完成', beatAutoDone(beat, { 'a.txt': 10, 'b.txt': 3 }) === true)
  ok('只要有一章没正文 → 不算完成', beatAutoDone(beat, { 'a.txt': 10, 'b.txt': 0 }) === false)
  ok('章节不存在（没写）→ 不算完成', beatAutoDone(beat, { 'a.txt': 10 }) === false)

  ok('没勾也没自动 → 未写', beatDone(beat, {}) .done === false)
  ok('自动完成时 by=自动', beatDone(beat, { 'a.txt': 5, 'b.txt': 5 }).by === '自动')
  ok('手勾优先（by=手动）', beatDone({ ...beat, done: true }, { 'a.txt': 5, 'b.txt': 5 }).by === '手动')
  ok('手勾了但章节没写 → 仍算已写（手勾优先）', beatDone({ ...beat, done: true }, {}).done === true)

  const prog = plotProgress(
    { beats: [beat, { id: 'b2', title: '乙', chapters: ['c.txt'], done: true }, { id: 'b3', title: '丙', chapters: [], done: false }] },
    { 'a.txt': 9, 'b.txt': 9, 'c.txt': 0 }
  )
  ok('进度：2/3（自动 1 + 手勾 1）', prog.total === 3 && prog.done === 2 && prog.auto === 1 && prog.manual === 1, JSON.stringify(prog).slice(0, 90))
  ok('下一个该写的是第一个没完成的', prog.next && prog.next.title === '丙', prog.next && prog.next.title)
}

// ─────────────── 4. 渲染成 剧情.txt ───────────────
console.log('\n── 4. renderPlotText（记事本能看） ──')
{
  const plot = {
    arcs: { '第一卷 恋爱练习': '练习开始越界' },
    beats: [
      { id: 'b1', title: '第3章 契约', volume: '第一卷 恋爱练习', chapters: ['第003章-契约.txt'], cast: ['c1'], done: true },
      { id: 'b2', title: '第4章 约会', volume: '第一卷 恋爱练习', chapters: ['第004章-a.txt'], cast: [], done: false }
    ]
  }
  const txt = renderPlotText(plot, { stamp: '2026-09-29 22:00', bodyChars: { '第004章-a.txt': 100 }, castById: { c1: '苏晚' } })
  ok('开头是人话标题', txt.startsWith('剧情表'), txt.slice(0, 10))
  ok('有卷小节', txt.includes('════ 第一卷 恋爱练习 ════'))
  ok('卷纲领在标题下面', txt.includes('本卷纲领：练习开始越界'))
  ok('手勾的写「（手动）」并打勾', txt.includes('☑ 第3章 契约（手动）'))
  ok('自动完成的写「（自动）」', txt.includes('☐ 第4章 约会（自动）') === false && txt.includes('第4章 约会（自动）'), txt.split('\n').find((l) => l.includes('第4章')))
  ok('章节挂在哪写着', txt.includes('章节：第003章-契约.txt'))
  ok('出场角色用了名字不是 id', txt.includes('出场：苏晚'))
  ok('进度写在头上', txt.includes('已写 2 / 2（手勾 1 · 自动 1）'), txt.split('\n')[4])
  ok('没有 markdown 记号', !/[#*`|]/.test(txt.replace(/※/g, '')), JSON.stringify(txt.match(/[#*`|]/g) || []))
}

// ─────────────── 5. 走真路由：落盘 + 自动勾选真的会变 ───────────────
console.log('\n── 5. 真路由 + 真磁盘 ──')
const NOVEL = '剧情测试书'
createNovel(NOVEL)
writeCast(NOVEL, { version: 1, characters: [{ id: 'c1', name: '苏晚', role: '主角', tier: '重要' }], relations: [] })
const base = path.join(ROOT, NOVEL)
createChapter(NOVEL, '开头') // 第001章（有骨架，算"有正文"吗？骨架只有标题行 → 不算）
{
  const empty = await call('/novel/api/plot', { url: `/novel/api/plot?novel=${encodeURIComponent(NOVEL)}` })
  ok('没建过剧情时 GET 也行', empty.status === 200 && empty.json.exists === false, `实际 ${empty.status}`)
  ok('返回空剧情表', empty.json.plot.beats.length === 0)
  ok('顺带给了章节/卷/角色（面板一次拿全）', Array.isArray(empty.json.chapters) && Array.isArray(empty.json.volumes) && Array.isArray(empty.json.cast))
  ok('角色带 tier（剧情页要显示谁重要谁不重要）', empty.json.cast[0] && empty.json.cast[0].tier === '重要', JSON.stringify(empty.json.cast[0]))

  const chFile = empty.json.chapters[0].file
  ok('骨架章节不算"有正文"', empty.json.beatState && Object.keys(empty.json.beatState).length === 0)

  const post = await call('/novel/api/plot', {
    method: 'POST',
    body: {
      novel: NOVEL,
      plot: {
        arcs: { '': '全书往哪走' },
        beats: [{ id: 'b1', title: '第1章 开头：她卡文了', volume: '', chapters: [chFile], cast: ['c1'], done: false }]
      }
    }
  })
  ok('POST 存剧情 200', post.status === 200, `实际 ${post.status} ${post.json && post.json.message}`)
  ok('写了 剧情.json', fs.existsSync(path.join(base, '剧情.json')))
  ok('也渲染了 剧情.txt', fs.existsSync(path.join(base, '剧情.txt')))
  ok('骨架章节 → 还是未写', post.json.beatState.b1.done === false, JSON.stringify(post.json.beatState.b1))

  // 真的往里写正文 → 自动勾上
  fs.writeFileSync(path.join(base, 'chapters', chFile), '第1章 开头：她卡文了\n\n「苏晚，你又在写悲剧？」\n', 'utf8')
  const after = await call('/novel/api/plot', { url: `/novel/api/plot?novel=${encodeURIComponent(NOVEL)}` })
  ok('写了正文 → 自动变成已写', after.json.beatState.b1.done === true && after.json.beatState.b1.by === '自动', JSON.stringify(after.json.beatState.b1))
  ok('进度跟着变', after.json.progress.done === 1 && after.json.progress.auto === 1, JSON.stringify(after.json.progress).slice(0, 80))
  ok('json 里没写 done（自动不落盘）', JSON.parse(fs.readFileSync(path.join(base, '剧情.json'), 'utf8')).beats[0].done === false)

  // 手勾优先
  const manual = await call('/novel/api/plot', {
    method: 'POST',
    body: { novel: NOVEL, plot: { arcs: { '': '全书往哪走' }, beats: [{ id: 'b1', title: '第1章 开头：她卡文了', volume: '', chapters: [chFile], cast: ['c1'], done: true }] } }
  })
  ok('手勾之后 by=手动', manual.json.beatState.b1.by === '手动', JSON.stringify(manual.json.beatState.b1))

  // 删正文 → 自动那勾会掉（但手勾的不会）
  fs.writeFileSync(path.join(base, 'chapters', chFile), '第1章 开头：她卡文了\n\n', 'utf8')
  const gone = await call('/novel/api/plot', { url: `/novel/api/plot?novel=${encodeURIComponent(NOVEL)}` })
  ok('手勾的不受正文影响', gone.json.beatState.b1.done === true && gone.json.beatState.b1.by === '手动')

  // 剧情.txt 也跟着更新
  const txt = fs.readFileSync(path.join(base, '剧情.txt'), 'utf8')
  ok('剧情.txt 里有这个情节点', txt.includes('第1章 开头：她卡文了'))
  ok('剧情.txt 里有全书纲领', txt.includes('全书纲领：全书往哪走') || txt.includes('本卷纲领：全书往哪走'), txt.split('\n').find((l) => l.includes('纲领')))

  const noNovel = await call('/novel/api/plot', { url: '/novel/api/plot' })
  ok('缺 novel → 400', noNovel.status === 400)
  const ghost = await call('/novel/api/plot', { url: `/novel/api/plot?novel=${encodeURIComponent('没有这本书')}` })
  ok('小说不存在 → 400', ghost.status === 400)
  const badPost = await call('/novel/api/plot', { method: 'POST', body: { plot: {} } })
  ok('POST 缺 novel → 400', badPost.status === 400)

  // 直接调库函数也要一致
  const st = plotStateFor(NOVEL)
  ok('plotStateFor 和路由一致', st.plot.beats.length === 1 && st.beatState.b1.done === true)
  const w = writePlot(NOVEL, { beats: [] })
  ok('整表替换成空也认', w.plot.beats.length === 0 && fs.readFileSync(path.join(base, '剧情.json'), 'utf8').includes('"beats": []'))
  ok('readPlot 读回来是空表', readPlot(NOVEL).plot.beats.length === 0)
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('\n🧹 临时小说根目录已删掉：' + TMP)
console.log(failed === 0 ? '\n✅ 剧情（情节点）全部通过' : `\n❌ 有 ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
