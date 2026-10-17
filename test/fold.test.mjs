import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens, foldTools, foldTool, skeletonize, firstSentence, schemaTokens, FOLD_HINT } from '../lib/fold.js'

const bigSchema = (depth = 3) => {
  const node = { type: 'object', description: 'x'.repeat(400), properties: {} }
  let current = node
  for (let i = 0; i < depth; i++) {
    current.properties = {
      [`field_${i}_${'n'.repeat(20)}`]: {
        type: 'object',
        description: 'y'.repeat(400),
        properties: { nested: { type: 'string', description: 'z'.repeat(300) }, other: { type: 'number', enum: [1, 2, 3] } },
      },
    }
    current = current.properties[`field_${i}_${'n'.repeat(20)}`]
  }
  return node
}

const tool = (name, parameters, description = 'Does a thing. More detail follows here.') => ({ name, description, parameters })

test('estimateTokens counts ASCII and CJK differently', () => {
  assert.ok(estimateTokens('a'.repeat(400)) < estimateTokens('中'.repeat(400)))
  assert.equal(estimateTokens(''), 0)
})

test('skeletonize keeps names, primitive types and required, drops nesting', () => {
  const skeleton = skeletonize({
    type: 'object',
    required: ['alpha', 'missing'],
    properties: {
      alpha: { type: 'string', description: 'long'.repeat(50), enum: ['a', 'b'] },
      beta: { type: 'object', properties: { deep: { type: 'object', properties: { x: { type: 'string' } } } } },
      gamma: { $ref: '#/$defs/__schema1' },
    },
  })
  assert.deepEqual(Object.keys(skeleton.properties), ['alpha', 'beta', 'gamma'])
  assert.deepEqual(skeleton.properties.alpha.enum, ['a', 'b'])
  assert.equal(skeleton.properties.beta.type, 'object')
  assert.equal('properties' in skeleton.properties.beta, false)
  assert.equal(skeleton.additionalProperties, true)
  assert.deepEqual(skeleton.required, ['alpha'])
})

test('firstSentence truncates on a sentence boundary', () => {
  const text = 'First sentence is here. Second sentence is much longer and should be dropped.'
  assert.equal(firstSentence(text, 30), 'First sentence is here.')
  assert.equal(firstSentence('short', 30), 'short')
})

test('foldTool announces the lookup tool in the description', () => {
  const folded = foldTool(tool('mcp__x__big', bigSchema()))
  assert.ok(folded.description.includes('tool_schema'))
  assert.ok(folded.description.includes(FOLD_HINT('mcp__x__big').slice(0, 20)))
  assert.ok(schemaTokens(folded) < schemaTokens(tool('mcp__x__big', bigSchema())))
})

test('only schemas above the threshold fold', () => {
  const small = tool('small', { type: 'object', properties: { a: { type: 'string' } } })
  const big = tool('big', bigSchema(4))
  const result = foldTools([small, big], { foldThresholdTokens: 400, minVisibleTools: 0 })
  assert.deepEqual(result.folded, ['big'])
  assert.equal(result.tools[0], small, 'untouched tools keep identity')
  assert.ok(result.tools[1].description.includes('tool_schema'))
  assert.ok(result.savedTokens > 0)
})

test('expanded tools are never folded again (monotone)', () => {
  const big = tool('big', bigSchema(4))
  const result = foldTools([big], { foldThresholdTokens: 400, minVisibleTools: 0, expanded: new Set(['big']) })
  assert.deepEqual(result.folded, [])
  assert.equal(result.tools[0], big)
})

test('alwaysKeep wins over the threshold', () => {
  const big = tool('big', bigSchema(4))
  const result = foldTools([big], { foldThresholdTokens: 400, minVisibleTools: 0, alwaysKeep: new Set(['big']) })
  assert.deepEqual(result.folded, [])
})

test('the catalogue is never emptied below minToolsKept', () => {
  const tools = [tool('a', bigSchema(4)), tool('b', bigSchema(4))]
  const result = foldTools(tools, { foldThresholdTokens: 100, minVisibleTools: 2 })
  assert.deepEqual(result.folded, [])
})

test('folding a schema never increases its size', () => {
  const alreadyTiny = { name: 'tiny', description: 'x', parameters: { type: 'object', properties: { a: {} } } }
  const result = foldTools([alreadyTiny], { foldThresholdTokens: 1, minVisibleTools: 0 })
  if (result.folded.length > 0) {
    assert.ok(schemaTokens(result.tools[0]) < schemaTokens(alreadyTiny))
  }
})

test('malformed tools are left alone', () => {
  const result = foldTools([null, { description: 'no name' }, tool('ok', bigSchema(4))], { foldThresholdTokens: 400, minVisibleTools: 0 })
  assert.equal(result.tools[0], null)
  assert.equal(result.tools[1].name, undefined)
})
