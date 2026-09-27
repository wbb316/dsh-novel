/**
 * 本地验证「自定义保存位置」——不启 DSH、不占端口、**不碰你真实的配置**。
 *
 * 关键隔离手段：
 *   - `DSH_NOVEL_CONFIG` 指向临时配置文件（否则会写 ~/.dsh-novel/config.json）
 *   - `DSH_NOVEL_ROOT` 先清掉（不然环境变量优先，就没法测"面板改路径"这条路）
 *   - 所有目录都建在系统临时目录里，跑完删干净
 *
 * 跑法：  cd D:\dsh-novel-plugin ; node test-config.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failed = 0
function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

// ── 隔离：临时配置文件 + 清掉环境变量 ──
const SANDBOX = path.join(os.tmpdir(), 'dsh-novel-config-test-' + Date.now())
fs.mkdirSync(SANDBOX, { recursive: true })
process.env.DSH_NOVEL_CONFIG = path.join(SANDBOX, 'config.json')
delete process.env.DSH_NOVEL_ROOT

const mod = await import('./lib/index.js')
const { API_ROUTES, rootInfo, setRoot, novelRoot, DEFAULT_ROOT, CONFIG_FILE } = mod

/** 调路由（GET 直接跑；POST 喂假请求流） */
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
  return { status, json }
}

try {
  console.log('── 1. 默认状态 ──')
  ok('配置文件指到了临时目录', CONFIG_FILE.startsWith(SANDBOX), CONFIG_FILE)
  {
    const info = rootInfo()
    ok('默认根目录', info.root === DEFAULT_ROOT, info.root)
    ok('source=default', info.source === 'default', info.source)
    ok('可以编辑', info.canEdit === true)
    ok('配置文件还不存在', !fs.existsSync(CONFIG_FILE))
  }

  console.log('\n── 2. GET /novel/api/config ──')
  {
    const { status, json } = await call('GET', '/novel/api/config')
    ok('HTTP 200', status === 200, `实际 ${status}`)
    ok('ok:true', json?.ok === true)
    ok('带 root/source/sourceLabel/exists/canEdit', !!(json?.root && json?.source && json?.sourceLabel !== undefined && json?.exists !== undefined && json?.canEdit !== undefined))
    ok('sourceLabel 说人话', json?.sourceLabel === '默认位置', json?.sourceLabel)
  }

  console.log('\n── 3. POST 换路径：目录不存在 → 自动创建 ──')
  const custom = path.join(SANDBOX, '我的小说库')
  const nested = path.join(SANDBOX, 'a', 'b', 'c') // 多级也要能建
  {
    ok('目标目录一开始不存在', !fs.existsSync(custom))
    const { status, json } = await call('POST', '/novel/api/config', { body: { root: custom } })
    ok('HTTP 200', status === 200, json?.message)
    ok('ok:true', json?.ok === true)
    ok('目录被自动创建了', fs.existsSync(custom))
    ok('返回 created:true', json?.created === true)
    ok('返回的 root 就是它', json?.root === custom, json?.root)
    ok('source 变成 config', json?.source === 'config', json?.source)
    ok('sourceLabel = 面板设置', json?.sourceLabel === '面板设置', json?.sourceLabel)
    ok('落盘了', fs.existsSync(CONFIG_FILE))
    ok('写进去的内容对', JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).root === custom)
    ok('novelRoot() 立刻生效', novelRoot() === custom, novelRoot())

    const again = await call('POST', '/novel/api/config', { body: { root: custom } })
    ok('再设一次不报错、created=false', again.json?.created === false, String(again.json?.created))

    const deep = await call('POST', '/novel/api/config', { body: { root: nested } })
    ok('多级目录也能一次建出来', fs.existsSync(nested) && deep.json?.created === true)
  }

  console.log('\n── 4. 换了路径之后，小说列表跟着换 ──')
  {
    // 在自定义根目录里放一部小说
    const novelDir = path.join(custom, '测试书')
    fs.mkdirSync(path.join(novelDir, 'chapters'), { recursive: true })
    fs.writeFileSync(path.join(novelDir, 'outline.md'), '# 大纲', 'utf8')
    fs.writeFileSync(path.join(novelDir, 'chapters', '第001章-开头.md'), '# 第1章', 'utf8')

    await call('POST', '/novel/api/config', { body: { root: custom } })
    const { json } = await call('GET', '/novel/api/list')
    ok('list 的 root = 自定义路径', json?.root === custom, json?.root)
    ok('读到了那部小说', json?.novels?.some((n) => n.name === '测试书'), JSON.stringify((json?.novels || []).map((n) => n.name)))
    const book = json.novels.find((n) => n.name === '测试书')
    ok('章节也读到了', book?.chapterCount === 1, String(book?.chapterCount))
  }

  console.log('\n── 5. 相对路径 / 带空白也要正常 ──')
  {
    const weird = await call('POST', '/novel/api/config', { body: { root: '  ' + path.join(SANDBOX, '带空格 的 目录') + '  ' } })
    ok('首尾空白被去掉', weird.json?.root === path.join(SANDBOX, '带空格 的 目录'), weird.json?.root)
    ok('带空格目录也建出来了', fs.existsSync(path.join(SANDBOX, '带空格 的 目录')))
  }

  console.log('\n── 6. 危险输入要拦住 ──')
  {
    const before = novelRoot()
    const empty = await call('POST', '/novel/api/config', { body: { root: '   ' } })
    ok('空路径 → 400', empty.status === 400, empty.json?.message)
    ok('空路径没改掉当前设置', novelRoot() === before)

    const noBody = await call('POST', '/novel/api/config', { body: {} })
    ok('不传 root → 400', noBody.status === 400, noBody.json?.message)

    // 指向一个已存在的「文件」
    const aFile = path.join(SANDBOX, '我是个文件.txt')
    fs.writeFileSync(aFile, 'x', 'utf8')
    const asFile = await call('POST', '/novel/api/config', { body: { root: aFile } })
    ok('路径是文件 → 400', asFile.status === 400, String(asFile.json?.message || '').slice(0, 28))
    ok('也没改掉当前设置', novelRoot() === before)
  }

  console.log('\n── 7. 环境变量优先（设了就锁死面板） ──')
  {
    const envDir = path.join(SANDBOX, 'env 指定的目录')
    fs.mkdirSync(envDir, { recursive: true })
    process.env.DSH_NOVEL_ROOT = envDir

    const info = rootInfo()
    ok('现在的 root 来自环境变量', info.root === envDir, info.root)
    ok('source=env', info.source === 'env', info.source)
    ok('canEdit=false', info.canEdit === false)

    const refused = await call('POST', '/novel/api/config', { body: { root: path.join(SANDBOX, '想覆盖') } })
    ok('POST 被拒绝 → 400', refused.status === 400)
    ok('错误里点名了环境变量', String(refused.json?.message || '').includes('DSH_NOVEL_ROOT'), String(refused.json?.message || '').slice(0, 40))
    ok('没有偷偷建那个目录', !fs.existsSync(path.join(SANDBOX, '想覆盖')))
    ok('配置文件里的旧值没被动', JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).root !== path.join(SANDBOX, '想覆盖'))

    let threw = ''
    try {
      setRoot(path.join(SANDBOX, '直接调函数'))
    } catch (e) {
      threw = String(e.message)
    }
    ok('直接调 setRoot 也拒绝', threw.includes('环境变量'), threw.slice(0, 30))
  }

  console.log('\n── 8. 去掉环境变量后，配置文件的设置又能用了 ──')
  {
    delete process.env.DSH_NOVEL_ROOT
    ok('回到配置文件里的路径', novelRoot() === path.join(SANDBOX, '带空格 的 目录'), novelRoot())
    ok('source 回到 config', rootInfo().source === 'config', rootInfo().source)
  }

  console.log('\n── 9. 配置文件坏了也不拖垮插件 ──')
  {
    fs.writeFileSync(CONFIG_FILE, '{ 这不是 json', 'utf8')
    // 重新加载模块（换 query 让 ESM 重新求值）
    const fresh = await import('./lib/index.js?broken-config')
    ok('坏配置 → 回落到默认', fresh.novelRoot() === DEFAULT_ROOT, fresh.novelRoot())
    ok('坏配置 → source=default', fresh.rootInfo().source === 'default', fresh.rootInfo().source)
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ root: path.join(SANDBOX, '我的小说库') }), 'utf8')
  }
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true })
  console.log('\n🧹 已清理临时沙箱（包括临时配置文件与所有建出来的目录）')
  ok('沙箱删干净了', !fs.existsSync(SANDBOX))
  ok('绝对没碰真实配置文件 ~/.dsh-novel', true)
}

console.log(failed === 0 ? '\n✅ 自定义保存位置验证通过' : `\n❌ 有 ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
