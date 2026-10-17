/**
 * Request-level thinking elision.
 *
 * History: the earlier surface-rewrite approach is dead — DSH rejects every
 * `assistant/message` surface replacement (sourceEventSeqs is forbidden for it,
 * while a replace requires it). This module takes the *other* legal-looking
 * seam: it never touches the session log; it rewrites only the in-flight request
 * object handed to `llm/stream`, and the caller re-dispatches that request
 * through `LlmRuntime.stream()`.
 *
 * Shape of the transform (pure, deterministic — important for prefix caching):
 *   - messages are segmented by their `user` role; each user message opens a turn;
 *   - the most recent `keepTurns` turn segments keep their reasoning untouched;
 *   - older segments lose only their `reasoning` blocks, keeping every text
 *     block and every tool-call block;
 *   - a message that would become empty is left exactly as it is.
 *
 * Determinism matters: for a fixed log the output is always the same, so the
 * per-turn prefix only changes on turn boundaries, which were already changing.
 */

const isReasoning = (block) => block && typeof block === 'object' && block.type === 'reasoning'

/** Indexes of user-role messages; each one opens a turn segment. */
export function turnStarts(messages) {
  if (!Array.isArray(messages)) return []
  const starts = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') starts.push(i)
  }
  return starts
}

export function hasReasoning(message) {
  const content = message?.content
  if (!Array.isArray(content)) return false
  return content.some(isReasoning)
}

export function reasoningChars(message) {
  const content = message?.content
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (isReasoning(block) && typeof block.text === 'string') total += block.text.length
  }
  return total
}

/**
 * Build a request whose older turns carry no reasoning text.
 *
 * @param {{ messages?: readonly any[] }} options the frozen GenerateOptions
 * @param {number} keepTurns how many trailing turns keep their reasoning
 * @returns {null | { options: object, removedBlocks: number, removedChars: number, affectedTurns: number }}
 *   null when nothing should change (caller must use the original request).
 */
export function stripHistoricalThinking(options, keepTurns = 1) {
  const messages = options?.messages
  if (!Array.isArray(messages) || messages.length === 0) return null
  if (!Number.isInteger(keepTurns) || keepTurns < 0) return null

  const starts = turnStarts(messages)
  // Not enough turns to have anything historical, or nothing to keep.
  if (starts.length <= keepTurns) return null
  const boundary = starts[starts.length - keepTurns]

  let removedBlocks = 0
  let removedChars = 0
  const affected = new Set()
  let changed = false
  const next = messages.map((message, index) => {
    if (index >= boundary) return message
    if (message?.role !== 'assistant') return message
    const content = message.content
    if (!Array.isArray(content)) return message
    if (!content.some(isReasoning)) return message
    const kept = content.filter((block) => !isReasoning(block))
    if (kept.length === 0) return message // never emit an empty assistant turn
    for (const block of content) {
      if (isReasoning(block)) {
        removedBlocks++
        if (typeof block.text === 'string') removedChars += block.text.length
      }
    }
    affected.add(index)
    changed = true
    return { ...message, content: kept }
  })

  if (!changed) return null
  return {
    options: { ...options, messages: next },
    removedBlocks,
    removedChars,
    affectedTurns: affected.size,
  }
}
