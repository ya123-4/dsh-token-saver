/**
 * Minimal Electron asar reader, used to read DSH's own implementation.
 *
 * Format:
 *   offset 0..3   uint32  = 4 (size of the next pickle's payload)
 *   offset 4..7   uint32  = total size of the header pickle that follows
 *   offset 8..    header pickle: uint32 jsonLength, then jsonLength bytes of JSON
 *   dataStart     = 8 + headerPickleSize (4-byte aligned)
 *   each file entry has { offset, size } relative to dataStart.
 *
 * Usage:
 *   node tools/asar-inspect.mjs --asar <path> --list <prefix>
 *   node tools/asar-inspect.mjs --asar <path> --cat <entry-path>
 *   node tools/asar-inspect.mjs --asar <path> --grep <regex> [--limit N] [--max-files N]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const asarPath = argValue('--asar')
if (!asarPath) throw new Error('--asar is required')

const buf = readFileSync(asarPath)
// bytes 0..3: payload size of the first pickle (= 4)
// bytes 4..7: total size of the header pickle that follows
const headerPickleSize = buf.readUInt32LE(4)
const headerBuf = buf.subarray(8, 8 + headerPickleSize)
// header pickle: bytes 0..3 payload size, bytes 4..7 string length, then JSON
const jsonLength = headerBuf.readUInt32LE(4)
const header = JSON.parse(headerBuf.subarray(8, 8 + jsonLength).toString('utf8'))
const dataStart = 8 + headerPickleSize

/** Walk the asar directory tree into a flat { path -> {offset,size} } map. */
function flatten(node, prefix = '', out = new Map()) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (child.files) flatten(child, path, out)
    else out.set(path, { offset: Number(child.offset), size: Number(child.size), unpacked: child.unpacked })
  }
  return out
}
const files = flatten(header)

const list = argValue('--list')
const cat = argValue('--cat')
const grep = argValue('--grep')
const limit = Number(argValue('--limit', '40'))
const maxFiles = Number(argValue('--max-files', '4000'))

const readEntry = (entry) => {
  if (entry.unpacked) return null
  return buf.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size)
}

if (list) {
  const matches = [...files.keys()].filter((path) => path.includes(list))
  console.log(`matched ${matches.length} entries (showing ${Math.min(matches.length, limit)})`)
  for (const path of matches.slice(0, limit)) console.log(path)
} else if (cat) {
  const entry = files.get(cat)
  if (!entry) {
    console.error(`not found: ${cat}`)
    process.exit(2)
  }
  const bytes = readEntry(entry)
  if (bytes === null) {
    console.error('entry is unpacked (lives in app.asar.unpacked)')
    process.exit(3)
  }
  const outFile = argValue('--out')
  if (outFile) {
    writeFileSync(outFile, bytes)
    console.log(`wrote ${bytes.length} bytes -> ${outFile}`)
  } else {
    process.stdout.write(bytes)
  }
} else if (grep) {
  const pattern = new RegExp(grep)
  let scanned = 0
  let hits = 0
  for (const [path, entry] of files) {
    if (entry.unpacked) continue
    if (!/\.(js|mjs|cjs|ts|json)$/.test(path)) continue
    if (scanned++ > maxFiles) break
    const bytes = readEntry(entry)
    if (!bytes) continue
    const text = bytes.toString('utf8')
    if (!pattern.test(text)) continue
    hits++
    console.log(`\n=== ${path} (${entry.size} bytes) ===`)
    const lines = text.split('\n')
    const hitsInFile = []
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) hitsInFile.push(i)
    }
    for (const index of hitsInFile.slice(0, 6)) {
      const from = Math.max(0, index - 2)
      const to = Math.min(lines.length, index + 8)
      console.log(`--- line ${index + 1} ---`)
      console.log(lines.slice(from, to).map((line) => line.length > 400 ? `${line.slice(0, 400)}…` : line).join('\n'))
    }
    if (hits >= limit) break
  }
  console.log(`\nscanned ${scanned} files, ${hits} matched`)
} else {
  console.log(`entries: ${files.size}`)
  const top = new Set([...files.keys()].map((path) => path.split('/')[0]))
  console.log('top level:', [...top].join(', '))
}
