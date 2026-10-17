/**
 * Inspect the physical framing of a DSH session log (*.jsonl.zstd):
 * are the zstd frames contiguous, length-prefixed, or newline separated?
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)
console.log('size:', buf.length)
console.log('head hex:', buf.subarray(0, 64).toString('hex').replace(/(..)/g, '$1 '))

const magic = [0x28, 0xb5, 0x2f, 0xfd]
const offsets = []
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) {
    offsets.push(i)
    i += 3
  }
}
console.log('zstd magic count:', offsets.length)
console.log('first 15 offsets:', offsets.slice(0, 15).join(', '))
const gaps = []
for (let i = 1; i < Math.min(offsets.length, 200); i++) gaps.push(offsets[i] - offsets[i - 1])
console.log('first 30 gaps:', gaps.slice(0, 30).join(', '))

const newlines = []
for (let i = 0; i < Math.min(buf.length, 4096); i++) if (buf[i] === 0x0a) newlines.push(i)
console.log('newline offsets in first 4K:', newlines.slice(0, 20).join(', '))

// Try to decompress frame by frame using the magic offsets as boundaries.
let ok = 0
let totalBytes = 0
const texts = []
for (let i = 0; i < Math.min(offsets.length, 5); i++) {
  const start = offsets[i]
  const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
  try {
    const out = zstdDecompressSync(buf.subarray(start, end))
    ok++
    totalBytes += out.length
    texts.push(out.toString('utf8').slice(0, 300))
  } catch (error) {
    texts.push(`<frame ${i} failed: ${error.code ?? error.message}>`)
  }
}
console.log('frames decoded ok:', ok, 'bytes:', totalBytes)
texts.forEach((t, i) => console.log(`\n--- frame ${i} ---\n${t}`))
