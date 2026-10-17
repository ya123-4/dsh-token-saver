/**
 * Shared reader for DSH session logs (`session.v4.jsonl.zstd`).
 *
 * The file is an append-only sequence of independent zstd frames, each holding
 * one or more JSON lines. Frames are located by their magic number; a
 * false-positive split simply fails to decompress and is skipped.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

export const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

export function readSessionEvents(file) {
  const buf = readFileSync(file)
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      offsets.push(i)
      i += 3
    }
  }
  const events = []
  let failedFrames = 0
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    let text
    try {
      text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      failedFrames++
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        /* frame truncated mid-line: already covered by the next frame */
      }
    }
  }
  return { events, failedFrames, bytes: buf.length }
}

/** List session logs modified within the last `days` days. */
export function collectSessionFiles(root, days) {
  const cutoff = Date.now() - days * 86_400_000
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl.zstd')) {
        try {
          const info = statSync(full)
          if (info.mtimeMs >= cutoff && info.size > 0) files.push(full)
        } catch {
          /* unreadable entry */
        }
      }
    }
  }
  walk(root)
  return files
}

/**
 * Rebuild the live session surface (append / replace ops) and return the
 * events that are currently visible to the model, in order.
 */
export function liveSurfaceEvents(events) {
  const bySeq = new Map()
  const nodes = []
  for (const event of events) {
    if (typeof event.seq !== 'number') continue
    bySeq.set(event.seq, event)
    if (!SURFACE_TYPES.has(event.type)) continue
    const op = event.surfaceOp
    if (op === undefined || op === 'append') {
      nodes.push(event.seq)
    } else if (op && typeof op === 'object' && op.op === 'replace') {
      const { startSeq, endSeq } = op
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i] >= startSeq && nodes[i] <= endSeq) nodes.splice(i, 1)
      }
      nodes.push(event.seq)
    }
  }
  return nodes.map((seq) => bySeq.get(seq)).filter(Boolean)
}

/** Text blocks of one message's content array, concatenated. */
export function textOfMessage(event) {
  const blocks = event?.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}
