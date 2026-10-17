/**
 * Within-session A/B: did request-level thinking elision keep or destroy the
 * provider prefix cache?
 *
 * The cache is a prefix match. If rewriting older turns invalidates the prefix,
 * the next request re-prices everything after the first changed node at full
 * input price, which can cost more than the tokens that were removed. Since the
 * plugin's switch was flipped mid-session, the same log holds both arms:
 *
 *   before <cut>  no request elision
 *   after  >=cut  request elision active
 *
 * Compares per-step cache-read share, input tokens per step, and the implied
 * cost at DeepSeek's published cache-read ratio (0.1x of full input).
 *
 * Usage: node tools/cache-ab.mjs --session <file> --cut <ISO time>
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const argValue = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d
}
const sessionFile = argValue('--session')
const cutIso = argValue('--cut', '2026-10-17T13:51:00+08:00')
const cacheReadRatio = Number(argValue('--cache-read-ratio', '0.1'))
if (!sessionFile) throw new Error('--session is required')

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const buf = readFileSync(sessionFile)
const offsets = []
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
    offsets.push(i)
    i += 3
  }
}
const events = []
for (let i = 0; i < offsets.length; i++) {
  const start = offsets[i]
  const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
  let text
  try {
    text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
  } catch {
    continue
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* partial frame */
    }
  }
}

const cut = new Date(cutIso).getTime()
const steps = []
for (const event of events) {
  if (event.type !== 'assistant/message') continue
  const usage = event.data?.usage
  if (!usage || typeof usage.inputTokens !== 'number') continue
  steps.push({
    time: event.time,
    turn: event.data.turn,
    step: event.data.step,
    input: usage.inputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    output: usage.outputTokens ?? 0,
    arm: event.time >= cut ? 'after' : 'before',
  })
}

/** Equivalent cost in "full-price input tokens". */
const priced = (s) => s.input + s.cacheRead * cacheReadRatio + s.cacheWrite * 1.25

const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : 'n/a')

const arms = ['before', 'after'].map((arm) => {
  const list = steps.filter((s) => s.arm === arm)
  const total = {
    n: list.length,
    input: list.reduce((a, s) => a + s.input, 0),
    cacheRead: list.reduce((a, s) => a + s.cacheRead, 0),
    cacheWrite: list.reduce((a, s) => a + s.cacheWrite, 0),
    output: list.reduce((a, s) => a + s.output, 0),
    priced: list.reduce((a, s) => a + priced(s), 0),
  }
  return { arm, list, total }
})

console.log('# 请求级思考清理 · 同会话 A/B（缓存影响实测）')
console.log()
console.log(`- 会话：${sessionFile.split(/[\\/]/).slice(-2)[0]}`)
console.log(`- 分界：${cutIso}（重启并开启 requestThinkingElision）`)
console.log(`- 有效步数：before ${arms[0].total.n} / after ${arms[1].total.n}`)
console.log()
console.log('| 组 | 步数 | input | cacheRead | cacheWrite | 缓存命中率 | 每步等效成本 |')
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const { arm, total } of arms) {
  const denom = total.input + total.cacheRead
  console.log(
    `| ${arm} | ${total.n} | ${fmt(total.input)} | ${fmt(total.cacheRead)} | ${fmt(total.cacheWrite)} | ${pct(total.cacheRead, denom)} | ${total.n > 0 ? fmt(total.priced / total.n) : 'n/a'} |`,
  )
}
console.log()

const before = arms[0].total
const after = arms[1].total
if (before.n > 0 && after.n > 0) {
  const beforePerStep = before.priced / before.n
  const afterPerStep = after.priced / after.n
  const delta = afterPerStep - beforePerStep
  console.log(`- 每步等效成本：before ${fmt(beforePerStep)} → after ${fmt(afterPerStep)}（${delta >= 0 ? '+' : ''}${fmt(delta)}，${pct(Math.abs(delta), beforePerStep)}）`)
  console.log(`- 若为正 = 清理更贵（缓存惩罚 > 删除收益）；为负 = 清理更省`)
  console.log()
}

console.log('## 逐步骤（最后 24 步）')
console.log()
console.log('| # | turn.step | 组 | input | cacheRead | 命中率 | 等效成本 |')
console.log('| ---: | --- | --- | ---: | ---: | ---: | ---: |')
const tail = steps.slice(-24)
tail.forEach((s, i) => {
  const denom = s.input + s.cacheRead
  console.log(`| ${i + 1} | ${s.turn}.${s.step} | ${s.arm} | ${fmt(s.input)} | ${fmt(s.cacheRead)} | ${pct(s.cacheRead, denom)} | ${fmt(priced(s))} |`)
})
console.log()

// Cache-hit trend: the first steps of a turn after a rewrite are the expensive ones.
const afterArm = arms[1].list
if (afterArm.length > 0) {
  console.log('## after 组的首步 vs 后续步（清理发生在 turn 首步前）')
  console.log()
  const firsts = afterArm.filter((s) => s.step === 1)
  const rests = afterArm.filter((s) => s.step !== 1)
  const avg = (list, pick) => (list.length > 0 ? list.reduce((a, s) => a + pick(s), 0) / list.length : 0)
  console.log('| 分组 | 步数 | 平均 input | 平均 cacheRead | 平均命中率 | 平均等效成本 |')
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const [label, list] of [['turn 首步（清理后）', firsts], ['同 turn 后续步', rests]]) {
    const denom = avg(list, (s) => s.input + s.cacheRead)
    console.log(
      `| ${label} | ${list.length} | ${fmt(avg(list, (s) => s.input))} | ${fmt(avg(list, (s) => s.cacheRead))} | ${pct(avg(list, (s) => s.cacheRead), denom)} | ${fmt(avg(list, priced))} |`,
    )
  }
  console.log()
  console.log('若"首步"命中率明显低于"后续步"，说明每次清理都在支付一次前缀重建；')
  console.log('若两者接近，说明清理的确定性设计保住了缓存。')
}
