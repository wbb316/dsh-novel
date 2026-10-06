#!/usr/bin/env node
// 跑完本包根目录下所有 test-*.mjs，汇总成一个退出码。
//
// 为什么需要它：这些测试文件用的是**包根相对路径**（例如读 `lib/client.js`、
// `package.json`），从别处直接 `node test-xxx.mjs` 会因为 cwd 不对而假失败
// （实测：从桌面目录跑就有 3 个报 ENOENT，看着像真 bug）。
// 所以统一在这里把 cwd 钉成包根，再逐个 spawn。
//
// 子进程用 stdio: 'inherit'（不捕获输出）：
// 一是失败时的堆栈原样留在 CI 日志里，二是避免在受限沙盒里开管道被 EPERM 拦住。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

const files = fs
  .readdirSync(root)
  .filter((n) => /^test-.*\.mjs$/.test(n))
  .sort()

if (files.length === 0) {
  console.error('没有找到任何 test-*.mjs —— 检查是不是在包根目录跑。')
  process.exit(1)
}

const failed = []
for (const file of files) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [file], { cwd: root, stdio: 'inherit' })
  const ms = Date.now() - started
  const code = r.status === null ? 1 : r.status
  if (code === 0) {
    console.log(`✓ ${file}  (${ms}ms)`)
  } else {
    console.log(`✗ ${file}  (${ms}ms, exit ${code})`)
    failed.push(file)
  }
}

console.log('')
if (failed.length === 0) {
  console.log(`全部通过：${files.length} 个测试文件。`)
  process.exit(0)
}
console.log(`${failed.length}/${files.length} 个测试文件失败：`)
for (const f of failed) console.log(`  · ${f}`)
process.exit(1)
