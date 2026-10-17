import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasReasoning,
  reasoningChars,
  stripHistoricalThinking,
  turnStarts,
} from '../lib/request-elision.js'

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (think, say, extra = []) => ({
  role: 'assistant',
  content: [{ type: 'reasoning', text: think }, { type: 'text', text: say }, ...extra],
})
const toolResult = (text) => ({ role: 'tool', content: [{ type: 'text', text }] })
const options = (...messages) => ({ provider: 'p', model: 'm', messages })

test('turnStarts finds every user message', () => {
  const messages = [user('a'), assistant('t', 'x'), toolResult('o'), user('b'), assistant('t', 'y')]
  assert.deepEqual(turnStarts(messages), [0, 3])
})

test('nothing is stripped when there are not enough turns', () => {
  const request = options(user('only turn'), assistant('think', 'say'))
  assert.equal(stripHistoricalThinking(request, 1), null)
})

test('older turns lose reasoning, the last turns keep it', () => {
  const request = options(
    user('turn 1'),
    assistant('old-1', 'answer 1'),
    toolResult('r1'),
    assistant('old-2', 'answer 2'),
    user('turn 2'),
    assistant('keep-1', 'answer 3'),
    user('turn 3'),
    assistant('keep-2', 'answer 4'),
  )
  const result = stripHistoricalThinking(request, 2)
  assert.ok(result)
  const content = result.options.messages.map((m) => (Array.isArray(m.content) ? m.content.map((b) => b.type) : []))
  // Turn 1 segments: first two assistants lose reasoning.
  assert.deepEqual(content[1], ['text'])
  assert.deepEqual(content[3], ['text'])
  // Turns 2 and 3 keep everything.
  assert.deepEqual(content[5], ['reasoning', 'text'])
  assert.deepEqual(content[7], ['reasoning', 'text'])
  assert.equal(result.removedBlocks, 2)
  assert.equal(result.removedChars, 'old-1'.length + 'old-2'.length)
})

test('tool calls and tool results are never touched', () => {
  const toolCall = { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }
  const request = options(user('t1'), assistant('think', 'say', [toolCall]), toolResult('output'), user('t2'))
  const result = stripHistoricalThinking(request, 1)
  assert.deepEqual(result.options.messages[1].content.map((b) => b.type), ['text', 'tool-call'])
  assert.equal(result.options.messages[2], request.messages[2], 'tool result identity preserved')
})

test('an assistant message that would become empty is left alone', () => {
  const request = options(
    user('t1'),
    { role: 'assistant', content: [{ type: 'reasoning', text: 'only thinking' }] },
    user('t2'),
  )
  assert.equal(stripHistoricalThinking(request, 1), null)
})

test('reasoning-free input produces no change', () => {
  const request = options(user('t1'), { role: 'assistant', content: [{ type: 'text', text: 'plain' }] }, user('t2'))
  assert.equal(stripHistoricalThinking(request, 1), null)
})

test('keepTurns=0 strips every turn', () => {
  const request = options(user('t1'), assistant('a', 'b'), user('t2'), assistant('c', 'd'))
  const result = stripHistoricalThinking(request, 0)
  assert.equal(result.removedBlocks, 2)
  assert.deepEqual(result.options.messages[1].content.map((b) => b.type), ['text'])
  assert.deepEqual(result.options.messages[3].content.map((b) => b.type), ['text'])
})

test('the transform is deterministic (same input, same output shape)', () => {
  const build = () => options(user('t1'), assistant('think', 'say'), user('t2'), assistant('x', 'y'))
  const a = stripHistoricalThinking(build(), 1)
  const b = stripHistoricalThinking(build(), 1)
  assert.deepEqual(
    a.options.messages.map((m) => m.content?.map?.((block) => block.type)),
    b.options.messages.map((m) => m.content?.map?.((block) => block.type)),
  )
})

test('the original request object is never mutated', () => {
  const request = options(user('t1'), assistant('think', 'say'), user('t2'))
  const before = JSON.stringify(request)
  const result = stripHistoricalThinking(request, 1)
  assert.ok(result)
  assert.equal(JSON.stringify(request), before)
  assert.notEqual(result.options, request)
})

test('malformed input is handled', () => {
  assert.equal(stripHistoricalThinking(undefined, 1), null)
  assert.equal(stripHistoricalThinking({ messages: 'nope' }, 1), null)
  assert.equal(stripHistoricalThinking({ messages: [] }, 1), null)
  assert.equal(hasReasoning({ content: null }), false)
  assert.equal(reasoningChars({ content: [{ type: 'reasoning', text: 'abc' }] }), 3)
})
