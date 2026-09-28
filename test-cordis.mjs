/**
 * 用 **DSH 自带的真 cordis** 加载插件，验证「动态注入 webServer」这段生命周期。
 *
 * 为什么值得单独测：`ctx.inject(['webServer'], cb)` 是个"等服务出现再挂路由"的钩子，
 * 平时只有重启 DSH 才能看到效果。这里用假服务把它在本地跑通：
 *
 *   T0 提供 reflect + tools         → 加载插件 → 4 个工具应立刻注册，路由 0 条
 *   T1 稍后才提供 webServer         → 注入钩子应自动触发 → 路由 2 条
 *
 * 不启动 web server、不占端口。
 *
 * 跑法：  cd D:\dsh-novel-plugin ; node test-cordis.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import * as novel from './lib/index.js'

let failed = 0
function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}
const tick = () => new Promise((r) => setTimeout(r, 0))

// ── 假服务 ──
const tools = {
  registered: [],
  register(t) {
    this.registered.push(t)
    return () => {}
  }
}
const webServer = {
  routes: [],
  register(route) {
    this.routes.push(route)
    return () => {}
  }
}
/** reflect.get(name) 的返回值表（DSH 里 reflect 是"绕过 fiber 链"的服务查询入口） */
const store = { tools }

const app = new Context()
app.provide('reflect', {
  get(name, strict) {
    const v = store[name]
    if (v === undefined && strict) throw new Error('missing service: ' + name)
    return v
  }
})
app.provide('tools', tools)

console.log('── T0：只有 tools 服务时加载插件 ──')
const fiber = app.plugin(novel)
await fiber
await tick()

ok('插件名', novel.name === 'dsh-novel', novel.name)
ok('顶层 inject = ["tools"]', JSON.stringify(novel.inject) === '["tools"]', JSON.stringify(novel.inject))
ok('注册了 5 个工具', tools.registered.length === 5, `实际 ${tools.registered.length}`)
ok(
  '工具名对得上',
  tools.registered.map((t) => t.name).join(',') ===
    'novel_list,novel_read,novel_context,novel_save_chapter,novel_cast',
  tools.registered.map((t) => t.name).join(',')
)
ok('每个工具都有 parameters + output.schema', tools.registered.every((t) => t.parameters && t.output && t.output.schema))
ok('webServer 还没出现 → 路由 0 条', webServer.routes.length === 0, `实际 ${webServer.routes.length}`)

console.log('\n── T1：稍后才提供 webServer ──')
app.provide('webServer', webServer)
await tick()
await tick()

ok('注入钩子自动触发了 → 路由 10 条', webServer.routes.length === 10, `实际 ${webServer.routes.length}`)
ok(
  '路由路径正确',
  webServer.routes.map((r) => r.path).join(',') ===
    '/novel/api/list,/novel/api/read,/novel/api/cast,/novel/api/save,/novel/api/stream,/novel/api/chapter,/novel/api/migrate,/novel/api/export,/novel/api/config,/novel/api/novel',
  webServer.routes.map((r) => r.path).join(',')
)
ok('都是 exact', webServer.routes.every((r) => r.kind === 'exact'))
ok('handler 都是函数', webServer.routes.every((r) => typeof r.handler === 'function'))
ok('没有重复路径', new Set(webServer.routes.map((r) => r.path)).size === webServer.routes.length)

console.log('\n── T2：路由能真出数据 ──')
{
  const list = webServer.routes.find((r) => r.path === '/novel/api/list')
  let status = 0
  let body = ''
  list.handler(
    { url: '/novel/api/list', method: 'GET' },
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
  const json = JSON.parse(body)
  ok('HTTP 200', status === 200, `实际 ${status}`)
  ok('ok:true', json.ok === true)
  ok('读到小说', Array.isArray(json.novels) && json.novels.length >= 1, `共 ${json.novels.length} 部`)
}

console.log('\n── T3：卸载插件 ──')
{
  await fiber.dispose()
  await tick()
  ok('卸载不报错', true)
}

console.log(failed === 0 ? '\n✅ 真 cordis 生命周期验证通过' : `\n❌ 有 ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
