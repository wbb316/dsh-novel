// 清单不变式（不启动 DSH、不占端口、不依赖宿主装了什么）
//
// 起因（2026-09-30，v0.12.0）：我把两个 inject 都写成了**包 id** ——
//   · package.json 的 dsh.client.inject 里塞了 `@deepseek-ai/dsh-client-ui-slots`
//   · 客户端半的 exports.inject 里也塞了包 id
// 而 ui-slots 是**纯库**（只有 index.js，没有 lib/client.js）：宿主永远等不到这个模块，
// apply 永不执行 → **面板凭空消失，控制台还不报错**。查了半天才定位。
//
// 这个文件把当时靠"读懂宿主源码"才明白的几条规矩钉成断言，下次改 inject 会当场红。
import fs from 'node:fs'

let total = 0
let bad = 0
const ok = (name, cond, extra) => {
  total += 1
  if (!cond) bad += 1
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`)
}
const exists = (p) => fs.existsSync(p)

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8').replace(/^\uFEFF/, ''))
const clientSrc = fs.readFileSync('./lib/client.js', 'utf8')

console.log('── 1. 双面声明的两个入口都得真的在 ──')
ok('main 指向的文件存在', exists(pkg.main), String(pkg.main))
const clientExport = pkg.exports?.['./client']
const clientPath = typeof clientExport === 'string' ? clientExport : clientExport?.default
ok('exports["./client"] 指向的文件存在', !!clientPath && exists(clientPath), String(clientPath))
const patch = pkg.dsh?.bundle?.patch
ok('dsh.bundle.patch 指向的文件存在', !!patch && exists(patch), String(patch))

console.log('\n── 2. dsh.client.inject = 包 id（且必须是有客户端半的包）──')
const pkgInject = pkg.dsh?.client?.inject ?? []
ok('platform = web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
ok('inject 不是空的', pkgInject.length > 0, JSON.stringify(pkgInject))
ok(
  'inject 的每一项都"像包 id"（以 @ 开头或含 /）',
  pkgInject.every((id) => id.startsWith('@') || id.includes('/')),
  JSON.stringify(pkgInject)
)
// 这一条是本文件的由来：服务名（裸词）出现在这里 = 宿主找不到这个"包"
ok(
  'inject 里不许出现服务名（裸词，如 slots）',
  pkgInject.every((id) => id.startsWith('@') || id.includes('/')),
  JSON.stringify(pkgInject.filter((id) => !id.startsWith('@') && !id.includes('/')))
)

console.log('\n── 3. 客户端半的 exports.inject = 服务名（不是包 id）──')
const m = /(?:const|var|let)\s+inject\s*=\s*\[([^\]]*)\]/.exec(clientSrc)
const svcInject = m
  ? m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  : []
ok('客户端半里有模块级 inject 数组', !!m, m ? JSON.stringify(svcInject) : '(没找到)')
ok(
  '每一项都是服务名（不含 @ 和 /）',
  svcInject.length > 0 && svcInject.every((n) => !n.startsWith('@') && !n.includes('/')),
  JSON.stringify(svcInject)
)
ok('两组 inject 不重叠（一个写包、一个写服务）', svcInject.every((n) => !pkgInject.includes(n)))
ok('客户端等的是 slots 服务（由 ui-renderer 提供）', svcInject.includes('slots'), JSON.stringify(svcInject))

console.log('\n── 4. 版本要求声明齐（让宿主能拦住不兼容组合）──')
ok('dsh.engines.dsh 已声明', typeof pkg.dsh?.engines?.dsh === 'string' && /^[>^~]/.test(pkg.dsh.engines.dsh), String(pkg.dsh?.engines?.dsh))
const dshPeers = Object.entries(pkg.peerDependencies ?? {}).filter(
  ([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-')
)
ok('peerDependencies 里至少 5 条 @deepseek-ai/dsh*', dshPeers.length >= 5, `${dshPeers.length} 条`)
ok(
  '每条 peer 都是合法范围（非空、以 >= 或 ^ 开头）',
  dshPeers.every(([, r]) => typeof r === 'string' && /^([>^~]|\d)/.test(r.trim())),
  dshPeers.map(([n, r]) => `${n}@${r}`).join(' / ')
)

console.log('\n── 5. 面板注册的两条路都还在（别被谁顺手删了）──')
ok('原生席位：sidebar.panellist', clientSrc.includes('sidebar.panellist'))
ok('原生席位：main', clientSrc.includes('"main"'))
ok('机会主义回退：betterSidebar', clientSrc.includes('betterSidebar'))
ok('回退没写进 inject（否则那个插件卸了客户端半就不加载）', !pkgInject.includes('dsh-better-sidebar') && !svcInject.includes('betterSidebar'))

console.log(`\n共 ${total} 项断言`)
if (bad) {
  console.log(`❌ 有 ${bad} 项不合规`)
  process.exit(1)
}
console.log('✅ 清单不变式全部通过')
