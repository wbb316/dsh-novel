/**
 * 只读探针：算出某个插件客户端 bundle 的 rev，然后去问正在跑的 DSH 要它。
 * 只发 GET，不启停任何服务。
 *
 *   node probe-client-bundle.mjs dsh-novel <client.js 路径>
 *   node probe-client-bundle.mjs dsh-whale-widget <client.js 路径>
 */
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'

const HASH_LEN = 12
function framedHash(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(part.byteLength)}:`).update(part)
  return hash.digest('hex').slice(0, HASH_LEN)
}
function revOf(clientPath) {
  const bundle = readFileSync(clientPath)
  const mapPath = clientPath + '.map'
  const map = existsSync(mapPath) ? readFileSync(mapPath) : undefined
  return map === undefined ? framedHash('plugin-artifact', [bundle]) : framedHash('plugin-artifact', [bundle, map])
}

const base = process.env.DSH_BASE || 'http://127.0.0.1:3080'
const targets = process.argv.slice(2)

for (let i = 0; i < targets.length; i += 2) {
  const id = targets[i]
  const file = targets[i + 1]
  if (!existsSync(file)) {
    console.log(`?  ${id}\n   客户端文件不存在：${file}`)
    continue
  }
  const rev = revOf(file)
  const url = `${base}/plugins/??${id}/client.js&rev=${rev}`
  let line = ''
  try {
    const res = await fetch(url)
    const text = res.ok ? await res.text() : await res.text().catch(() => '')
    line = `HTTP ${res.status}  (${text.length} 字符)`
    if (res.ok) line += `\n   开头: ${text.slice(0, 70).replace(/\s+/g, ' ')}`
    console.log(`✅ ${id}\n   rev=${rev}\n   ${line}`)
  } catch (e) {
    console.log(`❌ ${id}\n   rev=${rev}\n   请求失败：${e}`)
  }
  console.log(`   URL: ${url}\n`)
}
