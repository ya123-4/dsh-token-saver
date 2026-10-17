/**
 * Inspect the anatomy of the biggest tool schemas: how much of their token
 * cost is structure the model must see to call the tool correctly, versus
 * repetition/description that a slimmer rendering could drop safely.
 *
 * Usage: node tools/inspect-schema.mjs [--top 3] [--days 14]
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectSessionFiles, readSessionEvents } from './session-log.mjs'

const tokenxUrl = pathToFileURL(
  join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'node_modules', 'tokenx', 'dist', 'index.mjs'),
).href
const { estimateTokenCount } = await import(tokenxUrl)

const args = process.argv.slice(2)
const argValue = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const top = Number(argValue('--top', '2'))
const days = Number(argValue('--days', '14'))
const sessionsRoot = argValue('--sessions', join(process.env.USERPROFILE ?? '', '.dsh', 'sessions'))

const T = (s) => (s ? estimateTokenCount(typeof s === 'string' ? s : JSON.stringify(s)) : 0)
const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))

// Pick the header with the largest schema in the window.
let best = null
for (const file of collectSessionFiles(sessionsRoot, days)) {
  let parsed
  try {
    parsed = readSessionEvents(file)
  } catch {
    continue
  }
  for (const event of parsed.events) {
    if (event.type !== 'request/header' || !Array.isArray(event.data?.header?.tools)) continue
    const cost = T(event.data.header.tools)
    if (!best || cost > best.cost) best = { cost, tools: event.data.header.tools }
  }
}
if (!best) throw new Error('no request header found')

console.log(`largest tools payload: ${fmt(best.cost)} tokens, ${best.tools.length} tools\n`)
const ranked = best.tools.map((tool) => ({
  tool,
  cost: T(tool.parameters ?? {}) + T(tool.description ?? ''),
})).sort((a, b) => b.cost - a.cost)

for (const { tool, cost } of ranked.slice(0, top)) {
  console.log(`=== ${tool.name} — ${fmt(cost)} tokens ===`)
  console.log(`description (${(tool.description ?? '').length} chars, ${T(tool.description ?? '')} tok): ${(tool.description ?? '').slice(0, 200)}…`)
  const params = tool.parameters ?? {}
  console.log(`top-level keys: ${Object.keys(params).join(', ')}`)
  const props = params.properties ?? {}
  const rows = Object.entries(props).map(([key, value]) => {
    const declaration = JSON.stringify(value)
    return { key, tokens: T(declaration), type: value?.type ?? (value?.oneOf ? 'oneOf' : value?.anyOf ? 'anyOf' : '?'), chars: declaration.length }
  }).sort((a, b) => b.tokens - a.tokens)
  console.log(`parameters: ${rows.length} properties, ${fmt(T(params))} tokens`)
  for (const row of rows.slice(0, 12)) {
    console.log(`  - ${row.key}: ${row.type}, ${fmt(row.tokens)} tok, ${row.chars} chars`)
  }
  // Depth analysis of the largest property.
  if (rows[0]) {
    const biggest = props[rows[0].key]
    const skeleton = JSON.stringify(biggest, (key, value) => {
      if (key === 'description') return typeof value === 'string' ? `<${value.length}c>` : value
      if (key === 'enum' && Array.isArray(value) && value.length > 6) return [`<enum ${value.length}>`]
      return value
    }, 1)
    console.log(`  structure of "${rows[0].key}" with descriptions/enums collapsed (${skeleton.length} chars):`)
    console.log(skeleton.split('\n').slice(0, 45).map((line) => `    ${line}`).join('\n'))
    const collapsed = T(skeleton)
    console.log(`  → that property: ${fmt(rows[0].tokens)} tok raw vs ${fmt(collapsed)} tok structure-only`)
  }
  console.log()
}

// Aggregate: how much of all schemas is enum/description noise?
let totalTokens = 0
let descTokens = 0
let enumTokens = 0
for (const tool of best.tools) {
  totalTokens += T(tool.parameters ?? {}) + T(tool.description ?? '')
  descTokens += T(tool.description ?? '')
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 14) return
    if (Array.isArray(node.enum)) enumTokens += T(node.enum)
    for (const value of Object.values(node)) walk(value, depth + 1)
  }
  walk(tool.parameters ?? {})
}
console.log(`ALL TOOLS: ${fmt(totalTokens)} tokens total; top-level descriptions ${fmt(descTokens)}; enum literals ${fmt(enumTokens)}`)
