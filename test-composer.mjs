// 「✍️ 写下一章」把请求塞进对话输入框 —— 那条链路的不变式
//
// 起因（2026-11-09）：朋友在桌面版（DSH 0.2.2-rc.1）点「写下一章」，面板弹红字
// 「没接上输入框（拿不到 conversation 服务）」。真因**不是**服务不存在：
//   · `conversation` 服务在，但 `conversation.input.for(actx)` 要一个**会话作用域**的
//     ctx；面板是 root 席位（`main`），宿主只递 hook、不递 sessionId，
//     于是老代码把自己的 ctx 递进去 → 拿不到 facade → 报"服务没了"。
//   · 会话作用域 ctx 要从 `ctx.get('sessions').scope(id)` 拿，而 `sessions`
//     必须在客户端半的 inject 里声明（Cordis：不声明就 "cannot get property"）。
//   · 这两个服务都是**晚于 apply 注册**的，只能在点击时惰性去取。
//
// 这个文件把上面三条钉成断言：以后谁把 inject 改回去、或者顺手把 sessionId 丢掉，
// 这里当场红。
import fs from 'node:fs'

let total = 0
let bad = 0
const ok = (name, cond, extra) => {
  total += 1
  if (!cond) bad += 1
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`)
}

// ── 加载客户端半（不需要真 React：__test 里的都是纯函数/纯逻辑）──
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: (m) => {
      loaded = m
    }
  }
}
new Function(fs.readFileSync('./lib/client.js', 'utf8'))()
const mod = loaded.factory((n) => {
  if (n === 'react') return { createElement: () => null, useEffect: () => {}, useState: (v) => [v, () => {}], useRef: () => ({ current: null }) }
  throw new Error('意外的 require: ' + n)
})
const T = mod.__test

console.log('── 1. 会话快照 → "当前会话" ──')
{
  const snap = {
    ids: ['s-old', 's-current', 's-sub'],
    byId: {
      's-old': { id: 's-old', updatedAt: 100, retainedBy: {} },
      's-current': { id: 's-current', updatedAt: 50, retainedBy: { mainView: 1, sidebarView: 1 } },
      's-sub': { id: 's-sub', updatedAt: 999, retainedBy: {}, origin: 'subagent' }
    }
  }
  ok('优先主区正在看的那一个（哪怕它更久没动）', T.currentSessionIdOf(snap) === 's-current', T.currentSessionIdOf(snap))
}
{
  const snap = {
    ids: ['a', 'b', 'c'],
    byId: {
      a: { id: 'a', updatedAt: 10, retainedBy: {} },
      b: { id: 'b', updatedAt: 30, retainedBy: { sidebarView: 1 } },
      c: { id: 'c', updatedAt: 20, retainedBy: {} }
    }
  }
  ok('没有主区会话 → 退回最近更新的那个', T.currentSessionIdOf(snap) === 'b', T.currentSessionIdOf(snap))
}
{
  const snap = {
    ids: ['x', 'sub'],
    byId: {
      x: { id: 'x', updatedAt: 1, retainedBy: {} },
      sub: { id: 'sub', updatedAt: 999, retainedBy: {}, origin: 'subagent' }
    }
  }
  ok('不把子代理会话当"当前会话"', T.currentSessionIdOf(snap) === 'x', T.currentSessionIdOf(snap))
}
ok('空快照 / 坏数据 → 空串（不抛）', T.currentSessionIdOf(null) === '' && T.currentSessionIdOf({}) === '' && T.currentSessionIdOf(undefined) === '')
ok('apply 阶段拿不到服务也不炸（ctx 里什么都没有）', T.composerInput({}, { sessionId: 's' }) === null && T.composerInput(null, null) === null)

console.log('\n── 2. 输入框 facade：必须用**会话作用域** ctx 去要 ──')
{
  const calls = []
  const scopeCtx = { kind: 'scoped' }
  const facade = { setDraft: () => {}, submit: () => {}, state: { getSnapshot: () => ({ draft: '' }) } }
  const ctx = {
    get(name) {
      calls.push('get:' + name)
      if (name === 'conversation') return { input: { for: (actx) => (calls.push('for:' + (actx === scopeCtx ? 'scoped' : 'root')), actx === scopeCtx ? facade : null) } }
      if (name === 'sessions') return { scope: (id) => (calls.push('scope:' + id), scopeCtx) }
      return undefined
    }
  }
  const got = T.composerInput(ctx, { sessionId: 'sess-1' })
  ok('拿到了 facade', got === facade)
  ok('先按 id 取会话作用域，再 for(那个 scoped ctx)', calls.join(',') === 'get:conversation,get:sessions,scope:sess-1,for:scoped', calls.join(','))
}
{
  // 老宿主/没会话：拿 root ctx 去 for() —— 拿不到就返回 null，绝不抛
  const ctx = {
    get(name) {
      if (name === 'conversation') {
        return {
          input: {
            for: () => {
              throw new Error('no session scope')
            }
          }
        }
      }
      return undefined
    }
  }
  ok('for() 抛错 → 安静降级 null', T.composerInput(ctx, { sessionId: '' }) === null)
}

console.log('\n── 3. writeToComposer：空框直接发，有内容只追加 ──')
function fakeCtx(draft) {
  const log = []
  const facade = {
    state: { getSnapshot: () => ({ draft }) },
    setDraft: (t) => log.push('setDraft:' + t),
    submit: (mode) => log.push('submit:' + mode)
  }
  const ctx = {
    get(name) {
      if (name === 'conversation') return { input: { for: () => facade } }
      if (name === 'sessions') return { scope: () => ({ scoped: true }) }
      return undefined
    }
  }
  return { ctx, log }
}
{
  const { ctx, log } = fakeCtx('')
  const r = T.writeToComposer(ctx, { sessionId: 's' }, '请续写第002章')
  ok('返回 ok（不再是"没接上输入框"）', r.kind === 'ok', r.text)
  ok('填进去 + 直接发送（queue，不打断在写的）', log.join(',') === 'setDraft:请续写第002章,submit:queue', log.join(','))
}
{
  const { ctx, log } = fakeCtx('我正在写别的')
  const r = T.writeToComposer(ctx, { sessionId: 's' }, '请续写第002章')
  ok('框里有字 → 只追加，不覆盖也不发', r.kind === 'ok' && /setDraft:我正在写别的\n\n请续写第002章/.test(log.join(',')) && !log.some((x) => x.startsWith('submit:')), log.join(','))
}

console.log('\n── 4. inject 必须同时声明 slots 与 sessions ──')
ok('inject = ["slots","sessions"]（少一个都拿不到会话作用域）', JSON.stringify(mod.inject) === '["slots","sessions"]', JSON.stringify(mod.inject))

console.log(`\n${bad === 0 ? '✅ 输入框链路全部通过' : `❌ ${bad}/${total} 条没过`}`)
process.exit(bad === 0 ? 0 : 1)
