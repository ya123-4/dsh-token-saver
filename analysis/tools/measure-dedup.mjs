/**
 * Measure how much of the live tool-result surface is repeated content:
 * the same bytes shown again in a later step of the same session.
 * Repetition is the cheapest possible saving (a reference replaces a copy).
 *
 * Usage: node tools/measure-dedup.mjs [--days 14]
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { collectSessionFiles, readSessionEvents, liveSurfaceEvents } from './session-log.mjs'

const args = process.argv.slice(2)
const argValue = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const days = Number(argValue('--days', '14'))
const sessionsRoot = argValue('--sessions', join(process.env.USERPROFILE ?? '', '.dsh', 'sessions'))
const MIN_CHARS = Number(argValue('--min', '1000'))

const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : 'n/a')

const byTool = new Map()
let totalChars = 0
let repeatedChars = 0
let repeatedEntries = 0
let eligibleEntries = 0
let sessions = 0

for (const file of collectSessionFiles(sessionsRoot, days)) {
  let parsed
  try {
    parsed = readSessionEvents(file)
  } catch {
    continue
  }
  if (parsed.events.length === 0) continue
  sessions++

  const callNames = new Map()
  for (const event of parsed.events) {
    if (event.type === 'tool/call') callNames.set(event.data.callId, event.data.name)
  }

  const seen = new Map()
  for (const event of liveSurfaceEvents(parsed.events)) {
    if (event.type !== 'tool/result') continue
    const blocks = event.data?.message?.content
    if (!Array.isArray(blocks)) continue
    const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
    if (text.length < MIN_CHARS) continue
    const tool = callNames.get(event.data.message?.toolCallId) ?? '(unknown)'
    totalChars += text.length
    eligibleEntries++
    const fingerprint = createHash('sha256').update(text).digest('hex')
    const acc = byTool.get(tool) ?? { entries: 0, chars: 0, repeatChars: 0, repeats: 0 }
    acc.entries++
    acc.chars += text.length
    if (seen.has(fingerprint)) {
      repeatedChars += text.length
      repeatedEntries++
      acc.repeatChars += text.length
      acc.repeats++
    } else {
      seen.set(fingerprint, event.seq)
    }
    byTool.set(tool, acc)
  }
}

console.log(`sessions: ${sessions}`)
console.log(`entries >= ${MIN_CHARS} chars: ${eligibleEntries}, total ${fmt(totalChars)} chars`)
console.log(`byte-identical repeats: ${repeatedEntries} entries, ${fmt(repeatedChars)} chars (${pct(repeatedChars, totalChars)} of eligible surface)`)
console.log()
console.log('| tool | entries | chars | repeat entries | repeat chars | repeat share |')
console.log('| --- | ---: | ---: | ---: | ---: | ---: |')
for (const [tool, acc] of [...byTool.entries()].sort((a, b) => b[1].repeatChars - a[1].repeatChars).slice(0, 12)) {
  console.log(`| ${tool} | ${acc.entries} | ${fmt(acc.chars)} | ${acc.repeats} | ${fmt(acc.repeatChars)} | ${pct(acc.repeatChars, acc.chars)} |`)
}
