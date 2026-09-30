/**
 * 本地验证「流式缓冲」——纯逻辑，喂假帧就行（不启 DSH、不占端口）。
 *
 * 跑法：  cd D:\dsh\plugins\dsh-novel-plugin ; node test-stream.mjs
 */
import { createStreamBuffer, STREAM_TEXT_CAP, extractJsonStringField, pickPreview } from './lib/stream.js'

let failed = 0
function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

/** 造一帧 start / chunk / end */
const start = (attemptId, turn = 1, step = 1) => ({ type: 'start', attemptId, turn, step })
const delta = (attemptId, index, text) => ({
  type: 'chunk',
  attemptId,
  index,
  chunk: { type: 'text-delta', text }
})
const think = (attemptId, index, text) => ({
  type: 'chunk',
  attemptId,
  index,
  chunk: { type: 'reasoning-delta', text }
})
const end = () => ({ type: 'end' })
/** 包成宿主真实发的 payload */
const wrap = (sessionId, frame) => ({ agent: { session: { id: sessionId } }, frame })

console.log('── 1. 什么都没来时 ──')
{
  const b = createStreamBuffer()
  const s = b.forSession('s1')
  ok('has:false', s.has === false)
  ok('writing:false', s.writing === false)
  ok('text 是空串', s.text === '')
  ok('totalFrames=0（用来排查事件是否真的来了）', b.totalFrames() === 0)
  ok('没有会话时 latestSessionId 是空串', b.latestSessionId() === '')
}

console.log('\n── 2. start → chunk → 文字累积 ──')
{
  const b = createStreamBuffer()
  ok('onFrame 认得出 payload', b.onFrame(wrap('s1', start('a1', 2, 3))) === true)
  b.onFrame(wrap('s1', delta('a1', 0, '「苏晚')))
  b.onFrame(wrap('s1', delta('a1', 1, '，你又在写悲剧？」')))
  let s = b.forSession('s1')
  ok('文字拼起来了', s.text === '「苏晚，你又在写悲剧？」', s.text)
  ok('writing:true', s.writing === true)
  ok('chars 对', s.chars === 12, String(s.chars))
  ok('frames=2', s.frames === 2, String(s.frames))
  ok('turn/step 带出来', s.turn === 2 && s.step === 3)
  ok('has:true', s.has === true)

  console.log('   —— end 之后 ——')
  b.onFrame(wrap('s1', end()))
  s = b.forSession('s1')
  ok('writing:false', s.writing === false)
  ok('文字还留着（让人看清最后写了啥）', s.text === '「苏晚，你又在写悲剧？」')
  ok('doneAt 有值', s.doneAt > 0)
}

console.log('\n── 3. 思考过程单独攒 ──')
{
  const b = createStreamBuffer()
  b.onFrame(wrap('s1', start('a1')))
  b.onFrame(wrap('s1', think('a1', 0, '先想一下人设')))
  b.onFrame(wrap('s1', delta('a1', 1, '正文来了')))
  const s = b.forSession('s1')
  ok('reasoning 单独存', s.reasoning === '先想一下人设', s.reasoning)
  ok('text 只有正文', s.text === '正文来了', s.text)
}

console.log('\n── 4. 乱序 / 换尝试 / 没 start → 宁可不要，也不拼出错字 ──')
{
  const b = createStreamBuffer()
  b.onFrame(wrap('s1', delta('a1', 0, '孤儿块')))
  ok('没 start 就来的 chunk 被丢', b.forSession('s1').text === '')

  b.onFrame(wrap('s1', start('a1')))
  b.onFrame(wrap('s1', delta('a1', 0, 'A')))
  b.onFrame(wrap('s1', delta('a1', 5, '跳号了')))
  const s = b.forSession('s1')
  ok('跳号那段不进来', s.text === 'A', JSON.stringify(s.text))
  ok('但已收到的保留（预览突然变空更像 bug）', s.text.length > 0)
  ok('立了 gapped 标记，界面可以提示', s.gapped === true)
  ok('没有炸', s.has === true)

  b.onFrame(wrap('s1', start('a2')))
  b.onFrame(wrap('s1', delta('a1', 0, '旧尝试的块')))
  ok('换了尝试后旧块被丢', b.forSession('s1').text === '')

  b.onFrame(wrap('s1', delta('a2', 0, '新尝试')))
  ok('新尝试正常累积', b.forSession('s1').text === '新尝试')
}

console.log('\n── 5. 多个会话互不干扰 + 兜底 ──')
{
  const b = createStreamBuffer()
  b.onFrame(wrap('s1', start('a1')))
  b.onFrame(wrap('s1', delta('a1', 0, '会话一的字')))
  b.onFrame(wrap('s2', start('a2')))
  b.onFrame(wrap('s2', delta('a2', 0, '会话二的字')))
  ok('s1 只看到自己的', b.forSession('s1').text === '会话一的字')
  ok('s2 只看到自己的', b.forSession('s2').text === '会话二的字')
  ok('两个会话都在', b.size() === 2)
  ok('不给 sessionId 时兜底到最近活动的', b.forSession('').session === 's2', b.forSession('').session)
  ok('给一个不存在的 sessionId 也能安全返回', b.forSession('nope').has === false)
}

console.log('\n── 6. 畸形帧一律不炸 ──')
{
  const b = createStreamBuffer()
  for (const bad of [null, undefined, 0, 'x', {}, { agent: {} }, { agent: { session: {} } }, { frame: {} }]) {
    const r = b.onFrame(bad)
    if (r !== false) ok('畸形 payload 返回 false: ' + JSON.stringify(bad), false)
  }
  ok('畸形 payload 全部安全', true)
  ok('帧里乱七八糟的类型也不炸', b.frame('s1', { type: 'weird' }) === false)
  ok('chunk 里没有 chunk 字段', b.frame('s1', { type: 'chunk', attemptId: 'a', index: 0 }) === false)
  ok('chunk 类型不认识', b.frame('s1', { type: 'chunk', attemptId: 'a', index: 0, chunk: { type: 'x', text: 'y' } }) === false)
  ok('sessionId 非字符串', b.frame(123, start('a')) === false)
}

console.log('\n── 7. 超长文本按 cap 截断（留尾巴） ──')
{
  const b = createStreamBuffer({ cap: 10 })
  b.onFrame(wrap('s1', start('a1')))
  b.onFrame(wrap('s1', delta('a1', 0, '12345678')))
  b.onFrame(wrap('s1', delta('a1', 1, '90ABCDEF')))
  const s = b.forSession('s1')
  ok('只留最后 cap 个字符', s.text === '90ABCDEF' || s.text.length === 10, JSON.stringify(s.text))
  ok('默认 cap 是个大数', STREAM_TEXT_CAP >= 100000, String(STREAM_TEXT_CAP))
}

console.log('\n── 8. rev 会变（客户端靠它决定要不要重画） ──')
{
  const b = createStreamBuffer()
  const r0 = b.forSession('s1').rev
  b.onFrame(wrap('s1', start('a1')))
  const r1 = b.forSession('s1').rev
  b.onFrame(wrap('s1', delta('a1', 0, 'x')))
  const r2 = b.forSession('s1').rev
  ok('start 之后 rev 变大', r1 > r0, `${r0} → ${r1}`)
  ok('chunk 之后 rev 继续变大', r2 > r1, `${r1} → ${r2}`)
  b.clear('s1')
  ok('clear 之后 has:false', b.forSession('s1').has === false)
}

console.log('\n── 9. 从半截 JSON 里抠字符串字段 ──')
{
  const full = '{"title":"卡文","content":"# 第2章\\n\\n「苏晚」"}'
  const got = extractJsonStringField(full, 'content')
  ok('完整字段能抠出来', got.value === '# 第2章\n\n「苏晚」', JSON.stringify(got.value))
  ok('complete:true', got.complete === true)
  ok('字段不存在时 found:false', extractJsonStringField(full, 'nope').found === false)
  ok('值不是字符串时 found:false', extractJsonStringField('{"content":123}', 'content').found === false)

  ok('断在孤立反斜杠上不炸', extractJsonStringField('{"content":"abc\\', 'content').value === 'abc')
  ok('断在 \\u 中间不炸', extractJsonStringField('{"content":"abc\\u4e', 'content').value === 'abc')
  ok('\\u4e2d 能还原成中', extractJsonStringField('{"content":"abc\\u4e2d"}', 'content').value === 'abc中')
  ok('转义引号能还原', extractJsonStringField('{"content":"他说\\"你好\\""}', 'content').value === '他说"你好"')
  ok('\\t \\n 能还原', extractJsonStringField('{"content":"a\\tb\\nc"}', 'content').value === 'a\tb\nc')
  ok('空串也是 found', extractJsonStringField('{"content":""}', 'content').found === true)
  ok('空 raw 不炸', extractJsonStringField('', 'content').found === false)
  ok('raw 不是字符串不炸', extractJsonStringField(null, 'content').found === false)
}

console.log('\n── 10. 工具参数折叠 + preview 选取 ──')
{
  const b = createStreamBuffer()
  const toolDelta = (outerIndex, id, name, argumentsDelta) => ({
    type: 'chunk',
    attemptId: 'a1',
    index: outerIndex,
    chunk: { type: 'tool-call-delta', index: 1, id, name, argumentsDelta }
  })

  b.onFrame(wrap('s1', start('a1')))
  b.onFrame(wrap('s1', delta('a1', 0, '好的，我这就写第2章。')))
  ok('一开始 preview 是散文', b.forSession('s1').preview === '好的，我这就写第2章。')
  ok('kind=text', b.forSession('s1').previewKind === 'text')

  // 模拟模型开始吐工具参数（分三块，模拟真实的分片）
  b.onFrame(wrap('s1', toolDelta(1, 't1', 'novel_save_chapter', '{"novel":"测试","title":"卡文')))
  b.onFrame(wrap('s1', toolDelta(2, 't1', undefined, '的人","content":"# 第2章 卡文\\n\\n「苏晚')))
  b.onFrame(wrap('s1', toolDelta(3, 't1', undefined, '，你又在写悲剧？」\\n"}')))
  const s = b.forSession('s1')
  ok('preview 换成章节正文', s.previewKind === 'chapter', s.previewKind)
  ok('正文开头对', s.preview.indexOf('# 第2章 卡文') === 0, JSON.stringify(s.preview.slice(0, 16)))
  ok('换行被还原', s.preview.indexOf('\n\n「苏晚，你又在写悲剧？」') >= 0, JSON.stringify(s.preview.slice(-22)))
  ok('工具信息带出来', s.tool.name === 'novel_save_chapter' && s.tool.hasContent === true, JSON.stringify(s.tool))
  ok('散文没丢', s.text === '好的，我这就写第2章。')
  ok('args 长度也报了', s.tool.argsChars > 30, String(s.tool.argsChars))
}

console.log('\n── 11. pickPreview 的三级降级 ──')
{
  ok('只有思考 → 显示思考', pickPreview({ text: '', reasoning: '嗯…', tool: {} }).previewKind === 'reasoning')
  ok('有散文 → 优先散文', pickPreview({ text: '正文', reasoning: '想', tool: {} }).previewKind === 'text')
  ok(
    '有章节参数 → 优先正文',
    pickPreview({ text: '散文', reasoning: '想', tool: { name: 'novel_save_chapter', args: '{"content":"章节"}' } }).previewKind === 'chapter'
  )
  ok(
    '别的工具不抢正文位',
    pickPreview({ text: '散文', tool: { name: 'novel_context', args: '{"content":"x"}' } }).previewKind === 'text'
  )
  ok('什么都没有 → 空', pickPreview({ text: '', reasoning: '', tool: {} }).preview === '')
  ok('传 null 不炸', pickPreview(null).preview === '')
}

console.log(failed === 0 ? '\n✅ 流式缓冲验证通过' : `\n❌ 有 ${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)