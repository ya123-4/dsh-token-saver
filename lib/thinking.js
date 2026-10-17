/**
 * History thinking elision.
 *
 * Every step re-sends the whole conversation. Historical reasoning text is a
 * large share of that (measured locally: 31.7% of the live surface) and it is
 * *scratch work*: the next decision rests on what was said, what tools were
 * called, and what they returned — not on how the previous thought unfolded.
 *
 * So this module rewrites the session surface to drop `reasoning` blocks from
 * assistant messages that belong to *older* turns, keeping:
 *   - every assistant text block (the conclusions),
 *   - every tool-call block (the actions),
 *   - the raw `stream` record, so the UI's replay data is untouched,
 *   - the most recent `keepRecentTurns` turns complete.
 *
 * Why this is safe and cheap:
 *   - monotone: a turn is cleaned once and never restored, so the request
 *     prefix changes at most once per turn boundary (where it was changing
 *     anyway) instead of on every step;
 *   - additive to the log: the replacement is a normal surface op, so the
 *     session stays replayable and the original bytes are still on disk;
 *   - fail-open: any error leaves the session untouched.
 */

/** Does this assistant message still carry reasoning blocks? */
export function hasReasoning(message) {
  const content = message?.content
  if (!Array.isArray(content)) return false
  return content.some((block) => block && typeof block === 'object' && block.type === 'reasoning')
}

/** Strip reasoning blocks, keeping order of everything else. Returns null when nothing to do. */
export function withoutReasoning(message) {
  const content = message?.content
  if (!Array.isArray(content)) return null
  const kept = content.filter((block) => !(block && typeof block === 'object' && block.type === 'reasoning'))
  if (kept.length === content.length) return null
  // Never leave an assistant message with no content at all: providers reject it.
  if (kept.length === 0) return null
  return { ...message, content: kept }
}

/** Total characters of reasoning blocks in one message. */
export function reasoningChars(message) {
  const content = message?.content
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'reasoning' && typeof block.text === 'string') {
      total += block.text.length
    }
  }
  return total
}

/**
 * Find the surface nodes that should lose their reasoning text.
 *
 * @param {object} session live Session (needs `surface.nodes` and `eventAt`)
 * @param {number} currentTurn the turn about to start
 * @param {number} keepRecentTurns keep this many turns before `currentTurn` intact
 * @returns {{ seq: number, turn: number, data: object, chars: number }[]}
 */
export function collectThinkingTargets(session, currentTurn, keepRecentTurns = 1) {
  const targets = []
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)) return targets
  const oldestKeptTurn = currentTurn - keepRecentTurns
  for (const seq of nodes) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      continue
    }
    if (!event || event.type !== 'assistant/message') continue
    const turn = event.data?.turn
    if (typeof turn !== 'number' || turn >= oldestKeptTurn) continue
    if (!hasReasoning(event.data?.message)) continue
    targets.push({
      seq,
      turn,
      data: event.data,
      chars: reasoningChars(event.data.message),
    })
  }
  return targets
}

/**
 * Apply the elision to a live session.
 *
 * @returns {{ replaced: number, turns: number, chars: number, errors: string[] }}
 */
export function elideHistoryThinking(session, currentTurn, options = {}) {
  const keepRecentTurns = options.keepRecentTurns ?? 1
  const maxReplacements = options.maxReplacements ?? 400
  const stats = { replaced: 0, turns: 0, chars: 0, errors: [] }
  const targets = collectThinkingTargets(session, currentTurn, keepRecentTurns)
  if (targets.length === 0) return stats
  const turns = new Set()
  for (const target of targets.slice(0, maxReplacements)) {
    const message = withoutReasoning(target.data.message)
    if (!message) continue
    try {
      session.append(
        'assistant/message',
        { ...target.data, message },
        { surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq } },
      )
      stats.replaced++
      stats.chars += target.chars
      turns.add(target.turn)
    } catch (error) {
      stats.errors.push(String(error))
    }
  }
  stats.turns = turns.size
  return stats
}
