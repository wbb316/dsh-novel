/**
 * 最小 ZIP 写入器 —— 零依赖，只借 node:zlib 的 deflateRaw
 *
 * 为什么要自己写（而不是 jszip / archiver / yazl）：
 *   这个插件的卖点就是"零依赖，装完就能跑"，package.json 不许加东西；
 *   而我们要写的东西很窄 —— EPUB 和 DOCX 都是"一堆小文件打个包"，
 *   不需要 ZIP64、不需要加密、不需要流式、也不需要数据描述符
 *   （压缩前后的大小在写之前就算得出来，直接写进 local header）。
 *   于是自己写 ZIP 反而更短、更可控。
 *
 * 文件里的字节顺序：
 *
 *   ┌─────────────────────────────────────────────────┐
 *   │ [Local File Header][name][data]    ← 条目 1     │
 *   │ [Local File Header][name][data]    ← 条目 2     │
 *   │ ……                                             │
 *   │ [Central Directory Header][name]   ← 条目 1     │
 *   │ ……                                             │
 *   │ [End of Central Directory]                      │
 *   └─────────────────────────────────────────────────┘
 *
 * 中央目录故意放在**最后**：解压工具从尾巴上的 EOCD 找到中央目录，
 * 再按中央目录里记的偏移回到每个 local header。所以中央目录里的
 * "relative offset of local header" 指的是 **local header 的起始偏移**，
 * 不是数据偏移（差 30 + 文件名长度 + extra 长度）。
 *
 * 两个必须写对的地方（写错 = 别的软件打不开）：
 *
 *   1) 通用位标记 bit 11 = 0x0800。置上它，文件名才按 UTF-8 解释 ——
 *      像 `OEBPS/text/第001章.xhtml` 这种中文名在任何解压工具里都不乱码。
 *      没置的话 WinRAR/7-Zip 会按 CP437/GBK 猜，中文名直接变乱码。
 *
 *   2) EPUB 的 `mimetype` 必须 **不压缩（method 0）** 并且 **排在第一个**，
 *      而且这一条的 local header 不能带 extra field —— 因为 OCF 规范要求
 *      它的正文从**第 38 字节**开始（30 字节 local header + 8 字节文件名
 *      "mimetype"）。阅读器和 epubcheck 就是读那一段原文来认 EPUB 的；
 *      压缩了、挪位置了、或者 extra field 把正文推后了，都认不出来，
 *      只会被当成一个普通 zip（双击打开是一包文件，不是书）。
 *      这也是为什么 createZip 支持每条自己选 store / deflate。
 */

import zlib from 'node:zlib'

/** 通用位标记：bit 11 = 文件名是 UTF-8（见文件头注释第 1 点） */
const FLAG_UTF8 = 0x0800

/** 压缩方法 */
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** 校验码用的魔术常量（IEEE 802.3 多项式，反射写法） */
const CRC_POLY = 0xedb88320

/**
 * CRC-32 查表（256 项）。表只算一次，之后每条数据都是 O(n) 的字节循环。
 * 用 Int32Array 是因为运算是按 32 位有符号做的，最后再 >>> 0 转成无符号。
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? CRC_POLY ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** 把 string / Buffer / TypedArray 统一成 Buffer（string 按 utf8） */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (data === undefined || data === null) return Buffer.alloc(0)
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return Buffer.from(String(data), 'utf8')
}

/**
 * 标准 CRC-32（IEEE，和 `cksum -c` / ZIP 里用的是同一个），返回**无符号** 32 位整数。
 *
 * 用法就是算"压缩前的原始数据"的校验码 —— ZIP 里的 CRC 永远是原始数据的，
 * 不是压缩后的。填错了解压工具会报"CRC 校验失败 / 文件已损坏"。
 *
 * @param {Buffer|string|Uint8Array} buf
 * @returns {number} 0 ~ 0xFFFFFFFF
 */
export function crc32(buf) {
  const data = toBuffer(buf)
  let c = 0xffffffff
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * JS 的 Date → DOS 时间戳（ZIP 用的就是 MS-DOS 那套古董格式）。
 *
 *   date（2 字节）：bit15-9 年（相对 1980）、bit8-5 月、bit4-0 日
 *   time（2 字节）：bit15-11 时、bit10-5 分、bit4-0 秒/2（**只有 2 秒精度**）
 *
 * DOS 的年从 1980 起算，7 位最多到 2107 —— 超出就夹住，
 * 免得写出一个非法的时间戳让某些工具判文件损坏。
 */
function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  return { dosDate, dosTime }
}

/**
 * 打一个 ZIP 包。
 *
 * @param {Array<{name: string, data: Buffer|string|Uint8Array, store?: boolean}>} entries
 *   - name  用 `/` 分隔（ZIP 规范只认正斜杠），可以有中文；结尾不要加 `/`（这里不写目录项）
 *   - data  string 按 utf8 编码
 *   - store true = 不压缩（method 0），默认 false = deflate（method 8）
 *           EPUB 的 mimetype 这一条必须 store: true
 * @returns {Buffer}
 */
export function createZip(entries) {
  const list = Array.isArray(entries) ? entries : []
  const now = new Date()
  const { dosDate, dosTime } = dosDateTime(now)

  /** 已经写好的字节块，最后一次性 concat（比反复 Buffer.concat 快得多） */
  const chunks = []
  /** 中央目录要用的信息（每条一份） */
  const records = []
  /** 游标：下一个 local header 会写在这个偏移上 */
  let offset = 0

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const name = raw.name === undefined || raw.name === null ? '' : String(raw.name)
    if (!name) continue

    const nameBuf = Buffer.from(name, 'utf8')
    const data = toBuffer(raw.data)
    const store = raw.store === true || raw.method === METHOD_STORE
    const method = store ? METHOD_STORE : METHOD_DEFLATE
    // deflateRawSync：只做 deflate 本体，不带 zlib 头和 Adler-32
    // —— ZIP 要的就是裸 deflate（带头的那个是 gzip/zlib，塞进去解压工具会报错）
    const body = store ? data : zlib.deflateRawSync(data)
    const sum = crc32(data)

    // ── Local File Header（30 字节 + 文件名，没有 extra） ──
    //   0  签名            0x04034b50  "PK\x03\x04"
    //   4  version needed  20 = 2.0（deflate 从 2.0 开始支持，20 够用）
    //   6  general flag    0x0800（UTF-8 文件名）
    //   8  method          0 / 8
    //  10  mod time / date DOS 格式
    //  14  crc-32          原始数据的
    //  18  compressed size 压缩后（store 时 == 原始大小）
    //  22  uncompressed size
    //  26  name length / 28 extra length（0）
    //  30  文件名（UTF-8 字节）
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    records.push({ nameBuf, method, dosDate, dosTime, sum, compSize: body.length, size: data.length, offset })
    chunks.push(local, nameBuf, body)
    offset += local.length + nameBuf.length + body.length
  }

  // ── Central Directory：每条 46 字节 + 文件名 ──
  // 比 local header 多的字段里，真正有用的是最后那个 offset（指回 local header）
  const centralOffset = offset
  let centralSize = 0
  for (const rec of records) {
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // 签名 "PK\x01\x02"
    cd.writeUInt16LE(20, 4) // version made by：20 = 2.0，平台 0（MS-DOS）
    cd.writeUInt16LE(20, 6) // version needed to extract
    cd.writeUInt16LE(FLAG_UTF8, 8) // 通用位标记（和 local header 保持一致）
    cd.writeUInt16LE(rec.method, 10)
    cd.writeUInt16LE(rec.dosTime, 12)
    cd.writeUInt16LE(rec.dosDate, 14)
    cd.writeUInt32LE(rec.sum, 16)
    cd.writeUInt32LE(rec.compSize, 20)
    cd.writeUInt32LE(rec.size, 24)
    cd.writeUInt16LE(rec.nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // extra field length
    cd.writeUInt16LE(0, 32) // file comment length
    cd.writeUInt16LE(0, 34) // 起始磁盘号（不分卷，恒 0）
    cd.writeUInt16LE(0, 36) // internal attributes
    cd.writeUInt32LE(0, 38) // external attributes（0 = 普通文件，不写 unix 权限位）
    cd.writeUInt32LE(rec.offset, 42) // ← 这个 local header 的起始偏移
    chunks.push(cd, rec.nameBuf)
    centralSize += cd.length + rec.nameBuf.length
  }

  // ── End of Central Directory（22 字节，末尾没有注释） ──
  //   0  签名 "PK\x05\x06"
  //   4  本磁盘号 / 6 中央目录起始磁盘号（都是 0）
  //   8  本磁盘上的条目数 / 10 总条目数
  //  12  中央目录大小 / 16 中央目录起始偏移
  //  20  注释长度（0）
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(records.length, 8)
  eocd.writeUInt16LE(records.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  eocd.writeUInt16LE(0, 20)
  chunks.push(eocd)

  return Buffer.concat(chunks)
}
