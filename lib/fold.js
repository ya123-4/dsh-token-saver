/**
 * Progressive tool disclosure: keep every tool *callable and discoverable*
 * while collapsing the payload of oversized parameter schemas.
 *
 * Why this exists: measured on this machine, one request carried 185k tokens
 * of tool schemas for 199 tools — 21% of the ~360k-token context every step
 * pays for. A single machine-generated MCP tool cost 23k tokens, almost all of
 * it inside `$defs` reachable only through `$ref`. Trimming descriptions buys
 * ~2%; the only real lever is not shipping the whole schema on every request.
 *
 * Safety contract:
 *   - fail-open: any doubt returns the original tool untouched;
 *   - tools stay listed and callable (a loose skeleton schema is still a valid
 *     JSON Schema, so the model can attempt a call);
 *   - the model is told, in the tool description itself, how to get the exact
 *     schema back, and a companion tool does that on demand;
 *   - unfolding is monotone: once a tool is expanded it stays expanded, so the
 *     request prefix does not flap and the provider prefix cache stays warm.
 */

/**
 * Cheap, dependency-free token estimate. Only used for relative decisions
 * (is this schema big? did folding actually shrink it?), so a heuristic is
 * enough and an absolute tokenizer would only add an install-time dependency.
 * ASCII runs at ~4 chars/token, CJK and other non-ASCII at ~1.5 chars/token.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let ascii = 0
  let wide = 0
  for (const char of text) {
    if (char.codePointAt(0) <= 0x7f) ascii++
    else wide++
  }
  return Math.ceil(ascii / 4 + wide / 1.5)
}

export function schemaTokens(tool) {
  return estimateTokens(JSON.stringify(tool))
}

/** First sentence (or first `maxChars`) of a description, for folded entries. */
export function firstSentence(text, maxChars = 160) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  const window = flat.slice(0, maxChars)
  const stop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('。'), window.lastIndexOf('\n'))
  return stop > maxChars * 0.4 ? window.slice(0, stop + 1) : `${window.trimEnd()}…`
}

/**
 * Build a loose but valid JSON-Schema skeleton: property names, primitive
 * types, tiny literal enums, and required names survive; nested structure,
 * `$defs`, and long descriptions do not. `additionalProperties: true` keeps it
 * permissive, so the call is attemptable instead of blocked.
 */
export function skeletonize(parameters) {
  const skeleton = { type: 'object', properties: {}, additionalProperties: true }
  if (!parameters || typeof parameters !== 'object') return skeleton
  const props = parameters.properties
  if (!props || typeof props !== 'object') return skeleton
  for (const [key, value] of Object.entries(props)) {
    if (!value || typeof value !== 'object') {
      skeleton.properties[key] = {}
      continue
    }
    const entry = {}
    if (typeof value.type === 'string') entry.type = value.type
    if (
      Array.isArray(value.enum) &&
      value.enum.length > 0 &&
      value.enum.length <= 8 &&
      value.enum.every((item) => typeof item === 'string' && item.length <= 24)
    ) {
      entry.enum = value.enum
    }
    skeleton.properties[key] = entry
  }
  if (typeof parameters.type === 'string') skeleton.type = parameters.type
  if (Array.isArray(parameters.required)) {
    // Only keep required names that still exist in the skeleton: a required
    // key pointing at a property the skeleton no longer declares is invalid.
    const required = parameters.required.filter((key) => typeof key === 'string' && key in skeleton.properties)
    if (required.length > 0) skeleton.required = required
  }
  return skeleton
}

export const FOLD_HINT = (name) =>
  `[token-saver: 参数 schema 已折叠以节省上下文。调用本工具前，请先用 tool_schema 工具查询 name="${name}" 获取完整参数结构。]`

export function foldTool(tool, options = {}) {
  const maxChars = options.hintDescriptionChars ?? 200
  const description = `${firstSentence(tool.description ?? '', maxChars)} ${FOLD_HINT(tool.name)}`.trim()
  return {
    name: tool.name,
    description,
    parameters: skeletonize(tool.parameters),
    ...(tool.deferLoading === true ? { deferLoading: true } : {}),
  }
}

/**
 * Decide the fold set for one assembly.
 *
 * @param {readonly object[]} tools current tool schemas
 * @param {object} rules { foldThresholdTokens, minToolsKept, alwaysKeep:Set, neverFold:Set, expanded:Set }
 * @returns {{ tools: object[], folded: string[], savedTokens: number }}
 */
export function foldTools(tools, rules) {
  const threshold = rules.foldThresholdTokens ?? 2000
  const alwaysKeep = rules.alwaysKeep ?? new Set()
  const expanded = rules.expanded ?? new Set()
  const neverFold = rules.neverFold ?? new Set()
  const minVisibleTools = rules.minVisibleTools ?? 4

  const victims = []
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string') continue
    if (alwaysKeep.has(tool.name) || neverFold.has(tool.name) || expanded.has(tool.name)) continue
    const cost = schemaTokens(tool)
    if (cost < threshold) continue
    victims.push({ tool, cost })
  }

  // A folded entry still lists the tool and says how to get its schema, so
  // folding never hides a tool. `minVisibleTools` only keeps a floor of fully
  // rendered entries in the catalogue; below that floor nothing folds.
  const floor = Math.min(minVisibleTools, tools.length)
  const room = Math.max(0, tools.length - floor)
  victims.sort((a, b) => b.cost - a.cost)
  const foldSet = new Set(victims.slice(0, room).map((entry) => entry.tool.name))

  let savedTokens = 0
  const folded = []
  const out = tools.map((tool) => {
    if (!tool || !foldSet.has(tool.name)) return tool
    const replacement = foldTool(tool, rules)
    const before = schemaTokens(tool)
    const after = schemaTokens(replacement)
    if (after >= before) return tool
    savedTokens += before - after
    folded.push(tool.name)
    return replacement
  })
  return { tools: out, folded, savedTokens }
}
