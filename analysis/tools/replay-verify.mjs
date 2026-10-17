/**
 * Replay verification: run the shipped folding logic against the real tool
 * schemas recorded in local session logs and check both the saving and the
 * safety properties (no tool disappears, no dangling $ref, schemas shrink).
 *
 * Usage: node tools/replay-verify.mjs [--days 14] [--out FILE]
 */
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { collectSessionFiles, readSessionEvents } from './session-log.mjs'
import { foldTools, foldTool, skeletonize, schemaTokens, estimateTokens } from '../dsh-token-saver/lib/fold.js'

const args = process.argv.slice(2)
const argValue = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const days = Number(argValue('--days', '14'))
const sessionsRoot = argValue('--sessions', join(process.env.USERPROFILE ?? '', '.dsh', 'sessions'))
const outFile = argValue('--out', join(process.cwd(), 'reports', 'replay-verification.md'))

const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : 'n/a')

const headers = []
for (const file of collectSessionFiles(sessionsRoot, days)) {
  let parsed
  try {
    parsed = readSessionEvents(file)
  } catch {
    continue
  }
  let latest = null
  for (const event of parsed.events) {
    if (event.type === 'request/header' && Array.isArray(event.data?.header?.tools)) latest = event.data.header.tools
  }
  if (latest && latest.length > 0) headers.push(latest)
}
if (headers.length === 0) throw new Error('no request headers found')

const problems = []
let beforeTotal = 0
let afterTotal = 0
let foldedCount = 0
let toolsSeen = 0
const foldedNames = new Map()
const perHeader = []

for (const tools of headers) {
  const before = tools.reduce((acc, tool) => acc + schemaTokens(tool), 0)
  const result = foldTools(tools, { foldThresholdTokens: 2000, minVisibleTools: 4 })
  const after = result.tools.reduce((acc, tool) => acc + schemaTokens(tool), 0)

  // Safety 1: every tool still exists, exactly once, in the same order.
  if (result.tools.length !== tools.length) problems.push('tool count changed')
  for (let i = 0; i < tools.length; i++) {
    if (result.tools[i].name !== tools[i].name) problems.push(`order/name drift at ${i}: ${tools[i].name}`)
  }
  // Safety 2: folding never grows a schema.
  for (let i = 0; i < tools.length; i++) {
    if (schemaTokens(result.tools[i]) > schemaTokens(tools[i])) problems.push(`schema grew: ${tools[i].name}`)
  }
  // Safety 3: a folded skeleton must not carry a `$ref` whose `$defs` were
  // dropped. Untouched tools keep their own self-contained $ref/$defs pair, so
  // only fold products are checked here.
  for (const toolName of result.folded) {
    const folded = result.tools.find((tool) => tool.name === toolName)
    const json = JSON.stringify(folded?.parameters ?? {})
    if (json.includes('$ref')) problems.push(`dangling $ref in folded schema: ${toolName}`)
    if (json.includes('$defs')) problems.push(`leftover $defs in folded schema: ${toolName}`)
  }
  // Safety 4: every folded tool still advertises the lookup path.
  for (const toolName of result.folded) {
    const folded = result.tools.find((tool) => tool.name === toolName)
    if (!folded || !folded.description.includes('tool_schema')) problems.push(`missing lookup hint: ${toolName}`)
    if (!folded.parameters || folded.parameters.type !== 'object') problems.push(`unusable skeleton: ${toolName}`)
  }

  beforeTotal += before
  afterTotal += after
  foldedCount += result.folded.length
  toolsSeen += tools.length
  for (const toolName of result.folded) foldedNames.set(toolName, (foldedNames.get(toolName) ?? 0) + 1)
  perHeader.push({ tools: tools.length, before, after, folded: result.folded.length })
}

const lines = []
const push = (s = '') => lines.push(s)
push('# 回放验证：工具 schema 折叠（真实会话数据）')
push()
push(`- 采样 ${headers.length} 个会话的最终请求头，共 ${toolsSeen} 个工具条目（含重复）`)
push(`- 折叠前 schema 合计 ${fmt(beforeTotal)} tokens → 折叠后 ${fmt(afterTotal)} tokens，省 ${pct(beforeTotal - afterTotal, beforeTotal)}`)
push(`- 平均每个请求：${fmt(beforeTotal / headers.length)} → ${fmt(afterTotal / headers.length)} tokens（省 ${fmt((beforeTotal - afterTotal) / headers.length)}）`)
push(`- 共折叠 ${foldedCount} 个工具条目（平均 ${(foldedCount / headers.length).toFixed(1)} 个/请求）`)
const affected = perHeader.filter((row) => row.folded > 0)
if (affected.length > 0) {
  const beforeAffected = affected.reduce((acc, row) => acc + row.before, 0)
  const afterAffected = affected.reduce((acc, row) => acc + row.after, 0)
  push(
    `- 只看真正发生折叠的 ${affected.length} 个会话：${fmt(beforeAffected / affected.length)} → ${fmt(afterAffected / affected.length)} tokens/请求，省 ${pct(beforeAffected - afterAffected, beforeAffected)}（${fmt((beforeAffected - afterAffected) / affected.length)}/请求）`,
  )
  push(`- 其余 ${perHeader.length - affected.length} 个会话没有超过阈值的工具，一个字节都不会改动（fail-open）`)
}
push()
push('## 安全性检查')
push()
push(problems.length === 0 ? '- ✅ 全部通过：工具数量与顺序不变、没有任何 schema 变大、折叠后的 schema 无悬空 `$ref`、每个被折叠工具都带有 `tool_schema` 查询提示、骨架均为合法 object schema' : `- ❌ 发现 ${problems.length} 个问题：\n${[...new Set(problems)].slice(0, 20).map((p) => `  - ${p}`).join('\n')}`)
push()
push('## 被折叠最多的工具')
push()
push('| 工具 | 出现次数 | 原 schema tokens（估算） |')
push('| --- | ---: | ---: |')
const ranked = [...foldedNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
for (const [toolName, count] of ranked) {
  const sample = headers.map((tools) => tools.find((tool) => tool.name === toolName)).find(Boolean)
  push(`| ${toolName} | ${count} | ${sample ? fmt(schemaTokens(sample)) : '?'} |`)
}
push()
push('## 每个会话的折叠结果（前 15）')
push()
push('| # | 工具数 | 折叠前 tokens | 折叠后 tokens | 省 | 折叠数 |')
push('| ---: | ---: | ---: | ---: | ---: | ---: |')
perHeader.slice(0, 15).forEach((row, i) => {
  push(`| ${i + 1} | ${row.tools} | ${fmt(row.before)} | ${fmt(row.after)} | ${pct(row.before - row.after, row.before)} | ${row.folded} |`)
})
push()
push('## 折叠样例（最大工具，前 600 字符）')
push()
const biggest = headers
  .flatMap((tools) => tools)
  .map((tool) => ({ tool, cost: schemaTokens(tool) }))
  .sort((a, b) => b.cost - a.cost)[0]
if (biggest) {
  const folded = foldTool(biggest.tool, {})
  push(`原 schema：${fmt(biggest.cost)} tokens（${JSON.stringify(biggest.tool.parameters).length} 字符）`)
  push(`折叠后：${fmt(schemaTokens(folded))} tokens`)
  push('```json')
  push(JSON.stringify(folded, null, 1).slice(0, 900))
  push('```')
  push()
  push(`注：完整原 schema 可由 \`tool_schema("${biggest.tool.name}")\` 原样取回（回放验证另见单测 plugin.test.mjs）。`)
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
console.log(`\n[written] ${outFile}`)
console.log(`problems: ${problems.length}`)
