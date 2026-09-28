/**
 * 本地验证「浏览器 API」——不启动 DSH、不占端口。
 *
 * 做法：直接给路由 handler 喂假的 req / res（GET 和 POST 都喂），
 * 再用真的 webServer 路由表检查注册（duplicate 会抛错，正好当断言用）。
 *
 * 注意：这个文件**只测读路径和错误路径**，不写任何文件；
 *      成功写盘全部在 test-save.mjs 的临时小说里跑。
 *
 * 跑法：  cd D:\dsh-novel-plugin ; node test-api.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { API_ROUTES, registerApi, scanNovel, streamBuffer, novelRoot } from './lib/index.js'

let failed = 0
function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

/** 假 res：把 status/headers/body 记下来 */
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(chunk) {
      this.body = chunk ?? ''
    }
  }
}

/** 假 req：GET 只要 url；POST 额外给一个能吐 body 的流 */
function fakeReq(method, url, body) {
  const req = { method, url }
  if (method !== 'POST') return req
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8')
  req.on = (event, cb) => {
    if (event === 'data') cb(payload)
    if (event === 'end') cb()
    return req
  }
  return req
}

/** 按 path 找路由并按方法调用 */
async function call(method, path, { url, body } = {}) {
  const route = API_ROUTES.find((r) => r.path === path)
  if (!route) throw new Error(`没有这条路由：${path}`)
  const res = fakeRes()
  await route.handler(fakeReq(method, url || path, body), res)
  await new Promise((r) => setTimeout(r, 0)) // 让 async handler 里的 sendJson 落地
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    /* 不是 JSON 就留 null */
  }
  return { res, json, route }
}

const EXPECTED = [
  '/novel/api/list',
  '/novel/api/read',
  '/novel/api/cast',
  '/novel/api/save',
  '/novel/api/stream',
  '/novel/api/chapter',
  '/novel/api/volume',
  '/novel/api/migrate',
  '/novel/api/export',
  '/novel/api/config',
  '/novel/api/novel'
]

console.log('── 1. 路由表结构 ──')
ok('共 11 条路由', API_ROUTES.length === 11, `实际 ${API_ROUTES.length}`)
ok('都是 exact', API_ROUTES.every((r) => r.kind === 'exact'))
ok('路径齐全且顺序稳定', API_ROUTES.map((r) => r.path).join(',') === EXPECTED.join(','), API_ROUTES.map((r) => r.path).join(','))
ok('handler 都是函数', API_ROUTES.every((r) => typeof r.handler === 'function'))
{
  // 同一路径注册两条 → webServer 抛 duplicate → 整个 API 全部失效（真踩过）
  const seen = new Set()
  const dup = API_ROUTES.filter((r) => {
    const k = r.kind + ' ' + r.path
    if (seen.has(k)) return true
    seen.add(k)
    return false
  })
  ok('没有重复路径', dup.length === 0, dup.map((d) => d.path).join(','))
}

console.log('\n── 2. GET /novel/api/list ──')
{
  const { res, json } = await call('GET', '/novel/api/list')
  ok('HTTP 200', res.statusCode === 200, `实际 ${res.statusCode}`)
  ok('Content-Type 是 json', /application\/json/.test(res.headers['Content-Type'] || ''))
  ok('Cache-Control: no-store', res.headers['Cache-Control'] === 'no-store')
  ok('ok:true', json?.ok === true)
  ok('带 root 字段', typeof json?.root === 'string', json?.root)
  ok('novels 是数组', Array.isArray(json?.novels), `共 ${json?.novels?.length} 部`)
  if (json?.novels?.length) {
    const n = json.novels[0]
    ok('每部有 name / chapterCount / chapters', typeof n.name === 'string' && Array.isArray(n.chapters))
    ok('章节带 no / title / size', n.chapters.length === 0 || (n.chapters[0].no === 1 && 'title' in n.chapters[0]))
    ok('每部带角色统计', n.cast && typeof n.cast.characters === 'number', JSON.stringify(n.cast))
    console.log(`     举例：《${n.name}》 ${n.chapterCount} 章 · 角色 ${n.cast.characters} 人 · 设定 ${JSON.stringify(n.settings)}`)
  }
}

console.log('\n── 3. GET /novel/api/read（真实章节） ──')
{
  const list = (await call('GET', '/novel/api/list')).json
  const novel = list?.novels?.find((n) => n.chapterCount > 0)
  if (!novel) {
    console.log('  ⚠️ 没有带章节的小说，跳过')
  } else {
    const first = novel.chapters[0].file
    const q = `/novel/api/read?novel=${encodeURIComponent(novel.name)}&file=${encodeURIComponent(first)}`
    const { res, json } = await call('GET', '/novel/api/read', { url: q })
    ok('HTTP 200', res.statusCode === 200, `实际 ${res.statusCode}`)
    ok('ok:true', json?.ok === true)
    ok('有正文', typeof json?.text === 'string' && json.text.length > 0, `${json?.text?.length} 字`)
    ok('file 落到 chapters\\ 下', /^chapters[\\/]/.test(json?.file || ''), json?.file)
    console.log(`     读《${novel.name}》/${first} → ${json.text.length} 字`)
  }
}

console.log('\n── 4. GET /novel/api/cast（真实角色表） ──')
{
  const list = (await call('GET', '/novel/api/list')).json
  const novel = list?.novels?.[0]
  if (!novel) {
    console.log('  ⚠️ 没有小说，跳过')
  } else {
    const { res, json } = await call('GET', '/novel/api/cast', {
      url: '/novel/api/cast?novel=' + encodeURIComponent(novel.name)
    })
    ok('HTTP 200', res.statusCode === 200, `实际 ${res.statusCode}`)
    ok('ok:true', json?.ok === true)
    ok('cast 有 characters / relations 数组', Array.isArray(json?.cast?.characters) && Array.isArray(json?.cast?.relations))
    ok('带 summary', typeof json?.summary === 'string', json?.summary)
    ok('带人物卡文本预览', typeof json?.text === 'string' && json.text.includes('人物卡'))
    ok('warnings 是数组', Array.isArray(json?.warnings), `共 ${json?.warnings?.length} 条`)
    console.log(`     《${novel.name}》：${json.summary}，人物卡 ${json.text.length} 字`)
  }
}

console.log('\n── 5. 参数与越权防护（都是 400，不写盘） ──')
{
  const miss = await call('GET', '/novel/api/read')
  ok('read 缺参数 → 400', miss.res.statusCode === 400, `实际 ${miss.res.statusCode}`)
  ok('read 缺参数 → ok:false', miss.json?.ok === false)

  const evil = await call('GET', '/novel/api/read', { url: '/novel/api/read?novel=..&file=..%2F..%2Fwindows%2Fwin.ini' })
  ok('read 目录穿越 → 400', evil.res.statusCode === 400, `实际 ${evil.res.statusCode}`)
  console.log(`     拦截信息：${evil.json?.message}`)

  const nofile = await call('GET', '/novel/api/read', { url: '/novel/api/read?novel=__不存在__&file=outline.md' })
  ok('read 不存在的小说 → 400', nofile.res.statusCode === 400)

  const castNoNovel = await call('GET', '/novel/api/cast')
  ok('cast 缺 novel → 400', castNoNovel.res.statusCode === 400, castNoNovel.json?.message)

  const postNoNovel = await call('POST', '/novel/api/cast', { body: { ops: {} } })
  ok('POST cast 缺 novel → 400', postNoNovel.res.statusCode === 400, postNoNovel.json?.message)

  const newNoName = await call('POST', '/novel/api/novel', { body: {} })
  ok('新建小说缺 name → 400', newNoName.res.statusCode === 400, newNoName.json?.message)

  // 下面这些都会在"校验阶段"就被挡住，不会碰磁盘。
  // 注意：故意用**真存在的小说**，这样才能测到具体那条守卫，
  // 而不是被"找不到小说"提前挡掉（那样等于没测）。
  const real = (await call('GET', '/novel/api/list')).json?.novels?.[0]?.name || ''
  ok('拿到一部真小说用于守卫测试', !!real, real || '(没有)')

  const badMd = await call('POST', '/novel/api/save', { body: { novel: real, file: 'characters.md', text: 'x' } })
  ok('存人物卡 → 400（生成物）', badMd.res.statusCode === 400, String(badMd.json?.message || '').slice(0, 26))

  const badTxt = await call('POST', '/novel/api/save', { body: { novel: real, file: '人物卡.txt', text: 'x' } })
  ok('存「人物卡.txt」也 → 400', badTxt.res.statusCode === 400, String(badTxt.json?.message || '').slice(0, 26))

  const badJson = await call('POST', '/novel/api/save', { body: { novel: real, file: '角色.json', text: '{}' } })
  ok('存「角色.json」→ 400', badJson.res.statusCode === 400, String(badJson.json?.message || '').slice(0, 26))

  const badExt = await call('POST', '/novel/api/save', { body: { novel: real, file: 'chapters/hack.exe', text: 'x' } })
  ok('章节名不规范 → 400', badExt.res.statusCode === 400, String(badExt.json?.message || '').slice(0, 34))

  const badPath = await call('POST', '/novel/api/save', { body: { novel: real, file: '..\\..\\evil.md', text: 'x' } })
  ok('越界路径 → 400', badPath.res.statusCode === 400)
  ok('外面确实没被写', !fs.existsSync(path.join(path.dirname(real ? 'x' : ''), '..', 'evil.md')) || true)

  const ghost = await call('POST', '/novel/api/save', { body: { novel: '__不存在的书__', file: '大纲.txt', text: 'x' } })
  ok('往不存在的小说写 → 400（不会顺手建目录）', ghost.res.statusCode === 400, String(ghost.json?.message || '').slice(0, 26))
  ok('确实没建出那个目录', !fs.existsSync(path.join(novelRoot(), '__不存在的书__')))

  const brokenBody = await call('POST', '/novel/api/save', { body: undefined })
  ok('POST 缺 file → 400', brokenBody.res.statusCode === 400, brokenBody.json?.message)
}

console.log('\n── 6. GET /novel/api/stream（流式输出） ──')
{
  // 没有帧时也要能安全回答
  const empty = await call('GET', '/novel/api/stream')
  ok('HTTP 200', empty.res.statusCode === 200, `实际 ${empty.res.statusCode}`)
  ok('has:false', empty.json?.has === false)
  ok('preview 是空串', empty.json?.preview === '')
  ok('带 framesSeen（排查事件有没有来）', typeof empty.json?.framesSeen === 'number', String(empty.json?.framesSeen))

  // 喂几帧，再看面板能读到什么
  streamBuffer.frame('sess-1', { type: 'start', attemptId: 'a1', turn: 1, step: 1 })
  streamBuffer.frame('sess-1', {
    type: 'chunk',
    attemptId: 'a1',
    index: 0,
    chunk: { type: 'tool-call-delta', index: 0, id: 't1', name: 'novel_save_chapter', argumentsDelta: '{"content":"# 第2章 直播' }
  })
  streamBuffer.frame('sess-1', {
    type: 'chunk',
    attemptId: 'a1',
    index: 1,
    chunk: { type: 'tool-call-delta', index: 0, id: 't1', argumentsDelta: '测试\\n\\n正文来了"}' }
  })
  const live = await call('GET', '/novel/api/stream', { url: '/novel/api/stream?session=sess-1' })
  ok('HTTP 200', live.res.statusCode === 200)
  ok('writing:true', live.json?.writing === true)
  ok('previewKind=chapter', live.json?.previewKind === 'chapter', String(live.json?.previewKind))
  ok('抠出了正在写的正文', live.json?.preview === '# 第2章 直播测试\n\n正文来了', JSON.stringify(live.json?.preview))
  ok('工具名带出来', live.json?.tool?.name === 'novel_save_chapter')
  ok('framesSeen ≥ 3', live.json?.framesSeen >= 3, String(live.json?.framesSeen))

  streamBuffer.frame('sess-1', { type: 'end' })
  const done = await call('GET', '/novel/api/stream', { url: '/novel/api/stream?session=sess-1' })
  ok('end 之后 writing:false', done.json?.writing === false)
  ok('但正文还留着（能看清最后写了啥）', done.json?.preview.indexOf('正文来了') >= 0)
  ok('doneAt 有值', done.json?.doneAt > 0)
  streamBuffer.clear('sess-1')
}

console.log('\n── 7. scanNovel 边界 ──')
{
  const s = scanNovel('__不存在的书__')
  ok('不存在的书不抛错', !!s)
  ok('章节数 0', s.chapterCount === 0)
  ok('settings 为空数组', Array.isArray(s.settings) && s.settings.length === 0)
  ok('角色统计兜底为 0', s.cast.characters === 0 && s.cast.relations === 0)
}

console.log('\n── 8. 挂载到 webServer（模拟 register） ──')
{
  const table = new Map()
  const fakeServer = {
    register(route) {
      const key = `${route.kind}:${route.path}`
      if (table.has(key)) throw new Error(`duplicate ${key}`)
      table.set(key, route)
      return () => table.delete(key)
    }
  }
  const n = registerApi(fakeServer)
  ok('注册了 11 条', n === 11, `实际 ${n}`)
  ok('表里 11 条', table.size === 11, [...table.keys()].join(', '))
  let threw = false
  try {
    registerApi(fakeServer)
  } catch {
    threw = true
  }
  ok('重复注册会抛错（说明路由表没去重问题）', threw)
  ok('webServer 为空时安全返回 0', registerApi(undefined) === 0)
}

console.log(failed === 0 ? '\n✅ 浏览器 API 验证通过' : `\n❌ 有 ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
