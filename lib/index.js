/**
 * dsh-token-saver — spend fewer tokens per request without making the model
 * worse at its job.
 *
 * Two levers, both measured on real local traffic before shipping defaults:
 *
 *  1. Progressive tool disclosure (`system-prompt/assemble`). On this machine a
 *     single request carried 185k tokens of tool schemas for 199 tools — about
 *     21% of the ~360k-token context every step pays for — and 90% of that was
 *     nested parameter structure, not descriptions. Oversized schemas collapse
 *     to a callable skeleton plus an on-demand lookup tool.
 *
 *  2. Tool-result compaction (`tools/post-execute`). Tool output is ~45% of the
 *     live surface. Results are compacted deterministically (head/tail window
 *     with error-line rescue, repeat/blank folding) behind a never-worse double
 *     gate: if the result is not genuinely cheaper in both characters and
 *     estimated tokens, it passes through byte-identical.
 *
 * Invariants kept deliberately:
 *   - fail-open everywhere: any error returns the untouched value;
 *   - monotone decisions: a tool never re-collapses after it was expanded, so
 *     the request prefix does not flap and provider prefix caching stays warm;
 *   - nothing is dropped silently: every elision carries an explicit marker.
 */
import z from '@deepseek-ai/schemastery'
import { compactContent, compactText, DEFAULT_RULES, MARKER } from './compress.js'
import { estimateTokens, foldTools, schemaTokens } from './fold.js'
import { elideHistoryThinking } from './thinking.js'
import { stripHistoricalThinking } from './request-elision.js'

export const name = 'token-saver'
export const inject = ['tools']

const DEFAULT_SKIP_TOOLS = ['tool_schema', 'token_saver_report']

export const Config = z.object({
  /** Compact tool results before they enter the session log. */
  compactResults: z.boolean().default(true),
  /** Hard ceiling for one compacted tool result, in characters. */
  maxChars: z.number().default(24000),
  /** Only replace a result when it saves at least this many characters. */
  minSavingChars: z.number().default(500),
  /** ...and when the compacted text is at most this fraction of the original. */
  keepRatioMax: z.number().default(0.75),
  /** Leave failed tool results untouched: the error text is the payload. */
  keepErrorsIntact: z.boolean().default(true),
  /** Collapse oversized tool schemas into an on-demand lookup. */
  foldToolSchemas: z.boolean().default(true),
  /** Only tools whose schema costs more than this many estimated tokens fold. */
  foldThresholdTokens: z.number().default(2000),
  /** Keep at least this many catalogue entries fully rendered; below it nothing folds. */
  minVisibleTools: z.number().default(4),
  /** Never fold these tools, whatever they cost. */
  alwaysKeepTools: z.array(String).default([]),
  /** Tools whose results are never compacted. */
  skipTools: z.array(String).default([]),
  /**
   * Drop reasoning text from older turns; conclusions and tool calls stay.
   *
   * Default OFF. DSH refuses `assistant/message` surface replacement: carrying
   * `sourceEventSeqs` is rejected outright for that type, while a replace
   * without it fails the "must include every shadowed surface node" check. The
   * feature stays implemented for the day upstream relaxes that constraint;
   * enabling it on current builds only produces rejected appends, so the runtime
   * trips a breaker and reports it instead of retrying forever.
   */
  elideThinking: z.boolean().default(false),
  /** How many recent turns keep their reasoning text untouched. */
  keepRecentTurns: z.number().default(1),
  /**
   * EXPERIMENTAL: drop reasoning from older turns in the *outgoing request* only
   * (the session log is never touched). Works by re-dispatching a rewritten
   * request through LlmRuntime.stream(); the surface-rewrite route is impossible
   * because DSH rejects assistant/message replacements. Off by default until it
   * has been verified against a live provider.
   */
  requestThinkingElision: z.boolean().default(false),
  /** Turns kept verbatim by the request-level elision. */
  requestThinkingElisionKeepTurns: z.number().default(1),
  /** Expose `tool_schema` so the model can fetch a folded schema on demand. */
  lookupTool: z.boolean().default(true),
  /** Expose `token_saver_report` with per-session savings counters. */
  reportTool: z.boolean().default(true),
  /** Log one line per folded assembly / compacted result. */
  verbose: z.boolean().default(false),
}).description('省 token 插件配置')

const textOutput = () => ({
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => [
    { type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value ?? null) },
  ],
})

const DEFAULTS = {
  compactResults: true,
  maxChars: 24000,
  minSavingChars: 500,
  keepRatioMax: 0.75,
  keepErrorsIntact: true,
  foldToolSchemas: true,
  foldThresholdTokens: 2000,
  minVisibleTools: 4,
  alwaysKeepTools: [],
  skipTools: [],
  elideThinking: false,
  keepRecentTurns: 1,
  requestThinkingElision: false,
  requestThinkingElisionKeepTurns: 1,
  lookupTool: true,
  reportTool: true,
  verbose: false,
}

/** Resolve config defensively: the loader may hand us a raw object. */
function resolveSettings(input) {
  let parsed = input ?? {}
  try {
    parsed = Config(parsed)
  } catch {
    /* fall back to the raw object; defaults still apply below */
  }
  return { ...DEFAULTS, ...(parsed ?? {}) }
}

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const rules = {
    ...DEFAULT_RULES,
    maxChars: settings.maxChars,
    headChars: Math.max(2000, Math.round(settings.maxChars * 0.6)),
    tailChars: Math.max(1000, Math.round(settings.maxChars * 0.25)),
  }
  const skipTools = new Set([...DEFAULT_SKIP_TOOLS, ...(settings.skipTools ?? [])])
  const alwaysKeep = new Set(settings.alwaysKeepTools ?? [])

  const stats = {
    assemblies: 0,
    schemesFolded: 0,
    schemaTokensSaved: 0,
    lastFolded: [],
    resultsSeen: 0,
    resultsCompacted: 0,
    charsSaved: 0,
    tokensSavedEstimate: 0,
    gateRejections: 0,
    errorsSkipped: 0,
    thinkingBlocks: 0,
    thinkingTurns: 0,
    thinkingChars: 0,
    thinkingErrors: 0,
    thinkingUnavailable: false,
    thinkingLastError: undefined,
    requestElisionApplied: 0,
    requestElisionChars: 0,
    requestElisionErrors: 0,
    requestElisionLastError: undefined,
  }

  // The exact schema behind every folded tool, so the lookup tool can return it
  // even if the tool registry later hides or reshapes an entry.
  const fullSchemas = new Map()
  /** Session-scoped, monotone expansion state: expanded names never re-collapse. */
  const expandedBySession = new Map()
  const globals = new Set()
  const MAX_SESSIONS = 200

  const sessionKey = () => {
    try {
      const id = ctx.get('agents')?.currentInitiator()?.id
      return typeof id === 'string' ? id : undefined
    } catch {
      return undefined
    }
  }

  const expandedFor = (key) => {
    let set = key ? expandedBySession.get(key) : undefined
    if (!set) {
      set = new Set()
      if (key) {
        expandedBySession.set(key, set)
        if (expandedBySession.size > MAX_SESSIONS) {
          const oldest = expandedBySession.keys().next().value
          expandedBySession.delete(oldest)
        }
      }
    }
    return { set, globals }
  }

  const isExpanded = (key, toolName) => globals.has(toolName) || (key ? expandedBySession.get(key)?.has(toolName) === true : false)

  // ---------------------------------------------------------------------------
  // Lever 1: progressive tool disclosure.
  // ---------------------------------------------------------------------------
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const resolved = await next()
    if (!settings.foldToolSchemas) return resolved
    try {
      const tools = resolved?.tools
      if (!Array.isArray(tools) || tools.length === 0) return resolved

      const key = sessionKey()
      const { set } = expandedFor(key)
      for (const toolName of set) globals.add(toolName)
      const expandedView = new Set([...globals])

      const result = foldTools(tools, {
        foldThresholdTokens: settings.foldThresholdTokens,
        minVisibleTools: settings.minVisibleTools,
        alwaysKeep,
        expanded: expandedView,
      })
      if (result.folded.length === 0) return resolved

      // Remember the authoritative schema for each folded tool.
      for (const tool of tools) {
        if (typeof tool?.name === 'string' && result.folded.includes(tool.name)) fullSchemas.set(tool.name, tool)
      }

      stats.assemblies++
      stats.schemesFolded += result.folded.length
      stats.schemaTokensSaved += result.savedTokens
      stats.lastFolded = result.folded
      if (settings.verbose) {
        ctx.logger?.info?.(
          `[token-saver] 折叠 ${result.folded.length} 个工具 schema，预计省 ${result.savedTokens} tokens/请求：${result.folded.slice(0, 6).join(', ')}`,
        )
      }
      return { ...resolved, tools: result.tools }
    } catch (error) {
      ctx.logger?.warn?.(`[token-saver] schema 折叠失败，按原样放行：${String(error)}`)
      return resolved
    }
  })

  // ---------------------------------------------------------------------------
  // Lever 2: deterministic tool-result compaction behind a never-worse gate.
  // ---------------------------------------------------------------------------
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!settings.compactResults) return decision
    try {
      if (!decision || decision.kind !== 'accept') return decision
      if (decision.value !== undefined) return decision
      if (!Array.isArray(decision.content)) return decision

      const toolName = typeof exec?.name === 'string' ? exec.name : ''
      if (skipTools.has(toolName)) return decision

      stats.resultsSeen++
      const isError = result?.isError === true
      if (isError && settings.keepErrorsIntact) {
        stats.errorsSkipped++
        return decision
      }

      const compacted = compactContent(decision.content, { toolName, isError, rules })
      const { before, after, saved } = compacted.stats
      if (saved <= 0) return decision

      // Never-worse double gate: bytes must shrink meaningfully AND estimated
      // tokens must strictly drop, otherwise the original is kept verbatim.
      const byteGate = saved >= settings.minSavingChars && after <= before * settings.keepRatioMax
      const tokenGate = estimateTokens(compacted.blocks.map((b) => (b?.type === 'text' ? b.text : '')).join('')) < estimateTokens(
        decision.content.map((b) => (b?.type === 'text' ? b.text : '')).join(''),
      )
      if (!byteGate || !tokenGate) {
        stats.gateRejections++
        return decision
      }

      stats.resultsCompacted++
      stats.charsSaved += saved
      stats.tokensSavedEstimate += Math.max(0, estimateTokens(decision.content.map((b) => (b?.type === 'text' ? b.text : '')).join('')) - estimateTokens(compacted.blocks.map((b) => (b?.type === 'text' ? b.text : '')).join('')))
      if (settings.verbose) {
        ctx.logger?.info?.(`[token-saver] 压缩 ${toolName} 结果：${before} → ${after} 字符`)
      }
      return { ...decision, content: compacted.blocks }
    } catch (error) {
      ctx.logger?.warn?.(`[token-saver] 结果压缩失败，按原样放行：${String(error)}`)
      return decision
    }
  })

  // ---------------------------------------------------------------------------
  // Lever 3: historical thinking elision.
  //
  // The pre-step hook carries the agent but not the session, and the rewrite
  // needs the live Session object, so sessions are cached from the post-commit
  // event feed and looked up by id at the start of every turn.
  // ---------------------------------------------------------------------------
  const sessionById = new Map()
  const MAX_SESSIONS_TRACKED = 64

  ctx.on('session/event', (session) => {
    if (!settings.elideThinking || stats.thinkingUnavailable) return
    try {
      const id = session?.id === undefined ? undefined : String(session.id)
      if (!id) return
      if (sessionById.has(id)) sessionById.delete(id)
      sessionById.set(id, session)
      if (sessionById.size > MAX_SESSIONS_TRACKED) {
        sessionById.delete(sessionById.keys().next().value)
      }
    } catch (error) {
      ctx.logger?.warn?.(`[token-saver] 会话缓存失败：${String(error)}`)
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (
        settings.elideThinking &&
        !stats.thinkingUnavailable &&
        payload?.step === 1 &&
        typeof payload?.turn === 'number'
      ) {
        const id = payload.agent?.id === undefined ? undefined : String(payload.agent.id)
        const session = id ? sessionById.get(id) : undefined
        if (session) {
          const result = elideHistoryThinking(session, payload.turn, {
            keepRecentTurns: settings.keepRecentTurns,
          })
          if (result.replaced > 0) {
            stats.thinkingBlocks += result.replaced
            stats.thinkingTurns += result.turns
            stats.thinkingChars += result.chars
            if (settings.verbose) {
              ctx.logger?.info?.(
                `[token-saver] 清理 ${result.turns} 个历史 turn 的思考文本：${result.replaced} 块 / ${result.chars} 字符`,
              )
            }
          }
          if (result.errors.length > 0) {
            stats.thinkingErrors += result.errors.length
            // One rejection is proof, not noise: DSH's session invariant refuses
            // every assistant/message replacement, so stop paying for retries.
            stats.thinkingUnavailable = true
            stats.thinkingLastError = result.errors[0]
            ctx.logger?.warn?.(
              `[token-saver] 历史思考清理已停用：当前 DSH 不允许替换 assistant/message（${result.errors[0]}）。配置项保留但不会再生效。`,
            )
          }
        }
      }
    } catch (error) {
      stats.thinkingErrors++
      if (stats.thinkingErrors === 1) stats.thinkingLastError = String(error)
      ctx.logger?.warn?.(`[token-saver] 历史思考清理失败，按原样放行：${String(error)}`)
    }
    return next()
  })

  // ---------------------------------------------------------------------------
  // Lever 4 (experimental): request-level thinking elision.
  //
  // The session log is never touched. The outgoing GenerateOptions is frozen,
  // and assistant/message surface replacement is rejected by DSH, so the only
  // seam left is the request itself: build a new request object and re-dispatch
  // it through LlmRuntime.stream(). That re-enters this waterfall once —
  // recognised by object identity in `inflightRequests` — and then continues to
  // the adapter, so retry/routing listeners still run. Nothing that reaches the
  // caller is ever produced twice: if the rewritten request fails before its
  // first chunk, the original request runs as a fallback.
  // ---------------------------------------------------------------------------
  const inflightRequests = new Set()

  ctx.on('llm/stream', async function* (options, next) {
    if (inflightRequests.has(options) || !settings.requestThinkingElision) {
      yield* next()
      return
    }

    let rewritten
    let runtime
    try {
      // Compaction summaries and title generation are not worth re-dispatching.
      if (options?.purpose === 'compaction' || options?.purpose === 'session-title') {
        yield* next()
        return
      }
      rewritten = stripHistoricalThinking(options, settings.requestThinkingElisionKeepTurns)
      if (!rewritten) {
        yield* next()
        return
      }
      runtime = ctx.get('llm')
      if (!runtime || typeof runtime.stream !== 'function') {
        yield* next()
        return
      }
    } catch (error) {
      stats.requestElisionErrors++
      stats.requestElisionLastError = String(error)
      ctx.logger?.warn?.(`[token-saver] 请求级思考清理决策失败，回退原请求：${String(error)}`)
      yield* next()
      return
    }

    stats.requestElisionApplied++
    stats.requestElisionChars += rewritten.removedChars
    if (settings.verbose) {
      ctx.logger?.info?.(
        `[token-saver] 请求级思考清理：删除 ${rewritten.removedBlocks} 块 / ${rewritten.removedChars} 字符（保留最近 ${settings.requestThinkingElisionKeepTurns} 轮）`,
      )
    }

    inflightRequests.add(rewritten.options)
    let delivered = false
    try {
      for await (const chunk of runtime.stream(rewritten.options)) {
        delivered = true
        yield chunk
      }
    } catch (error) {
      stats.requestElisionErrors++
      stats.requestElisionLastError = String(error)
      if (!delivered) {
        // Nothing reached the caller yet: the original request is still a
        // perfectly good fallback, so a rejected rewrite stays invisible.
        ctx.logger?.warn?.(`[token-saver] 重发请求失败，回退原请求：${String(error)}`)
        yield* next()
        return
      }
      throw error
    } finally {
      inflightRequests.delete(rewritten.options)
    }
  })

  // ---------------------------------------------------------------------------
  // On-demand schema lookup for folded tools.
  // ---------------------------------------------------------------------------
  if (settings.lookupTool) {
    ctx.effect(() =>
      ctx.tools.register({
        name: 'tool_schema',
        description:
          '按名字查询某个工具的完整参数 schema。当某个工具的说明里出现 “[token-saver: 参数 schema 已折叠…]” 时，必须先调用本工具拿到完整参数结构，再调用目标工具；查询后本次会话内该工具会保持展开。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '要查询的工具名，例如 mcp__rea__compare_web_captures' },
          },
          required: ['name'],
          additionalProperties: false,
        },
        output: textOutput(),
        execute: async (args, exec) => {
          const toolName = typeof args?.name === 'string' ? args.name.trim() : ''
          if (!toolName) return { text: '缺少 name 参数。' }
          const registered = ctx.tools.get(toolName)
          const schema = fullSchemas.get(toolName) ?? (registered ? { name: registered.name, description: registered.description, parameters: registered.parameters } : undefined)
          if (!schema) {
            const known = [...fullSchemas.keys()].slice(0, 40).join(', ')
            return { text: `未找到工具 "${toolName}"。可查询的已折叠工具：${known || '（暂无）'}` }
          }
          // Monotone expansion: session-scoped when the caller is known,
          // process-wide otherwise. A tool never folds again afterwards.
          const id = typeof exec?.agent?.id === 'string' ? exec.agent.id : undefined
          globals.add(toolName)
          if (id) {
            const { set } = expandedFor(id)
            set.add(toolName)
          }
          return {
            text: JSON.stringify(
              { name: schema.name, description: schema.description, parameters: schema.parameters },
              null,
              1,
            ),
          }
        },
      }),
    )
  }

  // ---------------------------------------------------------------------------
  // Savings report.
  // ---------------------------------------------------------------------------
  if (settings.reportTool) {
    ctx.effect(() =>
      ctx.tools.register({
        name: 'token_saver_report',
        description: '查看 dsh-token-saver 本次运行累计节省的 token（工具 schema 折叠 + 工具结果压缩），以及当前被折叠的工具名单。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOutput(),
        execute: async () => {
          const expanded = [...globals]
          const lines = [
            `${MARKER} 运行统计`,
            `- 结果压缩：命中 ${stats.resultsCompacted} 条 / 检查 ${stats.resultsSeen} 条，省 ${stats.charsSaved} 字符（≈${stats.tokensSavedEstimate} tokens），门控拒绝 ${stats.gateRejections} 条，错误结果跳过 ${stats.errorsSkipped} 条`,
            `- schema 折叠：${stats.assemblies} 次组装，当前折叠 ${stats.lastFolded.length} 个工具，累计省 ≈${stats.schemaTokensSaved} tokens/请求`,
            `- 历史思考清理：${describeThinking()}`,
            `- 请求级思考清理（实验）：${describeRequestElision()}`,
            `- 已展开（不再折叠）：${expanded.length > 0 ? expanded.join(', ') : '（无）'}`,
            `- 折叠阈值：>${settings.foldThresholdTokens} tokens；结果上限：${settings.maxChars} 字符`,
          ]
          return { text: lines.join('\n') }
        },
      }),
    )
  }

  const describeThinking = () => {
    if (stats.thinkingUnavailable) {
      const reason = stats.thinkingLastError ?? '未知原因'
      return `**不可用** —— 当前 DSH 拒绝替换 assistant/message（sourceEventSeqs 互斥），已熔断并停用。最近一次拒绝：${reason}`
    }
    if (!settings.elideThinking) {
      return '关闭（当前 DSH 版本不支持改写历史思考；打开 elideThinking 只会得到被拒绝的写入，详见 README）'
    }
    return `${stats.thinkingTurns} 个 turn / ${stats.thinkingBlocks} 块，省 ${stats.thinkingChars} 字符（保留最近 ${settings.keepRecentTurns} 个 turn 的完整思考）`
  }

  const describeRequestElision = () => {
    if (!settings.requestThinkingElision) {
      return '关闭（实验性；打开后只改发出的请求、不碰会话日志）'
    }
    const tail =
      stats.requestElisionErrors > 0
        ? `，失败 ${stats.requestElisionErrors} 次（最后一次：${stats.requestElisionLastError ?? '未知'}）`
        : ''
    return `开启（保留最近 ${settings.requestThinkingElisionKeepTurns} 轮），已重发 ${stats.requestElisionApplied} 次请求，删 ${stats.requestElisionChars} 字符${tail}`
  }

  ctx.logger?.info?.(
    `[token-saver] 已启用：schema 折叠=${settings.foldToolSchemas ? `>${settings.foldThresholdTokens} tokens` : 'off'}，结果压缩=${settings.compactResults ? `≤${settings.maxChars} 字符` : 'off'}`,
  )
}

export { compactText, estimateTokens, schemaTokens }
