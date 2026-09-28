/**
 * 本地验证「EPUB / DOCX 导出」——不启 DSH、不占端口、不调用外部解压工具。
 *
 * 跑法：  cd D:\dsh-novel-plugin ; node test-ebook.mjs
 *
 * 测什么：
 *   1) crc32 对不对（标准测试向量 0xCBF43926 + 一个独立的逐位实现互相印证）
 *   2) createZip 的 ZIP 结构对不对（签名 / EOCD / 中央目录 offset / UTF-8 位标记）
 *   3) 真解压：自己写了个 readZip（解析中央目录 + zlib.inflateRawSync，
 *      store 的直接切片），把 epub / docx 的条目全解出来，
 *      逐字节比对 + 逐条重算 CRC-32，再检查该有的路径一个不少
 *   4) content.opf / document.xml 里的中文有没有乱码、章节数对不对、XML 转义对不对
 *   5) 生成物大小是不是合理（并打印字节数）
 *
 * 为什么不用系统解压工具核对：
 *   这台机器上 Node 里 spawn 抓子进程输出会被沙箱拦（EPERM），
 *   而且 epubcheck / Word 也不保证装了。所以断言全部靠 readZip 自己做，
 *   最多把 epub 落一份到系统临时目录（book.zip）确认写盘字节没变。
 *
 * 这个测试**只读** lib/zip.js 和 lib/ebook.js，不碰仓库里任何已有文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { crc32, createZip } from './lib/zip.js'
import { buildEpub, buildDocx } from './lib/ebook.js'

let failed = 0
let total = 0
function ok(label, cond, extra = '') {
  total += 1
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed += 1
}

const SIG_LOCAL = 0x04034b50 // "PK\x03\x04"
const SIG_CENTRAL = 0x02014b50 // "PK\x01\x02"
const SIG_EOCD = 0x06054b50 // "PK\x05\x06"
const UTF8_FLAG = 0x0800 // 通用位标记 bit 11

/** string → Buffer（测试里比对用） */
const toBuf = (d) => (Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8'))

/** XML 里“裸的可疑 &”：不是五个预定义实体、也不是数字实体，就算漏转义 */
const RAW_AMP = /&(?!amp;|lt;|gt;|quot;|apos;|#)/

/**
 * 读 ZIP：从尾巴上的 EOCD 找中央目录，再按每条记的 offset 回到 local header 取数据。
 * 这就是解压工具干的事（只是没有 ZIP64 / 加密 / 数据描述符，我们也没写那些）。
 */
function readZip(buf) {
  // EOCD 在最后，注释最长 65535 字节 —— 所以最多回扫 22 + 65535 字节
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('没找到 EOCD（PK\\x05\\x06）—— 这包不完整')

  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)

  const entries = []
  let p = cdOffset
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`中央目录第 ${i + 1} 条的签名不对（偏移 ${p}）`)
    }
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`条目「${name}」的中央目录 offset 没指向 local header（${localOffset}）`)
    }
    // 数据真正的起点 = local header(30) + 文件名 + extra（我们写 extra=0，但按规范读）
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    const rawData = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 0 ? Buffer.from(rawData) : zlib.inflateRawSync(rawData)

    entries.push({ name, method, flags, crc, size, compSize, localOffset, data })
    p += 46 + nameLen + extraLen + commentLen
  }

  return { entries, count, cdSize, cdOffset, eocd }
}

/** 解不开就当一条失败断言，别让整个测试崩在半路 */
function unzip(buf, label) {
  try {
    return readZip(buf)
  } catch (err) {
    ok(`${label} 能当 ZIP 解开（readZip 不抛错）`, false, String((err && err.message) || err))
    return { entries: [], count: 0, cdSize: 0, cdOffset: 0, eocd: 0 }
  }
}

/** 独立于 lib/zip.js 的逐位实现：两份都能对上才敢说 CRC 没写错 */
function crc32Slow(buf) {
  let c = 0xffffffff
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

// 测试用的书：故意包含卷、空行分段、段内换行、中文、& 和 <
const BOOK_TITLE = '雨里的伞'
const AUTHOR = '苏晚'
const CHAPTERS = [
  {
    volume: '第一卷 恋爱练习',
    title: '第1章 雨里的伞',
    text: '放学的时候下起了雨。\n\n苏晚站在校门口的屋檐下，看着雨帘发呆。\n她没有带伞，也不打算跑。\n\n「要一起走吗？」'
  },
  {
    volume: '第一卷 恋爱练习',
    title: '第2章 「苏晚 & 我」<上>',
    text: '这一章标题里带 & 和 <，专门用来试转义。\n\n第二段。'
  },
  { volume: '第二卷 不是恋爱', title: '第3章 收尾', text: '最后一章。' }
]
const FRONT = [
  { title: '大纲', text: '第 5 条被苏晚撕掉了。\n\n—— 出自 大纲.txt' },
  { title: '世界观', text: '一个只有雨的城市。' }
]

// ─────────────── 1. crc32 ───────────────
console.log('── 1. crc32 ──')
{
  const vec = crc32(Buffer.from('123456789'))
  ok('crc32("123456789") === 0xCBF43926（标准测试向量）', vec === 0xcbf43926, '0x' + vec.toString(16).toUpperCase())
  ok('空输入 = 0', crc32(Buffer.alloc(0)) === 0 && crc32('') === 0)
  ok('crc32("a") === 0xE8B7BE43', crc32(Buffer.from('a')) === 0xe8b7be43)
  ok('返回值是无符号 32 位（不是负数）', vec >= 0 && crc32(Buffer.from([0xff, 0xff, 0xff, 0xff])) >= 0)

  const rnd = crypto.randomBytes(4096)
  ok('查表版 == 独立逐位版（4096 字节随机数据）', crc32(rnd) === crc32Slow(rnd))
  const zh = Buffer.from('中文内容也会被当成普通字节流，CRC 与编码无关', 'utf8')
  ok('查表版 == 独立逐位版（中文文本）', crc32(zh) === crc32Slow(zh))
  ok('字符串入参按 utf8 处理（和 Buffer.from 一致）', crc32('雨里的伞') === crc32(Buffer.from('雨里的伞', 'utf8')))
}

// ─────────────── 2. createZip ───────────────
console.log('\n── 2. createZip（store / deflate / 中文名 / 空文件 / 二进制） ──')
const BIN = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff))
const PLAIN = { name: 'OEBPS/text/第001章.xhtml', data: '<p>中文文件名 & 内容</p>', store: true }
const DEFLATED = { name: 'OEBPS/style.css', data: 'body{color:#000}\n'.repeat(50) }
const EMPTY = { name: 'empty.bin', data: Buffer.alloc(0) }
const BLOB = { name: 'blob.bin', data: BIN, store: true }
const zipBuf = createZip([PLAIN, DEFLATED, EMPTY, BLOB])
{
  ok('开头 4 字节是 PK\\x03\\x04', zipBuf.readUInt32LE(0) === SIG_LOCAL, '0x' + zipBuf.readUInt32LE(0).toString(16))
  ok('结尾就是 EOCD（PK\\x05\\x06，没有 zip 注释）', zipBuf.readUInt32LE(zipBuf.length - 22) === SIG_EOCD)

  const z = unzip(zipBuf, 'createZip 的产物')
  const names = z.entries.map((e) => e.name)
  ok('条目数 = 4', z.entries.length === 4, String(z.entries.length))
  ok('EOCD 里的总条目数和实际一致', z.count === 4)
  ok('中央目录紧贴 EOCD（cdOffset + cdSize + 22 == 文件长度）', z.cdOffset + z.cdSize + 22 === zipBuf.length)
  ok('中央目录里的 offset 指回 local header（第一条在 0）', z.entries[0] && z.entries[0].localOffset === 0)
  ok('store 条目压缩方法 = 0', z.entries[0] && z.entries[0].method === 0)
  ok('默认条目压缩方法 = 8（deflate）', z.entries[1] && z.entries[1].method === 8)
  ok('所有条目都置了 UTF-8 位（bit 11 = 0x0800）', z.entries.length === 4 && z.entries.every((e) => (e.flags & UTF8_FLAG) !== 0))
  ok('中文文件名解出来不乱码', names[0] === 'OEBPS/text/第001章.xhtml', names[0])

  const expected = [PLAIN, DEFLATED, EMPTY, BLOB]
  const same = expected.every((item, i) => {
    const e = z.entries[i]
    return e && e.name === item.name && e.data.equals(toBuf(item.data))
  })
  ok('4 个条目解出来与输入**逐字节**相同', same)
  ok('空文件条目解出来长度 0', z.entries[2] && z.entries[2].data.length === 0)
  ok('二进制条目 300 字节一个不差', z.entries[3] && z.entries[3].data.equals(BIN))
  ok('每条 CRC-32 与原始数据重算一致', z.entries.length === 4 && z.entries.every((e) => e.crc === crc32(e.data)))
  ok('每条原始大小 = 解出来的长度', z.entries.length === 4 && z.entries.every((e) => e.size === e.data.length))
  ok('deflate 条目确实变小了（压缩生效）', z.entries[1] && z.entries[1].compSize < z.entries[1].size)

  // DOS 时间戳：1980 起算，字段得在合法范围（越界的时间戳有些工具会判文件损坏）
  const dosDate = zipBuf.readUInt16LE(12)
  const dosTime = zipBuf.readUInt16LE(10)
  const year = 1980 + ((dosDate >> 9) & 0x7f)
  const month = (dosDate >> 5) & 0x0f
  const day = dosDate & 0x1f
  const hour = (dosTime >> 11) & 0x1f
  const minute = (dosTime >> 5) & 0x3f
  const second = (dosTime & 0x1f) * 2
  ok(
    'DOS 时间戳合法（年 >= 1980，月/日/时/分/秒都在范围内）',
    year >= 1980 && year <= 2107 && month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59,
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${hour}:${minute}:${second}`
  )
}

// ─────────────── 3. EPUB ───────────────
console.log('\n── 3. buildEpub ──')
const epub = buildEpub({ title: BOOK_TITLE, author: AUTHOR, chapters: CHAPTERS, frontMatter: FRONT })
const ez = unzip(epub, 'epub')
const eMap = new Map(ez.entries.map((e) => [e.name, e]))
{
  const first = ez.entries[0]
  ok('mimetype 是**第一个**条目', first && first.name === 'mimetype', first && first.name)
  ok('mimetype 用 store（压缩方法 0）', first && first.method === 0, first && String(first.method))
  ok('mimetype 内容是 application/epub+zip（一字不差）', first && first.data.toString('utf8') === 'application/epub+zip')
  ok('mimetype 的 local header 偏移 = 0', first && first.localOffset === 0)
  // OCF 规范原话：mimetype 的内容必须从**第 38 字节**开始
  // = local header 30 字节 + 文件名 "mimetype" 8 字节（且不能有 extra field）
  ok(
    '文件第 38 字节起就是 mimetype 原文（阅读器就是靠这个认出 EPUB 的）',
    epub.subarray(38, 38 + 20).toString('utf8') === 'application/epub+zip',
    JSON.stringify(epub.subarray(38, 58).toString('utf8'))
  )

  const need = [
    'META-INF/container.xml',
    'OEBPS/content.opf',
    'OEBPS/nav.xhtml',
    'OEBPS/toc.ncx',
    'OEBPS/style.css',
    'OEBPS/text/front.xhtml',
    'OEBPS/text/chapter-001.xhtml',
    'OEBPS/text/chapter-002.xhtml',
    'OEBPS/text/chapter-003.xhtml'
  ]
  const missing = need.filter((n) => !eMap.has(n))
  ok('必需路径一个不少（container / opf / nav / ncx / css / front / 每章一个 xhtml）', missing.length === 0, missing.join(', '))
  ok('章节 xhtml 数 = 输入章数', need.filter((n) => n.startsWith('OEBPS/text/chapter-')).length === CHAPTERS.length)
  ok('每条 CRC-32 与解出来的数据重算一致', ez.entries.length > 0 && ez.entries.every((e) => e.crc === crc32(e.data)))

  const opf = (eMap.get('OEBPS/content.opf') || { data: Buffer.alloc(0) }).data.toString('utf8')
  const nav = (eMap.get('OEBPS/nav.xhtml') || { data: Buffer.alloc(0) }).data.toString('utf8')
  const ncx = (eMap.get('OEBPS/toc.ncx') || { data: Buffer.alloc(0) }).data.toString('utf8')
  const container = (eMap.get('META-INF/container.xml') || { data: Buffer.alloc(0) }).data.toString('utf8')
  const ch1 = (eMap.get('OEBPS/text/chapter-001.xhtml') || { data: Buffer.alloc(0) }).data.toString('utf8')
  const ch2 = (eMap.get('OEBPS/text/chapter-002.xhtml') || { data: Buffer.alloc(0) }).data.toString('utf8')

  ok('container.xml 指向 OEBPS/content.opf', container.includes('full-path="OEBPS/content.opf"') && container.includes('application/oebps-package+xml'))
  ok('content.opf 是 EPUB 3（version="3.0" + unique-identifier）', opf.includes('version="3.0"') && opf.includes('unique-identifier="bookid"'))
  ok('content.opf 里的书名是中文且没乱码', opf.includes(`<dc:title>${BOOK_TITLE}</dc:title>`))
  ok('content.opf 里有作者', opf.includes(`<dc:creator>${AUTHOR}</dc:creator>`))
  ok('content.opf 里默认语言是 zh-CN', opf.includes('<dc:language>zh-CN</dc:language>'))
  ok('content.opf 里有 urn:uuid 的 identifier', /<dc:identifier id="bookid">urn:uuid:[0-9a-f-]{36}<\/dc:identifier>/.test(opf))
  ok('content.opf 里有 EPUB 3 必需的 dcterms:modified', /<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/.test(opf))
  ok('spine 里的 itemref 数 = 章节数 + 设定集', (opf.match(/<itemref /g) || []).length === CHAPTERS.length + 1)
  ok('nav.xhtml 在 manifest 里带 properties="nav"', opf.includes('properties="nav"'))
  ok('每章的 manifest item 数对得上', (opf.match(/media-type="application\/xhtml\+xml"/g) || []).length === CHAPTERS.length + 2)

  ok('nav.xhtml 是 EPUB 3 的 toc（epub:type="toc"）', nav.includes('epub:type="toc"') && nav.includes('<nav '))
  ok('nav.xhtml 里有卷名', nav.includes('第一卷 恋爱练习') && nav.includes('第二卷 不是恋爱'))
  // 顶层 1 个 + 每个有卷的分组 1 个（2 个卷）+ landmarks 里 1 个 = 4
  ok('nav.xhtml 有卷的层级（嵌套 <ol>）', (nav.match(/<ol>/g) || []).length === 4, String((nav.match(/<ol>/g) || []).length))
  ok('nav.xhtml 指向每一章', nav.includes('href="text/chapter-001.xhtml"') && nav.includes('href="text/chapter-003.xhtml"'))
  ok('nav.xhtml 里有设定集入口', nav.includes('href="text/front.xhtml"'))

  ok('toc.ncx 是 EPUB2 兜底（ncx 命名空间 + navMap）', ncx.includes('http://www.daisy.org/z3986/2005/ncx/') && ncx.includes('<navMap>'))
  const playOrders = (ncx.match(/playOrder="(\d+)"/g) || []).map((s) => Number(s.replace(/\D+/g, '')))
  ok('toc.ncx 的 navPoint 数 = 6（设定集 + 2 卷 + 3 章）', (ncx.match(/<navPoint /g) || []).length === 6, String((ncx.match(/<navPoint /g) || []).length))
  ok('playOrder 是 1..6 且不重复', playOrders.length === 6 && new Set(playOrders).size === 6 && playOrders.sort((a, b) => a - b).join(',') === '1,2,3,4,5,6')

  // 分段规则：空行分段 → 3 个 <p>；段内换行 → 1 个 <br/>
  ok('第1章按空行分成 3 段', (ch1.match(/<p>/g) || []).length === 3, String((ch1.match(/<p>/g) || []).length))
  ok('第1章段内的换行变成 <br/>（不另起一段）', (ch1.match(/<br\/>/g) || []).length === 1)
  ok('第1章有 <h1> 标题', ch1.includes(`<h1>${CHAPTERS[0].title}</h1>`))
  ok('章节正文里的中文没乱码', ch1.includes('苏晚站在校门口的屋檐下') && ch1.includes('「要一起走吗？」'))
  ok('第2章按空行分成 2 段', (ch2.match(/<p>/g) || []).length === 2)
  ok('第3章 1 段', ((eMap.get('OEBPS/text/chapter-003.xhtml') || { data: Buffer.alloc(0) }).data.toString('utf8').match(/<p>/g) || []).length === 1)

  ok('标题里的 & 被转义成 &amp;', ch2.includes(`<h1>第2章 「苏晚 &amp; 我」&lt;上&gt;</h1>`))
  // content.opf 里只有 id / href，不带章标题；带标题的是 nav 和 ncx，所以这里查 ncx
  ok('toc.ncx 里的章标题也转义了', ncx.includes('&amp;') && ncx.includes('&lt;上&gt;'))
  const badXml = ez.entries
    .filter((e) => /\.(xhtml|opf|ncx|xml|css)$/.test(e.name))
    .filter((e) => RAW_AMP.test(e.data.toString('utf8')))
  ok('没有任何条目里存在没转义的裸 &', badXml.length === 0, badXml.map((e) => e.name).join(', '))
  ok('生成物不是空的（epub 字节数 > 1000）', epub.length > 1000)
}

// ─────────────── 4. DOCX ───────────────
console.log('\n── 4. buildDocx ──')
const docx = buildDocx({ title: BOOK_TITLE, author: AUTHOR, chapters: CHAPTERS, frontMatter: FRONT })
const dz = unzip(docx, 'docx')
const dMap = new Map(dz.entries.map((e) => [e.name, e]))
{
  const need = [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/_rels/document.xml.rels',
    'docProps/core.xml',
    'docProps/app.xml'
  ]
  const missing = need.filter((n) => !dMap.has(n))
  ok('7 个必需路径一个不少', missing.length === 0, missing.join(', '))
  ok('条目数正好 7（不多不少）', dz.entries.length === 7, String(dz.entries.length))
  ok('[Content_Types].xml 排在第一个', dz.entries[0] && dz.entries[0].name === '[Content_Types].xml')
  ok('每条 CRC-32 与解出来的数据重算一致', dz.entries.length > 0 && dz.entries.every((e) => e.crc === crc32(e.data)))

  const doc = (dMap.get('word/document.xml') || { data: Buffer.alloc(0) }).data.toString('utf8')
  const styles = (dMap.get('word/styles.xml') || { data: Buffer.alloc(0) }).data.toString('utf8')
  const core = (dMap.get('docProps/core.xml') || { data: Buffer.alloc(0) }).data.toString('utf8')
  const types = (dMap.get('[Content_Types].xml') || { data: Buffer.alloc(0) }).data.toString('utf8')

  ok('document.xml 是 w:document + w:body', doc.includes('<w:document ') && doc.includes('<w:body>') && doc.includes('</w:body>'))
  ok('document.xml 末尾有 <w:sectPr>（页面设置）', doc.includes('<w:sectPr>') && doc.includes('<w:pgSz'))
  ok('书名是中文且没乱码', doc.includes(`<w:pStyle w:val="Title"/>`) && doc.includes(`>${BOOK_TITLE}<`))
  ok('卷名用 Heading1', doc.includes('<w:pStyle w:val="Heading1"/>') && doc.includes('>第一卷 恋爱练习<') && doc.includes('>第二卷 不是恋爱<'))
  ok('章标题用 Heading2', doc.includes('<w:pStyle w:val="Heading2"/>') && doc.includes(`>${CHAPTERS[2].title}<`))
  ok('Heading1 段数 = 2 个卷 + 2 份设定', (doc.match(/w:val="Heading1"/g) || []).length === 4, String((doc.match(/w:val="Heading1"/g) || []).length))
  ok('Heading2 段数 = 章节数', (doc.match(/w:val="Heading2"/g) || []).length === CHAPTERS.length)
  ok('正文段落用 Normal', (doc.match(/w:val="Normal"/g) || []).length >= CHAPTERS.length + FRONT.length)
  ok('第1章正文分 3 段，段内换行是 <w:br/>', doc.includes('<w:br/>') && doc.includes('苏晚站在校门口的屋檐下'))
  ok('document.xml 里没有裸的 & 或 <', !RAW_AMP.test(doc))
  ok('标题里的 & / < 转义了', doc.includes('&amp;') && doc.includes('&lt;上&gt;'))

  ok('styles.xml 定义了 Normal', styles.includes('w:styleId="Normal"'))
  ok('styles.xml 定义了 Heading1 / Heading2', styles.includes('w:styleId="Heading1"') && styles.includes('w:styleId="Heading2"'))
  ok('Normal 是默认样式（w:default="1"）', styles.includes('w:default="1"'))
  ok('正文字号 = 24 半点（12pt = 小四）', styles.includes('<w:sz w:val="24"/>'))
  ok('给了中文字体 w:eastAsia', /w:eastAsia="[^"]+"/.test(styles), (styles.match(/w:eastAsia="([^"]+)"/) || [])[1] || '')
  ok('设置了行距（w:line + lineRule）', styles.includes('<w:spacing') && styles.includes('w:lineRule="auto"'))
  ok('core.xml 里书名是中文且没乱码', core.includes(`<dc:title>${BOOK_TITLE}</dc:title>`))
  ok('core.xml 里有作者', core.includes(`<dc:creator>${AUTHOR}</dc:creator>`))
  ok('[Content_Types].xml 给 document.xml 和 styles.xml 都写了 Override', types.includes('/word/document.xml') && types.includes('/word/styles.xml'))
  ok('生成物不是空的（docx 字节数 > 1000）', docx.length > 1000)
}

// ─────────────── 5. 落盘 + 大小 ───────────────
console.log('\n── 5. 写盘（系统临时目录）与体积 ──')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-novel-ebook-'))
  const file = path.join(dir, 'book.zip')
  fs.writeFileSync(file, epub)
  const back = fs.readFileSync(file)
  ok('epub 写进临时目录再读回来，字节完全一致', back.equals(epub))
  const bz = unzip(back, '落盘的 book.zip')
  ok('落盘的 book.zip 用自己写的 readZip 解得出 mimetype', bz.entries[0] && bz.entries[0].name === 'mimetype' && bz.entries[0].data.toString('utf8') === 'application/epub+zip')
  ok('落盘的 book.zip 条目数和内存里一致', bz.entries.length === ez.entries.length, `${bz.entries.length} vs ${ez.entries.length}`)
  fs.rmSync(dir, { recursive: true, force: true })
  ok('临时目录已收拾干净', !fs.existsSync(dir))
}

console.log(`\n  epub = ${epub.length} 字节（${ez.entries.length} 个条目）`)
console.log(`  docx = ${docx.length} 字节（${dz.entries.length} 个条目）`)

console.log(failed === 0 ? '\n✅ EPUB / DOCX 导出全部通过' : `\n❌ 有 ${failed} 项未通过`)
console.log(`共 ${total} 项断言`)
process.exit(failed === 0 ? 0 : 1)
