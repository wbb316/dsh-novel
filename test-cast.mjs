/**
 * 本地验证「角色/关系」纯函数层（lib/cast.js）—— 不碰磁盘、不启 DSH。
 *
 * 跑法：  cd D:\dsh-novel-plugin ; node test-cast.mjs
 */
import {
  emptyCast,
  normalizeCast,
  parseCastJson,
  applyCastOps,
  renderCastText,
  resolveRef,
  castSummary,
  castTiers
} from './lib/cast.js'

let failed = 0
function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}
function throws(label, fn, mustInclude = '') {
  try {
    fn()
    ok(label, false, '（居然没抛错）')
  } catch (e) {
    const msg = String((e && e.message) || e)
    ok(label, !mustInclude || msg.includes(mustInclude), msg.slice(0, 70))
  }
}

console.log('── 1. normalizeCast：脏数据也不能炸 ──')
{
  ok('null → 空表', normalizeCast(null).cast.characters.length === 0)
  ok('数组 → 空表 + 警告', normalizeCast([1, 2]).warnings.length > 0, normalizeCast([1, 2]).warnings[0])
  ok('字符串 → 空表 + 警告', normalizeCast('x').warnings.length > 0)
  ok('emptyCast 结构对', JSON.stringify(emptyCast()) === '{"version":1,"characters":[],"relations":[]}')

  const { cast, warnings } = normalizeCast({
    characters: [
      { name: '苏晚', role: '主角', age: 17, tags: '文学社、毒舌', desc: ' 嘴硬 ' },
      { name: '', role: '主角' },
      'not-an-object',
      { id: 'c1', name: '林知夏' },
      { id: 'c1', name: '周晓' }
    ],
    relations: [
      { from: '苏晚', to: '林知夏', type: '暗恋（单向）', note: '不敢说' },
      { from: '苏晚', to: '查无此人', type: 'x' }
    ]
  })
  ok('有效角色 3 个', cast.characters.length === 3, cast.characters.map((c) => c.name + '/' + c.id).join(', '))
  ok('age 数字变字符串', cast.characters[0].age === '17', cast.characters[0].age)
  ok('tags 字符串按顿号切', cast.characters[0].tags.join('|') === '文学社|毒舌', cast.characters[0].tags.join('|'))
  ok('desc 去空白', cast.characters[0].desc === '嘴硬', JSON.stringify(cast.characters[0].desc))
  ok('重复 id 自动改', cast.characters[2].id !== 'c1', '周晓 → ' + cast.characters[2].id)
  ok('关系按名字解析成 id', cast.relations.length === 1 && cast.relations[0].from === cast.characters[0].id)
  ok('关系 to = 林知夏的 id', cast.relations[0].to === cast.characters[1].id)
  ok('指向不存在的人 → 警告', warnings.some((w) => w.includes('查无此人')), warnings.find((w) => w.includes('查无此人')))
  ok('没名字的跳过有警告', warnings.some((w) => w.includes('没有名字')))
  ok('非对象跳过有警告', warnings.some((w) => w.includes('不是对象')))
  ok('summary 对', castSummary(cast) === '3 个角色 · 1 条关系', castSummary(cast))

  // 头像（v0.9）：1~4 个字符，去空白，超长截断
  const av = normalizeCast({
    characters: [
      { name: '苏晚', avatar: '🖋️' },
      { name: '林知夏', avatar: '  夏  ' },
      { name: '周晓', avatar: '这个头像太长了会被截掉' }
    ]
  }).cast
  ok('头像存下来了', av.characters[0].avatar === '🖋️', av.characters[0].avatar)
  ok('头像去空白', av.characters[1].avatar === '夏', JSON.stringify(av.characters[1].avatar))
  ok('头像超长截断到 4 个字符', av.characters[2].avatar.length === 4, av.characters[2].avatar)
  ok('没给头像就是空串', normalizeCast({ characters: [{ name: 'x' }] }).cast.characters[0].avatar === '')
}

console.log('\n── 2. resolveRef：id 和名字都认 ──')
{
  const { cast } = normalizeCast({ characters: [{ id: 'c1', name: '苏晚' }] })
  ok('按 id', resolveRef(cast, 'c1')?.name === '苏晚')
  ok('按名字', resolveRef(cast, '苏晚')?.id === 'c1')
  ok('带空白也认', resolveRef(cast, '  苏晚 ')?.id === 'c1')
  ok('查不到返回 undefined', resolveRef(cast, '不存在') === undefined)
}

console.log('\n── 3. applyCastOps：增删改 ──')
{
  let { cast, log } = applyCastOps(emptyCast(), {
    addCharacters: [
      { name: '苏晚', role: '主角', tags: ['文学社'], desc: '高二，写悲剧' },
      { name: '林知夏', role: '配角', desc: '学妹' }
    ]
  })
  ok('加了 2 个', cast.characters.length === 2, log.join(' / '))
  ok('id 自动编号 c1/c2', cast.characters.map((c) => c.id).join(',') === 'c1,c2')
  const su = cast.characters[0].id
  const lin = cast.characters[1].id

  // 同名再加 → 变更新
  ;({ cast, log } = applyCastOps(cast, { addCharacters: [{ name: '苏晚', age: '17' }] }))
  ok('同名不重复加，改成更新', cast.characters.length === 2 && log.some((l) => l.includes('改为更新')))
  ok('更新真的生效', cast.characters[0].age === '17')

  // 按名字改
  ;({ cast, log } = applyCastOps(cast, { updateCharacters: [{ name: '林知夏', role: '主角', tags: '学妹, 转学生' }] }))
  ok('按名字改 role', cast.characters[1].role === '主角')
  ok('tags 字符串也能吃', cast.characters[1].tags.join('|') === '学妹|转学生', cast.characters[1].tags.join('|'))

  throws('改不存在的人 → 抛错并列出可选', () => applyCastOps(cast, { updateCharacters: [{ name: '查无此人', age: '1' }] }), '现有角色')

  // 关系
  ;({ cast, log } = applyCastOps(cast, {
    addRelations: [
      { from: '苏晚', to: '林知夏', type: '暗恋（单向）', note: '不敢说' },
      { from: su, to: lin, type: '同班' }
    ]
  }))
  ok('加了 2 条关系', cast.relations.length === 2, log.join(' / '))
  ;({ cast, log } = applyCastOps(cast, { addRelations: [{ from: '苏晚', to: '林知夏', type: '暗恋（单向）' }] }))
  ok('重复关系不重复加', cast.relations.length === 2 && log.some((l) => l.includes('已存在')))

  ;({ cast, log } = applyCastOps(cast, { removeRelations: [{ from: '苏晚', to: '林知夏', type: '同班' }] }))
  ok('定向删关系', cast.relations.length === 1 && cast.relations[0].type === '暗恋（单向）')

  throws('加关系指错人 → 抛错', () => applyCastOps(cast, { addRelations: [{ from: '苏晚', to: '不存在' }] }), '现有角色')

  // 删角色：连带关系
  ;({ cast, log } = applyCastOps(cast, { removeCharacters: ['林知夏'] }))
  ok('删掉角色', cast.characters.length === 1)
  ok('连带删掉相关关系', cast.relations.length === 0, log.join(' / '))
  throws('删不存在的人 → 抛错', () => applyCastOps(cast, { removeCharacters: ['查无此人'] }), '找不到要删除')
}

console.log('\n── 4. renderCastText：纯文本人物卡（记事本能直接看） ──')
{
  const { cast } = normalizeCast({
    characters: [
      { id: 'c1', name: '苏晚', role: '主角', age: '17', tags: ['文学社'], desc: '高二' },
      { id: 'c2', name: '林知夏', role: '配角', desc: '学妹' }
    ],
    relations: [{ from: 'c1', to: 'c2', type: '暗恋（单向）', note: '不敢说' }]
  })
  const txt = renderCastText(cast, { stamp: '2026-09-27 17:00' })
  ok('开头是人话标题', txt.startsWith('人物卡'), txt.slice(0, 12))
  ok('有角色小节（【】包名字）', txt.includes('【苏晚】 主角') && txt.includes('【林知夏】 配角'))
  ok('有年龄/标签/简介', txt.includes('  年龄：17') && txt.includes('  标签：文学社') && txt.includes('  简介：高二'))
  ok('角色名下有关系', txt.includes('    ・暗恋（单向） → 林知夏：不敢说'))
  ok('对方视角也有', txt.includes('    ・苏晚 → 暗恋（单向）（指向本人）：不敢说'))
  ok('有关系总表', txt.includes('关系总表') && txt.includes('  苏晚 —暗恋（单向）→ 林知夏（不敢说）'))
  ok('带同步时间', txt.includes('最后同步：2026-09-27 17:00'))
  ok('没有 markdown 记号', !/[#*`|]/.test(txt.replace(/※/g, '')), JSON.stringify(txt.match(/[#*`|]/g) || []))
  ok('说明了数据源是角色.json', txt.includes('角色.json'))

  const empty = renderCastText(emptyCast())
  ok('空表也说得清', empty.includes('还没有角色'))
  ok('空表总表写暂无', empty.includes('（暂无）'))
  ok('全是重要角色时不加小节标题（老输出不变）', !txt.includes('════ 重要角色'))
}

console.log('\n── 4b. 分档：重要 / 不重要（路人也要进表） ──')
{
  // 不写 tier 就按定位猜
  const { cast } = normalizeCast({
    characters: [
      { id: 'c1', name: '苏晚', role: '主角' },
      { id: 'c2', name: '店长', role: '路人' },
      { id: 'c3', name: '周晓', role: '配角' },
      { id: 'c4', name: '神秘人', role: '路人', tier: '重要' }, // 显式指定优先
      { id: 'c5', name: '同班同学', role: '龙套' }
    ]
  })
  const by = (n) => cast.characters.find((c) => c.name === n)
  ok('主角 → 重要', by('苏晚').tier === '重要', by('苏晚').tier)
  ok('配角 → 重要', by('周晓').tier === '重要', by('周晓').tier)
  ok('路人 → 不重要（自动）', by('店长').tier === '不重要', by('店长').tier)
  ok('龙套 → 不重要（自动）', by('同班同学').tier === '不重要', by('同班同学').tier)
  ok('写了 tier 就听 tier（路人也能是重要的）', by('神秘人').tier === '重要', by('神秘人').tier)
  ok('关系是可选的：这些人都没有关系也没报错', cast.relations.length === 0)

  const t = castTiers(cast)
  ok('分档统计对', t.major === 3 && t.minor === 2 && t.total === 5, JSON.stringify(t))

  const txt = renderCastText(cast)
  ok('两档都有 → 出现两个小节标题', txt.includes('════ 重要角色（3）════') && txt.includes('════ 不重要'), txt.split('\n').filter((l) => l.startsWith('════')).join(' | '))
  ok('路人也在人物卡里（带身份）', txt.includes('【店长】 路人'))
  ok('头像用姓氏时不重复（不写成「苏 苏晚」）', renderCastText({ characters: [{ name: '苏晚', role: '主角', avatar: '苏' }] }).includes('【苏晚】 主角'))
  ok('头像用 emoji 时照旧带上', renderCastText({ characters: [{ name: '苏晚', role: '主角', avatar: '🖋️' }] }).includes('【🖋️ 苏晚】 主角'))
  ok('不重要的那一节里确实是不重要的人', (() => {
    const parts = txt.split('════ 不重要')
    return parts.length === 2 && parts[1].includes('【店长】') && !parts[1].includes('【苏晚】')
  })())

  // 工具的增量接口也要认 tier
  const up = applyCastOps(cast, { addCharacters: [{ name: '隔壁班女生', role: '路人', desc: '只出现一次' }] })
  const added = up.cast.characters.find((c) => c.name === '隔壁班女生')
  ok('addCharacters 收 tier（路人自动进不重要）', added && added.tier === '不重要', added && added.tier)
  const up2 = applyCastOps(up.cast, { updateCharacters: [{ name: '隔壁班女生', tier: '重要' }] })
  ok('updateCharacters 能改档', up2.cast.characters.find((c) => c.name === '隔壁班女生').tier === '重要')
  ok('日志里写了档位', up.log.join(' ').includes('不重要'), up.log.join(' '))
}

console.log('\n── 5. parseCastJson：文件坏了也能开面板 ──')
{
  ok('空文本 → 空表', parseCastJson('').cast.characters.length === 0)
  ok('正常 JSON', parseCastJson('{"characters":[{"name":"苏晚"}]}').cast.characters.length === 1)
  const bad = parseCastJson('{ 这不是 json }')
  ok('坏 JSON → 空表 + 警告', bad.cast.characters.length === 0 && bad.warnings.length > 0, bad.warnings[0].slice(0, 50))
}

console.log(failed === 0 ? '\n✅ 角色/关系纯函数层验证通过' : `\n❌ 有 ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
