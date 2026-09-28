/**
 * 本地验证「图片头像」——不启动 DSH、不占端口。
 *
 * 设计（为什么这么存）：
 *   · `avatar`      1~4 个字符（emoji / 姓氏）—— 纯文本，永远在，是兜底
 *   · `avatarFile`  图片文件，存 `<小说>\头像\<角色id>.png`，json 里只记路径
 *   图片**不塞进 角色.json 的 base64**：那文件是留着给人用记事本改的，
 *   塞了图片就变成几十 KB 乱码，人就不敢碰了。
 *
 * 全程跑在临时小说根目录里（DSH_NOVEL_ROOT），跑完删掉。
 *
 * 跑法：  cd D:\dsh-novel-plugin ; node test-avatar.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failed = 0
function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-novel-avatar-'))
const ROOT = path.join(TMP, 'library')
process.env.DSH_NOVEL_ROOT = ROOT
process.env.DSH_NOVEL_CONFIG = path.join(TMP, 'config.json')
fs.mkdirSync(ROOT, { recursive: true })

const { API_ROUTES, createNovel, writeCast, readCast, scanNovel } = await import('./lib/index.js')

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
  let raw = Buffer.alloc(0)
  let ctype = ''
  const res = {
    setHeader(k, v) {
      if (String(k).toLowerCase() === 'content-type') ctype = v
    },
    end(c) {
      raw = Buffer.isBuffer(c) ? c : Buffer.from(String(c ?? ''), 'utf8')
    },
    set statusCode(v) {
      status = v
    },
    get statusCode() {
      return status
    }
  }
  await route.handler(req, res)
  const json = (() => {
    try {
      return JSON.parse(raw.toString('utf8'))
    } catch {
      return null
    }
  })()
  return { status, ctype, raw, json }
}

// 一张"图"：这里只要字节能原样往返就够了，所以不用真 PNG（省得记一大串 base64）
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])
const PNG_URL = 'data:image/png;base64,' + PNG_BYTES.toString('base64')
const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9])
const JPG_URL = 'data:image/jpeg;base64,' + JPG_BYTES.toString('base64')

const NOVEL = '头像测试书'
createNovel(NOVEL)
writeCast(NOVEL, {
  version: 1,
  characters: [
    { id: 'c1', name: '苏晚', role: '主角', avatar: '🖋️' },
    { id: 'c2', name: '林知夏', role: '配角', avatar: '夏' }
  ],
  relations: [{ from: 'c1', to: 'c2', type: '暗恋（单向）' }]
})

const base = path.join(ROOT, NOVEL)
const avatarDir = path.join(base, '头像')

// ─────────────── 1. 没图片时的老行为 ───────────────
console.log('── 1. 还没图片头像时（老行为不能变） ──')
{
  const r = await call('/novel/api/cast', { url: `/novel/api/cast?novel=${encodeURIComponent(NOVEL)}` })
  ok('GET /cast 200', r.status === 200, `实际 ${r.status}`)
  ok('没有图片时 avatars 是空表', r.json.avatars && Object.keys(r.json.avatars).length === 0, JSON.stringify(r.json.avatars))
  ok('emoji 头像照旧在', r.json.cast.characters[0].avatar === '🖋️', r.json.cast.characters[0].avatar)
  ok('avatarFile 是空串（不是 undefined）', r.json.cast.characters[0].avatarFile === '')
  ok('头像目录还不存在', !fs.existsSync(avatarDir))

  const g = await call('/novel/api/avatar', { url: `/novel/api/avatar?novel=${encodeURIComponent(NOVEL)}&id=c1` })
  ok('没图时 GET 头像 → 404', g.status === 404, `实际 ${g.status}`)
}

// ─────────────── 2. 上传 ───────────────
console.log('\n── 2. 上传图片头像 ──')
{
  const up = await call('/novel/api/avatar', { method: 'POST', body: { novel: NOVEL, id: 'c1', dataUrl: PNG_URL } })
  ok('POST 上传 200', up.status === 200, `实际 ${up.status} ${up.json && up.json.message}`)
  ok('说了存哪', up.json.avatarFile === '头像/c1.png', up.json.avatarFile)
  ok('文件真的落盘了', fs.existsSync(path.join(base, '头像', 'c1.png')))
  ok('字节和上传的一模一样', fs.readFileSync(path.join(base, '头像', 'c1.png')).equals(PNG_BYTES))
  ok('按角色 id 命名（c1.png）', fs.readdirSync(avatarDir).join(',') === 'c1.png', fs.readdirSync(avatarDir).join(','))

  const raw = fs.readFileSync(path.join(base, '角色.json'), 'utf8')
  ok('角色.json 里记的是路径', raw.includes('"avatarFile": "头像/c1.png"'), raw.slice(0, 90).replace(/\n/g, ' '))
  ok('角色.json 里**没有** base64 垃圾（它得留着能手改）', !raw.includes('base64') && raw.length < 1200, `${raw.length} 字节`)
  ok('emoji 那个字段没被动', JSON.parse(raw).characters[0].avatar === '🖋️')
  ok('scanNovel 也算得到角色数', scanNovel(NOVEL).cast.characters === 2)
}

// ─────────────── 3. /cast 给出图地址 ───────────────
console.log('\n── 3. /cast 返回出图地址 ──')
let url0 = ''
{
  const r = await call('/novel/api/cast', { url: `/novel/api/cast?novel=${encodeURIComponent(NOVEL)}` })
  url0 = r.json.avatars.c1 || ''
  ok('c1 有出图地址', /^\/novel\/api\/avatar\?/.test(url0), url0)
  ok('地址里带小说名和 id', url0.includes(encodeURIComponent(NOVEL)) && url0.includes('id=c1'))
  ok('带 mtime 版本号（换图不用手动刷缓存）', /[?&]v=\d+/.test(url0), url0)
  ok('c2 没有图片 → 不在表里', !r.json.avatars.c2)
}

// ─────────────── 4. 出图 ───────────────
console.log('\n── 4. GET 出图 ──')
{
  const g = await call('/novel/api/avatar', { url: `/novel/api/avatar?novel=${encodeURIComponent(NOVEL)}&id=c1` })
  ok('GET 头像 200', g.status === 200, `实际 ${g.status}`)
  ok('Content-Type = image/png', g.ctype === 'image/png', g.ctype)
  ok('原样返回（逐字节）', g.raw.equals(PNG_BYTES))

  const wrong = await call('/novel/api/avatar', { url: `/novel/api/avatar?novel=${encodeURIComponent(NOVEL)}&id=c2` })
  ok('没图的那个角色 → 404', wrong.status === 404, `实际 ${wrong.status}`)

  const ghost = await call('/novel/api/avatar', { url: `/novel/api/avatar?novel=${encodeURIComponent(NOVEL)}&id=c999` })
  ok('不存在的角色 → 404（不炸）', ghost.status === 404, `实际 ${ghost.status}`)
}

// ─────────────── 5. 换格式：别留两张 ───────────────
console.log('\n── 5. 换格式（png → jpg） ──')
{
  const up = await call('/novel/api/avatar', { method: 'POST', body: { novel: NOVEL, id: 'c1', dataUrl: JPG_URL } })
  ok('换成 jpg 200', up.status === 200, `实际 ${up.status}`)
  ok('avatarFile 变成 .jpg', up.json.avatarFile === '头像/c1.jpg', up.json.avatarFile)
  ok('旧的 png 被删掉了（不留两张）', !fs.existsSync(path.join(base, '头像', 'c1.png')))
  ok('目录里就剩一张', fs.readdirSync(avatarDir).join(',') === 'c1.jpg', fs.readdirSync(avatarDir).join(','))
  const g = await call('/novel/api/avatar', { url: `/novel/api/avatar?novel=${encodeURIComponent(NOVEL)}&id=c1` })
  ok('jpg 的 mime 对', g.ctype === 'image/jpeg', g.ctype)
  ok('内容也对', g.raw.equals(JPG_BYTES))
}

// ─────────────── 6. 删头像 ───────────────
console.log('\n── 6. 去掉图片头像 ──')
{
  const rm = await call('/novel/api/avatar', { method: 'POST', body: { novel: NOVEL, id: 'c1', action: 'remove' } })
  ok('删除 200', rm.status === 200, `实际 ${rm.status}`)
  ok('文件没了', !fs.existsSync(path.join(base, '头像', 'c1.jpg')))
  const { cast } = readCast(NOVEL)
  ok('avatarFile 清空了', cast.characters[0].avatarFile === '')
  ok('emoji 还在（自动兜底）', cast.characters[0].avatar === '🖋️', cast.characters[0].avatar)
  const r = await call('/novel/api/cast', { url: `/novel/api/cast?novel=${encodeURIComponent(NOVEL)}` })
  ok('出图表也空了', Object.keys(r.json.avatars).length === 0)
  const g = await call('/novel/api/avatar', { url: `/novel/api/avatar?novel=${encodeURIComponent(NOVEL)}&id=c1` })
  ok('删完再 GET → 404', g.status === 404, `实际 ${g.status}`)
}

// ─────────────── 7. 各种坏输入 ───────────────
console.log('\n── 7. 坏输入都要 400，不能炸 ──')
{
  const cases = [
    ['不是 dataURL', { novel: NOVEL, id: 'c1', dataUrl: 'http://example.com/a.png' }],
    ['不支持的格式（bmp）', { novel: NOVEL, id: 'c1', dataUrl: 'data:image/bmp;base64,AAAA' }],
    ['空的 base64', { novel: NOVEL, id: 'c1', dataUrl: 'data:image/png;base64,' }],
    ['角色不存在', { novel: NOVEL, id: 'c404', dataUrl: PNG_URL }],
    ['小说不存在', { novel: '没有这本书', id: 'c1', dataUrl: PNG_URL }],
    ['缺 novel', { id: 'c1', dataUrl: PNG_URL }],
    ['什么都没传', {}]
  ]
  for (const [label, body] of cases) {
    const r = await call('/novel/api/avatar', { method: 'POST', body })
    ok(label + ' → 400', r.status === 400, `实际 ${r.status} ${r.json && r.json.message}`)
  }

  // 太大：造一个 > 2MB 的 dataURL
  const big = 'data:image/png;base64,' + Buffer.alloc(2 * 1024 * 1024 + 10, 7).toString('base64')
  const r = await call('/novel/api/avatar', { method: 'POST', body: { novel: NOVEL, id: 'c1', dataUrl: big } })
  ok('超过 2MB → 400 并说明上限', r.status === 400 && /太大|上限/.test(r.json.message || ''), r.json && r.json.message)
  ok('超限那张没被写进目录', !fs.existsSync(avatarDir) || fs.readdirSync(avatarDir).length === 0)
}

// ─────────────── 8. 手改 json 的脏数据也不能炸 ───────────────
console.log('\n── 8. 脏数据（人拿记事本改坏了） ──')
{
  const p = path.join(base, '角色.json')
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  j.characters[0].avatarFile = '头像/../../跑出去了.png' // 想穿越的路径
  j.characters[1].avatarFile = '头像/c2.png' // 文件其实不存在
  fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8')

  const r = await call('/novel/api/cast', { url: `/novel/api/cast?novel=${encodeURIComponent(NOVEL)}` })
  ok('读角色表不炸', r.status === 200, `实际 ${r.status}`)
  ok('穿越路径和"文件不存在"都不会给地址', Object.keys(r.json.avatars).length === 0, JSON.stringify(r.json.avatars))
  const g = await call('/novel/api/avatar', { url: `/novel/api/avatar?novel=${encodeURIComponent(NOVEL)}&id=..%2F..%2F跑出去了` })
  ok('拿穿越的 id 要图 → 404', g.status === 404, `实际 ${g.status}`)
  ok('目录外面没被创建奇怪的文件', !fs.existsSync(path.join(TMP, '跑出去了.png')))

  const up = await call('/novel/api/avatar', { method: 'POST', body: { novel: NOVEL, id: 'c1', dataUrl: PNG_URL } })
  ok('脏了以后照样能正常上传', up.status === 200, `实际 ${up.status}`)
  ok('存的是清洗过的文件名', fs.readdirSync(avatarDir).join(',') === 'c1.png', fs.readdirSync(avatarDir).join(','))
}

// ─────────────── 9. 人物卡（给人看的那份）保持纯文本 ───────────────
console.log('\n── 9. 纯文本原则 ──')
{
  const castText = fs.readFileSync(path.join(base, '人物卡.txt'), 'utf8')
  ok('人物卡.txt 里没有 base64', !castText.includes('base64'))
  ok('人物卡.txt 里没有图片路径噪音', !castText.includes('头像/c1.png'), castText.split('\n').slice(0, 3).join(' / '))
  ok('人物卡.txt 还是纯文本（能记事本打开）', castText.includes('苏晚'))
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('\n🧹 临时小说根目录已删掉：' + TMP)
console.log(failed === 0 ? '\n✅ 图片头像全部通过' : `\n❌ 有 ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
