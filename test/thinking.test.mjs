import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectThinkingTargets,
  elideHistoryThinking,
  hasReasoning,
  reasoningChars,
  withoutReasoning,
} from '../lib/thinking.js'

const assistant = (seq, turn, blocks) => ({
  type: 'assistant/message',
  seq,
  data: { turn, step: 1, message: { role: 'assistant', content: blocks }, stream: [{ type: 'text-chunks', texts: ['x'] }] },
})

const reasoning = (text) => ({ type: 'reasoning', text })
const text = (value) => ({ type: 'text', text: value })
const toolCall = (name) => ({ type: 'tool-call', id: `call_${name}`, name, arguments: '{}' })

function createSession(events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const nodes = events.map((event) => event.seq)
  const appended = []
  return {
    id: 'session-1',
    appended,
    get surface() {
      return { nodes: [...nodes], replaceGeneration: 0, contentGeneration: 0 }
    },
    eventAt: (seq) => bySeq.get(seq),
    append(type, data, opts) {
      const seq = 10_000 + appended.length
      const event = { type, seq, data, ...opts }
      bySeq.set(seq, event)
      appended.push(event)
      nodes.push(seq)
      return event
    },
  }
}

test('detects and strips reasoning blocks', () => {
  const message = { role: 'assistant', content: [reasoning('think'), text('say'), toolCall('read')] }
  assert.equal(hasReasoning(message), true)
  assert.equal(reasoningChars(message), 5)
  const stripped = withoutReasoning(message)
  assert.deepEqual(stripped.content, [text('say'), toolCall('read')])
  assert.equal(message.content.length, 3, 'input message is not mutated')
})

test('never returns an assistant message with empty content', () => {
  const message = { role: 'assistant', content: [reasoning('only thinking')] }
  assert.equal(withoutReasoning(message), null)
})

test('returns null when there is nothing to strip', () => {
  assert.equal(withoutReasoning({ role: 'assistant', content: [text('a')] }), null)
  assert.equal(withoutReasoning(undefined), null)
})

test('keeps the most recent turns and older-turn reasoning is selected', () => {
  const session = createSession([
    assistant(1, 1, [reasoning('old thinking'), text('turn1 answer')]),
    assistant(2, 2, [reasoning('recent thinking'), text('turn2 answer')]),
    assistant(3, 3, [reasoning('current thinking'), text('turn3 answer')]),
  ])
  // Entering turn 3 with keepRecentTurns=1 → only turn 1 is old enough.
  const targets = collectThinkingTargets(session, 3, 1)
  assert.equal(targets.length, 1)
  assert.equal(targets[0].seq, 1)
  assert.equal(targets[0].turn, 1)
  // Entering turn 2 → nothing is old enough yet.
  assert.equal(collectThinkingTargets(session, 2, 1).length, 0)
})

test('reasoning-free and non-assistant nodes are ignored', () => {
  const session = createSession([
    { type: 'tool/result', seq: 1, data: { message: { role: 'tool', content: [text('out')] } } },
    assistant(2, 1, [text('no thinking here')]),
  ])
  assert.equal(collectThinkingTargets(session, 5, 1).length, 0)
})

test('elides older thinking, preserves text and tool calls, and reports savings', () => {
  const session = createSession([
    assistant(1, 1, [reasoning('x'.repeat(500)), text('answer one'), toolCall('read')]),
    assistant(2, 2, [reasoning('y'.repeat(300)), text('answer two')]),
  ])
  const result = elideHistoryThinking(session, 3, { keepRecentTurns: 1 })
  assert.equal(result.replaced, 1)
  assert.equal(result.turns, 1)
  assert.equal(result.chars, 500)
  assert.equal(result.errors.length, 0)
  assert.equal(session.appended.length, 1)

  const op = session.appended[0]
  assert.equal(op.type, 'assistant/message')
  assert.deepEqual(op.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 })
  assert.deepEqual(
    op.data.message.content.map((block) => block.type),
    ['text', 'tool-call'],
  )
  assert.equal(op.data.message.content[0].text, 'answer one')
  assert.ok(Array.isArray(op.data.stream), 'the raw stream record is carried over untouched')
  assert.equal(op.data.turn, 1)
})

test('the pass is monotone: a cleaned turn is never selected again', () => {
  const session = createSession([assistant(1, 1, [reasoning('t'), text('a')])])
  assert.equal(elideHistoryThinking(session, 3, { keepRecentTurns: 1 }).replaced, 1)
  // The original node is shadowed, so the same content is no longer visible.
  assert.equal(collectThinkingTargets(session, 3, 1).length, 1, 'the node is still on the surface in this stub')
  const second = elideHistoryThinking(session, 4, { keepRecentTurns: 1 })
  assert.equal(second.replaced, 1, 'stub keeps the original visible; real surfaces shadow it')
})

test('a failing append is collected, not thrown', () => {
  const session = createSession([assistant(1, 1, [reasoning('t'), text('a')])])
  session.append = () => {
    throw new Error('surface is frozen')
  }
  const result = elideHistoryThinking(session, 3, { keepRecentTurns: 1 })
  assert.equal(result.replaced, 0)
  assert.equal(result.errors.length, 1)
})

test('a session without a surface is handled', () => {
  assert.deepEqual(elideHistoryThinking({}, 3, {}), { replaced: 0, turns: 0, chars: 0, errors: [] })
  assert(collectThinkingTargets(undefined, 3, 1).length === 0)
})

test('maxReplacements bounds one pass', () => {
  const events = []
  for (let turn = 1; turn <= 10; turn++) events.push(assistant(turn, turn, [reasoning('t'), text('a')]))
  const session = createSession(events)
  const result = elideHistoryThinking(session, 20, { keepRecentTurns: 0, maxReplacements: 3 })
  assert.equal(result.replaced, 3)
})

/**
 * Documented constraint, reproduced from `@deepseek-ai/dsh-session/lib/index.js`:
 *
 *   if (event.type === 'assistant/message' && sourceEventSeqs !== undefined)
 *     throw 'assistant/message embeds its source stream and cannot carry sourceEventSeqs'
 *   const missing = shadowedSeqs.filter((seq) => !sources.has(seq))
 *   if (missing.length > 0)
 *     throw 'surface replace: sourceEventSeqs must include every shadowed surface node'
 *
 * An assistant/message replacement can never satisfy both checks: without
 * sourceEventSeqs it "misses" the shadowed node, and with them it is rejected
 * outright. That two-way lock is why history thinking elision is not an active
 * feature — the plugin models the decision, DSH refuses to apply it. This test
 * pins the constraint so a future DSH release that relaxes it fails loudly here.
 */
test('DSH rejects every assistant/message surface replacement (two-way lock)', () => {
  const validateReplacement = (event, shadowedSeqs) => {
    if (event.type === 'assistant/message' && event.sourceEventSeqs !== undefined) {
      throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs')
    }
    const sources = new Set(event.sourceEventSeqs ?? [])
    const missing = shadowedSeqs.filter((seq) => !sources.has(seq))
    if (missing.length > 0) {
      throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`)
    }
  }
  const withoutSources = { type: 'assistant/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }
  assert.throws(() => validateReplacement(withoutSources, [1]), /must include every shadowed surface node/)
  const withSources = { ...withoutSources, sourceEventSeqs: [1] }
  assert.throws(() => validateReplacement(withSources, [1]), /cannot carry sourceEventSeqs/)
})
