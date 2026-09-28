/**
 * EPUB 3 / DOCX 生成 —— 把「小说目录」里的东西排成阅读器和 Word 认的文件
 *
 * 两个入口都返回 Buffer，且都是"zip + 几个 XML"：
 *
 *   buildEpub({ title, author, language, chapters, frontMatter, identifier }) → EPUB 3
 *   buildDocx({ title, author, chapters, frontMatter })                       → DOCX
 *
 * 输入形状（两边一样）：
 *   chapters    [{ title, text, volume? }]   **按阅读顺序**；text 是纯文本，用 \n 分段
 *   frontMatter [{ title, text }]            可选：大纲 / 世界观 / 人物卡（就是 设定集.txt 那种内容）
 *   volume                                   可选：卷名，如「第一卷 恋爱练习」
 *
 * 分段规则（EPUB 和 DOCX 故意用**同一条**规则，别指望两边不一样）：
 *   - 一个或多个**空行** → 换段
 *   - 段内单个换行 → <br/>（EPUB）/ <w:br/>（DOCX），还算同一段
 *   为什么这么定：正文是用记事本写的，作者经常在一段话中间随手回车；
 *   把这些都当成新段落，排版会碎成一片。
 *
 * XML 转义：& < > " ' 五个预定义实体全转，中文**原样**（绝不动成 &#xxxxx;，
 * 那样文件大到没必要，记事本里也没法看）。顺手剥掉 XML 1.0 里非法的控制字符
 * （\x00-\x08 之类，多半是误粘贴带进来的），它们在文件里会让阅读器 / Word
 * 直接报"文件已损坏"，而且很难看出是哪来的。
 *
 * 真实的字节活儿都在 ./zip.js，这里只负责拼 XML。
 *
 * 已知的取舍（老实说）：
 *   - EPUB 不做封面图（要图片就得放二进制资源，现在只需要文字）；
 *   - EPUB 的 nav 是手写的，没做 landmarks 之外的语义增强；
 *   - DOCX 没有目录域（TOC 域要 Word 打开时更新，写死反而更烦），
 *     但标题用的是内置的 Heading1/Heading2，Word 里能直接生成导航。
 */

import crypto from 'node:crypto'
import { createZip } from './zip.js'

/** EPUB 的 mimetype 内容：必须一字不差，且不压缩地放在第一条 */
const EPUB_MIMETYPE = 'application/epub+zip'

/** EPUB 的样式表（章节里用 <link> 引它）。只做最基本的事：行距、段距、标题层次 */
const STYLE_CSS = `/* 电子书排版：只做最基本的事 —— 行距、段距、标题层次。
   阅读器大多会覆盖字体和字号，所以这里不写 font-family / font-size。 */
body {
  line-height: 1.7;
  margin: 0 0.5em;
  text-align: justify;
}

p {
  margin: 0 0 0.6em 0;
  text-indent: 2em; /* 中文段落首行缩进两字 */
}

h1 {
  font-size: 1.4em;
  line-height: 1.4;
  margin: 1em 0 0.8em 0;
  text-align: center;
  page-break-before: always; /* 每章另起一页 */
}

h2 {
  font-size: 1.1em;
  margin: 1em 0 0.5em 0;
}

nav ol {
  line-height: 1.6;
}
`

/** META-INF/container.xml：告诉阅读器 OPF（书的主描述文件）在哪 */
const CONTAINER_XML = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`

/** XHTML 的 doctype（EPUB 3 要求是 XHTML5，这个 doctype 是最保险的写法） */
const XHTML_DOCTYPE = '<!DOCTYPE html>'

/** DOCX 里 7 个必需的部件（少了任何一个，Word 会直接说"文件损坏"） */
const CT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
`

/** 包级关系：officeDocument 指到主文档，另外两个指属性部件 */
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
`

/** document.xml 的关系：只有一份 styles.xml */
const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
`

/** docProps/app.xml（扩展属性）。子元素按 schema 的顺序排，别随手调 */
const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Company></Company>
  <ScaleCrop>false</ScaleCrop>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <Application>dsh-novel</Application>
  <AppVersion>16.0000</AppVersion>
  <DocSecurity>0</DocSecurity>
</Properties>
`

/**
 * DOCX 样式表。
 *
 * 中文友好是关键：w:rFonts 里 **必须** 给 w:eastAsia 指定中文字体，
 * 只写 w:ascii 的话中文会落到 Word 的默认回退字体上（宋体/等线不一定，看版本）。
 *
 * 字号用"半点"：w:sz val="24" = 12pt = 小四（中文排版最常用的正文字号）。
 * 行距 w:line="360" lineRule="auto" = 1.5 倍行距。
 */
function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>
        <w:sz w:val="24"/>
        <w:szCs w:val="24"/>
        <w:lang w:val="en-US" w:eastAsia="zh-CN"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:line="360" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="auto"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:eastAsia="宋体"/>
      <w:sz w:val="24"/>
      <w:szCs w:val="24"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:jc w:val="center"/>
      <w:spacing w:before="240" w:after="240" w:line="360" w:lineRule="auto"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:eastAsia="Microsoft YaHei"/>
      <w:b/>
      <w:sz w:val="44"/>
      <w:szCs w:val="44"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:spacing w:before="360" w:after="120" w:line="360" w:lineRule="auto"/>
      <w:outlineLvl w:val="0"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:eastAsia="Microsoft YaHei"/>
      <w:b/>
      <w:sz w:val="32"/>
      <w:szCs w:val="32"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/>
      <w:outlineLvl w:val="1"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:eastAsia="Microsoft YaHei"/>
      <w:b/>
      <w:sz w:val="28"/>
      <w:szCs w:val="28"/>
    </w:rPr>
  </w:style>
</w:styles>
`
}

/** 宽松地取字符串（数字、null 都别炸） */
function str(v) {
  return v === undefined || v === null ? '' : String(v)
}

/** 章节正文里不该出现的控制字符（\t \n \r 是合法的，保留） */
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g

/**
 * XML 转义：五个预定义实体全转。
 * 中文**不**转 —— 转成 &#x4E2D; 会让文件大好几倍，人也看不懂。
 */
function xmlEscape(text) {
  return str(text)
    .replace(ILLEGAL_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 纯文本 → 段落数组（空行分段，段内换行留在段落字符串里）。
 * 行尾统一成 \n：Windows 的记事本写出来的是 \r\n，不统一后面到处要处理。
 */
function splitParagraphs(text) {
  return str(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/) // 一个或多个空行 = 分段
    .map((p) => p.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, ''))
    .filter(Boolean)
}

/** 一串正文 → EPUB 的 <p>（段内换行 = <br/>，先转义再插标签） */
function htmlParagraphs(text) {
  return splitParagraphs(text)
    .map((p) => `    <p>${xmlEscape(p).replace(/\n/g, '<br/>')}</p>`)
    .join('\n')
}

/** 一串正文 → DOCX 的若干 <w:p>（段内换行 = <w:br/>） */
function docxParagraphs(text, style) {
  return splitParagraphs(text)
    .map((p) => docxParagraph(style, p))
    .join('\n')
}

/** DOCX 一段：文本里的 \n 变成 <w:br/>，不另起一段 */
function docxParagraph(style, text) {
  const parts = xmlEscape(text).split('\n')
  const runs = parts
    .map((part, i) => (i > 0 ? '<w:br/>' : '') + (part ? `<w:t xml:space="preserve">${part}</w:t>` : ''))
    .join('')
  return `  <w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runs}</w:p>`
}

/** 章节列表洗一遍：标题空就给个「第N章」，卷名空就当成没有卷 */
function normalizeChapters(chapters) {
  const list = Array.isArray(chapters) ? chapters : []
  const out = []
  list.forEach((ch, i) => {
    if (typeof ch === 'string') {
      const text = ch.trim()
      if (text) out.push({ title: `第${out.length + 1}章`, text, volume: '' })
      return
    }
    if (!ch || typeof ch !== 'object') return
    const text = str(ch.text)
    if (!text.trim() && !str(ch.title).trim()) return // 标题正文都空，跳过
    out.push({
      title: str(ch.title).trim() || `第${i + 1}章`,
      text,
      volume: str(ch.volume).trim()
    })
  })
  return out
}

/** 设定集（大纲 / 世界观 / 人物卡）洗一遍 */
function normalizeFrontMatter(frontMatter) {
  const list = Array.isArray(frontMatter) ? frontMatter : []
  const out = []
  list.forEach((item, i) => {
    if (typeof item === 'string') {
      const text = item.trim()
      if (text) out.push({ title: `设定 ${out.length + 1}`, text })
      return
    }
    if (!item || typeof item !== 'object') return
    const text = str(item.text)
    if (!text.trim()) return
    out.push({ title: str(item.title).trim() || `设定 ${i + 1}`, text })
  })
  return out
}

/** 章节正文的文件名 / manifest id：chapter-001、chapter-002 …… */
function chapterSlug(index) {
  return `chapter-${String(index + 1).padStart(3, '0')}`
}

/** 一章在 OEBPS/ 里的相对路径 */
function chapterHref(index) {
  return `text/${chapterSlug(index)}.xhtml`
}

/**
 * 把章节按"连续的同一个卷"分组，方便 nav / ncx 里嵌套。
 * @returns {Array<{volume: string, items: number[]}>} items 是章节下标
 */
function groupByVolume(chapters) {
  const groups = []
  let i = 0
  while (i < chapters.length) {
    const volume = chapters[i].volume
    const items = []
    while (i < chapters.length && chapters[i].volume === volume) {
      items.push(i)
      i += 1
    }
    groups.push({ volume, items })
  }
  return groups
}

/** EPUB 3 的导航文档：有卷就嵌套 <ol>，没卷就平铺 */
function buildNavXhtml({ lang, title, chapters, hasFront }) {
  const lines = []
  if (hasFront) lines.push(`      <li><a href="text/front.xhtml">设定集</a></li>`)
  for (const group of groupByVolume(chapters)) {
    if (!group.volume) {
      for (const idx of group.items) {
        lines.push(`      <li><a href="${chapterHref(idx)}">${xmlEscape(chapters[idx].title)}</a></li>`)
      }
      continue
    }
    lines.push(`      <li><span>${xmlEscape(group.volume)}</span>`)
    lines.push('        <ol>')
    for (const idx of group.items) {
      lines.push(`          <li><a href="${chapterHref(idx)}">${xmlEscape(chapters[idx].title)}</a></li>`)
    }
    lines.push('        </ol>')
    lines.push('      </li>')
  }

  const body = [
    '    <nav epub:type="toc" id="toc">',
    '      <h1>目录</h1>',
    '      <ol>',
    ...lines,
    '      </ol>',
    '    </nav>'
  ]
  // landmarks 是给阅读器"跳转到正文"用的，可选但很便宜
  if (chapters.length) {
    body.push('    <nav epub:type="landmarks" hidden="hidden">')
    body.push('      <h2>书标</h2>')
    body.push('      <ol>')
    body.push(`        <li><a epub:type="bodymatter" href="${chapterHref(0)}">正文</a></li>`)
    body.push('      </ol>')
    body.push('    </nav>')
  }

  return `<?xml version="1.0" encoding="utf-8"?>
${XHTML_DOCTYPE}
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xmlEscape(lang)}" lang="${xmlEscape(lang)}">
  <head>
    <meta charset="utf-8"/>
    <title>${xmlEscape(title)}</title>
  </head>
  <body>
${body.join('\n')}
  </body>
</html>
`
}

/**
 * toc.ncx —— EPUB 2 的老目录，给不认 EPUB 3 nav 的老阅读器兜底。
 * playOrder 必须全局递增；卷的 navPoint 先占号，再往里塞子点，这样父 < 子。
 */
function buildNcx({ uid, title, chapters, frontTitle }) {
  let order = 0
  const points = []

  if (frontTitle) {
    order += 1
    points.push(
      `    <navPoint id="navPoint-${order}" playOrder="${order}">` +
        `<navLabel><text>${xmlEscape(frontTitle)}</text></navLabel>` +
        `<content src="text/front.xhtml"/></navPoint>`
    )
  }

  for (const group of groupByVolume(chapters)) {
    if (!group.volume) {
      for (const idx of group.items) {
        order += 1
        points.push(
          `    <navPoint id="navPoint-${order}" playOrder="${order}">` +
            `<navLabel><text>${xmlEscape(chapters[idx].title)}</text></navLabel>` +
            `<content src="${chapterHref(idx)}"/></navPoint>`
        )
      }
      continue
    }
    order += 1
    const parentOrder = order
    const kids = []
    for (const idx of group.items) {
      order += 1
      kids.push(
        `      <navPoint id="navPoint-${order}" playOrder="${order}">` +
          `<navLabel><text>${xmlEscape(chapters[idx].title)}</text></navLabel>` +
          `<content src="${chapterHref(idx)}"/></navPoint>`
      )
    }
    points.push(
      `    <navPoint id="navPoint-${parentOrder}" playOrder="${parentOrder}">\n` +
        `      <navLabel><text>${xmlEscape(group.volume)}</text></navLabel>\n` +
        `      <content src="${chapterHref(group.items[0])}"/>\n` +
        `${kids.join('\n')}\n` +
        `    </navPoint>`
    )
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${xmlEscape(uid)}"/>
    <meta name="dtb:depth" content="2"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${xmlEscape(title)}</text></docTitle>
  <navMap>
${points.join('\n')}
  </navMap>
</ncx>
`
}

/** 一章 / 一节正文页（`css` 传相对路径，nav.xhtml 不引样式表就传空） */
function buildTextXhtml({ lang, title, body, css }) {
  const head = ['    <meta charset="utf-8"/>', `    <title>${xmlEscape(title)}</title>`]
  if (css) head.push(`    <link rel="stylesheet" type="text/css" href="${xmlEscape(css)}"/>`)
  return `<?xml version="1.0" encoding="utf-8"?>
${XHTML_DOCTYPE}
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xmlEscape(lang)}" lang="${xmlEscape(lang)}">
  <head>
${head.join('\n')}
  </head>
  <body>
${body}
  </body>
</html>
`
}

/** OEBPS/content.opf —— EPUB 3 的包文件（书的"主描述"） */
function buildOpf({ uid, title, author, lang, modified, chapters, hasFront }) {
  const metadata = [
    `    <dc:identifier id="bookid">${xmlEscape(uid)}</dc:identifier>`,
    `    <dc:title>${xmlEscape(title)}</dc:title>`
  ]
  if (author) metadata.push(`    <dc:creator>${xmlEscape(author)}</dc:creator>`)
  metadata.push(`    <dc:language>${xmlEscape(lang)}</dc:language>`)
  // dcterms:modified 是 EPUB 3 **必需**的（epubcheck 报 RSC-005 就是少了它）。
  // dcterms 是 OPF 规范里保留的前缀，不用另外声明。
  metadata.push(`    <meta property="dcterms:modified">${modified}</meta>`)

  const manifest = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '    <item id="css" href="style.css" media-type="text/css"/>'
  ]
  const spine = []
  if (hasFront) {
    manifest.push('    <item id="front" href="text/front.xhtml" media-type="application/xhtml+xml"/>')
    spine.push('    <itemref idref="front"/>')
  }
  chapters.forEach((ch, i) => {
    const slug = chapterSlug(i)
    manifest.push(`    <item id="${slug}" href="${chapterHref(i)}" media-type="application/xhtml+xml"/>`)
    spine.push(`    <itemref idref="${slug}"/>`)
  })

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${xmlEscape(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${metadata.join('\n')}
  </metadata>
  <manifest>
${manifest.join('\n')}
  </manifest>
  <spine toc="ncx">
${spine.join('\n')}
  </spine>
</package>
`
}

/** ISO 时间去掉毫秒，变成 EPUB 要的 `2024-01-01T00:00:00Z` */
function epubTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * 生成 EPUB 3（返回 Buffer，直接写盘就是 .epub）。
 *
 * @param {{title?: string, author?: string, language?: string,
 *          chapters?: Array<{title: string, text: string, volume?: string}>,
 *          frontMatter?: Array<{title: string, text: string}>,
 *          identifier?: string}} [input]
 * @returns {Buffer}
 */
export function buildEpub(input = {}) {
  const opts = input && typeof input === 'object' ? input : {}
  const title = str(opts.title).trim() || '未命名'
  const author = str(opts.author).trim()
  const lang = str(opts.language).trim() || 'zh-CN'
  // 没给 identifier 就现造一个 —— EPUB 要求 dc:identifier 全局唯一
  const uid = str(opts.identifier).trim() || `urn:uuid:${crypto.randomUUID()}`
  const modified = epubTimestamp(new Date())
  const chapters = normalizeChapters(opts.chapters)
  const front = normalizeFrontMatter(opts.frontMatter)

  const files = []
  // ① mimetype：第一条 + 不压缩（见 zip.js 文件头注释第 2 点）
  files.push({ name: 'mimetype', data: EPUB_MIMETYPE, store: true })
  files.push({ name: 'META-INF/container.xml', data: CONTAINER_XML })
  files.push({
    name: 'OEBPS/content.opf',
    data: buildOpf({ uid, title, author, lang, modified, chapters, hasFront: front.length > 0 })
  })
  files.push({
    name: 'OEBPS/nav.xhtml',
    data: buildNavXhtml({ lang, title, chapters, hasFront: front.length > 0 })
  })
  files.push({
    name: 'OEBPS/toc.ncx',
    data: buildNcx({ uid, title, chapters, frontTitle: front.length ? '设定集' : '' })
  })
  files.push({ name: 'OEBPS/style.css', data: STYLE_CSS })

  // ② 设定集：全部塞进一个 front.xhtml，每份设定一个 <h2>
  if (front.length) {
    const body = [`    <h1>设定集</h1>`]
    for (const item of front) {
      body.push(`    <h2>${xmlEscape(item.title)}</h2>`)
      const paras = htmlParagraphs(item.text)
      if (paras) body.push(paras)
    }
    files.push({ name: 'OEBPS/text/front.xhtml', data: buildTextXhtml({ lang, title: '设定集', body: body.join('\n'), css: '../style.css' }) })
  }

  // ③ 每章一个 xhtml
  chapters.forEach((ch, i) => {
    const body = [`    <h1>${xmlEscape(ch.title)}</h1>`]
    const paras = htmlParagraphs(ch.text)
    if (paras) body.push(paras)
    files.push({
      name: `OEBPS/${chapterHref(i)}`,
      data: buildTextXhtml({ lang, title: ch.title, body: body.join('\n'), css: '../style.css' })
    })
  })

  return createZip(files)
}

/** DOCX 的 core.xml（书名/作者/时间），命名空间一个都不能少 */
function buildCoreXml({ title, author, stamp }) {
  const lines = [`  <dc:title>${xmlEscape(title)}</dc:title>`]
  if (author) {
    lines.push(`  <dc:creator>${xmlEscape(author)}</dc:creator>`)
    lines.push(`  <cp:lastModifiedBy>${xmlEscape(author)}</cp:lastModifiedBy>`)
  }
  lines.push(`  <dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>`)
  lines.push(`  <dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>`)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${lines.join('\n')}
</cp:coreProperties>
`
}

/** 署名的那个小段落（居中、小一号、灰色） */
function docxByline(text) {
  const rpr = '<w:rPr><w:sz w:val="21"/><w:szCs w:val="21"/><w:color w:val="595959"/></w:rPr>'
  return (
    `  <w:p><w:pPr><w:jc w:val="center"/>${rpr}</w:pPr>` +
    `<w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`
  )
}

/**
 * 生成 DOCX（返回 Buffer，直接写盘就是 .docx）。
 *
 * @param {{title?: string, author?: string,
 *          chapters?: Array<{title: string, text: string, volume?: string}>,
 *          frontMatter?: Array<{title: string, text: string}>}} [input]
 * @returns {Buffer}
 */
export function buildDocx(input = {}) {
  const opts = input && typeof input === 'object' ? input : {}
  const title = str(opts.title).trim() || '未命名'
  const author = str(opts.author).trim()
  const stamp = epubTimestamp(new Date())
  const chapters = normalizeChapters(opts.chapters)
  const front = normalizeFrontMatter(opts.frontMatter)

  const body = [docxParagraph('Title', title)]
  if (author) body.push(docxByline(author))

  // 设定集排在正文前面：每份设定一个 Heading1（Word 导航窗格里能直接跳）
  for (const item of front) {
    body.push(docxParagraph('Heading1', item.title))
    const paras = docxParagraphs(item.text, 'Normal')
    if (paras) body.push(paras)
  }

  // 正文：卷名变了就出一个 Heading1，章标题 Heading2，正文 Normal
  let prevVolume = null
  chapters.forEach((ch) => {
    if (ch.volume && ch.volume !== prevVolume) body.push(docxParagraph('Heading1', ch.volume))
    prevVolume = ch.volume
    body.push(docxParagraph('Heading2', ch.title))
    const paras = docxParagraphs(ch.text, 'Normal')
    if (paras) body.push(paras)
  })

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
${body.join('\n')}
  <w:sectPr>
    <w:pgSz w:w="11906" w:h="16838"/>
    <w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/>
  </w:sectPr>
</w:body>
</w:document>
`

  // [Content_Types].xml 放第一条：OPC 没强制要求顺序，但读者（和某些校验器）习惯先看它
  return createZip([
    { name: '[Content_Types].xml', data: CT_XML },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: stylesXml() },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'docProps/core.xml', data: buildCoreXml({ title, author, stamp }) },
    { name: 'docProps/app.xml', data: APP_XML }
  ])
}
