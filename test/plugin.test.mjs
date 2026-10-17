import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name as pluginName, inject } from '../lib/index.js'

/** Minimal stand-in for the Cordis context the plugin talks to. */
function createHarness(config = {}, services = {}) {
  const listeners = new Map()
  const tools = new Map()
  const logs = []
  const ctx = {
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    get: (name) => services[name],
    effect: (fn) => {
      const disposer = fn()
      return () => disposer?.()
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: (toolName) => tools.get(toolName),
    },
  }
  apply(ctx, config)
  return { listeners, tools, logs }
}

const bigText = (lines = 900) => Array.from({ length: lines }, (_, i) => `row ${i} ${'d'.repeat(40)}`).join('\n')

const contentDecision = (text) => ({ kind: 'accept', content: [{ type: 'text', text }] })

const bigSchema = () => ({
  name: 'huge_tool',
  description: 'A huge machine-generated tool. Second sentence.',
  parameters: {
    type: 'object',
    $defs: Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [`__schema${i}`, { type: 'object', description: 'e'.repeat(200), properties: { a: { type: 'string' }, b: { type: 'object' } } }]),
    ),
    properties: { before: { $ref: '#/$defs/__schema1' }, after: { $ref: '#/$defs/__schema2' } },
  },
})

test('plugin exports the cordis contract', () => {
  assert.equal(pluginName, 'token-saver')
  assert.deepEqual(inject, ['tools'])
})

test('compacts an oversized tool result', async () => {
  const { listeners } = createHarness()
  const listener = listeners.get('tools/post-execute')
  const original = bigText()
  const decision = await listener({ name: 'pwsh' }, { isError: false }, async () => contentDecision(original))
  const text = decision.content[0].text
  assert.ok(text.length < original.length * 0.75, 'must clear the byte gate')
  assert.ok(text.includes('token-saver'))
})

test('leaves a small result byte-identical', async () => {
  const { listeners } = createHarness()
  const listener = listeners.get('tools/post-execute')
  const original = 'ok\n'
  const decision = await listener({ name: 'pwsh' }, { isError: false }, async () => contentDecision(original))
  assert.equal(decision.content[0].text, original)
})

test('never touches failed results', async () => {
  const { listeners } = createHarness()
  const listener = listeners.get('tools/post-execute')
  const original = bigText()
  const decision = await listener({ name: 'pwsh' }, { isError: true }, async () => contentDecision(original))
  assert.equal(decision.content[0].text, original)
})

test('passes through a value-shaped decision untouched', async () => {
  const { listeners } = createHarness()
  const listener = listeners.get('tools/post-execute')
  const decision = await listener({ name: 'pwsh' }, { isError: false }, async () => ({ kind: 'accept', value: { a: 1 } }))
  assert.deepEqual(decision, { kind: 'accept', value: { a: 1 } })
})

test('folds an oversized tool schema and keeps the tool listed', async () => {
  const { listeners } = createHarness({ minVisibleTools: 1 })
  const listener = listeners.get('system-prompt/assemble')
  const assembly = { sections: [], contexts: [], tools: [bigSchema(), { name: 'small_tool', description: 's', parameters: { type: 'object', properties: {} } }], variables: {} }
  const result = await listener(assembly, {}, async () => assembly)
  assert.equal(result.tools.length, 2)
  assert.equal(result.tools[1], assembly.tools[1], 'small tool untouched')
  assert.ok(result.tools[0].description.includes('tool_schema'))
  assert.ok(JSON.stringify(result.tools[0]).length < JSON.stringify(assembly.tools[0]).length / 2)
})

test('a throwing downstream listener is not swallowed', async () => {
  const { listeners } = createHarness()
  const listener = listeners.get('system-prompt/assemble')
  await assert.rejects(() => listener({ tools: [] }, {}, async () => { throw new Error('boom') }))
})

test('lookup tool returns the full schema and unfolds the tool for good', async () => {
  const { listeners, tools } = createHarness({ minVisibleTools: 0 })
  const assemble = listeners.get('system-prompt/assemble')
  const lookup = tools.get('tool_schema')
  assert.ok(lookup, 'tool_schema must be registered')

  const assembly = { sections: [], contexts: [], tools: [bigSchema()], variables: {} }
  const folded = await assemble(assembly, {}, async () => assembly)
  assert.ok(folded.tools[0].description.includes('tool_schema'))

  const answer = await lookup.execute({ name: 'huge_tool' }, { agent: { id: 'session-a' } })
  const parsed = JSON.parse(answer.text)
  assert.equal(parsed.name, 'huge_tool')
  assert.ok(parsed.parameters.$defs, 'the exact original schema comes back')
  assert.ok(parsed.parameters.$defs.__schema1)

  const after = await assemble(assembly, {}, async () => assembly)
  assert.equal(after.tools[0], assembly.tools[0], 'expanded tool stays expanded (monotone)')
})

test('lookup tool answers a helpful message for an unknown tool', async () => {
  const { tools } = createHarness()
  const answer = await tools.get('tool_schema').execute({ name: 'nope' }, {})
  assert.ok(answer.text.includes('未找到'))
})

test('report tool summarizes savings', async () => {
  const { listeners, tools } = createHarness()
  const listener = listeners.get('tools/post-execute')
  await listener({ name: 'pwsh' }, { isError: false }, async () => contentDecision(bigText()))
  const report = await tools.get('token_saver_report').execute({}, {})
  assert.ok(report.text.includes('结果压缩'))
  assert.ok(/hit|命中/.test(report.text))
})

test('both levers can be switched off independently', async () => {
  const { listeners, tools } = createHarness({ compactResults: false, foldToolSchemas: false, lookupTool: false, reportTool: false })
  const post = listeners.get('tools/post-execute')
  const original = bigText()
  const decision = await post({ name: 'pwsh' }, { isError: false }, async () => contentDecision(original))
  assert.equal(decision.content[0].text, original)
  const assembly = { sections: [], contexts: [], tools: [bigSchema()], variables: {} }
  const result = await listeners.get('system-prompt/assemble')(assembly, {}, async () => assembly)
  assert.equal(result, assembly)
  assert.equal(tools.size, 0)
})

test('skipTools exempts a named tool', async () => {
  const { listeners } = createHarness({ skipTools: ['read'] })
  const listener = listeners.get('tools/post-execute')
  const original = bigText()
  const decision = await listener({ name: 'read' }, { isError: false }, async () => contentDecision(original))
  assert.equal(decision.content[0].text, original)
})

/** A stand-in for the live Session the pre-step hook rewrites. */
function createMockSession(id, events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const nodes = events.map((event) => event.seq)
  const appended = []
  return {
    id,
    appended,
    get surface() {
      return { nodes: [...nodes] }
    },
    eventAt: (seq) => bySeq.get(seq),
    append(type, data, opts) {
      const seq = 9000 + appended.length
      appended.push({ type, seq, data, ...opts })
      nodes.push(seq)
      return appended[appended.length - 1]
    },
  }
}

const assistantEvent = (seq, turn, textLen) => ({
  type: 'assistant/message',
  seq,
  data: {
    turn,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'reasoning', text: 'r'.repeat(textLen) }, { type: 'text', text: `answer ${turn}` }] },
    stream: [],
  },
})

test('elides older-turn thinking when a new turn starts', async () => {
  const { listeners } = createHarness({ elideThinking: true })
  const session = createMockSession('session-1', [assistantEvent(1, 1, 400), assistantEvent(2, 2, 200)])
  listeners.get('session/event')(session, { type: 'turn/end', seq: 3 })

  const preStep = listeners.get('agent/pre-step')
  let nextCalled = 0
  const decision = await preStep({ agent: { id: 'session-1' }, turn: 3, step: 1, messages: [] }, async () => {
    nextCalled++
    return { kind: 'continue' }
  })

  assert.equal(nextCalled, 1, 'the waterfall must always reach next()')
  assert.deepEqual(decision, { kind: 'continue' }, 'and must return the downstream decision unchanged')
  assert.equal(session.appended.length, 1, 'only turn 1 is old enough to clean')
  assert.deepEqual(session.appended[0].surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 })
  assert.deepEqual(
    session.appended[0].data.message.content.map((block) => block.type),
    ['text'],
  )
})

test('only the first step of a turn triggers elision', async () => {
  const { listeners } = createHarness({ elideThinking: true })
  const session = createMockSession('session-1', [assistantEvent(1, 1, 400)])
  listeners.get('session/event')(session, {})
  const preStep = listeners.get('agent/pre-step')
  await preStep({ agent: { id: 'session-1' }, turn: 3, step: 2, messages: [] }, async () => ({}))
  assert.equal(session.appended.length, 0)
})

test('thinking elision can be switched off', async () => {
  const { listeners } = createHarness({ elideThinking: false })
  const session = createMockSession('session-1', [assistantEvent(1, 1, 400)])
  listeners.get('session/event')(session, {})
  await listeners.get('agent/pre-step')({ agent: { id: 'session-1' }, turn: 3, step: 1, messages: [] }, async () => ({}))
  assert.equal(session.appended.length, 0)
})

test('an unknown session id is a no-op', async () => {
  const { listeners } = createHarness()
  listeners.get('agent/pre-step') // registered even when nothing is cached
  const decision = await listeners.get('agent/pre-step')({ agent: { id: 'nope' }, turn: 5, step: 1, messages: [] }, async () => ({ kind: 'continue' }))
  assert.deepEqual(decision, { kind: 'continue' })
})

test('a throwing session does not break the step', async () => {
  const { listeners } = createHarness({ elideThinking: true })
  const session = createMockSession('session-1', [assistantEvent(1, 1, 100)])
  session.eventAt = () => {
    throw new Error('boom')
  }
  listeners.get('session/event')(session, {})
  const decision = await listeners.get('agent/pre-step')({ agent: { id: 'session-1' }, turn: 3, step: 1, messages: [] }, async () => ({ kind: 'continue' }))
  assert.deepEqual(decision, { kind: 'continue' })
})

test('report tool mentions the thinking lever', async () => {
  const { tools } = createHarness()
  const report = await tools.get('token_saver_report').execute({}, {})
  assert.ok(report.text.includes('历史思考清理'))
  assert.ok(report.text.includes('关闭'), 'off by default on current DSH builds')
})

test('a rejected replacement trips a breaker and stops retrying', async () => {
  const { listeners, tools } = createHarness({ elideThinking: true })
  const session = createMockSession('session-1', [assistantEvent(1, 1, 400)])
  let appends = 0
  session.append = () => {
    appends++
    // The exact rejection DSH raises for every assistant/message replacement.
    throw new Error('surface replace: sourceEventSeqs must include every shadowed surface node; missing 1')
  }
  listeners.get('session/event')(session, {})

  const preStep = listeners.get('agent/pre-step')
  await preStep({ agent: { id: 'session-1' }, turn: 3, step: 1, messages: [] }, async () => ({}))
  await preStep({ agent: { id: 'session-1' }, turn: 4, step: 1, messages: [] }, async () => ({}))

  assert.equal(appends, 1, 'one rejection proves the constraint; the breaker must stop retries')
  const report = await tools.get('token_saver_report').execute({}, {})
  assert.ok(report.text.includes('不可用'))
  assert.ok(report.text.includes('sourceEventSeqs'))
})

// ---------------------------------------------------------------------------
// Lever 4 (experimental): request-level thinking elision through llm/stream.
// ---------------------------------------------------------------------------

const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistantWithReasoning = (think, say) => ({
  role: 'assistant',
  content: [{ type: 'reasoning', text: think }, { type: 'text', text: say }],
})
const finishChunk = { type: 'finish', reason: { kind: 'stop' } }

const llmRequest = (...messages) => ({ provider: 'deepseek-account', model: 'deepseek-flash', messages })

const drain = async (iterable) => {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** A mock LlmRuntime whose .stream() re-enters the plugin's waterfall, like DSH does. */
function createMockLlm(listenerRef, dispatched) {
  return {
    stream: (options) => {
      dispatched.push(options)
      return (async function* () {
        yield* listenerRef.current(options, async function* () {
          yield finishChunk
        })
      })()
    },
  }
}

test('request-level elision rewrites the request exactly once and keeps the pipeline', async () => {
  const listenerRef = { current: null }
  const dispatched = []
  const { listeners } = createHarness({ requestThinkingElision: true }, { llm: createMockLlm(listenerRef, dispatched) })
  const listener = listeners.get('llm/stream')
  listenerRef.current = listener

  const request = llmRequest(
    userMsg('turn 1'),
    assistantWithReasoning('old-think', 'answer 1'),
    userMsg('turn 2'),
    assistantWithReasoning('recent-think', 'answer 2'),
  )
  const chunks = await drain(listener(request, async function* () {
    yield finishChunk
  }))

  assert.deepEqual(chunks, [finishChunk], 'the caller sees one clean stream')
  assert.equal(dispatched.length, 1, 'the request is dispatched once, not recursively')
  assert.deepEqual(
    dispatched[0].messages.map((m) => m.content.map((block) => block.type)),
    [['text'], ['text'], ['text'], ['reasoning', 'text']],
    'only the older turn lost its reasoning',
  )
})

test('request-level elision passes the original request through when disabled', async () => {
  const dispatched = []
  const { listeners } = createHarness({}, { llm: createMockLlm({ current: null }, dispatched) })
  const listener = listeners.get('llm/stream')
  const request = llmRequest(
    userMsg('turn 1'),
    assistantWithReasoning('think', 'answer'),
    userMsg('turn 2'),
    assistantWithReasoning('think2', 'answer2'),
  )
  const chunks = await drain(listener(request, async function* () {
    yield finishChunk
  }))
  assert.deepEqual(chunks, [finishChunk])
  assert.equal(dispatched.length, 0, 'disabled: the downstream pipeline runs directly')
})

test('request-level elision passes through when nothing needs stripping', async () => {
  const dispatched = []
  const { listeners } = createHarness({ requestThinkingElision: true }, { llm: createMockLlm({ current: null }, dispatched) })
  const listener = listeners.get('llm/stream')
  const request = llmRequest(userMsg('only turn'), { role: 'assistant', content: [{ type: 'text', text: 'plain' }] })
  const chunks = await drain(listener(request, async function* () {
    yield finishChunk
  }))
  assert.deepEqual(chunks, [finishChunk])
  assert.equal(dispatched.length, 0)
})

test('request-level elision never touches compaction or title requests', async () => {
  const dispatched = []
  const { listeners } = createHarness({ requestThinkingElision: true }, { llm: createMockLlm({ current: null }, dispatched) })
  const listener = listeners.get('llm/stream')
  for (const purpose of ['compaction', 'session-title']) {
    const request = {
      ...llmRequest(userMsg('t1'), assistantWithReasoning('a', 'b'), userMsg('t2'), assistantWithReasoning('c', 'd')),
      purpose,
    }
    await drain(listener(request, async function* () {
      yield finishChunk
    }))
  }
  assert.equal(dispatched.length, 0)
})

test('a rejected re-dispatch falls back to the original request before any chunk', async () => {
  const runtime = {
    stream: () => (async function* () {
      throw new Error('provider rejected the rewritten request')
    })(),
  }
  const { listeners, logs } = createHarness({ requestThinkingElision: true }, { llm: runtime })
  const listener = listeners.get('llm/stream')
  const request = llmRequest(
    userMsg('turn 1'),
    assistantWithReasoning('think', 'answer'),
    userMsg('turn 2'),
    assistantWithReasoning('think2', 'answer2'),
  )
  const chunks = await drain(listener(request, async function* () {
    yield finishChunk
  }))
  assert.deepEqual(chunks, [finishChunk], 'the caller still gets a complete stream')
  assert.ok(logs.some((line) => line.includes('回退原请求')), 'the fallback is logged')
})

test('the original request is never mutated by the elision', async () => {
  const dispatched = []
  let seen = null
  const runtime = {
    stream: (options) => {
      seen = options
      dispatched.push(options)
      return (async function* () {
        yield finishChunk
      })()
    },
  }
  const { listeners } = createHarness({ requestThinkingElision: true }, { llm: runtime })
  const listener = listeners.get('llm/stream')
  const request = llmRequest(
    userMsg('turn 1'),
    assistantWithReasoning('think', 'answer'),
    userMsg('turn 2'),
    assistantWithReasoning('think2', 'answer2'),
  )
  const before = JSON.stringify(request)
  await drain(listener(request, async function* () {
    yield finishChunk
  }))
  assert.equal(JSON.stringify(request), before)
  assert.notEqual(seen, request, 'a new request object is dispatched')
})
