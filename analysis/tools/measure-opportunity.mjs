/**
 * Measure the two token levers on real local traffic before shipping defaults:
 *
 *   A. tool-schema composition per request (description vs parameters), and
 *      what conservative description slimming would buy;
 *   B. tool-result compaction: per-rule contribution, never-worse gate pass
 *      rate (byte gate + token gate), and which tools actually benefit.
 *
 * Usage: node tools/measure-opportunity.mjs [--days 14] [--out FILE]
 */
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { collectSessionFiles, readSessionEvents, liveSurfaceEvents } from './session-log.mjs'
import { compactText, DEFAULT_RULES } from '../dsh-token-saver/lib/compress.js'

const tokenxUrl = pathToFileURL(
  join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'node_modules', 'tokenx', 'dist', 'index.mjs'),
).href
const { estimateTokenCount } = await import(tokenxUrl)

const args = process.argv.slice(2)
const argValue = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const days = Number(argValue('--days', '14'))
const sessionsRoot = argValue('--sessions', join(process.env.USERPROFILE ?? '', '.dsh', 'sessions'))
const outFile = argValue('--out', join(process.cwd(), 'reports', 'compaction-opportunity.md'))

const T = (s) => (s ? estimateTokenCount(s) : 0)
const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : 'n/a')

/** Sum every `description` string inside a JSON-schema node. */
function schemaDescriptionTokens(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return { tokens: 0, count: 0 }
  let tokens = 0
  let count = 0
  if (typeof node.description === 'string') {
    tokens += T(node.description)
    count++
  }
  if (Array.isArray(node.oneOf)) {
    for (const child of node.oneOf) {
      const sub = schemaDescriptionTokens(child, depth + 1)
      tokens += sub.tokens
      count += sub.count
    }
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const child of Object.values(node.properties)) {
      const sub = schemaDescriptionTokens(child, depth + 1)
      tokens += sub.tokens
      count += sub.count
    }
  }
  if (node.items) {
    const sub = schemaDescriptionTokens(node.items, depth + 1)
    tokens += sub.tokens
    count += sub.count
  }
  return { tokens, count }
}

/** Token cost when a description is trimmed the way the plugin would trim it. */
function trimmedDescriptionTokens(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return T(text)
  const slice = text.slice(0, maxChars)
  const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('。'), slice.lastIndexOf('. '))
  return T(cut > maxChars * 0.5 ? slice.slice(0, cut + 1) : slice)
}

const files = collectSessionFiles(sessionsRoot, days)
const schemaByTool = new Map()
const resultByTool = new Map()
const ruleTotals = { ansiChars: 0, encodedChars: 0, encodedFolded: 0, repeatRuns: 0, repeatLines: 0, blankLinesFolded: 0, jsonChars: 0, ceilingTrimmed: 0, ceilingOmittedLines: 0, ceilingRescued: 0 }
let schemaSamples = 0
let schemaTotalTokens = 0
let schemaTotalTrimmed = 0
let schemaDescTokens = 0
let schemaParamTokens = 0
let schemaParamDescTokens = 0
let sessionCount = 0

// Compaction measurement.
let resultCount = 0
let resultChars = 0
let compactedChars = 0
let skippedErrors = 0
let changedCount = 0
let byteGatePass = 0
let tokenGatePass = 0
let bothGatesPass = 0
let savedTokensOnPass = 0
let lostTokensOnFail = 0

const callNames = new Map()

for (const file of files) {
  let parsed
  try {
    parsed = readSessionEvents(file)
  } catch {
    continue
  }
  if (parsed.events.length === 0) continue
  sessionCount++

  // A. latest request header of this session.
  let header = null
  for (const event of parsed.events) {
    if (event.type === 'request/header' && Array.isArray(event.data?.header?.tools)) header = event.data.header
  }
  if (header) {
    schemaSamples++
    let sessionTokens = 0
    let sessionTrimmed = 0
    for (const tool of header.tools) {
      const name = tool.name ?? '(unnamed)'
      const descTokens = T(tool.description ?? '')
      const paramJson = JSON.stringify(tool.parameters ?? {})
      const paramTokens = T(paramJson)
      const paramDesc = schemaDescriptionTokens(tool.parameters ?? {})
      const trimmedDesc = trimmedDescriptionTokens(tool.description ?? '', 420)
      sessionTokens += descTokens + paramTokens
      sessionTrimmed += trimmedDesc + paramTokens
      const acc = schemaByTool.get(name) ?? { tools: 0, desc: 0, param: 0, paramDesc: 0, descChars: 0, trimmed: 0 }
      acc.tools++
      acc.desc += descTokens
      acc.param += paramTokens
      acc.paramDesc += paramDesc.tokens
      acc.descChars += (tool.description ?? '').length
      acc.trimmed += trimmedDesc
      schemaByTool.set(name, acc)
    }
    schemaTotalTokens += sessionTokens
    schemaTotalTrimmed += sessionTrimmed
    for (const tool of header.tools) {
      schemaDescTokens += T(tool.description ?? '')
      schemaParamTokens += T(JSON.stringify(tool.parameters ?? {}))
      schemaParamDescTokens += schemaDescriptionTokens(tool.parameters ?? {}).tokens
    }
  }

  // Map call ids to tool names, then compact the live surface results.
  for (const event of parsed.events) {
    if (event.type === 'tool/call') callNames.set(event.data.callId, event.data.name)
  }
  for (const event of liveSurfaceEvents(parsed.events)) {
    if (event.type !== 'tool/result') continue
    const blocks = event.data?.message?.content
    if (!Array.isArray(blocks)) continue
    const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
    if (!text) continue
    const toolName = callNames.get(event.data.message?.toolCallId) ?? '(unknown)'
    const isError = Boolean(event.data.message?.isError)
    resultCount++
    resultChars += text.length
    const tokensBefore = T(text)
    const { text: after, stats } = compactText(text, { toolName, isError, rules: DEFAULT_RULES })
    for (const key of Object.keys(ruleTotals)) ruleTotals[key] += stats[key] ?? 0
    const tokensAfter = T(after)
    compactedChars += after.length
    if (isError && DEFAULT_RULES.keepErrorsIntact) skippedErrors++
    const savedBytes = text.length - after.length
    const byteOk = after.length <= text.length * 0.72 && savedBytes >= 200
    const tokenOk = tokensAfter < tokensBefore
    if (changedCount !== undefined && after !== text) changedCount++
    if (byteOk) byteGatePass++
    if (tokenOk) tokenGatePass++
    const pass = byteOk && tokenOk
    if (pass) {
      bothGatesPass++
      savedTokensOnPass += tokensBefore - tokensAfter
    } else if (tokensAfter > tokensBefore) {
      lostTokensOnFail += tokensAfter - tokensBefore
    }
    const acc = resultByTool.get(toolName) ?? { n: 0, chars: 0, saved: 0, savedTokens: 0, pass: 0, tokens: 0 }
    acc.n++
    acc.chars += text.length
    acc.saved += savedBytes
    acc.tokens += tokensBefore
    if (pass) {
      acc.pass++
      acc.savedTokens += tokensBefore - tokensAfter
    }
    resultByTool.set(toolName, acc)
  }
}

const lines = []
const push = (s = '') => lines.push(s)
push('# 省 token 机会测量（本机真实会话数据）')
push()
push(`- 会话 ${sessionCount} 个（最近 ${days} 天），schema 样本 ${schemaSamples} 个请求头`)
push()

push('## A. 每次请求的工具 schema 构成')
push()
push(`| 组成 | tokens（平均/请求） | 占比 |`)
push(`| --- | ---: | ---: |`)
push(`| 全部工具 schema 合计 | ${fmt(schemaSamples ? schemaTotalTokens / schemaSamples : 0)} | 100% |`)
push(`| ├ 顶层 description | ${fmt(schemaSamples ? schemaDescTokens / schemaSamples : 0)} | ${pct(schemaDescTokens, schemaTotalTokens)} |`)
push(`| └ parameters JSON | ${fmt(schemaSamples ? schemaParamTokens / schemaSamples : 0)} | ${pct(schemaParamTokens, schemaTotalTokens)} |`)
push(`| &nbsp;&nbsp;&nbsp;└ 参数内 description | ${fmt(schemaSamples ? schemaParamDescTokens / schemaSamples : 0)} | ${pct(schemaParamDescTokens, schemaTotalTokens)} |`)
push()
push(`**只瘦身顶层 description（截断 420 字符）**：${fmt(schemaSamples ? schemaTotalTokens / schemaSamples : 0)} → ${fmt(schemaSamples ? schemaTotalTrimmed / schemaSamples : 0)} tokens/请求，省 ${pct(schemaTotalTokens - schemaTotalTrimmed, schemaTotalTokens)}`)
push()
push('| 工具（按 schema 成本） | description | parameters | 参数内 desc | 顶层 desc 字符 |')
push('| --- | ---: | ---: | ---: | ---: |')
const schemaRank = [...schemaByTool.entries()].sort((a, b) => b[1].desc + b[1].param - (a[1].desc + a[1].param)).slice(0, 18)
for (const [name, acc] of schemaRank) {
  push(`| ${name} | ${fmt(acc.desc / acc.tools)} | ${fmt(acc.param / acc.tools)} | ${fmt(acc.paramDesc / acc.tools)} | ${Math.round(acc.descChars / acc.tools)} |`)
}
push()

push('## B. 工具结果压缩')
push()
push(`- surface 内工具结果 ${resultCount} 条，共 ${fmt(resultChars)} 字符`)
push(`- 压缩后 ${fmt(compactedChars)} 字符（-${pct(resultChars - compactedChars, resultChars)}），其中错误结果按策略跳过 ${skippedErrors} 条`)
push(`- 双门控（≤72% 且省 ≥200 字符 + token 严格下降）通过 ${bothGatesPass} 条（${pct(bothGatesPass, resultCount)}），可省 ${fmt(savedTokensOnPass)} tokens`)
push(`- 仅字节门通过 ${byteGatePass}；仅 token 门通过 ${tokenGatePass}；token 反增的条目合计 +${fmt(lostTokensOnFail)} tokens（会被门控拦下）`)
push()
push('### 各规则贡献（全量）')
push()
push(`| 规则 | 命中 | 节省字符 |`)
push(`| --- | ---: | ---: |`)
push(`| 去 ANSI 转义 | - | ${fmt(ruleTotals.ansiChars)} |`)
push(`| 折叠重复行 | ${ruleTotals.repeatRuns} 段 / ${ruleTotals.repeatLines} 行 | - |`)
push(`| 折叠 base64/hex | ${ruleTotals.encodedFolded} 块 | ${fmt(ruleTotals.encodedChars)} |`)
push(`| 折叠连续空行 | ${ruleTotals.blankLinesFolded} 行 | - |`)
push(`| JSON 单行化（默认关） | - | ${fmt(ruleTotals.jsonChars)} |`)
push(`| 头尾窗口截断 | ${ruleTotals.ceilingOmittedLines} 行省略 | ${fmt(ruleTotals.ceilingTrimmed)} |`)
push(`| 中段错误行保留 | ${ruleTotals.ceilingRescued} 行 | - |`)
push()
push('### 按工具（字符节省）')
push()
push('| 工具 | 结果数 | 原字符 | 省字符 | 节省率 | 原 tokens | 门控通过可省 tokens |')
push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const [name, acc] of [...resultByTool.entries()].sort((a, b) => b[1].saved - a[1].saved).slice(0, 16)) {
  push(`| ${name} | ${acc.n} | ${fmt(acc.chars)} | ${fmt(acc.saved)} | ${pct(acc.saved, acc.chars)} | ${fmt(acc.tokens)} | ${fmt(acc.savedTokens)} |`)
}
push()

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
console.log(`\n[written] ${outFile}`)
