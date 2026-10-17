/**
 * Probe one DSH session log: decompress the zstd jsonl and report the event
 * shape, so the analyzer can be written against the real format.
 *
 * Usage: node tools/probe-session.mjs <path-to-session.v4.jsonl.zstd>
 */
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'

const file = process.argv[2]
if (!file) throw new Error('usage: node probe-session.mjs <file>')

const rawBytes = statSync(file).size
let text
try {
  const chunks = []
  const stream = createReadStream(file).pipe(createZstdDecompress())
  for await (const chunk of stream) chunks.push(chunk)
  text = Buffer.concat(chunks).toString('utf8')
} catch (error) {
  console.log('zstd failed:', error.message, '- falling back to plain read')
  text = readFileSync(file).toString('utf8')
}
const raw = { length: rawBytes }
const lines = text.split('\n').filter((line) => line.trim() !== '')
console.log('bytes:', raw.length, 'lines:', lines.length)

const counts = new Map()
const bytesByType = new Map()
const samples = new Map()
for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    counts.set('<unparsed>', (counts.get('<unparsed>') ?? 0) + 1)
    continue
  }
  const type = event.type ?? event.kind ?? '<none>'
  counts.set(type, (counts.get(type) ?? 0) + 1)
  bytesByType.set(type, (bytesByType.get(type) ?? 0) + line.length)
  if (!samples.has(type)) samples.set(type, line)
}
const rows = [...counts.entries()].sort((a, b) => b[1] - a[1])
console.log('\n=== event counts / bytes ===')
for (const [type, n] of rows) {
  console.log(`${String(n).padStart(6)}  ${String(bytesByType.get(type)).padStart(10)}B  ${type}`)
}

console.log('\n=== top-level record keys (first line) ===')
console.log(Object.keys(JSON.parse(lines[0])).join(', '))

console.log('\n=== sample per type (truncated) ===')
for (const [type, sample] of samples) {
  if (type === '<unparsed>') continue
  console.log(`\n--- ${type} ---`)
  console.log(sample.slice(0, 900))
}
