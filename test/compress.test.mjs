import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compactText, compactContent, DEFAULT_RULES, MARKER } from '../lib/compress.js'

const rules = (over = {}) => ({ ...DEFAULT_RULES, ...over })

test('strips ANSI control sequences', () => {
  const input = '\u001B[31merror\u001B[0m: bad\n\u001B[2K\u001B[1Gnext'
  const { text, stats } = compactText(input, { rules: rules({ maxChars: 100000 }) })
  assert.equal(text.includes('\u001B'), false)
  assert.ok(stats.ansiChars > 0)
  assert.ok(text.includes('error: bad'))
})

test('folds long runs of identical lines but keeps one copy', () => {
  const line = 'downloading chunk'
  const input = Array.from({ length: 20 }, () => line).join('\n')
  const { text } = compactText(input, { rules: rules({ maxChars: 100000 }) })
  assert.equal(text.split('\n')[0], line)
  assert.ok(text.includes('重复 19 次'))
  assert.ok(text.length < input.length)
})

test('does not fold short runs below minRepeatRun', () => {
  const input = 'a\nb\nb\nb\nc'
  const { text } = compactText(input, { rules: rules({ maxChars: 100000 }) })
  assert.equal(text, input)
})

test('collapses 3+ blank lines to one', () => {
  const input = 'a\n\n\n\n\nb'
  const { text } = compactText(input, { rules: rules({ maxChars: 100000 }) })
  assert.equal(text, 'a\n\nb')
})

test('folds a long base64-looking line', () => {
  const payload = 'A'.repeat(600)
  const { text, stats } = compactText(`header\n${payload}\nfooter`, { rules: rules({ maxChars: 100000 }) })
  assert.ok(text.includes('base64'))
  assert.equal(text.includes(payload), false)
  assert.equal(stats.encodedFolded, 1)
})

test('ceiling keeps head and tail and rescues error lines from the middle', () => {
  const head = Array.from({ length: 400 }, (_, i) => `head line ${i}`).join('\n')
  const middle = ['filler', 'ERROR: the real problem is here', 'filler again'].join('\n')
  const filler = Array.from({ length: 800 }, (_, i) => `middle ${i} ${'x'.repeat(40)}`).join('\n')
  const tail = Array.from({ length: 200 }, (_, i) => `tail line ${i}`).join('\n')
  const input = `${head}\n${middle}\n${filler}\n${tail}`
  const { text, stats } = compactText(input, { rules: rules({ maxChars: 4000, minCharsForCeiling: 1000, headChars: 2000, tailChars: 1000, errorChars: 500 }) })
  assert.ok(text.length < input.length)
  assert.ok(text.includes('head line 0'))
  assert.ok(text.includes('tail line 199'))
  assert.ok(text.includes('ERROR: the real problem is here'), 'error line must be rescued')
  assert.ok(text.includes(MARKER))
  assert.ok(stats.ceilingTrimmed > 0)
  assert.ok(stats.ceilingRescued >= 1)
})

test('never makes text longer, and is idempotent on already-compacted text', () => {
  const input = ['a'.repeat(300), '', '', '', ...Array.from({ length: 50 }, (_, i) => `line ${i} ${'y'.repeat(200)}`)].join('\n')
  const first = compactText(input, { rules: rules({ maxChars: 4000, minCharsForCeiling: 500 }) })
  assert.ok(first.text.length <= input.length)
  const second = compactText(first.text, { rules: rules({ maxChars: 4000, minCharsForCeiling: 500 }) })
  assert.equal(second.text.length <= first.text.length, true)
})

test('failed results pass through untouched when keepErrorsIntact is on', () => {
  const input = Array.from({ length: 900 }, (_, i) => `stack frame ${i} ${'z'.repeat(30)}`).join('\n')
  const { text } = compactText(input, { isError: true, rules: rules({ maxChars: 2000, minCharsForCeiling: 500 }) })
  assert.equal(text, input)
})

test('compactContent leaves non-text blocks untouched and preserves order', () => {
  const big = Array.from({ length: 900 }, (_, i) => `row ${i} ${'q'.repeat(40)}`).join('\n')
  const blocks = [
    { type: 'text', text: 'small' },
    { type: 'image', attachment: { attachmentId: 'a' } },
    { type: 'text', text: big },
  ]
  const { blocks: out, stats } = compactContent(blocks, { rules: rules({ maxChars: 2000, minCharsForCeiling: 500 }) })
  assert.equal(out.length, 3)
  assert.equal(out[1].type, 'image')
  assert.equal(out[0].text, 'small')
  assert.ok(out[2].text.length < big.length)
  assert.ok(stats.saved > 0)
})

test('empty and non-string inputs are safe', () => {
  assert.equal(compactText('').text, '')
  assert.equal(compactText(undefined).text, undefined)
})
