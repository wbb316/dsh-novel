/**
 * 本地验证「小说库」——记住"打开哪本 / 每本读到哪"的纯逻辑。
 *
 * 这些函数住在客户端半里（lib/client.js 的 exports.__test）——
 * 因为客户端半不能 import 自己的文件，所以只能这样给测试开后门。
 * 这里喂假 localStorage，不碰浏览器、不碰 DSH、不占端口。
 *
 * 跑法：  cd D:\dsh\plugins\dsh-novel-plugin ; node test-library.mjs
 */
import fs from 'node:fs'

let failed = 0
function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

// ── 假 localStorage + 假 ModuleLoader，把客户端半跑起来 ──
let loaded = null
globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }

const store = new Map()
let failWrites = false
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (failWrites) throw new Error('quota exceeded')
    store.set(k, String(v))
  },
  removeItem: (k) => store.delete(k)
}

const fakeReact = { createElement: () => null, useState: () => [null, () => {}] }
new Function(fs.readFileSync('./lib/client.js', 'utf8'))()
const m = loaded.factory((n) => {
  if (n === 'react') return fakeReact
  throw new Error('意外的 require: ' + n)
})
const T = m.__test

ok('客户端半把 __test 挂出来了', !!T, T ? Object.keys(T).join(', ') : '(没有)')

const ROOT_A = 'D:\\dsh-novel'
const ROOT_B = 'E:\\另一个库'
const A = ['学妹这只是练习而已', '老项目', '第三部']

console.log('\n── 1. 空库 / 坏数据都不炸 ──')
{
  ok(
    '空库 → 空记录',
    JSON.stringify(T.libRecord({}, ROOT_A)) === '{"open":"","recent":[],"seen":{},"pos":{}}',
    JSON.stringify(T.libRecord({}, ROOT_A))
  )
  ok('null 也不炸', T.libRecord(null, ROOT_A).open === '')
  ok('记录是数组（坏数据）→ 空记录', T.libRecord({ [ROOT_A]: [1, 2] }, ROOT_A).open === '')
  ok('recent 里有非字符串 → 过滤掉', T.libRecord({ [ROOT_A]: { recent: ['a', 1, null, 'b'] } }, ROOT_A).recent.join(',') === 'a,b')
  ok('seen 是数组 → 当空', JSON.stringify(T.libRecord({ [ROOT_A]: { seen: [] } }, ROOT_A).seen) === '{}')
  ok('没有根目录 → 空记录', T.libRecord({ [ROOT_A]: { open: 'x' } }, '').open === '')
}

console.log('\n── 2. chooseOpen：记住的 → recent → 第一本 ──')
{
  const empty = T.libRecord({}, ROOT_A)
  ok('第一次进库 → 第一本', T.chooseOpen(empty, A).name === A[0] && T.chooseOpen(empty, A).source === 'fresh')

  const remembered = T.libRecord({ [ROOT_A]: { open: '第三部', recent: ['第三部'] } }, ROOT_A)
  ok('记住的还在 → 就用它', T.chooseOpen(remembered, A).name === '第三部')
  ok('source=remembered', T.chooseOpen(remembered, A).source === 'remembered')

  const gone = T.libRecord({ [ROOT_A]: { open: '被删掉的书', recent: ['被删掉的书', '老项目'] } }, ROOT_A)
  ok('记住的没了 → 回落 recent 里还在的', T.chooseOpen(gone, A).name === '老项目')
  ok('source=vanished（要提示用户）', T.chooseOpen(gone, A).source === 'vanished')

  const goneAll = T.libRecord({ [ROOT_A]: { open: '没了', recent: ['也没了'] } }, ROOT_A)
  ok('记忆全没了 → 第一本，source 仍是 vanished', T.chooseOpen(goneAll, A).name === A[0] && T.chooseOpen(goneAll, A).source === 'vanished')

  ok('一本小说都没有 → empty', T.chooseOpen(empty, []).name === null && T.chooseOpen(empty, []).source === 'empty')
}

console.log('\n── 3. rememberOpen：推进"最近打开"，且没变就不产生新对象 ──')
{
  let lib = {}
  lib = T.rememberOpen(lib, ROOT_A, '老项目')
  ok('第一次记下 open', T.libRecord(lib, ROOT_A).open === '老项目')
  ok('recent 里排第一', T.libRecord(lib, ROOT_A).recent[0] === '老项目')

  lib = T.rememberOpen(lib, ROOT_A, '第三部')
  ok('换一本后 open 变了', T.libRecord(lib, ROOT_A).open === '第三部')
  ok('recent 是最近在前', T.libRecord(lib, ROOT_A).recent.join(',') === '第三部,老项目')

  lib = T.rememberOpen(lib, ROOT_A, '老项目')
  ok('再切回去，不重复（去重）', T.libRecord(lib, ROOT_A).recent.join(',') === '老项目,第三部')

  const same = T.rememberOpen(lib, ROOT_A, '老项目')
  ok('没变化时返回原对象（省一次重渲染）', same === lib)

  ok('没有 root 时原样返回', T.rememberOpen(lib, '', 'x') === lib)

  // recent 上限
  let many = {}
  for (let i = 0; i < T.RECENT_CAP + 5; i += 1) many = T.rememberOpen(many, ROOT_A, '书' + i)
  ok('recent 有上限（' + T.RECENT_CAP + '）', T.libRecord(many, ROOT_A).recent.length === T.RECENT_CAP, String(T.libRecord(many, ROOT_A).recent.length))
  ok('最新那本在最前', T.libRecord(many, ROOT_A).recent[0] === '书' + (T.RECENT_CAP + 4))
}

console.log('\n── 4. rememberSeen：记住每本读到哪 ──')
{
  let lib = {}
  lib = T.rememberSeen(lib, ROOT_A, '第三部', 'chapters', '第003章-又一章.txt')
  ok('记下了', JSON.stringify(T.seenOf(T.libRecord(lib, ROOT_A), '第三部')) === '{"view":"chapters","file":"第003章-又一章.txt"}')

  lib = T.rememberSeen(lib, ROOT_A, '老项目', 'settings', '大纲.txt')
  ok('两本互不干扰', T.seenOf(T.libRecord(lib, ROOT_A), '老项目').file === '大纲.txt')
  ok('第一本还在', T.seenOf(T.libRecord(lib, ROOT_A), '第三部').file === '第003章-又一章.txt')

  const same = T.rememberSeen(lib, ROOT_A, '老项目', 'settings', '大纲.txt')
  ok('没变化时返回原对象', same === lib)

  ok('没见过的书 → null', T.seenOf(T.libRecord(lib, ROOT_A), '不存在的书') === null)
  ok('没有 root / 没有书名 → 原样返回', T.rememberSeen(lib, '', 'x', 'chapters', 'y') === lib && T.rememberSeen(lib, ROOT_A, '', 'chapters', 'y') === lib)
}

console.log('\n── 5. 按小说库分组：切库不串 ──')
{
  let lib = {}
  lib = T.rememberOpen(lib, ROOT_A, '第三部')
  lib = T.rememberOpen(lib, ROOT_B, '另一库的书')
  lib = T.rememberSeen(lib, ROOT_A, '第三部', 'chapters', '第003章-又一章.txt')
  lib = T.rememberSeen(lib, ROOT_B, '另一库的书', 'chapters', '第001章-开头.txt')

  ok('A 库记的是 A 的', T.libRecord(lib, ROOT_A).open === '第三部')
  ok('B 库记的是 B 的', T.libRecord(lib, ROOT_B).open === '另一库的书')
  ok('A 库的 seen 不串到 B', T.seenOf(T.libRecord(lib, ROOT_B), '第三部') === null)
  ok('两个库都在', Object.keys(lib).length === 2)
}

console.log('\n── 6. 落盘 / 读回 / 坏数据 / 存不进去 ──')
{
  let lib = {}
  lib = T.rememberOpen(lib, ROOT_A, '第三部')
  lib = T.rememberSeen(lib, ROOT_A, '第三部', 'chapters', '第003章-又一章.txt')
  T.writeLibrary(lib)

  ok('写进去了', store.get(T.LIBRARY_KEY).indexOf('第三部') >= 0)
  const back = T.readLibrary()
  ok('读回来一模一样', JSON.stringify(back) === JSON.stringify(lib))
  ok('读回来的能直接用', T.chooseOpen(T.libRecord(back, ROOT_A), A).name === '第三部')
  ok('读回来的 seen 也在', T.seenOf(T.libRecord(back, ROOT_A), '第三部').file === '第003章-又一章.txt')

  store.set(T.LIBRARY_KEY, '{ 这不是 json')
  ok('坏 JSON → 当空库', JSON.stringify(T.readLibrary()) === '{}')
  store.set(T.LIBRARY_KEY, '[1,2,3]')
  ok('顶层是数组 → 当空库', JSON.stringify(T.readLibrary()) === '{}')
  store.set(T.LIBRARY_KEY, '"字符串"')
  ok('顶层是字符串 → 当空库', JSON.stringify(T.readLibrary()) === '{}')

  failWrites = true
  let threw = ''
  try {
    T.writeLibrary({ x: 1 })
  } catch (e) {
    threw = String(e.message)
  }
  ok('存不进去也不抛错（配额满了照样能用）', threw === '')
  failWrites = false

  delete globalThis.localStorage
  ok('连 localStorage 都没有也不炸', JSON.stringify(T.readLibrary()) === '{}')
  let threw2 = ''
  try {
    T.writeLibrary({ x: 1 })
  } catch (e) {
    threw2 = String(e.message)
  }
  ok('没 localStorage 时 writeLibrary 也不抛', threw2 === '')
}

console.log('\n── 7. 改名 / 删除 / 图位置的记忆收拾（v0.8 新增） ──')
{
  let lib = {}
  lib = T.rememberOpen(lib, ROOT_A, '书A')
  lib = T.rememberSeen(lib, ROOT_A, '书A', 'chapters', '第1章.txt')
  lib = T.setGraphPos(lib, ROOT_A, '书A', 'c1', 100, 50)
  lib = T.rememberOpen(lib, ROOT_A, '书B')

  const renamed = T.renameInLib(lib, ROOT_A, '书A', '书C')
  const rec1 = T.libRecord(renamed, ROOT_A)
  ok('改名后 open 不动（本来开的是 B）', rec1.open === '书B')
  ok('recent 里的旧名换成新名', rec1.recent.indexOf('书C') >= 0 && rec1.recent.indexOf('书A') < 0, rec1.recent.join(','))
  ok('seen 跟着搬', T.seenOf(rec1, '书C') && T.seenOf(rec1, '书C').file === '第1章.txt')
  ok('旧名的 seen 清掉了', T.seenOf(rec1, '书A') === null)
  ok('图位置也跟着搬', T.graphPosOf(rec1, '书C').c1.x === 100, JSON.stringify(T.graphPosOf(rec1, '书C')))
  ok('没变化时原样返回', T.renameInLib(lib, ROOT_A, '书A', '书A') === lib)

  // 打开的那本被删 → open 清空（下次就不会提示"上次打开的不在了"）
  const forgot = T.forgetNovel(lib, ROOT_A, '书B')
  const rec2 = T.libRecord(forgot, ROOT_A)
  ok('删掉正在打开的 → open 清空', rec2.open === '', JSON.stringify(rec2.open))
  ok('recent 里也去掉了', rec2.recent.indexOf('书B') < 0, rec2.recent.join(','))

  const forgotA = T.forgetNovel(lib, ROOT_A, '书A')
  const rec3 = T.libRecord(forgotA, ROOT_A)
  ok('删掉别的本：open 不受影响', rec3.open === '书B')
  ok('它的 seen 清掉了', T.seenOf(rec3, '书A') === null)
  ok('它的图位置也清掉了', Object.keys(T.graphPosOf(rec3, '书A')).length === 0)
  ok('没记过的那本：原样返回', T.forgetNovel(lib, ROOT_A, '没这本书') === lib)
}

console.log('\n── 8. 图位置（拖出来的坐标） ──')
{
  let lib = {}
  ok('没拖过 → 空对象', JSON.stringify(T.graphPosOf(T.libRecord(lib, ROOT_A), '书A')) === '{}')
  lib = T.setGraphPos(lib, ROOT_A, '书A', 'c1', 100.6, 50.4)
  ok('坐标取整存', JSON.stringify(T.graphPosOf(T.libRecord(lib, ROOT_A), '书A')) === '{"c1":{"x":101,"y":50}}', JSON.stringify(T.graphPosOf(T.libRecord(lib, ROOT_A), '书A')))
  const same = T.setGraphPos(lib, ROOT_A, '书A', 'c1', 101, 50)
  ok('没变化时原样返回', same === lib)
  lib = T.setGraphPos(lib, ROOT_A, '书A', 'c2', 10, 20)
  ok('另一个角色也记上', Object.keys(T.graphPosOf(T.libRecord(lib, ROOT_A), '书A')).length === 2)
  ok('别的书不受影响', JSON.stringify(T.graphPosOf(T.libRecord(lib, ROOT_A), '书B')) === '{}')

  const cleared = T.clearGraphPos(lib, ROOT_A, '书A')
  ok('清掉后回到空', JSON.stringify(T.graphPosOf(T.libRecord(cleared, ROOT_A), '书A')) === '{}')
  ok('本来就没有 → 原样返回', T.clearGraphPos(cleared, ROOT_A, '书A') === cleared)
  ok('脏坐标不炸（传字符串）', T.graphPosOf(T.libRecord(T.setGraphPos({}, ROOT_A, '书A', 'c1', 'abc', null), ROOT_A), '书A').c1.x === 0)
}

console.log('\n── 9. 排序 / 时间文案 / 章节名 ──')
{
  const now = Date.now()
  const novels = [
    { name: 'B 本', chapterCount: 1, cast: { characters: 0 }, chapters: [{ mtime: now - 86400000 * 3 }] },
    { name: 'A 本', chapterCount: 2, cast: { characters: 3 }, chapters: [{ mtime: now - 60000 }, { mtime: now - 1000 }] },
    { name: 'C 本', chapterCount: 0, cast: { characters: 0 }, chapters: [] }
  ]
  const rec = T.libRecord({ [ROOT_A]: { open: 'C 本', recent: ['C 本', 'B 本'] } }, ROOT_A)

  ok('默认按"最近在写"排', T.sortNovels(novels, 'recent-write', rec).map((n) => n.name).join(',') === 'A 本,B 本,C 本')
  ok('按名称排（中文）', T.sortNovels(novels, 'name', rec).map((n) => n.name).join(',') === 'A 本,B 本,C 本')
  ok('按"最近打开"排', T.sortNovels(novels, 'recent-open', rec).map((n) => n.name).join(',') === 'C 本,B 本,A 本')
  ok('排序不改原数组', novels.map((n) => n.name).join(',') === 'B 本,A 本,C 本')

  ok('从没写过 → 还没写过', T.agoText(0) === '还没写过')
  ok('刚刚写过', T.agoText(now - 1000) === '刚刚写过')
  ok('分钟级', T.agoText(now - 5 * 60000) === '5 分钟前写过', T.agoText(now - 5 * 60000))
  ok('小时级', T.agoText(now - 2 * 3600000) === '2 小时前写过', T.agoText(now - 2 * 3600000))
  ok('天级', T.agoText(now - 3 * 86400000) === '3 天前写过', T.agoText(now - 3 * 86400000))
  ok('lastWriteOf 取最新一章', T.lastWriteOf(novels[1]) === now - 1000)
  ok('没有章节 → 0', T.lastWriteOf({ chapters: [] }) === 0)
  ok('lastWriteOf 对 undefined 安全', T.lastWriteOf(undefined) === 0)

  ok('章节名带扩展名 → 第3章 又一章', T.chapterLabel('第003章-又一章.txt') === '第3章 又一章', T.chapterLabel('第003章-又一章.txt'))
  ok('.md 也认', T.chapterLabel('第001章-开头.md') === '第1章 开头', T.chapterLabel('第001章-开头.md'))
  ok('没有章号也能显示', T.chapterLabel('大纲.txt') === '大纲', T.chapterLabel('大纲.txt'))
  ok('空值安全', T.chapterLabel('') === '' && T.chapterLabel(null) === '')
}

console.log(failed === 0 ? '\n✅ 小说库逻辑验证通过' : `\n❌ 有 ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
