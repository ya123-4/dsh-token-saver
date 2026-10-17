/**
 * Dump the shape of the few event types the token accounting depends on.
 * Usage: node tools/dump-events.mjs <session.v4.jsonl.zstd> [type ...]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const wanted = process.argv.slice(3)
const buf = readFileSync(file)

const magic = [0x28, 0xb5, 0x2f, 0xfd]
const offsets = []
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) {
    offsets.push(i)
    i += 3
  }
}
const lines = []
let failed = 0
for (let i = 0; i < offsets.length; i++) {
  const start = offsets[i]
  const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
  try {
    lines.push(...zstdDecompressSync(buf.subarray(start, end)).toString('utf8').split('\n').filter((l) => l.trim() !== ''))
  } catch {
    failed++
  }
}
console.log('frames:', offsets.length, 'failed:', failed, 'lines:', lines.length)

const seen = new Map()
for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  const type = event.type
  const count = (seen.get(type) ?? 0) + 1
  seen.set(type, count)
  if (!wanted.includes(type)) continue
  if (count > 2) continue
  const text = JSON.stringify(event)
  console.log(`\n=== ${type} (${text.length} chars) ===`)
  console.log(text.slice(0, 1400))
}

console.log('\n=== counts ===')
for (const [type, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5), type)
