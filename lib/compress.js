/**
 * Deterministic, semantics-preserving compaction for tool-result text.
 *
 * Design contract (why this is safe):
 *
 *   - Every transform is a pure function of its input. The same tool result
 *     always compacts to the same bytes, so the request prefix stays stable
 *     across steps and provider prefix-cache hit rates do not regress.
 *   - Nothing is dropped silently. Every elision is replaced by an explicit
 *     marker carrying the amount of hidden content, so the model can tell the
 *     difference between "the tool printed nothing" and "content was elided"
 *     and can re-read the file/command when it actually needs the detail.
 *   - Structure a reader depends on survives: line order, indentation, error
 *     lines, and the head/tail of the output are always kept.
 *   - Fail-open: a transform that cannot help returns the input unchanged.
 *
 * The module is intentionally dependency-free and side-effect-free so the same
 * code runs inside the host plugin and inside offline measurement tooling.
 */

export const MARKER = '\u27ea token-saver'

/** Default rule set. Every field is overridable per call and per tool. */
export const DEFAULT_RULES = {
  /** Remove ANSI/VT control sequences (colour, cursor moves). */
  stripAnsi: true,
  /** Collapse runs of identical consecutive lines into one line plus a count. */
  collapseRepeats: true,
  /** Minimum run length before a repeat fold happens. */
  minRepeatRun: 4,
  /** Fold very long base64/hex payloads that no reader benefits from. */
  foldEncoded: true,
  /** Minimum length of an encoded-looking line before it is folded. */
  minEncodedLength: 256,
  /** Collapse 3+ consecutive blank lines to a single blank line. */
  collapseBlankLines: true,
  /** Strip trailing whitespace on every line. */
  trimLineEnds: true,
  /** Rewrite a whole-JSON payload as one line; only for large payloads. */
  minifyJson: false,
  /** Minimum size before JSON minification applies. */
  minifyJsonMinChars: 2000,
  /** Hard ceiling for the compacted text. */
  maxChars: 24000,
  /** Characters kept from the head when over the ceiling. */
  headChars: 14000,
  /** Characters kept from the tail when over the ceiling. */
  tailChars: 6000,
  /** Budget for error-looking lines rescued from the elided middle. */
  errorChars: 2000,
  /** Skip ceiling handling entirely below this size. */
  minCharsForCeiling: 4000,
  /** Never compact a failed tool result: the error text is the whole point. */
  keepErrorsIntact: true,
  /** Per-tool overrides: { [toolName]: Partial<Rules> }. */
  tools: {},
}

export function resolveRules(base, toolName, override) {
  const toolRules = (override?.tools ?? base.tools ?? {})[toolName] ?? {}
  return { ...base, ...override, ...toolRules, tools: undefined }
}

const ANSI_PATTERN = [
  // CSI: ESC [ ... final byte
  /\u001B\[[0-9;?]*[ -/]*[@-~]/g,
  // OSC: ESC ] ... BEL or ST
  /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g,
  // Two-byte escapes
  /\u001B[@-Z\\-_]/g,
]

const ERROR_PATTERN =
  /(^|\W)(error|errors|failed|failure|fatal|exception|panic|traceback|denied|refused|timed out|timeout|cannot|unable|not found|invalid|❌|✗|×|错误|失败|异常|无法|不存在)(\W|$)/i

const ENCODED_PATTERN = /^(?:\s*)([A-Za-z0-9+/=_-]{256,})(?:\s*)$/

const isAnnotated = (line) => line.includes(MARKER)

function stripAnsi(text, stats) {
  let removed = 0
  let out = text
  for (const pattern of ANSI_PATTERN) {
    out = out.replace(pattern, (match) => {
      removed += match.length
      return ''
    })
  }
  if (removed > 0) stats.ansiChars = removed
  return out
}

function trimLineEnds(text) {
  return text
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
}

function collapseBlankLines(text, stats) {
  const lines = text.split('\n')
  const out = []
  let blanks = 0
  let folded = 0
  for (const line of lines) {
    if (line.trim() === '') {
      blanks++
      if (blanks > 1) {
        folded++
        continue
      }
      out.push('')
      continue
    }
    blanks = 0
    out.push(line)
  }
  if (folded > 0) stats.blankLinesFolded = folded
  return out.join('\n')
}

function foldEncoded(text, rules, stats) {
  const lines = text.split('\n')
  let folded = 0
  let chars = 0
  const out = lines.map((line) => {
    if (isAnnotated(line)) return line
    if (line.length < rules.minEncodedLength) return line
    if (!ENCODED_PATTERN.test(line)) return line
    folded++
    chars += line.length
    return `${MARKER}: 省略 ${line.length} 字符的 base64/hex 数据块; 完整内容见原始工具输出 \u27eb`
  })
  if (folded > 0) {
    stats.encodedFolded = folded
    stats.encodedChars = chars
  }
  return out.join('\n')
}

function collapseRepeats(text, rules, stats) {
  const lines = text.split('\n')
  const out = []
  let runStart = 0
  let foldedRuns = 0
  let foldedLines = 0
  for (let i = 1; i <= lines.length; i++) {
    const same = i < lines.length && lines[i] === lines[runStart] && !isAnnotated(lines[i])
    if (same) continue
    const runLength = i - runStart
    if (runLength >= rules.minRepeatRun && lines[runStart].trim() !== '') {
      out.push(lines[runStart])
      out.push(`\u27ea token-saver: 上一行重复 ${runLength - 1} 次 \u27eb`)
      foldedRuns++
      foldedLines += runLength - 1
    } else {
      for (let k = runStart; k < i; k++) out.push(lines[k])
    }
    runStart = i
  }
  if (foldedRuns > 0) {
    stats.repeatRuns = foldedRuns
    stats.repeatLines = foldedLines
  }
  return out.join('\n')
}

function minifyJson(text, rules, stats) {
  if (text.length < rules.minifyJsonMinChars) return text
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return text
  }
  const minified = JSON.stringify(parsed)
  if (minified.length >= text.length) return text
  stats.jsonChars = text.length - minified.length
  return minified
}

function takeHead(text, budget) {
  if (text.length <= budget) return text
  const slice = text.slice(0, budget)
  const cut = slice.lastIndexOf('\n')
  return cut > budget * 0.5 ? slice.slice(0, cut) : slice
}

function takeTail(text, budget) {
  if (text.length <= budget) return text
  const slice = text.slice(text.length - budget)
  const cut = slice.indexOf('\n')
  return cut >= 0 && cut < budget * 0.5 ? slice.slice(cut + 1) : slice
}

function rescueErrorLines(middle, budget) {
  if (budget <= 0) return { lines: [], chars: 0 }
  const picked = []
  let chars = 0
  const lines = middle.split('\n')
  const cap = Math.max(4, Math.min(80, Math.ceil(budget / 40)))
  for (const line of lines) {
    if (picked.length >= cap) break
    if (line.length > 400) continue
    if (!ERROR_PATTERN.test(line)) continue
    picked.push(line.length > 240 ? `${line.slice(0, 240)}…` : line)
    chars += picked[picked.length - 1].length + 1
    if (chars >= budget) break
  }
  return { lines: picked, chars }
}

function applyCeiling(text, rules, stats) {
  if (text.length <= rules.maxChars) return text
  if (text.length < rules.minCharsForCeiling) return text

  const allLines = text.split('\n')
  const head = takeHead(text, rules.headChars)
  const tail = takeTail(text, rules.tailChars)
  const headLen = head.length
  const tailStart = text.length - tail.length

  const middle = text.slice(headLen, tailStart)
  const middleLines = middle === '' ? 0 : middle.split('\n').length
  const rescued = rescueErrorLines(middle, rules.errorChars)

  const omitted = Math.max(0, middleLines - rescued.lines.length)
  const notice = `${MARKER}: 省略中段 ${omitted} 行 / ${Math.max(0, middle.length - rescued.chars)} 字符（如需完整内容请重新运行工具或缩小查询范围）\u27eb`

  const pieces = [head.replace(/\n+$/, '')]
  pieces.push('')
  pieces.push(notice)
  if (rescued.lines.length > 0) {
    pieces.push(`${MARKER}: 以下为被省略中段里与错误/失败相关的 ${rescued.lines.length} 行\u27eb`)
    pieces.push(...rescued.lines)
  }
  pieces.push('')
  pieces.push(`${MARKER}: 尾部 \u27eb`)
  pieces.push(tail.replace(/^\n+/, ''))

  const result = pieces.join('\n')
  if (result.length >= text.length) return text
  stats.ceilingTrimmed = text.length - result.length
  stats.ceilingOmittedLines = omitted
  stats.ceilingRescued = rescued.lines.length
  return result
}

/**
 * Compact one tool-result text.
 *
 * @param {string} text raw tool output
 * @param {{ toolName?: string, rules?: object, override?: object }} [context]
 * @returns {{ text: string, stats: object }}
 */
export function compactText(text, context = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, stats: { before: 0, after: 0, saved: 0, savedRatio: 0 } }
  }
  const stats = { before: text.length, after: text.length }

  const rules = context.rules ?? resolveRules(DEFAULT_RULES, context.toolName, context.override)
  if (rules.keepErrorsIntact && context.isError) return { text, stats }

  let out = text
  if (rules.stripAnsi) out = stripAnsi(out, stats)
  if (rules.trimLineEnds) out = trimLineEnds(out)
  if (rules.foldEncoded) out = foldEncoded(out, rules, stats)
  if (rules.minifyJson) out = minifyJson(out, rules, stats)
  if (rules.collapseBlankLines) out = collapseBlankLines(out, stats)
  if (rules.collapseRepeats) out = collapseRepeats(out, rules, stats)
  out = applyCeiling(out, rules, stats)

  stats.after = out.length
  stats.saved = text.length - out.length
  stats.savedRatio = text.length > 0 ? stats.saved / text.length : 0
  return { text: out, stats }
}

/** Compact the text blocks of a content array, leaving rich blocks untouched. */
export function compactContent(blocks, context = {}) {
  if (!Array.isArray(blocks)) return { blocks, stats: { before: 0, after: 0, saved: 0 } }
  const out = []
  const stats = { before: 0, after: 0, saved: 0, changedBlocks: 0 }
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
      out.push(block)
      continue
    }
    const result = compactText(block.text, context)
    stats.before += result.stats.before
    stats.after += result.stats.after
    stats.saved += result.stats.saved ?? 0
    if (result.text !== block.text) stats.changedBlocks++
    out.push(result.text === block.text ? block : { ...block, text: result.text })
  }
  return { blocks: out, stats }
}
