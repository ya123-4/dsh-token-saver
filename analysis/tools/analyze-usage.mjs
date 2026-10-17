/**
 * Quantify where DSH token budget actually goes.
 *
 * Reads DSH session logs (`session.v4.jsonl.zstd`, an append-only sequence of
 * independent zstd frames), rebuilds the *current* session surface exactly the
 * way the host does (append / replace ops), and reports:
 *
 *   1. real provider usage (input / output / cache / reasoning) per session;
 *   2. the token composition of the live surface (system prompt, tool schemas,
 *      tool results, assistant history, user turns, images);
 *   3. per-tool cost ranking, so a saver plugin can target the real hotspots.
 *
 * Usage:
 *   node tools/analyze-usage.mjs [--days N] [--sessions DIR] [--out FILE] [--top N]
 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const tokenxUrl = pathToFileURL(
  join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'node_modules', 'tokenx', 'dist', 'index.mjs'),
).href
const { estimateTokenCount } = await import(tokenxUrl)

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const days = Number(argValue('--days', '14'))
const sessionsRoot = argValue('--sessions', join(process.env.USERPROFILE ?? '', '.dsh', 'sessions'))
const outFile = argValue('--out', join(process.cwd(), 'reports', 'usage-analysis.md'))
const topN = Number(argValue('--top', '12'))

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** Decode every zstd frame of one session log into JSON event objects. */
function readSession(file) {
  const buf = readFileSync(file)
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      offsets.push(i)
      i += 3
    }
  }
  const events = []
  let failedFrames = 0
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    let text
    try {
      text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      // A false-positive magic split; the slice is not a whole frame.
      failedFrames++
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // A frame that ends mid-line is retried by the next frame; ignore.
      }
    }
  }
  return { events, failedFrames, bytes: buf.length }
}

const textOfBlocks = (blocks) => {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
    else if (block.type === 'reasoning' && typeof block.text === 'string') out += block.text
    else if (block.type === 'tool-call' && typeof block.arguments === 'string') out += block.arguments
  }
  return out
}

const countTokens = (text) => (text ? estimateTokenCount(text) : 0)

const emptyToolStat = () => ({ calls: 0, results: 0, resultTokens: 0, argTokens: 0, maxResultTokens: 0, errorResults: 0 })

function analyzeSession(file) {
  const { events, failedFrames, bytes } = readSession(file)
  if (events.length === 0) return null

  const bySeq = new Map()
  const surfaceNodes = []
  const callNames = new Map()
  const toolStats = new Map()
  const stat = {
    file: basename(dirname(file)),
    bytes,
    failedFrames,
    events: events.length,
    turns: 0,
    steps: 0,
    compactions: 0,
    prunes: 0,
    prunedChars: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, samples: 0 },
    model: undefined,
    toolSchemaTokens: 0,
    toolSchemaCount: 0,
    requestHeaders: 0,
    stepInputs: [],
  }

  for (const event of events) {
    const type = event.type
    if (type === undefined) continue
    if (typeof event.seq === 'number') bySeq.set(event.seq, event)

    if (SURFACE_TYPES.has(type)) {
      const op = event.surfaceOp
      if (op === undefined || op === 'append') {
        surfaceNodes.push(event.seq)
      } else if (op && typeof op === 'object' && op.op === 'replace') {
        const { startSeq, endSeq } = op
        for (let i = surfaceNodes.length - 1; i >= 0; i--) {
          const seq = surfaceNodes[i]
          if (seq >= startSeq && seq <= endSeq) surfaceNodes.splice(i, 1)
        }
        surfaceNodes.push(event.seq)
        if (type === 'tool/result') stat.prunes++
      }
    }

    if (type === 'turn/start') stat.turns++
    else if (type === 'step/start') stat.steps++
    else if (type === 'compaction/start') stat.compactions++
    else if (type === 'tool/call') {
      callNames.set(event.data.callId, event.data.name)
      const tool = toolStats.get(event.data.name) ?? emptyToolStat()
      tool.calls++
      tool.argTokens += countTokens(event.data.arguments ?? '')
      toolStats.set(event.data.name, tool)
    } else if (type === 'request/header') {
      stat.requestHeaders++
      const tools = event.data?.header?.tools
      if (Array.isArray(tools)) {
        stat.toolSchemaTokens = countTokens(JSON.stringify(tools))
        stat.toolSchemaCount = tools.length
      }
      const model = event.data?.header?.config?.model
      if (model) stat.model = model
    } else if (type === 'assistant/message') {
      const usage = event.data?.usage
      if (usage && typeof usage.inputTokens === 'number') {
        stat.usage.samples++
        stat.usage.input += usage.inputTokens
        stat.usage.output += usage.outputTokens ?? 0
        stat.usage.cacheRead += usage.cacheReadTokens ?? 0
        stat.usage.cacheWrite += usage.cacheWriteTokens ?? 0
        stat.usage.reasoning += usage.reasoningTokens ?? 0
        stat.stepInputs.push(usage.inputTokens)
      }
    }
  }

  // Token composition of the live surface.
  const composition = { system: 0, developer: 0, user: 0, assistantText: 0, assistantReasoning: 0, toolResult: 0, images: 0, imageTokens: 0 }
  const surfaceToolTokens = new Map()
  const biggestResults = []
  for (const seq of surfaceNodes) {
    const event = bySeq.get(seq)
    if (!event) continue
    const message = event.data?.message
    const blocks = message?.content
    switch (event.type) {
      case 'system/message':
        composition.system += countTokens(textOfBlocks(blocks))
        break
      case 'developer/message':
        composition.developer += countTokens(textOfBlocks(blocks))
        break
      case 'user/message':
        composition.user += countTokens(textOfBlocks(blocks))
        break
      case 'assistant/message': {
        let text = ''
        let reasoning = ''
        for (const block of blocks ?? []) {
          if (block?.type === 'text') text += block.text
          else if (block?.type === 'reasoning') reasoning += block.text
          else if (block?.type === 'tool-call') text += block.arguments ?? ''
          else if (block?.type === 'image') composition.images++
        }
        composition.assistantText += countTokens(text)
        composition.assistantReasoning += countTokens(reasoning)
        break
      }
      case 'tool/result': {
        let text = ''
        for (const block of blocks ?? []) {
          if (block?.type === 'text') text += block.text
          else if (block?.type === 'image') {
            composition.images++
            composition.imageTokens += 1024 // conservative placeholder for a retained image
          }
        }
        const tokens = countTokens(text)
        composition.toolResult += tokens
        const name = callNames.get(message?.toolCallId) ?? '(unknown)'
        const tool = toolStats.get(name) ?? emptyToolStat()
        tool.results++
        tool.resultTokens += tokens
        tool.maxResultTokens = Math.max(tool.maxResultTokens, tokens)
        if (message?.isError) tool.errorResults++
        toolStats.set(name, tool)
        surfaceToolTokens.set(name, (surfaceToolTokens.get(name) ?? 0) + tokens)
        biggestResults.push({ tool: name, tokens, chars: text.length, isError: Boolean(message?.isError) })
        break
      }
      default:
        break
    }
  }

  biggestResults.sort((a, b) => b.tokens - a.tokens)
  const surfaceTotal = Object.values(composition).reduce((a, b) => a + b, 0)
  return {
    ...stat,
    surfaceNodes: surfaceNodes.length,
    composition,
    surfaceTotal,
    toolStats: [...toolStats.entries()],
    biggestResults: biggestResults.slice(0, topN),
    contextWindowPressure: stat.stepInputs.length ? Math.max(...stat.stepInputs) : 0,
  }
}

function collectSessionFiles(root, days) {
  const cutoff = Date.now() - days * 86_400_000
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl.zstd')) {
        try {
          const info = statSync(full)
          if (info.mtimeMs >= cutoff && info.size > 0) files.push(full)
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(root)
  return files
}

const files = collectSessionFiles(sessionsRoot, days)
const sessions = []
for (const file of files) {
  try {
    const result = analyzeSession(file)
    if (result && result.steps > 0) sessions.push(result)
  } catch (error) {
    console.error('skip', file, error.message)
  }
}

const sum = (list, pick) => list.reduce((acc, item) => acc + pick(item), 0)
const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const pct = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : 'n/a')

const totals = {
  sessions: sessions.length,
  bytes: sum(sessions, (s) => s.bytes),
  steps: sum(sessions, (s) => s.steps),
  turns: sum(sessions, (s) => s.turns),
  input: sum(sessions, (s) => s.usage.input),
  output: sum(sessions, (s) => s.usage.output),
  cacheRead: sum(sessions, (s) => s.usage.cacheRead),
  cacheWrite: sum(sessions, (s) => s.usage.cacheWrite),
  reasoning: sum(sessions, (s) => s.usage.reasoning),
  usageSamples: sum(sessions, (s) => s.usage.samples),
  compactions: sum(sessions, (s) => s.compactions),
  prunes: sum(sessions, (s) => s.prunes),
}

// Aggregate the surface composition of the most recent session per distinct
// session id, and of everything, to show both the steady state and the tail.
const compositionTotals = { system: 0, developer: 0, user: 0, assistantText: 0, assistantReasoning: 0, toolResult: 0, images: 0, imageTokens: 0 }
for (const session of sessions) {
  for (const key of Object.keys(compositionTotals)) compositionTotals[key] += session.composition[key] ?? 0
}
const surfaceTotalAll = Object.values(compositionTotals).reduce((a, b) => a + b, 0)

const aggregateTools = new Map()
for (const session of sessions) {
  for (const [name, tool] of session.toolStats) {
    const acc = aggregateTools.get(name) ?? emptyToolStat()
    acc.calls += tool.calls
    acc.results += tool.results
    acc.resultTokens += tool.resultTokens
    acc.argTokens += tool.argTokens
    acc.maxResultTokens = Math.max(acc.maxResultTokens, tool.maxResultTokens)
    acc.errorResults += tool.errorResults
    aggregateTools.set(name, acc)
  }
}
const toolRanking = [...aggregateTools.entries()].sort((a, b) => b[1].resultTokens - a[1].resultTokens)

const biggest = sessions
  .flatMap((s) => s.biggestResults.map((r) => ({ ...r, session: s.file })))
  .sort((a, b) => b.tokens - a.tokens)
  .slice(0, topN)

const schemaPressure = sessions.map((s) => ({ session: s.file, tokens: s.toolSchemaTokens, tools: s.toolSchemaCount, steps: s.steps })).filter((s) => s.tokens > 0)
const avgSchema = schemaPressure.length ? sum(schemaPressure, (s) => s.tokens) / schemaPressure.length : 0

const lines = []
const push = (line = '') => lines.push(line)
push('# DSH token 花费分析（离线，来自本机会话日志）')
push()
push(`- 统计窗口：最近 ${days} 天；会话数：${totals.sessions}；日志体积：${(totals.bytes / 1_048_576).toFixed(1)} MiB`)
push(`- 采样步数：${totals.steps}；模型请求（有 usage 的步）：${totals.usageSamples}`)
push()
push('## 1. 真实计费 token（provider usage）')
push()
push(`| 指标 | 合计 | 每步均值 |`)
push(`| --- | ---: | ---: |`)
const per = (v) => (totals.usageSamples ? v / totals.usageSamples : 0)
push(`| input tokens | ${fmt(totals.input)} | ${fmt(per(totals.input))} |`)
push(`| of which cache read | ${fmt(totals.cacheRead)} | ${fmt(per(totals.cacheRead))} |`)
push(`| of which cache write | ${fmt(totals.cacheWrite)} | ${fmt(per(totals.cacheWrite))} |`)
push(`| output tokens | ${fmt(totals.output)} | ${fmt(per(totals.output))} |`)
push(`| of which reasoning | ${fmt(totals.reasoning)} | ${fmt(per(totals.reasoning))} |`)
push()
push('## 2. 活动上下文（surface）构成')
push()
push(`| 组成 | tokens（估算） | 占比 |`)
push(`| --- | ---: | ---: |`)
const compRows = [
  ['系统提示 system', compositionTotals.system],
  ['开发消息 developer', compositionTotals.developer],
  ['用户消息 user', compositionTotals.user],
  ['assistant 文本 + 工具调用参数', compositionTotals.assistantText],
  ['assistant 推理 reasoning', compositionTotals.assistantReasoning],
  ['工具结果 tool/result', compositionTotals.toolResult],
  ['图片（按保留张数估）', compositionTotals.imageTokens],
]
for (const [label, value] of compRows.sort((a, b) => b[1] - a[1])) {
  push(`| ${label} | ${fmt(value)} | ${pct(value, surfaceTotalAll)} |`)
}
push(`| **合计** | ${fmt(surfaceTotalAll)} | 100% |`)
push()
push(`图片张数（surface 内）：${compositionTotals.images}`)
push()
push('## 3. 每次请求的固定开销（工具 schema + 系统提示）')
push()
push(`- 平均工具 schema：${fmt(avgSchema)} tokens / 请求，覆盖 ${schemaPressure.length} 个会话`)
push(`- 最大工具 schema：${fmt(Math.max(0, ...schemaPressure.map((s) => s.tokens)))} tokens`)
push(`- 平均系统提示：${fmt(sessions.length ? compositionTotals.system / sessions.length : 0)} tokens`)
push()
push('## 4. 工具输出排行（surface 内累计 tokens）')
push()
push('| 工具 | 调用 | surface 结果 tokens | 平均每次 | 单次最大 | 错误结果 |')
push('| --- | ---: | ---: | ---: | ---: | ---: |')
for (const [name, tool] of toolRanking.slice(0, topN + 8)) {
  push(`| ${name} | ${tool.calls} | ${fmt(tool.resultTokens)} | ${fmt(tool.results ? tool.resultTokens / tool.results : 0)} | ${fmt(tool.maxResultTokens)} | ${tool.errorResults} |`)
}
push()
push('## 5. 单条最贵工具结果（全窗口）')
push()
push('| # | 工具 | tokens | 字符 | 错误 | 会话 |')
push('| ---: | --- | ---: | ---: | --- | --- |')
biggest.forEach((row, index) => {
  push(`| ${index + 1} | ${row.tool} | ${fmt(row.tokens)} | ${fmt(row.chars)} | ${row.isError ? 'yes' : ''} | ${row.session.slice(0, 28)} |`)
})
push()
push('## 6. 已有节流机制的实际使用')
push()
push(`- compaction 次数：${totals.compactions}`)
push(`- tool-result prune（replace 落地）次数：${totals.prunes}`)
push()

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
console.log(`\n[written] ${outFile}`)
