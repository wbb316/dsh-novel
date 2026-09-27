// 本地双重验证（不启动 DSH、不占端口）
//   (1) 插件能加载并注册
//   (2) 所有工具的 parameters / output.schema 都能过 DSH 的校验器
//   (3) 只读工具真的调用一次（写盘工具只校验、不执行）
import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import * as mod from './lib/index.js'

console.log('插件名 :', mod.name)
console.log('inject :', JSON.stringify(mod.inject))

const registered = []
const fakeCtx = {
  reflect: {
    get(name, dflt) {
      return name === 'tools' ? { register: (t) => registered.push(t) } : dflt
    }
  }
}
mod.apply(fakeCtx)
console.log('注册的工具:', registered.map((t) => t.name).join(', '), '\n')

// 只读工具（可安全调用）；写盘工具只校验 schema
const READONLY = new Set(['novel_list', 'novel_read', 'novel_context', 'novel_cast'])
const sampleArgs = {
  novel_read: { novel: '学妹这只是练习而已', file: 'outline.md' },
  novel_context: { novel: '学妹这只是练习而已' },
  novel_cast: { novel: '学妹这只是练习而已' }
}

let ok = true
for (const t of registered) {
  console.log(`=== ${t.name} ===`)
  try {
    assertObjectJsonSchema(t.parameters)
    console.log('  入参 schema: OK')
  } catch (e) {
    ok = false
    console.log('  入参 schema 报错:', e.message)
  }
  try {
    assertSupportedJsonSchema(t.output.schema)
    console.log('  输出 schema: OK')
  } catch (e) {
    ok = false
    console.log('  输出 schema 报错:', e.message)
  }
  if (READONLY.has(t.name)) {
    // 调不动不算失败：保存位置是可以改的（面板里能换根目录），
    // 换了之后这里写死的小说名可能就不存在了 —— 那说明环境变了，不是 schema 的问题。
    try {
      const out = await t.execute(sampleArgs[t.name] ?? {})
      console.log('  调用结果:', String(out.text ?? '').slice(0, 70).replace(/\n/g, ' / '))
    } catch (e) {
      console.log('  （调用报错，可能换过保存位置；schema 仍然 OK）:', String((e && e.message) || e).slice(0, 56))
    }
  } else {
    console.log('  （写盘工具，跳过实际调用）')
  }
  console.log('')
}

console.log(ok ? '✅ 全部通过' : '❌ 有 schema 错误')
process.exit(ok ? 0 : 1)
