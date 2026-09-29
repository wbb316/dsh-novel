/**
 * 本地验证「客户端半」——不启动 DSH、不开浏览器、不占端口。
 *
 * 四件事：
 *   1) 模拟 window.__ModuleLoader__ 与 require('react')
 *   2) 一个**迷你 React**：useState/useEffect/useCallback/useMemo + **递归渲染子组件**
 *      （用「组件路径」当 hooks 槽位 key，路径消失即卸载重置）
 *   3) 把 globalThis.fetch 桩到**真实的宿主路由**（lib/index.js 的 API_ROUTES）
 *      → 「面板 → API → 磁盘文件」这条链路是真跑的
 *   4) 整场跑在一个**临时小说根目录**里（DSH_NOVEL_ROOT 指过去），跑完删掉
 *      → 绝不碰你真实的小说
 *
 * 跑法：  cd D:\dsh-novel-plugin ; node test-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let failed = 0
function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

// ─────────────── 0. 造一个临时小说根目录（全隔离） ───────────────
const ROOT = path.join(os.tmpdir(), 'dsh-novel-client-test-' + Date.now())
process.env.DSH_NOVEL_ROOT = ROOT

const NOVEL_A = '测试小说'
const NOVEL_B = '老项目'
const NEW = '第三部'

function seed() {
  const a = path.join(ROOT, NOVEL_A)
  fs.mkdirSync(path.join(a, 'chapters'), { recursive: true })
  fs.writeFileSync(
    path.join(a, 'outline.md'),
    '# 大纲\n\n## 一句话简介\n为了克服恋爱恐惧症，苏晚决定找人练习。\n',
    'utf8'
  )
  fs.writeFileSync(path.join(a, 'world.md'), '# 世界观\n\n现代校园。\n', 'utf8')
  fs.writeFileSync(path.join(a, 'chapters', '第001章-开头.md'), '# 第1章 开头\n\n「苏晚，你又在写悲剧？」\n', 'utf8')
  fs.writeFileSync(
    path.join(a, 'characters.json'),
    JSON.stringify(
      {
        version: 1,
        characters: [
          { id: 'c1', name: '苏晚', role: '主角', age: '17', tags: ['文学社'], desc: '嘴硬心软' },
          { id: 'c2', name: '林知夏', role: '配角', age: '16', tags: [], desc: '学妹' }
        ],
        relations: [{ from: 'c1', to: 'c2', type: '暗恋（单向）', note: '不敢说出口' }]
      },
      null,
      2
    ),
    'utf8'
  )
  fs.writeFileSync(path.join(a, 'characters.md'), '# 人物卡（生成的）\n', 'utf8')

  // 老项目：只有手写的 characters.md（模拟"学妹"现在的情况）
  const b = path.join(ROOT, NOVEL_B)
  fs.mkdirSync(b, { recursive: true })
  fs.writeFileSync(path.join(b, 'characters.md'), '# 人物卡（我一个字一个字敲的）\n\n## 老王\n- 别覆盖我\n', 'utf8')
}
seed()

// ─────────────── 1. fetch 桩 → 真宿主路由 ───────────────
const { API_ROUTES, streamBuffer } = await import('./lib/index.js')

/** 按 path 找路由（和真 webserver 一样：路径匹配，方法在 handler 里分） */
function dispatch(requestUrl, method, bodyText) {
  const u = new URL(requestUrl, 'http://localhost')
  const route = API_ROUTES.find((r) => r.path === u.pathname)
  if (!route) {
    return { status: 404, body: JSON.stringify({ ok: false, message: 'no route: ' + u.pathname }), done: Promise.resolve() }
  }
  let status = 0
  let body = ''
  const res = {
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
  const req = { method, url: requestUrl }
  if (method === 'POST') {
    const payload = Buffer.from(bodyText || '{}', 'utf8')
    req.on = (event, cb) => {
      if (event === 'data') cb(payload)
      if (event === 'end') cb()
      return req
    }
  }
  const done = Promise.resolve(route.handler(req, res))
  return {
    get status() {
      return status
    },
    get body() {
      return body
    },
    done
  }
}

let fetchOverride = null
globalThis.fetch = async (url, init) => {
  if (fetchOverride) return fetchOverride(url, init)
  const method = (init && init.method) || 'GET'
  const r = dispatch(String(url), method, init && init.body)
  if (method === 'POST') await r.done
  return { status: r.status, json: async () => JSON.parse(r.body) }
}

// ─────────────── 2. 迷你 React（含递归渲染） ───────────────
function createReact() {
  const stores = new Map() // 组件路径 -> { hooks, cursor, alive }
  let dirty = false
  let cur = null
  let queue = []

  const same = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))

  const React = {
    createElement(type, props, ...kids) {
      return { type, props: props || {}, kids: kids.flat(Infinity) }
    },
    useState(init) {
      // 关键：把 store 捕获进闭包。副作用里调 set 时 cur 已经被还原了
      // （真 React 的 setState 也是绑在 fiber 上的，不是"当前正在渲染的组件"）
      const store = cur
      const i = store.cursor++
      if (!(i in store.hooks)) store.hooks[i] = typeof init === 'function' ? init() : init
      const set = (v) => {
        const next = typeof v === 'function' ? v(store.hooks[i]) : v
        if (Object.is(next, store.hooks[i])) return
        store.hooks[i] = next
        dirty = true
      }
      return [store.hooks[i], set]
    },
    useEffect(fn, deps) {
      const store = cur
      const i = store.cursor++
      const prev = store.hooks[i]
      if (prev && prev.deps && same(prev.deps, deps)) return
      store.hooks[i] = { deps: deps ? deps.slice() : null, cleanup: prev ? prev.cleanup : undefined }
      queue.push({ i, fn, store })
    },
    useCallback(fn, deps) {
      const store = cur
      const i = store.cursor++
      const prev = store.hooks[i]
      if (prev && prev.deps && same(prev.deps, deps)) return prev.value
      store.hooks[i] = { deps: deps ? deps.slice() : null, value: fn }
      return fn
    },
    useMemo(fn, deps) {
      const store = cur
      const i = store.cursor++
      const prev = store.hooks[i]
      if (prev && prev.deps && same(prev.deps, deps)) return prev.value
      const value = fn()
      store.hooks[i] = { deps: deps ? deps.slice() : null, value }
      return value
    },
    useRef(init) {
      const store = cur
      const i = store.cursor++
      if (!(i in store.hooks)) store.hooks[i] = { current: init }
      return store.hooks[i]
    }
  }

  function renderComponent(type, props, where) {
    // 槽位 key = 位置 + 组件类型名：同一个位置换了组件类型就该重新挂载
    // （真 React 也是按 type 判断卸载/重建的，否则 hooks 会被张冠李戴）
    const key = where + '::' + (type.name || 'anon')
    let st = stores.get(key)
    if (!st) {
      st = { hooks: [], cursor: 0, alive: true }
      stores.set(key, st)
    }
    st.alive = true
    const savedCur = cur
    const savedQueue = queue
    cur = st
    st.cursor = 0
    queue = []
    const out = type(props)
    const fx = queue
    cur = savedCur
    queue = savedQueue
    for (const item of fx) {
      const slot = item.store.hooks[item.i]
      if (slot.cleanup) {
        try {
          slot.cleanup()
        } catch {
          /* 忽略 */
        }
      }
      const c = item.fn()
      slot.cleanup = typeof c === 'function' ? c : undefined
    }
    return renderNode(out, where)
  }

  function renderNode(node, where) {
    if (node === null || node === undefined || typeof node === 'boolean') return node
    if (Array.isArray(node)) return node.map((n, i) => renderNode(n, where + '.' + i))
    if (typeof node !== 'object') return node
    if (typeof node.type === 'function') return renderComponent(node.type, node.props, where)
    return { ...node, kids: (node.kids || []).map((k, i) => renderNode(k, where + '.' + i)) }
  }

  return {
    React,
    render(Component, props) {
      for (const s of stores.values()) s.alive = false
      const tree = renderNode({ type: Component, props: props || {}, kids: [] }, 'root')
      for (const [k, s] of [...stores]) if (!s.alive) stores.delete(k) // 卸载 → 状态重置
      return tree
    },
    isDirty: () => dirty,
    clearDirty: () => {
      dirty = false
    },
    hookCount: () => stores.size
  }
}

/** 反复渲染到稳定（等 Promise / setTimeout 落地） */
async function settle(rt, Component, props) {
  let tree = rt.render(Component, props)
  let stabilized = false
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 0))
    if (!rt.isDirty()) {
      await new Promise((r) => setTimeout(r, 0))
      if (!rt.isDirty()) {
        stabilized = true
        break
      }
    }
    rt.clearDirty()
    tree = rt.render(Component, props)
  }
  if (!stabilized) throw new Error('渲染没有收敛（可能有无限 setState 循环）')
  return tree
}

// ─────────────── 3. 树工具 ───────────────
function findAll(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, pred, out)
    return out
  }
  if (pred(node)) out.push(node)
  for (const k of node.kids || []) findAll(k, pred, out)
  return out
}
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return (node.kids || []).map(textOf).join('')
}
const hasClass = (n, cls) => String(n.props.className || '').split(/\s+/).indexOf(cls) >= 0
const byClass = (tree, cls) => findAll(tree, (n) => hasClass(n, cls))
const byType = (tree, type) => findAll(tree, (n) => n.type === type)
const treeText = textOf

/** 按文字找按钮 */
function btn(tree, label) {
  return findAll(tree, (n) => n.type === 'button' && textOf(n).indexOf(label) >= 0)[0] || null
}
function click(node) {
  if (!node || !node.props.onClick) throw new Error('这个节点点不了：' + (node ? textOf(node) : '(null)'))
  node.props.onClick()
}
/** 按 label 文字定位里面的输入框 */
function fieldBox(tree, label) {
  const labels = findAll(tree, (n) => n.type === 'label' && hasClass(n, 'dn_f'))
  const hit = labels.find((l) => textOf(l.kids[0]) === label)
  if (!hit) return null
  return findAll(hit, (n) => n.type === 'input' || n.type === 'select' || n.type === 'textarea')[0] || null
}
function setValue(node, v) {
  if (!node || !node.props.onChange) throw new Error('这个输入框改不了：' + (node ? node.type : '(null)'))
  node.props.onChange({ target: { value: v } })
}

/**
 * 换一本小说：点书名行 → 在切换器里点那一本。
 * （以前是 setValue(dn_sel)，现在走真实入口，顺便验证入口真的在界面上）
 */
async function pickNovel(rt, Panel, props, tree, name) {
  let open = tree
  // 切换器可能已经开着（那就别再去点书名行，否则会把它关掉）
  if (!byClass(open, 'dn_swrow').length) {
    const row = byClass(open, 'dn_bookrow').find((n) => hasClass(n, 'pick'))
    if (!row) throw new Error('书名行不可点（小说不足两本？）')
    click(row)
    open = await settle(rt, Panel, props)
  }
  const target = byClass(open, 'dn_swrow').find((n) => textOf(n).indexOf(name) >= 0)
  if (!target) throw new Error('切换器里找不到：' + name)
  click(target)
  return await settle(rt, Panel, props)
}

// ─────────────── 4. 加载客户端半 ───────────────
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: (m) => {
      loaded = m
    }
  }
}

const rt = createReact()
const fakeRequire = (name) => {
  if (name === 'react') return rt.React
  throw new Error('意外的 require: ' + name)
}

new Function(fs.readFileSync('./lib/client.js', 'utf8'))()

/** 起一个全新面板（等价于"刷新浏览器"）。跨测试段要用，所以放在外面。 */
async function freshPanel() {
  const rtx = createReact()
  const mx = loaded.factory((n) => {
    if (n === 'react') return rtx.React
    throw new Error('意外的 require: ' + n)
  })
  let tabx = null
  mx.apply({
    betterSidebar: {
      registerTab: (d) => {
        tabx = d
        return () => {}
      }
    },
    effect: (fn) => fn()
  })
  const tree = await settle(rtx, tabx.component, { visible: true })
  return { rt: rtx, Panel: tabx.component, tree }
}

try {
  console.log('── 1. 模块形状 ──')
  ok('模块 id = dsh-novel', loaded && loaded.id === 'dsh-novel', String(loaded && loaded.id))
  const m = loaded.factory(fakeRequire)
  ok('inject = ["betterSidebar"]', JSON.stringify(m.inject) === '["betterSidebar"]', JSON.stringify(m.inject))
  ok('apply 是函数', typeof m.apply === 'function')

  console.log('\n── 2. 注册页签 ──')
  let tab = null
  m.apply({
    betterSidebar: {
      registerTab: (d) => {
        tab = d
        return () => {}
      }
    },
    effect: (fn) => fn()
  })
  ok('id = dsh-novel:panel', tab && tab.id === 'dsh-novel:panel')
  ok('title = 小说', tab && tab.title === '小说')
  ok('component 是函数', tab && typeof tab.component === 'function')

  const props = { visible: true }
  const Panel = tab.component

  console.log('\n── 3. 章节页（假浏览器 → 真路由 → 真 .md） ──')
  let tree = await settle(rt, Panel, props)
  ok('标题栏在', treeText(byClass(tree, 'dn_head')[0]).indexOf('小说创作台') >= 0)
  {
    const row = byClass(tree, 'dn_bookrow')[0]
    ok('书名行显示当前这本', !!row && treeText(row).indexOf(NOVEL_A) >= 0, row ? treeText(row) : '(没有)')
    ok('书名行可点（能换本）', !!row && hasClass(row, 'pick'))
    ok('书名行带进度（章数/角色分档/多久前写过）', !!row && /章 · 角色 \d+ 人（重要 \d+ · 路人 \d+）·/.test(treeText(row)), row ? treeText(row) : '')
  }
  ok('自动打开最新章节', byClass(tree, 'dn_pre').length === 1)
  ok('正文是真内容', treeText(byClass(tree, 'dn_pre')[0]).indexOf('苏晚，你又在写悲剧') >= 0)
  ok('子组件被递归渲染（有多个 hook 槽）', rt.hookCount() >= 2, `槽位 ${rt.hookCount()}`)

  console.log('\n── 4. 设定页：改大纲 → 保存 ──')
  {
    click(findAll(tree, (n) => n.type === 'button' && textOf(n).indexOf('设定') === 0)[0])
    tree = await settle(rt, Panel, props)
    const ta = byType(tree, 'textarea')[0]
    ok('有可编辑的大纲框', !!ta)
    ok('框里是从磁盘读的大纲', String(ta.props.value).indexOf('恋爱恐惧症') >= 0, String(ta.props.value).slice(0, 22))
    ok('没改之前保存按钮禁用', !!btn(tree, '已保存') && btn(tree, '已保存').props.disabled === true)

    setValue(ta, '# 新大纲\n\n- 第一幕：练习开始\n')
    tree = await settle(rt, Panel, props)
    const saveBtn = btn(tree, '保存 (Ctrl+S)')
    ok('改了之后保存按钮可点', !!saveBtn && !saveBtn.props.disabled)
    click(saveBtn)
    tree = await settle(rt, Panel, props)
    ok('出现「已保存」提示', treeText(tree).indexOf('已保存') >= 0)
    ok('磁盘 outline.md 真变了', fs.readFileSync(path.join(ROOT, NOVEL_A, 'outline.md'), 'utf8').indexOf('第一幕') >= 0)
    ok('保存后又变回禁用', !!btn(tree, '已保存') && btn(tree, '已保存').props.disabled === true)
  }

  console.log('\n── 5. 人物卡在设定页是只读的 ──')
  {
    click(findAll(tree, (n) => n.type === 'button' && textOf(n).indexOf('人物卡') >= 0)[0])
    tree = await settle(rt, Panel, props)
    const ta = byType(tree, 'textarea')[0]
    ok('人物卡框 readOnly', ta && ta.props.readOnly === true)
    ok('有说明文字', treeText(tree).indexOf('由「角色」页生成') >= 0)
  }

  console.log('\n── 6. 角色页：读出来 + 改 + 拉关系 + 保存 ──')
  {
    click(findAll(tree, (n) => n.type === 'button' && textOf(n).indexOf('角色') === 0)[0])
    tree = await settle(rt, Panel, props)
    ok('两个角色都列出来了', treeText(tree).indexOf('苏晚') >= 0 && treeText(tree).indexOf('林知夏') >= 0)
    ok('关系显示成人话', treeText(tree).indexOf('苏晚 —暗恋（单向）→ 林知夏') >= 0, treeText(byClass(tree, 'dn_reltext')[0]))
    ok('有「＋ 新角色」', !!btn(tree, '新角色'))
    ok('没改之前保存禁用', !!btn(tree, '已同步') && btn(tree, '已同步').props.disabled === true)

    click(btn(tree, '新角色'))
    tree = await settle(rt, Panel, props)
    ok('变成 3 个角色', treeText(byClass(tree, 'dn_toolbar')[0]).indexOf('3 人') >= 0, treeText(byClass(tree, 'dn_toolbar')[0]))

    setValue(fieldBox(tree, '名字'), '周晓')
    tree = await settle(rt, Panel, props)
    setValue(fieldBox(tree, '标签（顿号或逗号分隔）'), '损友、汽水')
    tree = await settle(rt, Panel, props)
    ok('名字改了', treeText(byClass(tree, 'dn_rows')[0]).indexOf('周晓') >= 0)
    ok('标签框回填成顿号连接', String(fieldBox(tree, '标签（顿号或逗号分隔）').props.value) === '损友、汽水')

    const selFrom = fieldBox(tree, '从')
    const selTo = fieldBox(tree, '到')
    const optZhou = (selFrom.kids || []).find((o) => textOf(o) === '周晓')
    const optSu = (selFrom.kids || []).find((o) => textOf(o) === '苏晚')
    ok('下拉里能选到新人', !!optZhou && !!optSu)
    setValue(selFrom, optZhou.props.value)
    tree = await settle(rt, Panel, props)
    setValue(fieldBox(tree, '到'), optSu.props.value)
    tree = await settle(rt, Panel, props)
    setValue(fieldBox(tree, '关系（如：暗恋（单向）/ 闺蜜 / 兄妹）'), '青梅竹马')
    tree = await settle(rt, Panel, props)
    click(btn(tree, '添加关系'))
    tree = await settle(rt, Panel, props)
    ok('关系变 2 条', treeText(byClass(tree, 'dn_toolbar')[0]).indexOf('2 条关系') >= 0, treeText(byClass(tree, 'dn_toolbar')[0]))
    ok('新关系显示出来', treeText(tree).indexOf('周晓 —青梅竹马→ 苏晚') >= 0)

    click(btn(tree, '保存角色表'))
    tree = await settle(rt, Panel, props)
    const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, NOVEL_A, 'characters.json'), 'utf8'))
    ok('磁盘上 3 个角色', onDisk.characters.length === 3, String(onDisk.characters.length))
    ok('磁盘上 2 条关系', onDisk.relations.length === 2, String(onDisk.relations.length))
    ok('新角色标签进了 json', JSON.stringify(onDisk.characters).indexOf('损友') >= 0)
    const md = fs.readFileSync(path.join(ROOT, NOVEL_A, 'characters.md'), 'utf8')
    ok('characters.md 自动同步', md.indexOf('周晓') >= 0 && md.indexOf('青梅竹马') >= 0)
    ok('保存后有成功提示', treeText(tree).indexOf('人物卡已同步') >= 0)
    ok('页签上的角色数也刷新了', treeText(byClass(tree, 'dn_tabs')[0]).indexOf('角色 3') >= 0, treeText(byClass(tree, 'dn_tabs')[0]))
  }

  console.log('\n── 7. 删角色：连带关系一起清 ──')
  {
    click(btn(tree, '删除这个角色'))
    tree = await settle(rt, Panel, props)
    click(btn(tree, '保存角色表'))
    tree = await settle(rt, Panel, props)
    const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, NOVEL_A, 'characters.json'), 'utf8'))
    ok('磁盘上剩 2 个角色', onDisk.characters.length === 2, String(onDisk.characters.length))
    ok('关系只剩苏晚→林知夏那一条', onDisk.relations.length === 1 && onDisk.relations[0].from === 'c1', JSON.stringify(onDisk.relations))
    ok('周晓那条被连带删掉', JSON.stringify(onDisk.relations).indexOf('青梅竹马') < 0)
  }

  console.log('\n── 8. 多部小说：切到老项目会看到备份提醒 ──')
  {
    ok('书名行可点（多部小说时）', !!byClass(tree, 'dn_bookrow').find((n) => hasClass(n, 'pick')))
    tree = await pickNovel(rt, Panel, props, tree, NOVEL_B)
    click(findAll(tree, (n) => n.type === 'button' && textOf(n).indexOf('角色') === 0)[0])
    tree = await settle(rt, Panel, props)
    ok(
      '提示这是老的手写人物卡',
      treeText(byClass(tree, 'dn_warn')[0] || {}).indexOf('.bak') >= 0,
      treeText(byClass(tree, 'dn_warn')[0] || {}).slice(0, 34)
    )
    ok('角色表是空的（还没转成 json）', treeText(tree).indexOf('还没有角色') >= 0)

    click(btn(tree, '新角色'))
    tree = await settle(rt, Panel, props)
    setValue(fieldBox(tree, '名字'), '老王')
    tree = await settle(rt, Panel, props)
    click(btn(tree, '保存角色表'))
    tree = await settle(rt, Panel, props)
    ok('旧手写文件被备份', fs.existsSync(path.join(ROOT, NOVEL_B, 'characters.md.bak')))
    ok('备份 = 手写原文', fs.readFileSync(path.join(ROOT, NOVEL_B, 'characters.md.bak'), 'utf8').indexOf('别覆盖我') >= 0)
    ok('新 characters.md 是生成的', fs.readFileSync(path.join(ROOT, NOVEL_B, 'characters.md'), 'utf8').indexOf('自动生成') >= 0)
  }

  console.log('\n── 9. 新建小说 ──')
  {
    click(btn(tree, '＋ 新建'))
    tree = await settle(rt, Panel, props)
    ok('出现新建表单', !!fieldBox(tree, '书名'))
    setValue(fieldBox(tree, '书名'), NEW)
    setValue(fieldBox(tree, '一句话简介（可以先空着）'), '一个用来测试的新故事')
    tree = await settle(rt, Panel, props)
    click(btn(tree, '创建'))
    tree = await settle(rt, Panel, props)
    ok('磁盘上建好目录', fs.existsSync(path.join(ROOT, NEW)))
    ok(
      '四份文件都在',
      ['大纲.txt', '世界观.txt', '人物卡.txt', '角色.json'].every((f) => fs.existsSync(path.join(ROOT, NEW, f)))
    )
    ok('简介写进大纲', fs.readFileSync(path.join(ROOT, NEW, '大纲.txt'), 'utf8').indexOf('一个用来测试的新故事') >= 0)
    ok('创建后自动跳到设定页', byType(tree, 'textarea').length > 0)
    // 打开切换器看看现在有几部（选完它会自己关掉，所以先看再关）
    click(byClass(tree, 'dn_bookrow').find((n) => hasClass(n, 'pick')))
    tree = await settle(rt, Panel, props)
    ok('切换器里现在有 3 部', byClass(tree, 'dn_swrow').length === 3, String(byClass(tree, 'dn_swrow').length))
    ok('切换器里能看到小说库路径', treeText(tree).indexOf('小说库：') >= 0)
    click(btn(tree, '✕'))
    tree = await settle(rt, Panel, props)
    ok('✕ 能关掉切换器', byClass(tree, 'dn_swrow').length === 0)
  }

  console.log('\n── 10. 错误态 / 空态 ──')
  {
    fetchOverride = async () => {
      throw new Error('模拟网络断了')
    }
    click(btn(tree, '刷新'))
    tree = await settle(rt, Panel, props)
    ok('出现错误提示', byClass(tree, 'dn_err').length > 0, treeText(byClass(tree, 'dn_err')[0]))
    ok('错误里带原因', treeText(byClass(tree, 'dn_err')[0]).indexOf('模拟网络断了') >= 0)

    fetchOverride = async () => ({ status: 200, json: async () => ({ ok: true, root: ROOT, novels: [] }) })
    click(btn(tree, '刷新'))
    tree = await settle(rt, Panel, props)
    ok('空态提示能新建', treeText(tree).indexOf('还没有小说项目') >= 0)
    ok('空态不显示正文预览', byClass(tree, 'dn_pre').length === 0)
    fetchOverride = null

    click(btn(tree, '刷新'))
    tree = await settle(rt, Panel, props)
    ok('恢复真数据后又读到 3 部', (byClass(tree, 'dn_bookrow')[0] ? 1 : 0) === 1)
  }

  console.log('\n── 11. 「✍️ 写下一章」按钮 ──')
  {
    // (a) 拿不到 conversation 服务（props 里没 ctx）→ 明确降级，不乱来
    click(btn(tree, '写下一章'))
    tree = await settle(rt, Panel, props)
    ok('没 ctx 时明确提示降级', treeText(tree).indexOf('没接上输入框') >= 0, treeText(byClass(tree, 'dn_err')[0] || {}).slice(0, 28))

    // (b) 输入框是空的 → 填进去 + 自动发送
    const calls = []
    const fakeInput = {
      state: { getSnapshot: () => ({ draft: '' }) },
      setDraft: (v) => calls.push(['setDraft', v]),
      submit: (m) => calls.push(['submit', m])
    }
    const ctx2 = {
      get: (n) => (n === 'conversation' ? { input: { for: () => fakeInput } } : undefined),
      sessions: { scope: () => 'SCOPED' }
    }
    const props2 = { visible: true, ctx: ctx2, scope: { sessionId: 's1' } }
    tree = await settle(rt, Panel, props2)
    click(btn(tree, '写下一章'))
    tree = await settle(rt, Panel, props2)
    ok('调了 setDraft', !!calls[0] && calls[0][0] === 'setDraft', JSON.stringify(calls.map((c) => c[0])))
    ok(
      '调了 submit（自动发送 · queue 模式）',
      !!calls[1] && calls[1][0] === 'submit' && calls[1][1] === 'queue',
      JSON.stringify(calls.map((c) => c[0]))
    )
    const prompt = String(calls[0][1])
    ok('提示词带书名和章号', prompt.indexOf('《') >= 0 && /第\d{3}章/.test(prompt), prompt.slice(0, 32))
    ok('提示词点了两个工具', prompt.indexOf('novel_context') >= 0 && prompt.indexOf('novel_save_chapter') >= 0)
    ok('界面说已发出', treeText(tree).indexOf('已替你发进会话') >= 0)

    // (c) 输入框已有内容 → 只追加，绝不覆盖、不自动发
    const calls3 = []
    const fakeInput3 = {
      state: { getSnapshot: () => ({ draft: '我自己打了一半的话' }) },
      setDraft: (v) => calls3.push(['setDraft', v]),
      submit: (m) => calls3.push(['submit', m])
    }
    const ctx3 = {
      get: (n) => (n === 'conversation' ? { input: { for: () => fakeInput3 } } : undefined),
      sessions: { scope: () => 'S' }
    }
    const props3 = { visible: true, ctx: ctx3, scope: { sessionId: 's1' } }
    tree = await settle(rt, Panel, props3)
    click(btn(tree, '写下一章'))
    tree = await settle(rt, Panel, props3)
    ok('没覆盖用户输入', String(calls3[0][1]).indexOf('我自己打了一半的话') === 0, String(calls3[0][1]).slice(0, 16))
    ok('没有自动发送', !calls3.some((c) => c[0] === 'submit'))
    ok('提示要自己按 Enter', treeText(tree).indexOf('按 Enter 发送') >= 0)
  }
  console.log('\n── 12. 自动刷新（不用手点） ──')
  {
    // 先让面板隐藏再显示，强制重新挂载轮询 effect，同时把 setInterval/clearInterval 换成间谍
    tree = await settle(rt, Panel, { visible: false })
    const realSetInterval = globalThis.setInterval
    const realClearInterval = globalThis.clearInterval
    const timers = []
    const cleared = []
    globalThis.setInterval = (fn, ms) => {
      timers.push({ fn, ms })
      return 1000 + timers.length
    }
    globalThis.clearInterval = (h) => cleared.push(h)

    tree = await settle(rt, Panel, { visible: true })
    const listTimer = timers.find((t) => t.ms === 3000)
    const liveTimer = timers.find((t) => t.ms === 400)
    ok('挂了列表轮询（3 秒）', !!listTimer, timers.map((t) => t.ms).join(','))
    ok('挂了直播轮询（0.4 秒）', !!liveTimer, timers.map((t) => t.ms).join(','))

    // 切到有章节的那部小说，并回到「章节」页
    tree = await pickNovel(rt, Panel, { visible: true }, tree, NOVEL_A)
    click(findAll(tree, (n) => n.type === 'button' && textOf(n).indexOf('章节') === 0)[0])
    tree = await settle(rt, Panel, { visible: true })
    ok('现在看到 1 章', byClass(tree, 'dn_item').length === 1, String(byClass(tree, 'dn_item').length))

    // 模拟"小d 在后台写完一章"：直接往磁盘写一个章节文件
    const newFile = path.join(ROOT, NOVEL_A, 'chapters', '第002章-后台写好的.md')
    fs.writeFileSync(newFile, '# 第2章 后台写好的\n\n这一章是趁你不注意写的。\n', 'utf8')

    // 手动触发一次轮询回调（真实场景里是 3 秒后自己触发）
    await listTimer.fn()
    tree = await settle(rt, Panel, { visible: true })
    ok('面板自己发现了新章节（2 章）', byClass(tree, 'dn_item').length === 2, String(byClass(tree, 'dn_item').length))
    ok('新章出现在列表里', treeText(tree).indexOf('后台写好的') >= 0)
    ok('正文自动跟到最新一章', treeText(byClass(tree, 'dn_pre')[0] || {}).indexOf('趁你不注意') >= 0)

    // 手动点回旧章 → 不再自动跟随
    const oldRow = byClass(tree, 'dn_item').find((n) => textOf(n).indexOf('开头') >= 0)
    click(oldRow)
    tree = await settle(rt, Panel, { visible: true })
    ok('点旧章后正文是旧章', treeText(byClass(tree, 'dn_pre')[0]).indexOf('苏晚，你又在写悲剧') >= 0)
    fs.writeFileSync(path.join(ROOT, NOVEL_A, 'chapters', '第003章-又一章.md'), '# 第3章 又一章\n\n更新来了。\n', 'utf8')
    await listTimer.fn()
    tree = await settle(rt, Panel, { visible: true })
    ok('列表还是跟着更新（3 章）', byClass(tree, 'dn_item').length === 3, String(byClass(tree, 'dn_item').length))
    ok('但正文没被抢走（用户在看旧章）', treeText(byClass(tree, 'dn_pre')[0]).indexOf('苏晚，你又在写悲剧') >= 0)

    // 隐藏面板 → 定时器要停
    tree = await settle(rt, Panel, { visible: false })
    ok('隐藏后清掉了两个定时器', cleared.indexOf(1001) >= 0 && cleared.indexOf(1002) >= 0, cleared.join(','))

    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }

  console.log('\n── 13. 流式输出（面板里的直播框） ──')
  {
    tree = await settle(rt, Panel, { visible: false })
    const realSI = globalThis.setInterval
    const realCI = globalThis.clearInterval
    const timers2 = []
    globalThis.setInterval = (fn, ms) => {
      timers2.push({ fn, ms })
      return 2000 + timers2.length
    }
    globalThis.clearInterval = () => {}

    const propsLive = { visible: true, ctx: { get: () => undefined }, scope: { sessionId: 's1' } }
    tree = await settle(rt, Panel, propsLive)
    const liveTimer = timers2.find((t) => t.ms === 400)
    ok('直播轮询挂上了', !!liveTimer, timers2.map((t) => t.ms).join(','))

    // 没在写 → 不该有直播框
    await liveTimer.fn()
    tree = await settle(rt, Panel, propsLive)
    ok('没在写时不显示直播框', byClass(tree, 'dn_live').length === 0)

    // 喂帧：模型正在把章节正文当工具参数吐出来
    streamBuffer.frame('s1', { type: 'start', attemptId: 'a1', turn: 1, step: 1 })
    streamBuffer.frame('s1', {
      type: 'chunk',
      attemptId: 'a1',
      index: 0,
      chunk: {
        type: 'tool-call-delta',
        index: 0,
        id: 't1',
        name: 'novel_save_chapter',
        argumentsDelta: '{"content":"# 第2章 直播测试\\n\\n「苏晚'
      }
    })
    await liveTimer.fn()
    tree = await settle(rt, Panel, propsLive)
    ok('直播框出现了', byClass(tree, 'dn_live').length === 1)
    ok(
      '标题说正在写正文',
      treeText(byClass(tree, 'dn_livehead')[0]).indexOf('正在写正文') >= 0,
      treeText(byClass(tree, 'dn_livehead')[0])
    )
    ok(
      '直播内容就是正文',
      treeText(byClass(tree, 'dn_livepre')[0]).indexOf('第2章 直播测试') >= 0,
      treeText(byClass(tree, 'dn_livepre')[0]).slice(0, 22)
    )
    ok('标了字数', /\d+ 字/.test(treeText(byClass(tree, 'dn_livehead')[0])), treeText(byClass(tree, 'dn_livehead')[0]))

    // 再来一块 → 追上最新文字
    streamBuffer.frame('s1', {
      type: 'chunk',
      attemptId: 'a1',
      index: 1,
      chunk: { type: 'tool-call-delta', index: 0, id: 't1', argumentsDelta: '，你又在写悲剧？」\\n"}' }
    })
    await liveTimer.fn()
    tree = await settle(rt, Panel, propsLive)
    ok('新内容追上了', treeText(byClass(tree, 'dn_livepre')[0]).indexOf('你又在写悲剧') >= 0)

    // 只有思考流时 → 显示思考（斜体）
    streamBuffer.clear('s1')
    streamBuffer.frame('s1', { type: 'start', attemptId: 'b1', turn: 2, step: 1 })
    streamBuffer.frame('s1', {
      type: 'chunk',
      attemptId: 'b1',
      index: 0,
      chunk: { type: 'reasoning-delta', text: '先想想人物动机…' }
    })
    await liveTimer.fn()
    tree = await settle(rt, Panel, propsLive)
    ok(
      '只有思考时显示思考',
      treeText(byClass(tree, 'dn_livehead')[0]).indexOf('正在想') >= 0,
      treeText(byClass(tree, 'dn_livehead')[0])
    )
    ok('思考内容是斜体样式', hasClass(byClass(tree, 'dn_livepre')[0], 'reason'))

    // end → 标题变"写完"
    streamBuffer.frame('s1', { type: 'end' })
    await liveTimer.fn()
    tree = await settle(rt, Panel, propsLive)
    ok('写完的标题', treeText(byClass(tree, 'dn_livehead')[0]).indexOf('完') >= 0, treeText(byClass(tree, 'dn_livehead')[0]))

    // 缓冲清空后再轮询 → 直播框收起来
    streamBuffer.clear('s1')
    await liveTimer.fn()
    tree = await settle(rt, Panel, propsLive)
    ok('没有内容后直播框收起来', byClass(tree, 'dn_live').length === 0)

    globalThis.setInterval = realSI
    globalThis.clearInterval = realCI
  }

  console.log('\n── 14. 章节改名 / 删除 ──')
  {
    tree = await settle(rt, Panel, { visible: true })
    // 回到有 3 章的《测试小说》的章节页
    tree = await pickNovel(rt, Panel, { visible: true }, tree, NOVEL_A)
    click(findAll(tree, (n) => n.type === 'button' && textOf(n).indexOf('章节') === 0)[0])
    tree = await settle(rt, Panel, { visible: true })
    const before = byClass(tree, 'dn_item').length
    ok('先有 3 章', before === 3, String(before))
    // 注意：面板现在会回到"上次看到的那一章"（记忆），所以这里明确点最新一章来测改名
    const rowsAll = byClass(tree, 'dn_item')
    click(rowsAll[rowsAll.length - 1])
    tree = await settle(rt, Panel, { visible: true })
    ok(
      '明确点最新一章后选中它',
      treeText(byClass(tree, 'dn_chbar')[0]).indexOf('第3章') >= 0,
      treeText(byClass(tree, 'dn_chbar')[0])
    )
    ok('有改名和删除按钮', !!btn(tree, '改名') && !!btn(tree, '删除'))

    click(btn(tree, '改名'))
    tree = await settle(rt, Panel, { visible: true })
    ok('出现改名输入行', byClass(tree, 'dn_chrename').length === 1)
    const input = findAll(byClass(tree, 'dn_chrename')[0], (n) => n.type === 'input')[0]
    ok('输入框预填了原标题', String(input.props.value) === '又一章', String(input.props.value))

    setValue(input, '改过名的第三章')
    tree = await settle(rt, Panel, { visible: true })
    click(btn(tree, '保存'))
    tree = await settle(rt, Panel, { visible: true })
    ok('磁盘上真改名了', fs.existsSync(path.join(ROOT, NOVEL_A, 'chapters', '第003章-改过名的第三章.md')))
    ok('老文件名没了', !fs.existsSync(path.join(ROOT, NOVEL_A, 'chapters', '第003章-又一章.md')))
    ok('列表里是新标题', treeText(tree).indexOf('改过名的第三章') >= 0)
    ok('提示改名成功', treeText(tree).indexOf('已改名为') >= 0, treeText(byClass(tree, 'dn_ok2')[0] || {}).slice(0, 22))

    // 删掉中间那一章
    const mid = byClass(tree, 'dn_item').find((n) => textOf(n).indexOf('后台写好的') >= 0)
    click(mid)
    tree = await settle(rt, Panel, { visible: true })
    ok('切换后动作条跟着变', treeText(byClass(tree, 'dn_chbar')[0]).indexOf('后台写好的') >= 0, treeText(byClass(tree, 'dn_chbar')[0]))
    click(btn(tree, '删除'))
    tree = await settle(rt, Panel, { visible: true })
    ok('磁盘上删掉了', !fs.existsSync(path.join(ROOT, NOVEL_A, 'chapters', '第002章-后台写好的.md')))
    ok('列表变 2 章', byClass(tree, 'dn_item').length === 2, String(byClass(tree, 'dn_item').length))
    ok('提示删除成功', treeText(tree).indexOf('已删除') >= 0)
    ok('剩下的章号没被串号', treeText(tree).indexOf('第3章 改过名的第三章') >= 0, treeText(byClass(tree, 'dn_rows')[0]).replace(/\s+/g, ' '))
  }

  console.log('\n── 15. 关系可视化（SVG 关系图） ──')
  {
    tree = await settle(rt, Panel, { visible: true })
    tree = await pickNovel(rt, Panel, { visible: true }, tree, NOVEL_A)
    click(findAll(tree, (n) => n.type === 'button' && textOf(n).indexOf('角色') === 0)[0])
    tree = await settle(rt, Panel, { visible: true })

    const svg = byClass(tree, 'dn_graph')[0]
    ok('画出来了（svg）', !!svg && svg.type === 'svg', svg ? svg.type : '(没有)')
    ok('有箭头 marker', findAll(svg, (n) => n.type === 'marker').length === 1)
    // 只数**节点上的**圆点（defs 里那个是裁头像用的 clipPath 圆，不算角色）
    const nodeCircles = findAll(svg, (n) => n.type === 'circle' && (n.props.fill === undefined ? false : true));
    ok('圆点 = 角色数（2）', nodeCircles.length === 2, String(nodeCircles.length))
    ok('连线 = 关系数（1）', findAll(svg, (n) => n.type === 'line').length === 1, String(findAll(svg, (n) => n.type === 'line').length))
    ok('线上标了关系名', treeText(svg).indexOf('暗恋（单向）') >= 0)
    ok('名字都标了', treeText(svg).indexOf('苏晚') >= 0 && treeText(svg).indexOf('林知夏') >= 0)
    ok('底部有统计', treeText(byClass(tree, 'dn_graphtip')[0]).indexOf('2 人 · 1 条关系') >= 0, treeText(byClass(tree, 'dn_graphtip')[0]))

    // 点圆点 → 切换选中的角色
    const nodes = findAll(svg, (n) => n.type === 'g' && typeof n.props.onClick === 'function')
    ok('圆点可点', nodes.length === 2, String(nodes.length))
    nodes[1].props.onClick()
    tree = await settle(rt, Panel, { visible: true })
    ok('点圆点切到了林知夏', treeText(byClass(tree, 'dn_sec')[0]).indexOf('林知夏') >= 0, treeText(byClass(tree, 'dn_sec')[0]))

    // 加一条反向关系 → 应该变成两条线（而且错开画）
    const selFrom = fieldBox(tree, '从')
    const selTo = fieldBox(tree, '到')
    setValue(selFrom, (selFrom.kids || []).find((o) => textOf(o) === '林知夏').props.value)
    tree = await settle(rt, Panel, { visible: true })
    setValue(fieldBox(tree, '到'), (fieldBox(tree, '到').kids || []).find((o) => textOf(o) === '苏晚').props.value)
    tree = await settle(rt, Panel, { visible: true })
    setValue(fieldBox(tree, '关系（如：暗恋（单向）/ 闺蜜 / 兄妹）'), '依赖')
    tree = await settle(rt, Panel, { visible: true })
    click(btn(tree, '添加关系'))
    tree = await settle(rt, Panel, { visible: true })
    const svg2 = byClass(tree, 'dn_graph')[0]
    ok('两条关系两条线', findAll(svg2, (n) => n.type === 'line').length === 2, String(findAll(svg2, (n) => n.type === 'line').length))
    ok('反向关系也标了名', treeText(svg2).indexOf('依赖') >= 0)
    ok(
      '互指的两条线错开了（不重合）',
      findAll(svg2, (n) => n.type === 'line')[0].props.x1 !== findAll(svg2, (n) => n.type === 'line')[1].props.x1
    )

    click(btn(tree, '保存角色表'))
    tree = await settle(rt, Panel, { visible: true })
    const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, NOVEL_A, 'characters.json'), 'utf8'))
    ok('两条关系都存盘了', onDisk.relations.length === 2, String(onDisk.relations.length))

    // 折叠
    click(btn(tree, '收起关系图'))
    tree = await settle(rt, Panel, { visible: true })
    ok('能收起来', byClass(tree, 'dn_graph').length === 0)
    click(btn(tree, '关系图'))
    tree = await settle(rt, Panel, { visible: true })
    ok('又能展开', byClass(tree, 'dn_graph').length === 1)
  }

  console.log('\n── 16. 自动刷新可配置（4 档） ──')
  {
    // 装一个假的 localStorage（Node 里没有）
    const store = new Map()
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    }

    tree = await settle(rt, Panel, { visible: false })
    const realSI2 = globalThis.setInterval
    const realCI2 = globalThis.clearInterval
    const seen = []
    globalThis.setInterval = (fn, ms) => {
      seen.push(ms)
      return 5000 + seen.length
    }
    globalThis.clearInterval = () => {}

    tree = await settle(rt, Panel, { visible: true })
    ok('默认档 = 实时（3000 + 400）', seen.indexOf(3000) >= 0 && seen.indexOf(400) >= 0, seen.join(','))

    const sel = byClass(tree, 'dn_mini')[0]
    ok('页脚有档位下拉', !!sel)
    ok('下拉当前值 = 实时', sel.props.value === 'live', String(sel.props.value))
    ok('有 5 个档位（4 预设 + 自定义）', (sel.kids || []).length === 5, (sel.kids || []).map((o) => textOf(o)).join('/'))
    ok('写着当前档位说明', treeText(byClass(tree, 'dn_foot')[0]).indexOf('列表 3 秒') >= 0)

    // 切「普通」
    seen.length = 0
    setValue(sel, 'normal')
    tree = await settle(rt, Panel, { visible: true })
    ok('普通档 → 10000 + 2000', seen.indexOf(10000) >= 0 && seen.indexOf(2000) >= 0, seen.join(','))
    ok('存进了 localStorage', store.get('dsh-novel:poll') === 'normal', String(store.get('dsh-novel:poll')))
    ok('说明文字跟着变', treeText(byClass(tree, 'dn_foot')[0]).indexOf('列表 10 秒') >= 0)

    // 切「省电」：不直播
    seen.length = 0
    setValue(byClass(tree, 'dn_mini')[0], 'eco')
    tree = await settle(rt, Panel, { visible: true })
    ok('省电档 → 只有 30000', seen.indexOf(30000) >= 0 && seen.indexOf(2000) < 0 && seen.indexOf(400) < 0, seen.join(','))
    ok('省电说明写了不直播', treeText(byClass(tree, 'dn_foot')[0]).indexOf('不直播') >= 0)

    // 切「关闭」：完全不轮询
    seen.length = 0
    setValue(byClass(tree, 'dn_mini')[0], 'off')
    tree = await settle(rt, Panel, { visible: true })
    ok('关闭档 → 一个定时器都不挂', seen.length === 0, seen.join(',') || '(0 个)')

    // 全新运行时 + localStorage 里存的是省电 → 启动就该是省电
    store.set('dsh-novel:poll', 'eco')
    const rt3 = createReact()
    const m3 = loaded.factory((n) => {
      if (n === 'react') return rt3.React
      throw new Error('意外的 require: ' + n)
    })
    let tab3 = null
    m3.apply({
      betterSidebar: {
        registerTab: (d) => {
          tab3 = d
          return () => {}
        }
      },
      effect: (fn) => fn()
    })
    const seen3 = []
    globalThis.setInterval = (fn, ms) => {
      seen3.push(ms)
      return 9000 + seen3.length
    }
    const tree3 = await settle(rt3, tab3.component, { visible: true })
    ok('启动时读到了存下来的省电档', seen3.indexOf(30000) >= 0 && seen3.indexOf(400) < 0, seen3.join(','))
    ok('下拉也显示省电', byClass(tree3, 'dn_mini')[0].props.value === 'eco')

    // 坏数据要能兜底
    store.set('dsh-novel:poll', '这不是档位')
    const rt4 = createReact()
    const m4 = loaded.factory((n) => {
      if (n === 'react') return rt4.React
      throw new Error('意外的 require: ' + n)
    })
    let tab4 = null
    m4.apply({
      betterSidebar: {
        registerTab: (d) => {
          tab4 = d
          return () => {}
        }
      },
      effect: (fn) => fn()
    })
    const seen4 = []
    globalThis.setInterval = (fn, ms) => {
      seen4.push(ms)
      return 11000 + seen4.length
    }
    const tree4 = await settle(rt4, tab4.component, { visible: true })
    ok('坏偏好值回落到实时', byClass(tree4, 'dn_mini')[0].props.value === 'live', String(byClass(tree4, 'dn_mini')[0].props.value))
    ok('坏值也挂了默认定时器', seen4.indexOf(3000) >= 0, seen4.join(','))

    globalThis.setInterval = realSI2
    globalThis.clearInterval = realCI2
    delete globalThis.localStorage
  }

  console.log('\n── 17. 自定义档（自己填秒数） ──')
  {
    const store = new Map()
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    }
    tree = await settle(rt, Panel, { visible: false })
    const realSI3 = globalThis.setInterval
    const realCI3 = globalThis.clearInterval
    const seen = []
    globalThis.setInterval = (fn, ms) => {
      seen.push(ms)
      return 7000 + seen.length
    }
    globalThis.clearInterval = () => {}
    tree = await settle(rt, Panel, { visible: true })

    const sel = byClass(tree, 'dn_mini')[0]
    ok('下拉里有「自定义」', (sel.kids || []).some((o) => textOf(o) === '自定义'))

    seen.length = 0
    setValue(sel, 'custom')
    tree = await settle(rt, Panel, { visible: true })
    ok('自定义默认 = 列表 5 秒 / 直播 1 秒', seen.indexOf(5000) >= 0 && seen.indexOf(1000) >= 0, seen.join(','))
    ok('出现两个秒数输入框', byClass(tree, 'dn_num').length === 2, String(byClass(tree, 'dn_num').length))
    ok(
      '输入框默认值 5 和 1',
      String(byClass(tree, 'dn_num')[0].props.value) === '5' && String(byClass(tree, 'dn_num')[1].props.value) === '1',
      byClass(tree, 'dn_num').map((i) => i.props.value).join('/')
    )
    ok('说明文字跟上了', treeText(byClass(tree, 'dn_foot')[0]).indexOf('列表 5 秒') >= 0)

    seen.length = 0
    setValue(byClass(tree, 'dn_num')[0], '2')
    tree = await settle(rt, Panel, { visible: true })
    ok('列表改成 2 秒 → 2000', seen.indexOf(2000) >= 0, seen.join(','))
    ok(
      '落盘了',
      store.get('dsh-novel:pollCustom') === '{"list":"2","live":"1"}',
      String(store.get('dsh-novel:pollCustom'))
    )

    seen.length = 0
    setValue(byClass(tree, 'dn_num')[1], '0')
    tree = await settle(rt, Panel, { visible: true })
    ok('直播填 0 = 不直播（没有直播定时器）', seen.filter((ms) => ms > 0 && ms < 1000).length === 0, seen.join(',') || '(0 个)')
    ok('说明写了不直播', treeText(byClass(tree, 'dn_foot')[0]).indexOf('不直播') >= 0)

    seen.length = 0
    setValue(byClass(tree, 'dn_num')[0], '0')
    tree = await settle(rt, Panel, { visible: true })
    ok('列表填 0 → 夹到 1 秒', seen.indexOf(1000) >= 0, seen.join(','))

    seen.length = 0
    setValue(byClass(tree, 'dn_num')[0], '99999')
    tree = await settle(rt, Panel, { visible: true })
    ok('列表填 99999 → 夹到 3600 秒', seen.indexOf(3600000) >= 0, seen.join(','))

    seen.length = 0
    setValue(byClass(tree, 'dn_num')[1], '0.1')
    tree = await settle(rt, Panel, { visible: true })
    ok('直播填 0.1 → 夹到 0.2 秒', seen.indexOf(200) >= 0, seen.join(','))

    seen.length = 0
    setValue(byClass(tree, 'dn_num')[1], 'abc')
    tree = await settle(rt, Panel, { visible: true })
    ok('直播填垃圾 → 不直播、也不新挂定时器', seen.length === 0, seen.join(',') || '(0 个)')

    seen.length = 0
    setValue(byClass(tree, 'dn_num')[0], '')
    tree = await settle(rt, Panel, { visible: true })
    ok('列表填空 → 兜底 3 秒', seen.indexOf(3000) >= 0, seen.join(','))

    // 全新运行时读回自定义
    store.set('dsh-novel:poll', 'custom')
    store.set('dsh-novel:pollCustom', '{"list":"7","live":"0.5"}')
    const rt5 = createReact()
    const m5 = loaded.factory((n) => {
      if (n === 'react') return rt5.React
      throw new Error('意外的 require: ' + n)
    })
    let tab5 = null
    m5.apply({
      betterSidebar: {
        registerTab: (d) => {
          tab5 = d
          return () => {}
        }
      },
      effect: (fn) => fn()
    })
    const seen5 = []
    globalThis.setInterval = (fn, ms) => {
      seen5.push(ms)
      return 13000 + seen5.length
    }
    const tree5 = await settle(rt5, tab5.component, { visible: true })
    ok('启动读回自定义 7 / 0.5', seen5.indexOf(7000) >= 0 && seen5.indexOf(500) >= 0, seen5.join(','))
    ok('下拉显示自定义', byClass(tree5, 'dn_mini')[0].props.value === 'custom')
    ok(
      '输入框也是 7 / 0.5',
      byClass(tree5, 'dn_num').map((i) => i.props.value).join('/') === '7/0.5',
      byClass(tree5, 'dn_num').map((i) => i.props.value).join('/')
    )

    globalThis.setInterval = realSI3
    globalThis.clearInterval = realCI3
    delete globalThis.localStorage
  }

  console.log('\n── 18. 📁 保存位置（入口必须真的在界面上） ──')
  {
    tree = await settle(rt, Panel, { visible: true })

    // 这一步正是上次翻车的地方：组件写了、入口没加，功能等于不存在
    const btnFolder = findAll(tree, (n) => n.type === 'button' && textOf(n) === '📁')[0]
    ok('标题栏有 📁 按钮', !!btnFolder, btnFolder ? '找到了' : '(没有 —— 功能等于不存在)')
    ok('没点开时表单不显示', findAll(tree, (n) => n.type === 'label' && textOf(n).indexOf('小说保存位置') >= 0).length === 0)

    if (btnFolder) {
      click(btnFolder)
      tree = await settle(rt, Panel, { visible: true })
    }
    const box = fieldBox(tree, '📁 小说保存位置')
    ok('点开后出现表单', !!box)
    ok('输入框预填了当前路径', !!box && String(box.props.value) === ROOT, box ? String(box.props.value) : '(没有)')
    ok('写明了当前状态', treeText(tree).indexOf('当前：' + ROOT) >= 0)
    ok('说明了会自动创建目录', treeText(tree).indexOf('不存在会自动创建') >= 0)

    // 测试环境里 DSH_NOVEL_ROOT 是设了的 → 面板必须明确说"改不动"
    ok('环境变量锁定时有警告', treeText(tree).indexOf('DSH_NOVEL_ROOT') >= 0)
    click(btn(tree, '保存并切换'))
    tree = await settle(rt, Panel, { visible: true })
    ok('保存被拒并说明原因', treeText(tree).indexOf('环境变量') >= 0, treeText(byClass(tree, 'dn_err')[0] || {}).slice(0, 28))

    click(btn(tree, '取消'))
    tree = await settle(rt, Panel, { visible: true })
    ok('能收起来', !fieldBox(tree, '📁 小说保存位置'))
  }

  console.log('\n── 19. 小说库：换小说 / 记住读到哪 / 回落 ──')
  {
    // 跨"重新挂载"要保留记忆，所以 localStorage 装在全局
    const store = new Map()
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    }
    // 造一本有独特章节的小说，好判断"真的换过去了"
    const OTHER = '__小说B__'
    fs.mkdirSync(path.join(ROOT, OTHER, 'chapters'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, OTHER, 'chapters', '第001章-B的开头.txt'), '第1章 B的开头\n\nB 本的正文\n', 'utf8')

    /** 起一个全新面板（等价于"刷新浏览器 / 重开面板"）—— 见文件上方的 freshPanel */

    const p1 = await freshPanel()
    let t19 = p1.tree
    ok('刚打开时有小说库入口', !!byClass(t19, 'dn_bookrow').length)
    const shownName = (treeText(byClass(t19, 'dn_bookrow')[0]).match(/《(.+?)》/) || [])[1] || ''
    ok('自动打开了某一本', !!shownName, shownName)
    ok(
      '自动打开的那本已经被记住了',
      String(store.get('dsh-novel:library') || '').indexOf('"open":"' + shownName + '"') >= 0,
      String(store.get('dsh-novel:library') || '').slice(0, 70)
    )

    // 打开切换器：搜索 + 排序 + 每本进度
    click(byClass(t19, 'dn_bookrow').find((n) => hasClass(n, 'pick')))
    t19 = await settle(p1.rt, p1.Panel, { visible: true })
    ok('切换器里列出所有小说', byClass(t19, 'dn_swrow').length >= 4, String(byClass(t19, 'dn_swrow').length))
    ok('每行有进度', /章 · 角色 \d+ 人 ·/.test(treeText(byClass(t19, 'dn_swrow')[0])), treeText(byClass(t19, 'dn_swrow')[0]))
    const 搜索 = findAll(t19, (n) => n.type === 'input' && n.props.placeholder === '搜索书名…')[0]
    ok('有搜索框', !!搜索)
    setValue(搜索, '小说B')
    t19 = await settle(p1.rt, p1.Panel, { visible: true })
    ok('搜索能过滤', byClass(t19, 'dn_swrow').length === 1, String(byClass(t19, 'dn_swrow').length))
    setValue(findAll(t19, (n) => n.type === 'input' && n.props.placeholder === '搜索书名…')[0], '不存在的书')
    t19 = await settle(p1.rt, p1.Panel, { visible: true })
    ok('搜不到时给提示', treeText(t19).indexOf('没有匹配') >= 0)
    setValue(findAll(t19, (n) => n.type === 'input' && n.props.placeholder === '搜索书名…')[0], '')
    t19 = await settle(p1.rt, p1.Panel, { visible: true })
    const 排序 = findAll(t19, (n) => n.type === 'select' && (n.kids || []).some((o) => textOf(o) === '最近在写'))[0]
    ok('有排序下拉', !!排序)
    ok('排序有 3 个选项', (排序.kids || []).length === 3, (排序.kids || []).map((o) => textOf(o)).join('/'))

    // 真的切过去
    t19 = await pickNovel(p1.rt, p1.Panel, { visible: true }, t19, OTHER)
    ok('书名行换成了 B 本', treeText(byClass(t19, 'dn_bookrow')[0]).indexOf(OTHER) >= 0, treeText(byClass(t19, 'dn_bookrow')[0]))
    ok('正文换成 B 本的', treeText(byClass(t19, 'dn_pre')[0] || {}).indexOf('B 本的正文') >= 0, treeText(byClass(t19, 'dn_pre')[0] || {}).slice(0, 20))
    ok('B 本被记成"正在打开"', String(store.get('dsh-novel:library')).indexOf('"open":"' + OTHER + '"') >= 0)
    ok('B 本的阅读位置也记了', String(store.get('dsh-novel:library')).indexOf('第001章-B的开头.txt') >= 0)

    // 再切回第一本，并明确点到另一章（制造"两份不同的记忆"）
    t19 = await pickNovel(p1.rt, p1.Panel, { visible: true }, t19, '测试小说')
    const rows19 = byClass(t19, 'dn_item')
    click(rows19[0])
    t19 = await settle(p1.rt, p1.Panel, { visible: true })
    ok('切回第一本后正文是第一本的', treeText(byClass(t19, 'dn_pre')[0]).indexOf('苏晚') >= 0)

    // 再切回 B 本：应该回到 B 自己那一章（同一会话内的记忆）
    t19 = await pickNovel(p1.rt, p1.Panel, { visible: true }, t19, OTHER)
    ok(
      '切回 B 本时回到 B 自己的那一章',
      treeText(byClass(t19, 'dn_pre')[0] || {}).indexOf('B 本的正文') >= 0,
      treeText(byClass(t19, 'dn_pre')[0] || {}).slice(0, 18)
    )

    // 模拟"刷新浏览器"：全新运行时，应该回到 B 本
    const p2 = await freshPanel()
    ok('重开面板后回到上次打开的那本（B 本）', treeText(byClass(p2.tree, 'dn_bookrow')[0]).indexOf(OTHER) >= 0, treeText(byClass(p2.tree, 'dn_bookrow')[0]))
    ok('而且回到上次看的那一章', treeText(byClass(p2.tree, 'dn_pre')[0] || {}).indexOf('B 本的正文') >= 0, treeText(byClass(p2.tree, 'dn_pre')[0] || {}).slice(0, 18))

    // 切换器里应该显示"上次看到"
    click(byClass(p2.tree, 'dn_bookrow').find((n) => hasClass(n, 'pick')))
    const t19b = await settle(p2.rt, p2.Panel, { visible: true })
    ok('切换器里显示上次看到第几章', treeText(t19b).indexOf('上次看到：第1章 B的开头') >= 0, treeText(byClass(t19b, 'dn_swrow')[0] || {}).slice(0, 40))
    ok('另一本显示"还没打开过"或它的记忆', byClass(t19b, 'dn_swseen').length >= 2)

    // 回落：把正在看的 B 本删掉 → 刷新后应回落 + 明确提示
    fs.rmSync(path.join(ROOT, OTHER), { recursive: true, force: true })
    const p3 = await freshPanel()
    ok('打开的那本没了 → 回落到别的本', treeText(byClass(p3.tree, 'dn_bookrow')[0]).indexOf(OTHER) < 0, treeText(byClass(p3.tree, 'dn_bookrow')[0]))
    ok('并明确告诉用户为什么', treeText(p3.tree).indexOf('不在这个小说库里了') >= 0, treeText(byClass(p3.tree, 'dn_err')[0] || {}).slice(0, 44))
    ok('回落也写回了库（下次不再提示）', String(store.get('dsh-novel:library')).indexOf('"open":"' + OTHER + '"') < 0)

    delete globalThis.localStorage
  }

  console.log('\n── 20. 小说重命名/删除 + 章节拖拽 + 关系图拖拽 ──')
  {
    const store = new Map()
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    }
    const 改名后 = '__自测改名后__'
    const p = await freshPanel()
    let t = p.tree

    // ── 切换器里的 ✏️ / 🗑️ ──
    click(byClass(t, 'dn_bookrow').find((n) => hasClass(n, 'pick')))
    t = await settle(p.rt, p.Panel, { visible: true })
    const rows0 = byClass(t, 'dn_swrow')
    ok('每本都有改名/删除按钮', rows0.length > 0 && byClass(t, 'dn_swacts').length === rows0.length, `${byClass(t, 'dn_swacts').length}/${rows0.length}`)

    // 点 ✏️ 不能把那一本打开（stopPropagation）
    const current0 = treeText(byClass(t, 'dn_bookrow')[0])
    const 目标行 = rows0.find((n) => textOf(n).indexOf('测试小说') >= 0)
    const 铅笔 = findAll(目标行, (n) => n.type === 'button' && textOf(n) === '✏️')[0]
    ok('找到 ✏️ 按钮', !!铅笔)
    click(铅笔)
    t = await settle(p.rt, p.Panel, { visible: true })
    ok('点 ✏️ 不会顺手打开那本', treeText(byClass(t, 'dn_bookrow')[0]) === current0, treeText(byClass(t, 'dn_bookrow')[0]))
    ok('出现了改名输入行', byClass(t, 'dn_swrename').length === 1)

    const 改名框 = findAll(byClass(t, 'dn_swrename')[0], (n) => n.type === 'input')[0]
    ok('改名框预填原书名', String(改名框.props.value) === '测试小说', String(改名框.props.value))
    setValue(改名框, 改名后)
    t = await settle(p.rt, p.Panel, { visible: true })
    click(btn(t, '保存'))
    t = await settle(p.rt, p.Panel, { visible: true })
    ok('磁盘上目录真改名了', fs.existsSync(path.join(ROOT, 改名后)) && !fs.existsSync(path.join(ROOT, '测试小说')))
    ok('章节跟着搬过去了', fs.readdirSync(path.join(ROOT, 改名后, 'chapters')).length > 0)
    ok('列表里是新名字', treeText(t).indexOf(改名后) >= 0)
    ok('记忆也跟着改名搬过去了', String(store.get('dsh-novel:library')).indexOf('测试小说') < 0)
    ok('新名字进了记忆', String(store.get('dsh-novel:library')).indexOf(改名后) >= 0)

    // 把它打开（后面要在它身上测拖拽）
    t = await pickNovel(p.rt, p.Panel, { visible: true }, t, 改名后)
    ok('切到了改名后的那本', treeText(byClass(t, 'dn_bookrow')[0]).indexOf(改名后) >= 0)

    // ── 章节拖拽排序 ──
    click(findAll(t, (n) => n.type === 'button' && textOf(n).indexOf('章节') === 0)[0])
    t = await settle(p.rt, p.Panel, { visible: true })
    const rowsC = byClass(t, 'dn_item')
    ok('有章节可以拖', rowsC.length >= 2, String(rowsC.length))
    const before1 = treeText(rowsC[0])
    rowsC[0].props.onPointerDown()
    t = await settle(p.rt, p.Panel, { visible: true })
    ok('拖动中那一行有标记', byClass(t, 'dn_item').some((n) => hasClass(n, 'dragging')))
    byClass(t, 'dn_item')[1].props.onPointerEnter()
    t = await settle(p.rt, p.Panel, { visible: true })
    ok('悬停的那行有插入提示', byClass(t, 'dn_item').some((n) => hasClass(n, 'over')))
    byClass(t, 'dn_item')[1].props.onPointerUp()
    t = await settle(p.rt, p.Panel, { visible: true })
    ok('拖完给了提示', treeText(t).indexOf('顺序已保存') >= 0, treeText(byClass(t, 'dn_ok2')[0] || {}).slice(0, 24))
    ok('第一行换人了（顺序真变了）', treeText(byClass(t, 'dn_item')[0]) !== before1, treeText(byClass(t, 'dn_item')[0]))
    const filesNow = fs.readdirSync(path.join(ROOT, 改名后, 'chapters')).sort()
    ok('文件按新顺序重新编号了', filesNow[0].indexOf('第001章-') === 0 && filesNow[1].indexOf('第002章-') === 0, filesNow.join(','))

    // ── 关系图拖拽 ──
    click(findAll(t, (n) => n.type === 'button' && textOf(n).indexOf('角色') === 0)[0])
    t = await settle(p.rt, p.Panel, { visible: true })
    const svg = byClass(t, 'dn_graph')[0]
    ok('关系图画出来了', !!svg)
    if (svg) {
      const node = findAll(svg, (n) => n.type === 'g' && typeof n.props.onPointerDown === 'function')[0]
      ok('圆点支持拖拽', !!node)
      const circleBefore = findAll(node, (n) => n.type === 'circle')[0]
      const x0 = circleBefore.props.cx
      node.props.onPointerDown({ stopPropagation() {} })
      t = await settle(p.rt, p.Panel, { visible: true })
      const svg2 = byClass(t, 'dn_graph')[0]
      svg2.props.onPointerMove({
        clientX: 100,
        clientY: 80,
        currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 220 }) }
      })
      t = await settle(p.rt, p.Panel, { visible: true })
      const node2 = findAll(byClass(t, 'dn_graph')[0], (n) => n.type === 'g' && n.props.onPointerDown)[0]
      const circleAfter = findAll(node2, (n) => n.type === 'circle')[0]
      ok('拖动后圆点位置变了', circleAfter.props.cx !== x0 && circleAfter.props.cx === 100, `cx: ${x0} → ${circleAfter.props.cx}`)
      ok('位置记进了小说库', String(store.get('dsh-novel:library')).indexOf('"x":100') >= 0)
      ok('出现了「🕸 自动布局」', !!btn(t, '自动布局'))

      byClass(t, 'dn_graph')[0].props.onPointerUp()
      t = await settle(p.rt, p.Panel, { visible: true })
      click(btn(t, '自动布局'))
      t = await settle(p.rt, p.Panel, { visible: true })
      ok('点自动布局后清掉了手动位置', String(store.get('dsh-novel:library')).indexOf('"x":100') < 0)
      ok('按钮也收起来了', !btn(t, '自动布局'))

      // ── 力导向布局本身（纯函数，直接在 __test 上量） ──
      const T = m.__test;
      const G = [ { id: 'c1', name: '苏晚' }, { id: 'c2', name: '林知夏' }, { id: 'c3', name: '闺蜜' }, { id: 'c4', name: '老师' }, { id: 'c5', name: '路人' } ];
      const E = [ { from: 'c1', to: 'c2', type: '暗恋' }, { from: 'c2', to: 'c3', type: '闺蜜' } ];
      const L1 = T.layoutGraph(G, E, 320, 220);
      const L2 = T.layoutGraph(G, E, 320, 220);
      ok('布局是确定性的（同样输入，两次一模一样）', JSON.stringify(L1) === JSON.stringify(L2));
      ok('每个角色都有位置', G.every((c) => L1[c.id] && typeof L1[c.id].x === 'number' && typeof L1[c.id].y === 'number'));
      ok('都在画布范围内', G.every((c) => L1[c.id].x >= 0 && L1[c.id].x <= 320 && L1[c.id].y >= 0 && L1[c.id].y <= 220));
      const dist = (p, q) => Math.sqrt((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y));
      const minPair = (() => {
        let mn = Infinity;
        for (let i = 0; i < G.length; i += 1) for (let j = i + 1; j < G.length; j += 1) mn = Math.min(mn, dist(L1[G[i].id], L1[G[j].id]));
        return mn;
      })();
      ok('圆点不叠在一起（留了最小间距）', minPair >= T.NODE_R * 2, `最近两点 ${minPair.toFixed(1)}px（圆点直径 ${T.NODE_R * 2}）`);
      const edgeLen = E.map((r) => dist(L1[r.from], L1[r.to]));
      const nonEdgeLen = [];
      for (let i = 0; i < G.length; i += 1) for (let j = i + 1; j < G.length; j += 1) {
        const pair = G[i].id + '>' + G[j].id;
        const has = E.some((r) => r.from + '>' + r.to === pair || r.to + '>' + r.from === pair);
        if (!has) nonEdgeLen.push(dist(L1[G[i].id], L1[G[j].id]));
      }
      const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
      ok('有关系的比没关系平均更近（这才叫"按亲疏摆位"）', avg(edgeLen) < avg(nonEdgeLen), `${avg(edgeLen).toFixed(1)} < ${avg(nonEdgeLen).toFixed(1)}`);
      ok('一个关系都没有时退回摆圈（不会全挤成一坨）', (() => {
        const R = T.layoutGraph(G, [], 320, 220);
        const ds = [];
        for (let i = 0; i < G.length; i += 1) for (let j = i + 1; j < G.length; j += 1) ds.push(dist(R[G[i].id], R[G[j].id]));
        return Math.min.apply(null, ds) > T.NODE_R * 2;
      })());
      ok('只有一个角色也能画（在正中间）', (() => {
        const one = T.layoutGraph([{ id: 'c1', name: '苏晚' }], [], 320, 220);
        return one.c1.x === 160 && one.c1.y === 110;
      })());
      ok('关系指向不存在的角色也不炸', (() => {
        const bad = T.layoutGraph(G, [{ from: 'c1', to: '不存在' }], 320, 220);
        return G.every((c) => bad[c.id]);
      })());
    }

    // ── 删掉一本 ──
    click(byClass(t, 'dn_bookrow').find((n) => hasClass(n, 'pick')))
    t = await settle(p.rt, p.Panel, { visible: true })
    const 要删的行 = byClass(t, 'dn_swrow').find((n) => textOf(n).indexOf(改名后) >= 0)
    click(findAll(要删的行, (n) => n.type === 'button' && textOf(n) === '🗑️')[0])
    t = await settle(p.rt, p.Panel, { visible: true })
    ok('删除后说了去回收站', treeText(t).indexOf('回收站') >= 0, treeText(byClass(t, 'dn_ok2')[0] || {}).slice(0, 26))
    ok('原目录不见了', !fs.existsSync(path.join(ROOT, 改名后)))
    // 注意：回收站提示里本来就会带书名，所以只查"列表行里有没有"
    ok(
      '列表行里也没了',
      byClass(t, 'dn_swrow').every((r) => textOf(r).indexOf(改名后) < 0),
      byClass(t, 'dn_swrow').map((r) => textOf(r).slice(0, 8)).join(' | ')
    )
    ok('回收站里有（能捞回来）', fs.existsSync(path.join(ROOT, '.dsh-novel-trash')))
    ok('回收站不被当成一本小说', byClass(t, 'dn_swrow').every((r) => textOf(r).indexOf('.dsh-novel-trash') < 0))
    ok('记忆也清干净了（不会下次提示"不在了"）', String(store.get('dsh-novel:library')).indexOf(改名后) < 0)

    delete globalThis.localStorage
  }

  console.log('\n── 21. 新章节 / 改正文 / 一键迁移 / 导出设定集 / 头像 ──')
  {
    // 造两部干净的书：一部新格式（用来写），一部老格式（用来迁移）
    const NEW2 = '__自测新格式2__'
    const OLD2 = '__自测老格式2__'
    fs.mkdirSync(path.join(ROOT, NEW2, 'chapters'), { recursive: true })
    for (const f of ['大纲.txt', '世界观.txt', '人物卡.txt']) {
      fs.writeFileSync(path.join(ROOT, NEW2, f), '占位\n', 'utf8')
    }
    fs.writeFileSync(
      path.join(ROOT, NEW2, '角色.json'),
      JSON.stringify({ version: 1, characters: [], relations: [] }),
      'utf8'
    )
    fs.writeFileSync(path.join(ROOT, NEW2, 'chapters', '第001章-开头.txt'), '第1章 开头\n\n原来的正文\n', 'utf8')

    fs.mkdirSync(path.join(ROOT, OLD2, 'chapters'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, OLD2, 'outline.md'), '# 老大纲\n\n**粗体**\n', 'utf8')
    fs.writeFileSync(path.join(ROOT, OLD2, 'world.md'), '# 老世界观\n', 'utf8')
    fs.writeFileSync(path.join(ROOT, OLD2, 'chapters', '第001章-甲.md'), '# 第1章 甲\n\n**正文甲**\n', 'utf8')

    const p = await freshPanel()
    let t = p.tree
    const props21 = { visible: true }

    // ── 新建空章节 ──
    t = await pickNovel(p.rt, p.Panel, props21, t, NEW2)
    click(findAll(t, (n) => n.type === 'button' && textOf(n).indexOf('章节') === 0)[0])
    t = await settle(p.rt, p.Panel, props21)
    ok('章节页有「＋ 新章节」', !!btn(t, '新章节'))
    click(btn(t, '新章节'))
    t = await settle(p.rt, p.Panel, props21)
    ok('出现新建章节的输入行', byClass(t, 'dn_chrename').length === 1)
    const 新章名 = findAll(byClass(t, 'dn_chrename')[0], (n) => n.type === 'input')[0]
    setValue(新章名, '契约')
    t = await settle(p.rt, p.Panel, props21)
    click(btn(t, '创建'))
    t = await settle(p.rt, p.Panel, props21)
    ok('磁盘上建出来了', fs.existsSync(path.join(ROOT, NEW2, 'chapters', '第002章-契约.txt')))
    ok('建完提示了', treeText(t).indexOf('已新建') >= 0, treeText(byClass(t, 'dn_ok2')[0] || {}).slice(0, 20))
    ok('建完直接进编辑态', byType(t, 'textarea').length >= 1)

    // ── 直接改正文 ──
    const ta = byType(t, 'textarea')[0]
    ok('编辑框里是空章节骨架', String(ta.props.value).indexOf('第2章 契约') >= 0, String(ta.props.value).slice(0, 14))
    setValue(ta, '第2章 契约\n\n「绝对不许当真。」她写下这行字的时候，我在旁边看着。\n')
    t = await settle(p.rt, p.Panel, props21)
    click(btn(t, '保存正文'))
    t = await settle(p.rt, p.Panel, props21)
    const saved = fs.readFileSync(path.join(ROOT, NEW2, 'chapters', '第002章-契约.txt'), 'utf8')
    ok('正文真写进磁盘了', saved.indexOf('绝对不许当真') >= 0, JSON.stringify(saved.slice(0, 16)))
    ok('保存后回到只读预览', byType(t, 'pre').length >= 1)
    ok('保存提示说了已保存', treeText(t).indexOf('已保存') >= 0, treeText(byClass(t, 'dn_ok2')[0] || {}).slice(0, 22))

    // ── 一键迁移（老格式的书） ──
    t = await pickNovel(p.rt, p.Panel, props21, t, OLD2)
    click(findAll(t, (n) => n.type === 'button' && textOf(n).indexOf('设定') === 0)[0])
    t = await settle(p.rt, p.Panel, props21)
    ok('老格式的书显示「转成新格式」', !!btn(t, '转成新格式'))
    ok('也提示了这是老格式', treeText(t).indexOf('还是老格式') >= 0)
    click(btn(t, '转成新格式'))
    t = await settle(p.rt, p.Panel, props21)
    ok('迁移后有成功提示', treeText(t).indexOf('已转换') >= 0, treeText(byClass(t, 'dn_ok2')[0] || {}).slice(0, 22))
    ok('大纲.txt 出现了', fs.existsSync(path.join(ROOT, OLD2, '大纲.txt')))
    ok('原件进了备份目录', fs.existsSync(path.join(ROOT, OLD2, '_旧格式备份', 'outline.md')))
    ok('章节也转了', fs.existsSync(path.join(ROOT, OLD2, 'chapters', '第001章-甲.txt')))
    ok('转完按钮就消失了', !btn(t, '转成新格式'))

    // ── 导出：点「⬇ 导出」先展开三种格式，选了才真的导 ──
    ok('设定页有「导出」按钮', !!btn(t, '导出'))
    ok('没点之前不显示格式', !btn(t, 'EPUB'))
    click(btn(t, '导出'))
    t = await settle(p.rt, p.Panel, props21)
    ok('展开后有三种格式', !!btn(t, '设定集.txt') && !!btn(t, 'EPUB') && !!btn(t, 'Word'))
    click(btn(t, '设定集.txt'))
    t = await settle(p.rt, p.Panel, props21)
    ok('导出后有提示', treeText(t).indexOf('已导出') >= 0, treeText(byClass(t, 'dn_ok2')[0] || {}).slice(0, 22))
    ok('设定集.txt 真生成了', fs.existsSync(path.join(ROOT, OLD2, '设定集.txt')))
    ok('设定集里有章节清单', fs.readFileSync(path.join(ROOT, OLD2, '设定集.txt'), 'utf8').indexOf('四、章节清单') >= 0)

    // ── 导出 EPUB / Word：要真的落盘，而且是 ZIP 签名 ──
    click(btn(t, '导出'))
    t = await settle(p.rt, p.Panel, props21)
    click(btn(t, 'EPUB'))
    t = await settle(p.rt, p.Panel, props21)
    const epubFile = path.join(ROOT, OLD2, OLD2 + '.epub')
    ok('EPUB 落盘了', fs.existsSync(epubFile), epubFile)
    ok(
      'EPUB 是 ZIP（PK 开头），而且能直接搜到 mimetype 原文（store 没压缩）',
      fs.existsSync(epubFile) &&
        fs.readFileSync(epubFile).subarray(0, 2).toString('utf8') === 'PK' &&
        fs.readFileSync(epubFile).includes('application/epub+zip')
    )
    click(btn(t, '导出'))
    t = await settle(p.rt, p.Panel, props21)
    click(btn(t, 'Word'))
    t = await settle(p.rt, p.Panel, props21)
    const docxFile = path.join(ROOT, OLD2, OLD2 + '.docx')
    ok('Word 落盘了且是 ZIP', fs.existsSync(docxFile) && fs.readFileSync(docxFile).subarray(0, 2).toString('utf8') === 'PK', docxFile)

    // ── 角色头像 ──
    t = await pickNovel(p.rt, p.Panel, props21, t, NEW2)
    click(findAll(t, (n) => n.type === 'button' && textOf(n).indexOf('角色') === 0)[0])
    t = await settle(p.rt, p.Panel, props21)
    click(btn(t, '新角色'))
    t = await settle(p.rt, p.Panel, props21)
    const avatarLabel = '头像（没有图片时用：1~4 个字符 / emoji）';
    ok('角色编辑里有头像字段', !!fieldBox(t, avatarLabel))
    setValue(fieldBox(t, '名字'), '苏晚')
    t = await settle(p.rt, p.Panel, props21)
    setValue(fieldBox(t, avatarLabel), '🖋️')
    t = await settle(p.rt, p.Panel, props21)
    ok('角色列表行显示了头像', treeText(byClass(t, 'dn_rows')[0]).indexOf('🖋️') >= 0, treeText(byClass(t, 'dn_rows')[0]).slice(0, 12))
    // 只有 1 个角色时，不该摆一个只能选自己的关系表单 —— 而要说明差什么
    ok(
      '只有 1 个角色时不摆关系表单，而是说明差什么',
      !btn(t, '添加关系') && treeText(t).indexOf('现在只有 1 个') >= 0,
      treeText(t).slice(-70)
    )
    // 只有 1 个角色时关系图不画（画不出线），所以再加一个
    click(btn(t, '新角色'))
    t = await settle(p.rt, p.Panel, props21)
    setValue(fieldBox(t, '名字'), '林知夏')
    t = await settle(p.rt, p.Panel, props21)
    {
      const texts = findAll(byClass(t, 'dn_graph')[0], (n) => n.type === 'text')
      ok('关系图圆点里画的是头像', texts.some((n) => textOf(n) === '🖋️'), texts.map(textOf).slice(0, 5).join('|'))
    }
    // 有 2 个人了 → 关系表单出现，而且不能选自己当关系对象
    {
      ok('有 2 个角色了，关系表单出现', !!btn(t, '添加关系'))
      const sels = findAll(byClass(t, 'dn_addrel')[0], (n) => n.type === 'select')
      ok('关系表单有「从」「到」两个下拉', sels.length === 2, String(sels.length))
      setValue(sels[0], 'c1')
      t = await settle(p.rt, p.Panel, props21)
      const sels2 = findAll(byClass(t, 'dn_addrel')[0], (n) => n.type === 'select')
      const toVals = findAll(sels2[1], (n) => n.type === 'option').map((o) => o.props.value)
      ok('「到」里不列刚选的「从」（不能自己对自己）', !toVals.includes('c1'), toVals.join(','))
      ok('「到」里有另一个人', toVals.includes('c2'), toVals.join(','))
    }
    // ── 分档：路人也进表，放「不重要」那一档（用户的明确要求） ──
    {
      ok('角色列表按分档分组（有「重要」小节）', treeText(t).indexOf('重要（2）') >= 0, treeText(byClass(t, 'dn_rows')[0] || {}).slice(0, 30))
      click(btn(t, '新角色'))
      t = await settle(p.rt, p.Panel, props21)
      setValue(fieldBox(t, '名字'), '店长')
      t = await settle(p.rt, p.Panel, props21)
      ok('编辑区有「分档」下拉', !!fieldBox(t, '分档'))
      setValue(fieldBox(t, '定位'), '路人')
      t = await settle(p.rt, p.Panel, props21)
      setValue(fieldBox(t, '分档'), '不重要')
      t = await settle(p.rt, p.Panel, props21)
      const all = treeText(t)
      ok('列表里出现「不重要」小节', all.indexOf('不重要 —— 路人 / 龙套等（1）') >= 0, all.slice(all.indexOf('重要', all.indexOf('dn_rows') >= 0 ? 0 : 0)).slice(0, 40))
      ok('路人在「不重要」那一节里', all.indexOf('不重要 —— 路人') < all.indexOf('店长', all.indexOf('不重要 —— 路人')))
    }
    click(btn(t, '保存角色表'))
    t = await settle(p.rt, p.Panel, props21)
    const castJson = JSON.parse(fs.readFileSync(path.join(ROOT, NEW2, '角色.json'), 'utf8'))
    ok('头像存进了 角色.json', castJson.characters[0].avatar === '🖋️', JSON.stringify(castJson.characters[0]))
    ok('人物卡.txt 里也带头像', fs.readFileSync(path.join(ROOT, NEW2, '人物卡.txt'), 'utf8').indexOf('【🖋️ 苏晚】') >= 0)
    {
      const card = fs.readFileSync(path.join(ROOT, NEW2, '人物卡.txt'), 'utf8')
      ok('人物卡.txt 按分档分了两节', card.indexOf('════ 重要角色（2）════') >= 0 && card.indexOf('════ 不重要') >= 0, card.split('\n').filter((l) => l.startsWith('════')).join(' | '))
      ok('路人写进了人物卡，身份也标了', card.indexOf('【店长】 路人') >= 0)
      const after = card.split('════ 不重要')[1] || ''
      ok('路人确实在不重要那一节里', after.indexOf('【店长】') >= 0 && after.indexOf('【苏晚】') < 0)
    }

    // ── 图片头像：点「换图片头像」→（桩出来的）选图 → 读成 dataURL 交给宿主存盘 ──
    {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
      const dataUrl = 'data:image/png;base64,' + png.toString('base64');
      // 面板会自己建 <style> 和 <input type=file>，所以这个桩要能同时装成两种
      globalThis.document = {
        head: { appendChild() {} },
        createElement(tag) {
          // 面板注入样式时会 createElement('style') + setAttribute + head.appendChild，
          // 所以这个桩要装得像一点（不然一渲染就炸）
          if (tag === 'style') return { textContent: '', setAttribute() {} };
          return {
            type: '',
            accept: '',
            onchange: null,
            files: [{ name: 'a.png' }],
            click() {
              if (this.onchange) this.onchange();
            }
          };
        }
      };
      globalThis.FileReader = class {
        readAsDataURL() {
          this.result = dataUrl;
          if (this.onload) this.onload();
        }
      };

      ok('编辑区有「换图片头像」按钮', !!btn(t, '换图片头像'));
      click(btn(t, '换图片头像'));
      t = await settle(p.rt, p.Panel, props21);
      const avDir = path.join(ROOT, NEW2, '头像');
      ok('图片真的落盘到 头像\\ 目录', fs.existsSync(avDir) && fs.readdirSync(avDir).length === 1, fs.existsSync(avDir) ? fs.readdirSync(avDir).join(',') : '目录不存在');
      ok('存的是原字节', fs.existsSync(avDir) && fs.readFileSync(path.join(avDir, fs.readdirSync(avDir)[0])).equals(png));
      const saved = JSON.parse(fs.readFileSync(path.join(ROOT, NEW2, '角色.json'), 'utf8'));
      const withPic = saved.characters.find((c) => c.avatarFile);
      ok('角色.json 里记的是路径（不是 base64）', !!withPic && /^头像\//.test(withPic.avatarFile), JSON.stringify(saved.characters.map((c) => [c.id, c.avatarFile])));
      ok('记的是**图片那个角色**的路径，文件名对得上', !!withPic && fs.existsSync(path.join(ROOT, NEW2, withPic.avatarFile)), withPic && withPic.avatarFile);
      t = await settle(p.rt, p.Panel, props21);
      ok('编辑区显示成 <img> 了', !!byClass(t, 'dn_avimg')[0]);
      ok('说了"用的是图片"', treeText(t).indexOf('用的是图片') >= 0);
      ok('出现了「去掉图片」', !!btn(t, '去掉图片'));

      click(btn(t, '去掉图片'));
      t = await settle(p.rt, p.Panel, props21);
      ok('去掉后图片文件删了', !fs.existsSync(avDir) || fs.readdirSync(avDir).length === 0);
      ok('回到 emoji 显示', !byClass(t, 'dn_avimg')[0] && treeText(t).indexOf('用的是字符') >= 0);
      const back = JSON.parse(fs.readFileSync(path.join(ROOT, NEW2, '角色.json'), 'utf8'));
      ok('emoji 兜底还在（没被图片顶掉）', back.characters[0].avatar === '🖋️', back.characters[0].avatar);
      delete globalThis.document;
      delete globalThis.FileReader;
    }

    // ── 卷：新建 / 往卷里加章 / 跨卷拖 / 改名 / 删卷 ──
    {
      click(findAll(t, (n) => n.type === 'button' && textOf(n).indexOf('章节') === 0)[0]);
      t = await settle(p.rt, p.Panel, props21);
      const volRows = () => byClass(t, 'dn_vol');
      ok('章节页有「＋ 新建卷」', !!btn(t, '新建卷'));
      ok('没有卷时只有「未分卷」一组', volRows().length === 1 && treeText(volRows()[0]).indexOf('未分卷') >= 0, String(volRows().length));

      click(btn(t, '新建卷'));
      t = await settle(p.rt, p.Panel, props21);
      ok('出现建卷的输入行', byClass(t, 'dn_chrename').length === 1);
      setValue(findAll(byClass(t, 'dn_chrename')[0], (n) => n.type === 'input')[0], '第一卷 恋爱练习');
      t = await settle(p.rt, p.Panel, props21);
      const volInput = findAll(byClass(t, 'dn_chrename')[0], (n) => n.type === 'input')[0];
      ok('输入框里真的有字', String(volInput.props.value) === '第一卷 恋爱练习', String(volInput.props.value));
      // ⚠️ 这里要用「创建卷」：`btn()` 是按下标/包含匹配的，「建卷」会先撞上工具栏的「＋ 新建卷」
      click(btn(t, '创建卷'));
      t = await settle(p.rt, p.Panel, props21);
      ok('建卷有提示', treeText(t).indexOf('建好') >= 0, treeText(t).slice(-90));
      ok('磁盘上多了卷目录', fs.existsSync(path.join(ROOT, NEW2, 'chapters', '第一卷 恋爱练习')));
      ok('列表里出现两行卷标题', volRows().length === 2, String(volRows().length));
      ok('空卷也显示（0 章）', treeText(volRows().find((n) => treeText(n).indexOf('第一卷') >= 0)).indexOf('0 章') >= 0);

      // 卷标题上的 ＋：往这一卷里加一章
      const volHead = () => byClass(t, 'dn_vol').find((n) => treeText(n).indexOf('第一卷 恋爱练习') >= 0);
      click(findAll(volHead(), (n) => n.type === 'button' && textOf(n) === '＋')[0]);
      t = await settle(p.rt, p.Panel, props21);
      ok('提示了要放进哪一卷', treeText(t).indexOf('放进「第一卷 恋爱练习」') >= 0);
      setValue(findAll(byClass(t, 'dn_chrename')[0], (n) => n.type === 'input')[0], '卷里的第一章');
      t = await settle(p.rt, p.Panel, props21);
      click(btn(t, '创建'));
      t = await settle(p.rt, p.Panel, props21);
      ok('建完提示里带卷名', treeText(t).indexOf('第一卷 恋爱练习') >= 0);
      const volDir = path.join(ROOT, NEW2, 'chapters', '第一卷 恋爱练习');
      ok('文件真的落在卷目录里', fs.readdirSync(volDir).some((f) => f.indexOf('卷里的第一章') >= 0), fs.readdirSync(volDir).join(','));
      ok('卷标题上变成 1 章', treeText(volHead()).indexOf('1 章') >= 0);
      ok(
        '卷里新建的章也直接进了编辑态（骨架不为空）',
        byType(t, 'textarea').length >= 1 && String(byType(t, 'textarea')[0].props.value).indexOf('第') === 0,
        byType(t, 'textarea').length ? String(byType(t, 'textarea')[0].props.value).slice(0, 12) : '(没有 textarea)'
      );

      // 跨卷拖：把平铺的章节拖到「第一卷」标题上 = 挪进这一卷
      const items = byClass(t, 'dn_item');
      const flatIdx = items.findIndex((n) => treeText(n).indexOf('开头') >= 0);
      ok('找得到未分卷那一章', flatIdx >= 0, String(flatIdx));
      items[flatIdx].props.onPointerDown();
      t = await settle(p.rt, p.Panel, props21);
      volHead().props.onPointerEnter();
      t = await settle(p.rt, p.Panel, props21);
      ok('卷标题成了落点（有 over 标记）', byClass(t, 'dn_vol').some((n) => hasClass(n, 'over')));
      volHead().props.onPointerUp();
      t = await settle(p.rt, p.Panel, props21);
      ok('拖完提示挪进了哪一卷', treeText(t).indexOf('已挪进「第一卷 恋爱练习」') >= 0, treeText(byClass(t, 'dn_ok2')[0] || {}).slice(0, 26));
      ok('文件真的从平铺挪进了卷目录', fs.readdirSync(volDir).some((f) => f.indexOf('开头') >= 0), fs.readdirSync(volDir).join(','));
      ok('平铺目录里没有那一章了', !fs.readdirSync(path.join(ROOT, NEW2, 'chapters')).some((f) => f.indexOf('开头') >= 0));

      // 卷改名 / 删卷：面板用的是系统 prompt / confirm，测试里桩掉
      globalThis.prompt = () => '第二卷 中段';
      click(findAll(volHead(), (n) => n.type === 'button' && textOf(n) === '🖊')[0]);
      t = await settle(p.rt, p.Panel, props21);
      ok('卷目录改名了', fs.existsSync(path.join(ROOT, NEW2, 'chapters', '第二卷 中段')));
      ok('旧卷目录没了', !fs.existsSync(volDir));
      ok('里面的章节跟着走', fs.readdirSync(path.join(ROOT, NEW2, 'chapters', '第二卷 中段')).length === 2, String(fs.readdirSync(path.join(ROOT, NEW2, 'chapters', '第二卷 中段')).length));
      ok('列表里是新卷名', treeText(t).indexOf('第二卷 中段') >= 0);

      globalThis.confirm = () => true;
      const renHead = () => byClass(t, 'dn_vol').find((n) => treeText(n).indexOf('第二卷 中段') >= 0);
      click(findAll(renHead(), (n) => n.type === 'button' && textOf(n) === '🗑️')[0]);
      t = await settle(p.rt, p.Panel, props21);
      ok('删卷有提示（说了是可恢复的）', treeText(t).indexOf('整卷进了回收站') >= 0, treeText(byClass(t, 'dn_ok2')[0] || {}).slice(0, 24));
      ok('卷目录没了', !fs.existsSync(path.join(ROOT, NEW2, 'chapters', '第二卷 中段')));
      const trash = path.join(ROOT, '.dsh-novel-trash');
      ok(
        '回收站里能找回整卷（章节都在里面）',
        fs.existsSync(trash) &&
          fs.readdirSync(trash).some(
            (d) => d.indexOf('第二卷 中段') >= 0 && fs.readdirSync(path.join(trash, d)).some((f) => /\.txt$/.test(f))
          )
      );
      ok('卷没了，列表回到只有未分卷', byClass(t, 'dn_vol').length === 1, String(byClass(t, 'dn_vol').length));
      delete globalThis.prompt;
      delete globalThis.confirm;
    }

    // ── 只有一本小说时，书名那一行也必须能点（小说库里还有改名/删除） ──
    //    用户就是这么被卡住的："书名这一行是改不了的"
    {
      const SOLO = path.join(os.tmpdir(), 'dsh-novel-solo-' + Date.now());
      fs.mkdirSync(path.join(SOLO, '唯一一本', 'chapters'), { recursive: true });
      fs.writeFileSync(path.join(SOLO, '唯一一本', '大纲.txt'), '占位\n', 'utf8');
      fs.writeFileSync(path.join(SOLO, '唯一一本', 'chapters', '第001章-甲.txt'), '第1章 甲\n\n正文\n', 'utf8');
      const prevRoot = process.env.DSH_NOVEL_ROOT;
      process.env.DSH_NOVEL_ROOT = SOLO;
      click(btn(t, '刷新'));
      t = await settle(p.rt, p.Panel, props21);
      const row = byClass(t, 'dn_bookrow')[0];
      ok('只有一本时，书名行也是可点的按钮', !!row && hasClass(row, 'pick') && typeof row.props.onClick === 'function');
      ok('只有一本也显示 ▾（暗示能点开）', treeText(row).indexOf('▾') >= 0, treeText(row));
      click(row);
      t = await settle(p.rt, p.Panel, props21);
      ok('点开就是小说库（改名 / 删除都在里面）', treeText(t).indexOf('小说库') >= 0 && byClass(t, 'dn_swrow').length >= 1, treeText(t).slice(0, 50));
      // 收回原来的根目录，别影响后面的清理
      click(row);
      t = await settle(p.rt, p.Panel, props21);
      process.env.DSH_NOVEL_ROOT = prevRoot;
      fs.rmSync(SOLO, { recursive: true, force: true });
    }
  }
} finally {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  console.log('\n🧹 已清理临时小说根目录')
  ok('临时根目录删干净了', !fs.existsSync(ROOT))
}

console.log(failed === 0 ? '\n✅ 客户端半验证通过（面板真读写链路 OK）' : `\n❌ 有 ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
