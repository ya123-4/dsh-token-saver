# dsh-token-saver

A token-saving plugin for DeepSeek Harness (DSH) that cuts what **every request pays for**, without trading away task success.

It does not guess which content matters. It applies two deterministic levers behind a **never-worse double gate**: if a change is not genuinely cheaper, the original bytes are passed through untouched.

## Why these two levers (measured locally)

Offline analysis of 106 real session logs / 9670 model steps (last 14 days):

| Observation | Measured |
| --- | --- |
| Real context per step (input + cache read) | ≈ 359k tokens |
| **Tool-schema overhead per request** | **77.2k avg, 185k max** |
| Share of that which is parameter structure | 90% (top-level descriptions only 10%) |
| Tool results as share of the live surface | 45.2% |
| Historical reasoning as share of the live surface | 31.7% |
| Byte-identical repeated tool results | 0.2% (so dedup was **not** built) |

The single biggest waste is the 77k–185k of tool schemas sent on every request — and 90% of it is structure, not prose, so description trimming is worthless (measured: 2.4%).

### Lever 1 — progressive tool disclosure (`system-prompt/assemble`)

Oversized schemas (default > 2000 tokens) collapse into a **still-callable** skeleton: property names, primitive types, small enums and `required` survive; `$defs`, deep nesting and long descriptions do not. The tool stays listed with a one-line description plus an explicit hint to fetch the exact schema via the new `tool_schema` tool. Expansion is **monotone** (once expanded in a session, never folded again), so the request prefix never flaps and provider prefix caching stays warm. Fail-open: small tools are never touched.

Replay over 90 real request headers (8868 tool entries):

- average schema per request: 68.0k → **25.9k tokens (-61.9%)**
- the 37 sessions that had foldable tools: 155.5k → **53.1k (-65.9%, 102.4k saved per request)**
- the other 53 sessions: nothing changes at all
- safety: tool count and order unchanged, no schema grows, no dangling `$ref`, skeletons valid

### Lever 2 — deterministic tool-result compaction (`tools/post-execute`)

Head/tail window with **error-line rescue** from the elided middle, repeated-line folding, base64/hex folding, blank-line collapsing. Every elision carries an explicit marker with the amount hidden, so the model can tell "the tool printed nothing" from "content was elided".

**Never-worse double gate:** a result is replaced only if it shrinks below 75% of the original *and* saves at least 500 characters *and* its estimated token count strictly drops. Failed results are never touched.

### Lever 3 — history thinking elision — **unavailable on current DSH, default OFF**

> **Withdrawn in v0.2.1**: in the real host this never succeeded once (`1189 rejections, 0 applied`). Reading the DSH source shows an architectural two-way lock, not a calling mistake:
>
> ```js
> // @deepseek-ai/dsh-session/lib/index.js
> if (event.type === "assistant/message" && sourceEventSeqs !== undefined)
>     throw new Error("assistant/message embeds its source stream and cannot carry sourceEventSeqs")
> const missing = shadowedSeqs.filter((seq) => !sources.has(seq))
> if (missing.length > 0)
>     throw new Error("surface replace: sourceEventSeqs must include every shadowed surface node")
> ```
>
> Without `sourceEventSeqs` the replace "misses" the shadowed node; with it, `assistant/message` is rejected outright. DSH deliberately keeps assistant messages immutable (they embed their full generation stream, the authoritative replay record) — `tool/result` is exempt, `assistant/message` is not.
>
> So `elideThinking` defaults to **off**, a rejection trips a breaker that stops retrying, and `token_saver_report` states why. The code stays for the day upstream relaxes the constraint. The measured upside (2.64M tokens ≈ 21.9% of long-session context) waits with it.

Original design (inactive, kept for context): when a new turn starts, `reasoning` blocks would be removed from the surface for **older** turns only, keeping every assistant text block, every tool-call block, the raw `stream` replay record, and the most recent `keepRecentTurns` turns.

| Metric (replay estimate at the time) | Result |
| --- | --- |
| Elidable historical thinking | 5.50M chars ≈ **2.64M tokens** |
| Affected multi-turn sessions | 14, elision averages **21.9%** of visible context (max 32.6%) |
| Left untouched | 1774 assistant text blocks, 4780 tool-call blocks |
| Safety guard | **23** real messages would be left contentless — the logic detects and skips them |

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `foldToolSchemas` | `true` | enable schema folding |
| `foldThresholdTokens` | `2000` | fold tools costing more than this |
| `minVisibleTools` | `4` | keep at least this many fully rendered entries |
| `alwaysKeepTools` | `[]` | never fold these tools |
| `compactResults` | `true` | enable result compaction |
| `maxChars` | `24000` | ceiling for one compacted result |
| `minSavingChars` | `500` | minimum characters saved to bother |
| `keepRatioMax` | `0.75` | compacted size must be at most this fraction |
| `keepErrorsIntact` | `true` | never compact failed results |
| `skipTools` | `[]` | results of these tools are never compacted |
| `elideThinking` | `true` | drop reasoning text from older turns (conclusions and tool calls stay) |
| `keepRecentTurns` | `1` | how many recent turns keep their reasoning intact |
| `lookupTool` / `reportTool` | `true` | expose `tool_schema` / `token_saver_report` |
| `verbose` | `false` | log every fold/compaction |

Override any key in the profile `cordis.patch.yml` under `id: token-saver`.

## Safety invariants

1. **Fail-open** — any error logs a warning and passes the original through.
2. **Monotone decisions** — no fold/unfold flapping, so cache-write penalties cannot eat the savings.
3. **Explicit elision** — nothing is dropped silently.
4. **Never rewrites the request** — `llm/stream` payloads are deep-frozen by design; this plugin only works at the two documented mutable points (`system-prompt/assemble`, `tools/post-execute`) and never rewrites history or the session surface.
5. **Tool identity is untouched** — folding changes presentation only.

## Relationship to other plugins

- `@yilinxiao/dsh-mcp-lazy` decides whether MCP tools get *registered*; this plugin decides whether registered schemas get *sent whole*. They compose.
- `dsh-plugin-save-token` pushes single-point tool-result compaction very far (TOON, tabular stride, spill+expand, dedup). This plugin's result compaction is deliberately more conservative, and its unique value is the **schema side**, which that plugin does not touch at all.

## Install

```powershell
plugin_manager install_bundle  <path-to-tgz>
```

## Test

```bash
node --test test/   # 48 tests: compaction rules, gates, fold safety, thinking elision, plugin wiring
```

## License

MIT
