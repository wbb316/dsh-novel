/**
 * 读文本的两个小工具 —— 存在的唯一理由是**去掉 UTF-8 BOM**。
 *
 * 为什么非要有它：
 *   Windows 上「记事本另存为 UTF-8」和 PowerShell 5.1 的
 *   `Set-Content -Encoding UTF8` / `Out-File` 都会在文件开头写上 `EF BB BF`。
 *   而 `JSON.parse` **不认 BOM**：
 *
 *       JSON.parse('\uFEFF{}')   →   SyntaxError: Unexpected token '﻿'
 *
 *   于是「用户拿记事本改了一下 角色.json」就能把整个插件打瘸。
 *
 *   最惨的一次不是数据文件，是插件自己的 package.json 被写进了 BOM：
 *   dsh web 启动时 `loadProfileDirectory` 里那句
 *   `JSON.parse(readFileSync(pkg, 'utf8'))` 直接抛错 → composeProfile 阶段退出
 *   → 3080 根本没监听（看起来只是"网页打不开"，完全看不出是 BOM 的锅）。
 *
 * 结论：**凡是从磁盘读进来要交给 JSON.parse / 给人看的文本，一律先过 stripBom()。**
 */
import fs from 'node:fs'

/** 去掉开头那个 U+FEFF（BOM 按 utf8 解码后就是这一个字符）。非字符串、没 BOM 都原样返回 */
export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 读文本文件（utf8），顺带去掉 BOM */
export function readText(file) {
  return stripBom(fs.readFileSync(file, 'utf8'))
}

/** 解析 JSON 文本，顺带去掉 BOM */
export function parseJsonText(text) {
  return JSON.parse(stripBom(text))
}

/** 读 + 解析 JSON 文件，顺带去掉 BOM */
export function readJson(file) {
  return parseJsonText(fs.readFileSync(file, 'utf8'))
}
