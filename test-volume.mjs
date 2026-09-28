/**
 * 本地验证「卷 / 章」——不启动 DSH、不占端口。
 *
 * 磁盘规矩（这一版的核心设计）：
 *
 *   chapters\第001章-开场.txt                  ← 未分卷（平铺）
 *   chapters\第一卷 恋爱练习\第002章-x.txt       ← 第一卷里的第 2 章
 *
 *   · 卷 = chapters 下的**子目录**
 *   · **章节号全局连续**（第002章 进了第一卷也还是第002章）→ 挪卷/删章都不会撞名
 *   · 对外一律用 id 说话：`第一卷 恋爱练习/第002章-x.txt`（`/` 分隔）
 *   · **老项目（全平铺）什么都不用改**：id 就是原来那串文件名
 *
 * 全程跑在一个临时小说根目录里（DSH_NOVEL_ROOT 指过去），跑完删掉 —— 绝不碰你真实的小说。
 *
 * 跑法：  cd D:\dsh-novel-plugin ; node test-volume.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failed = 0
function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

// ── 临时小说根目录（必须在 import 之前设好：novelRoot() 在模块加载时就读 config） ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-novel-volume-'))
const ROOT = path.join(TMP, 'library')
process.env.DSH_NOVEL_ROOT = ROOT
process.env.DSH_NOVEL_CONFIG = path.join(TMP, 'config.json')
fs.mkdirSync(ROOT, { recursive: true })

const {
  API_ROUTES,
  scanNovel,
  createNovel,
  createChapter,
  createVolume,
  renameVolume,
  deleteVolume,
  readChapters,
  splitChapterId,
  nextChapterNo,
  reorderChapters,
  migrateNovel,
  exportNovel,
  listVolumes,
  TRASH_DIR
} = await import('./lib/index.js')

/** 直接调真路由（假 req/res），跟面板走的是同一条路 */
async function call(routePath, { method = 'GET', url, body } = {}) {
  const route = API_ROUTES.find((r) => r.path === routePath)
  if (!route) throw new Error('没有这条路由：' + routePath)
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  const req = {
    url: url || routePath,
    method,
    // readBody() 是先 req.on('data') 再 req.on('end')，所以这里要把数据**喂给它的回调**，
    // 不能自己攒着 —— 攒着的话 readBody 拿到的就是空 body（我第一版就踩了这个）
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

const A = '卷测试书'
createNovel(A, '用来测卷的')

// ─────────────── 1. 平铺项目：跟以前一模一样 ───────────────
console.log('── 1. 未分卷（老项目的行为，一个字都不能变） ──')
{
  const c1 = createChapter(A, '开场')
  ok('第一张建出来是平铺的', c1.created === '第001章-开场.txt', c1.created)
  ok('novelState 里 chapter.volume 是空串', scanNovel(A).chapters[0].volume === '')
  ok('id 就是纯文件名（老项目兼容）', readChapters(ROOT + '\\' + A).length === 1)

  const read = await call('/novel/api/read', { url: `/novel/api/read?novel=${encodeURIComponent(A)}&file=${encodeURIComponent('第001章-开场.txt')}` })
  ok('GET /read 平铺章节 → 200', read.status === 200, `实际 ${read.status}`)
  ok('file 还是 chapters\\ 下', /^chapters[\\/]/.test(read.json.file), read.json.file)
  ok('id 是纯文件名', read.json.id === '第001章-开场.txt', read.json.id)
}

// ─────────────── 2. 建卷 + 往卷里放章 ───────────────
console.log('\n── 2. 建卷、往卷里放章 ──')
{
  const v = createVolume(A, '第一卷 恋爱练习')
  ok('建卷成功', v.volume === '第一卷 恋爱练习', v.volume)
  ok('磁盘上真有这个目录', fs.existsSync(path.join(ROOT, A, 'chapters', '第一卷 恋爱练习')))
  ok('scanNovel 报了这一卷', scanNovel(A).volumes.join(',') === '第一卷 恋爱练习', scanNovel(A).volumes.join(','))

  const dup = (() => { try { createVolume(A, '第一卷 恋爱练习'); return null } catch (e) { return e.message } })()
  ok('重名建卷被拦住', /已经有/.test(dup || ''), dup)

  const c2 = createChapter(A, '进卷了', '第一卷 恋爱练习')
  ok('章节 id 带卷前缀', c2.created === '第一卷 恋爱练习/第002章-进卷了.txt', c2.created)
  ok('编号是**全局连续**的（平铺那章是 001）', c2.created.includes('第002章'))
  ok('文件真落在卷目录里', fs.existsSync(path.join(ROOT, A, 'chapters', '第一卷 恋爱练习', '第002章-进卷了.txt')))

  const bad = createChapter(A, '标题带/斜杠', '第二卷')
  ok('卷名/标题里的斜杠被清掉（不会偷偷建目录）', bad.created === '第二卷/第003章-标题带斜杠.txt', bad.created)
  ok('只有一层目录（标题没把路径拆开）', bad.created.split('/').length === 2, bad.created)
  deleteVolume(A, '第二卷') // 收拾掉，免得干扰后面的顺序断言
}

// ─────────────── 3. 顺序：未分卷在前，卷按名字（数字感知）排 ───────────────
console.log('\n── 3. 章节顺序 ──')
{
  createVolume(A, '第2卷 夏天')
  createVolume(A, '第10卷 冬天')
  createChapter(A, '二卷的章', '第2卷 夏天')
  createChapter(A, '十卷的章', '第10卷 冬天')

  const ids = readChapters(path.join(ROOT, A))
  ok('未分卷的排最前面', ids[0] === '第001章-开场.txt', ids[0])
  ok('然后是卷里的（按卷名排）', ids[1].startsWith('第一卷'), ids[1])
  ok('第2卷 排在 第10卷 前面（数字感知）', ids[2].startsWith('第2卷') && ids[3].startsWith('第10卷'), ids.slice(2).join(' | '))
  ok('卷列表也是这个顺序', listVolumes(path.join(ROOT, A)).join(',') === '第一卷 恋爱练习,第2卷 夏天,第10卷 冬天', listVolumes(path.join(ROOT, A)).join(','))

  const s = scanNovel(A)
  ok('scanNovel 章节数对', s.chapterCount === 4, `实际 ${s.chapterCount}`)
  ok('每章都带 volume 和纯文件名 name', s.chapters.every((c) => 'volume' in c && /^第\d+章/.test(c.name)))
  ok('标题不带"第N章"前缀', s.chapters[1].title === '进卷了', s.chapters[1].title)

  // 中文卷号也要认：写网文的人几乎一定是「第一卷 / 第二卷 / ……」这么写的，
  // 光靠 localeCompare 会把「第一卷」排到「第2卷」后面（汉字的次序很反直觉）
  {
    const D = '中文卷号'
    createNovel(D)
    createVolume(D, '第十卷 结尾')
    createVolume(D, '第二卷 中段')
    createVolume(D, '第一卷 开头')
    ok('中文卷号排序（第一卷 < 第二卷 < 第十卷）', listVolumes(path.join(ROOT, D)).join(',') === '第一卷 开头,第二卷 中段,第十卷 结尾', listVolumes(path.join(ROOT, D)).join(','))

    const E = '混合卷名'
    createNovel(E)
    createVolume(E, '恋爱练习')
    createVolume(E, '第二卷 后')
    ok('没编号的卷排在有编号的后面', listVolumes(path.join(ROOT, E)).join(',') === '第二卷 后,恋爱练习', listVolumes(path.join(ROOT, E)).join(','))
  }
}

// ─────────────── 4. /read 认「卷名/章节名」 ───────────────
console.log('\n── 4. 读卷里的章节 ──')
{
  const id = '第一卷 恋爱练习/第002章-进卷了.txt'
  const r = await call('/novel/api/read', { url: `/novel/api/read?novel=${encodeURIComponent(A)}&file=${encodeURIComponent(id)}` })
  ok('GET /read 卷里的章 → 200', r.status === 200, `实际 ${r.status}`)
  ok('读到的正文是那一章的骨架', /^第2章 进卷了/.test(String(r.json.text).trim()), String(r.json.text).slice(0, 20))
  ok('file 带上了卷目录', /chapters[\\/]第一卷 恋爱练习[\\/]/.test(r.json.file), r.json.file)
  ok('id 还是那个带卷的 id', r.json.id === id, r.json.id)

  const ghost = await call('/novel/api/read', { url: `/novel/api/read?novel=${encodeURIComponent(A)}&file=${encodeURIComponent('不存在的卷/第002章-进卷了.txt')}` })
  ok('卷名写错 → 400（不会读到别的卷）', ghost.status === 400, `实际 ${ghost.status}`)

  const traversal = await call('/novel/api/read', { url: `/novel/api/read?novel=${encodeURIComponent(A)}&file=${encodeURIComponent('../../config.json')}` })
  ok('上跳目录 → 400', traversal.status === 400, `实际 ${traversal.status}`)
}

// ─────────────── 5. 拖拽排序 + 跨卷挪动（reorderChapters） ───────────────
console.log('\n── 5. 拖拽：排序 + 挪卷 ──')
{
  const before = readChapters(path.join(ROOT, A))
  ok('排序前有 4 章', before.length === 4, `实际 ${before.length}`)
  // 把平铺的第001章拖到「第一卷」里，并且放到那个卷的第一位
  const r = reorderChapters(A, [
    '第一卷 恋爱练习/第001章-开场.txt',
    '第一卷 恋爱练习/第002章-进卷了.txt',
    '第2卷 夏天/第003章-二卷的章.txt',
    '第10卷 冬天/第004章-十卷的章.txt'
  ])
  ok('排序返回新的 id 列表', Array.isArray(r.order) && r.order.length === 4, JSON.stringify(r.order))
  ok('平铺那章真的进了第一卷', fs.existsSync(path.join(ROOT, A, 'chapters', '第一卷 恋爱练习', '第001章-开场.txt')))
  ok('chapters 根目录下没有平铺的章节了', readChapters(path.join(ROOT, A)).every((id) => id.includes('/')))
  ok('顺序 = 未分卷(空) → 卷…', readChapters(path.join(ROOT, A))[0].startsWith('第一卷'), readChapters(path.join(ROOT, A))[0])
  ok('编号被重排成 001..004', readChapters(path.join(ROOT, A)).map((id) => splitChapterId(id).name.slice(1, 4)).join(',') === '001,002,003,004')

  // 再把它拖回平铺
  const ids = readChapters(path.join(ROOT, A))
  const flatFirst = [splitChapterId(ids[0]).name, ...ids.slice(1)]
  const r2 = reorderChapters(A, flatFirst)
  ok('拖出卷 → 回到平铺', r2.order[0] === '第001章-开场.txt', r2.order[0])
  ok('文件真的在 chapters 根下', fs.existsSync(path.join(ROOT, A, 'chapters', '第001章-开场.txt')))

  // 反向：整个列表倒过来（顺带证明跨卷来回挪不丢文件）
  const absOf = (id) => path.join(ROOT, A, 'chapters', id.replace(/\//g, path.sep))
  const revIds = readChapters(path.join(ROOT, A)).slice().reverse()
  const r3 = reorderChapters(A, revIds)
  ok('倒序也认（两阶段改名不会互相撞）', r3.order.length === 4, r3.order.join(' | '))
  ok('倒序后最后一章是平铺的开场（被挪出来了）', r3.order[3] === '第004章-开场.txt', r3.order[3])
  ok('倒序后第一章在最远的卷里', r3.order[0].startsWith('第10卷 冬天/第001章-'), r3.order[0])
  ok('四章的正文都还在（没丢文件）', readChapters(path.join(ROOT, A)).every((id) => fs.existsSync(absOf(id))))

  const wrong = (() => { try { reorderChapters(A, ['第001章-开场.txt']); return null } catch (e) { return e.message } })()
  ok('数量对不上 → 报错', /对不上/.test(wrong || ''), wrong)
  const dup = (() => { try { reorderChapters(A, ['第001章-开场.txt', '第001章-开场.txt', 'x', 'y']); return null } catch (e) { return e.message } })()
  ok('重复/不存在 → 报错', /重复|没有这一章/.test(dup || ''), dup)
}

// ─────────────── 6. 卷的改名 / 删除（走路由） ───────────────
console.log('\n── 6. 卷改名 / 删除 ──')
{
  const ren = await call('/novel/api/volume', { method: 'POST', body: { novel: A, action: 'rename', from: '第2卷 夏天', name: '第二卷 盛夏' } })
  ok('卷改名 200', ren.status === 200, `实际 ${ren.status}`)
  ok('目录跟着改了', fs.existsSync(path.join(ROOT, A, 'chapters', '第二卷 盛夏')))
  ok('章节列表里也是新卷名', readChapters(path.join(ROOT, A)).some((id) => id.startsWith('第二卷 盛夏/')))
  ok('旧卷名没了', !fs.existsSync(path.join(ROOT, A, 'chapters', '第2卷 夏天')))

  const created = await call('/novel/api/volume', { method: 'POST', body: { novel: A, action: 'create', name: '空卷' } })
  ok('建空卷 200', created.status === 200)
  ok('空卷也在 volumes 里（面板要显示它）', scanNovel(A).volumes.includes('空卷'))

  const del = await call('/novel/api/volume', { method: 'POST', body: { novel: A, action: 'delete', name: '空卷' } })
  ok('删卷 200', del.status === 200, `实际 ${del.status}`)
  ok('可恢复（说了挪去哪）', del.json.recoverable === true && !!del.json.movedTo, del.json.movedTo)
  ok('回收站里真有一份', fs.existsSync(path.join(ROOT, TRASH_DIR)))
  ok('卷没了', !scanNovel(A).volumes.includes('空卷'))

  const delFull = await call('/novel/api/volume', { method: 'POST', body: { novel: A, action: 'delete', name: '第10卷 冬天' } })
  ok('删有章节的卷也允许（整卷进回收站）', delFull.status === 200, `实际 ${delFull.status}`)
  ok('那一卷的章节跟着一起走了', !readChapters(path.join(ROOT, A)).some((id) => id.startsWith('第10卷')))
  const moved = path.join(ROOT, String(delFull.json.movedTo || ''))
  ok(
    '回收站里能找回整卷目录（章节都在里面）',
    fs.existsSync(moved) && fs.readdirSync(moved).some((f) => /\.txt$/.test(f)),
    String(delFull.json.movedTo)
  )

  const bad = await call('/novel/api/volume', { method: 'POST', body: { novel: A, action: '爆炸' } })
  ok('不认识的操作 → 400', bad.status === 400, `实际 ${bad.status}`)
  const noNovel = await call('/novel/api/volume', { method: 'POST', body: { action: 'create', name: 'x' } })
  ok('缺 novel → 400', noNovel.status === 400)
}

// ─────────────── 7. 章节路由在卷里也要能用（改名/删除） ───────────────
console.log('\n── 7. 卷里的章节改名 / 删除 ──')
{
  const target = readChapters(path.join(ROOT, A)).find((id) => id.startsWith('第一卷 恋爱练习/'))
  ok('找到一卷里的章节', !!target, String(target))
  const noBefore = /第(\d+)章/.exec(splitChapterId(target).name)[1]
  const ren = await call('/novel/api/chapter', { method: 'POST', body: { novel: A, action: 'rename', file: target, title: '改过名的' } })
  ok('卷里章节改名 200', ren.status === 200, `实际 ${ren.status} ${ren.json && ren.json.message}`)
  const newId = String(ren.json.renamed || '')
  ok('新 id 还在同一卷里', newId.startsWith('第一卷 恋爱练习/'), newId)
  ok('编号不变（章号是从文件名里读的）', new RegExp('第' + noBefore + '章').test(newId), `${noBefore} → ${newId}`)
  ok('磁盘上真的改名了', !!newId && fs.existsSync(path.join(ROOT, A, 'chapters', newId.replace(/\//g, path.sep))))

  const del = await call('/novel/api/chapter', { method: 'POST', body: { novel: A, action: 'delete', file: ren.json.renamed } })
  ok('卷里章节删除 200', del.status === 200, `实际 ${del.status}`)
  ok('删除 = 挪进回收站', del.json.recoverable === true)
  ok('列表里没了', !readChapters(path.join(ROOT, A)).includes(ren.json.renamed))

  const ghost = await call('/novel/api/chapter', { method: 'POST', body: { novel: A, action: 'delete', file: '第一卷 恋爱练习/第099章-根本没有.txt' } })
  ok('删不存在的章 → 400', ghost.status === 400, `实际 ${ghost.status}`)
}

// ─────────────── 8. 老格式项目：卷 + .md 一起迁移 ───────────────
console.log('\n── 8. 迁移（老格式 + 卷） ──')
{
  const B = '带卷的老项目'
  const dir = path.join(ROOT, B)
  fs.mkdirSync(path.join(dir, 'chapters', '第一卷 旧卷'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'outline.md'), '# 大纲\n\n老格式。\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'chapters', '第一卷 旧卷', '第001章-旧的.md'), '# 第1章 旧的\n\n**加粗**要抹掉。\n', 'utf8')

  const m = migrateNovel(B)
  ok('迁移 200（没因为卷炸掉）', Array.isArray(m.changed), JSON.stringify(m.changed))
  ok('.md → .txt 在**原来那一卷里**', fs.existsSync(path.join(dir, 'chapters', '第一卷 旧卷', '第001章-旧的.txt')))
  ok('备份里保留了卷结构', fs.existsSync(path.join(dir, '_旧格式备份', 'chapters', '第一卷 旧卷', '第001章-旧的.md')))
  ok('正文抹掉了 markdown', !fs.readFileSync(path.join(dir, 'chapters', '第一卷 旧卷', '第001章-旧的.txt'), 'utf8').includes('**'))
  ok('迁移后扫描还能看到卷', scanNovel(B).volumes.join(',') === '第一卷 旧卷', scanNovel(B).volumes.join(','))
}

// ─────────────── 9. 导出设定集要能看出卷 ───────────────
console.log('\n── 9. 导出设定集 ──')
{
  const e = exportNovel(A)
  const txt = fs.readFileSync(path.join(ROOT, A, e.file), 'utf8')
  ok('导出 200', e.chapters >= 1, `章节 ${e.chapters}`)
  const headers = txt
    .split('\n')
    .filter((l) => l.startsWith('── ') && l.endsWith(' ──'))
    .map((l) => l.slice(3, -3))
  const chapterVols = [...new Set(scanNovel(A).chapters.map((c) => c.volume))]
  ok(
    '章节清单按卷分组（小标题 = 实际有章节的卷，空卷不出现）',
    headers.length === chapterVols.length && headers.every((h) => chapterVols.includes(h === '未分卷' ? '' : h)),
    headers.join(' | ')
  )
  ok('有分卷统计', /共 \d+ 章（\d+ 卷），约 \d+ 字/.test(txt), txt.split('\n').filter((l) => l.startsWith('共 ')).join(' | '))
  ok('章节行还在', /第\d+章 .+  ——  \d+ 字/.test(txt))
}

// ─────────────── 10. agent 的存稿工具也认卷 ───────────────
console.log('\n── 10. novel_save_chapter 工具（带 volume） ──')
{
  const registered = []
  const fakeCtx = {
    reflect: {
      get(name, dflt) {
        return name === 'tools' ? { register: (t) => registered.push(t) } : dflt
      }
    }
  }
  const mod = await import('./lib/index.js')
  mod.apply(fakeCtx)
  const tool = registered.find((t) => t.name === 'novel_save_chapter')
  ok('工具注册了', !!tool)
  ok('schema 里有 volume（可选）', !!tool.parameters.properties.volume && !tool.parameters.required.includes('volume'))

  const out = await tool.execute({ novel: A, title: '工具写的', content: '正文。', volume: '第一卷 恋爱练习' })
  ok('工具报成功', /已保存/.test(out.text), out.text)
  ok('报的路径里带卷名', out.text.includes('第一卷 恋爱练习'), out.text)
  ok('文件真在卷目录里', fs.readdirSync(path.join(ROOT, A, 'chapters', '第一卷 恋爱练习')).some((f) => f.includes('工具写的')))
  const noVol = await tool.execute({ novel: A, title: '没卷的', content: '正文。' })
  ok('不传 volume → 平铺', /已保存/.test(noVol.text) && fs.existsSync(path.join(ROOT, A, 'chapters', fs.readdirSync(path.join(ROOT, A, 'chapters')).find((f) => f.includes('没卷的')))), noVol.text)
}

// ─────────────── 11. 空卷 / 边界 ───────────────
console.log('\n── 11. 边界 ──')
{
  ok('splitChapterId 没有斜杠时 volume 为空', JSON.stringify(splitChapterId('第001章-x.txt')) === '{"volume":"","name":"第001章-x.txt"}')
  ok('splitChapterId 认一层卷', splitChapterId('第一卷/x.txt').volume === '第一卷')
  ok('nextChapterNo 跳过已用的号', (() => {
    const C = '号码测试'
    createNovel(C)
    createChapter(C, 'a') // 001
    createChapter(C, 'b') // 002
    fs.rmSync(path.join(ROOT, C, 'chapters', '第001章-a.txt'))
    return nextChapterNo(path.join(ROOT, C)) === 3 // 剩 002 → 下一个是 003，不是 002
  })())
  ok('卷名全是点/空格 → 建不出来', (() => { try { createVolume(A, '  ..  '); return false } catch { return true } })())
  const weird = createVolume(A, 'a/b:c*d?e"f<g>h|i')
  ok('卷名里的非法字符被清掉', weird.volume === 'abcdefghi', weird.volume)
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('\n🧹 临时小说根目录已删掉：' + TMP)
console.log(failed === 0 ? '\n✅ 卷 / 章 全部通过' : `\n❌ 有 ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
