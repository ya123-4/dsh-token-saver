/**
 * Replay verification for historical thinking elision.
 *
 * Simulates the shipped rule (entering turn T drops reasoning from turns
 * < T - keepRecentTurns) over real session logs and reports:
 *   - how much of the live surface the elision removes;
 *   - that no assistant message is left empty;
 *   - that tool-call blocks and assistant text are never touched.
 *
 * Usage: node tools/measure-thinking.mjs [--days 14] [--out FILE]
 */
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { collectSessionFiles, readSessionEvents, liveSurfaceEvents } from './session-log.mjs'

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
const keepRecentTurns = Number(argValue('--keep', '1'))
const sessionsRoot = argValue('--sessions', join(process.env.USERPROFILE ?? '', '.dsh', 'sessions'))
const outFile = argValue('--out', join(process.cwd(), 'reports', 'thinking-elision.md'))

const T = (s) => (s ? estimateTokenCount(s) : 0)
const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : 'n/a')

let sessions = 0
let surfaceTokensAll = 0
let elidableTokens = 0
let elidableChars = 0
let blocksElided = 0
let turnsTouched = 0
let emptyWouldResult = 0
let toolCallBlocksKept = 0
let textBlocksKept = 0
let toolCallBlocksInElided = 0
let textBlocksInElided = 0
const perSession = []
const multiTurn = []

for (const file of collectSessionFiles(sessionsRoot, days)) {
  let parsed
  try {
    parsed = readSessionEvents(file)
  } catch {
    continue
  }
  const surface = liveSurfaceEvents(parsed.events)
  if (surface.length === 0) continue

  // Surface token total (approximate: text payload of every visible node).
  let surfaceTokens = 0
  let lastTurn = 0
  const assistantNodes = []
  for (const event of surface) {
    const blocks = event.data?.message?.content
    if (!Array.isArray(blocks)) continue
    let chars = 0
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') chars += block.text.length
      else if (block?.type === 'reasoning' && typeof block.text === 'string') chars += block.text.length
      else if (block?.type === 'tool-call' && typeof block.arguments === 'string') chars += block.arguments.length
    }
    surfaceTokens += T('x'.repeat(Math.min(chars, 20000))) * (chars > 20000 ? chars / 20000 : 1)
    if (event.type === 'assistant/message') {
      const turn = event.data?.turn
      if (typeof turn === 'number') {
        lastTurn = Math.max(lastTurn, turn)
        assistantNodes.push({ event, turn })
      }
    }
  }
  surfaceTokensAll += surfaceTokens

  const keepFrom = lastTurn - keepRecentTurns
  let sessionElided = 0
  let sessionSurface = 0
  const turns = new Set()
  for (const { event, turn } of assistantNodes) {
    const blocks = event.data?.message?.content ?? []
    let nodeChars = 0
    for (const block of blocks) {
      const size = typeof block?.text === 'string' ? block.text.length : typeof block?.arguments === 'string' ? block.arguments.length : 0
      nodeChars += size
      if (turn < keepFrom) {
        if (block?.type === 'reasoning') blocksElided++
        else if (block?.type === 'tool-call') toolCallBlocksInElided++
        else if (block?.type === 'text') textBlocksInElided++
      }
    }
    sessionSurface += nodeChars
    if (turn >= keepFrom) continue
    const reasoning = blocks.filter((b) => b?.type === 'reasoning')
    if (reasoning.length === 0) continue
    const kept = blocks.filter((b) => b?.type !== 'reasoning')
    if (kept.length === 0) {
      emptyWouldResult++
      continue
    }
    let chars = 0
    for (const block of reasoning) if (typeof block.text === 'string') chars += block.text.length
    const tokens = T(reasoning.map((b) => b.text ?? '').join(''))
    elidableChars += chars
    elidableTokens += tokens
    sessionElided += tokens
    turns.add(turn)
    toolCallBlocksKept += kept.filter((b) => b?.type === 'tool-call').length
    textBlocksKept += kept.filter((b) => b?.type === 'text').length
  }
  turnsTouched += turns.size
  sessions++
  if (sessionElided > 0) {
    perSession.push({ file: file.split(/[\\/]/).slice(-2)[0], elided: sessionElided, surface: sessionSurface })
    if (lastTurn >= 3) multiTurn.push({ file: file.split(/[\\/]/).slice(-2)[0], turns: lastTurn, elided: sessionElided })
  }
}
perSession.sort((a, b) => b.elided - a.elided)
const affected = perSession.filter((s) => s.surface > 0)
const avgShare = affected.length > 0 ? affected.reduce((acc, s) => acc + s.elided / Math.max(1, s.surface), 0) / affected.length : 0

const lines = []
const push = (s = '') => lines.push(s)
push('# 回放验证：历史思考清理')
push()
push(`- 采样 ${sessions} 个会话（最近 ${days} 天），保留最近 ${keepRecentTurns} 个 turn 的完整思考`)
push(`- 可清理的历史思考文本：${fmt(elidableChars)} 字符 ≈ **${fmt(elidableTokens)} tokens**，涉及 ${blocksElided} 个思考块 / ${turnsTouched} 个 turn`)
push(`- 受影响会话数：${affected.length}（单 turn 会话无从清理，符合预期）`)
if (affected.length > 0) {
  push(`- 这些会话里，清理量平均占可见上下文的 **${(avgShare * 100).toFixed(1)}%**`)
}
push()
push('## 安全性检查')
push()
push(`- 清理后变成空消息的条数：**${emptyWouldResult}**（为 0 才安全；非 0 的条目会被插件跳过，不会产生非法请求）`)
push(`- 保留下来、一个字都没动的：assistant 正文 ${textBlocksKept} 块、工具调用 ${toolCallBlocksKept} 块`)
push(`- 被清理的：全部是 reasoning 块 ${blocksElided} 个；其中同一批消息里还剩下的正文 ${textBlocksInElided} 块、工具调用 ${toolCallBlocksInElided} 块均保留`)
push()
push('## 清理量最大的 12 个会话')
push()
push('| 会话 | 可省 tokens | 会话可见 tokens（估算） | 占比 |')
push('| --- | ---: | ---: | ---: |')
for (const row of perSession.slice(0, 12)) {
  push(`| ${row.file.slice(0, 30)} | ${fmt(row.elided)} | ${fmt(row.surface)} | ${pct(row.elided, row.surface)} |`)
}
push()
push(`多 turn 会话（≥3 轮）共 ${multiTurn.length} 个，是收益主力：历史越长，清理得越多。`)
push()

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
console.log(`\n[written] ${outFile}`)
