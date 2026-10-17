# `dsh-plugin-save-token` 拆解报告（v2.4.1）

证据基线：`tmpwork/save-token-probe/dsh-plugin-save-token-2.4.1.tgz`（shasum 6a3ee2964bed54e19d7adb0322c556878b736ea8，12 文件），解包于 `tmpwork/save-token-probe/pkg/package/`。包内含 **完整 src/**（非仅构建产物），可直接读实现。

## 1. 存在性 / 版本 / 作者 / 时间 / 下载量

- 真实存在。`latest = 2.4.1`；历史版本 `2.0.0, 2.1.0, 2.1.1, 2.1.2, 2.1.3, 2.4.1`（注意 **2.2.x/2.3.x 未发布到 npm**，但 2.4.1 的源码注释完整记录了 v2.2.0/v2.3.0/v2.4.0 变更）。
- 作者/维护者：`playwithai <lixw.java@gmail.com>`；仓库 `github.com/vibe-any/dsh-plugin-save-token`；License MIT；`engines.node >= 18`。
- 时间：首次发布 `2026-08-27T02:27:16Z`（2.0.0），最新发布 `2026-09-04T01:29:55Z`（2.4.1），末次 registry 修改同刻。
- 周下载量 **1502**（2026-10-06 ~ 10-12）；月下载量 **4494**（2026-09-13 ~ 10-12）。来源 `api.npmjs.org/downloads/point`。
- 发布形态：`dsh.bundle.patch` 型 **bundle 插件**（非动态插件），安装后无需 GUI 授权弹窗。

## 2. 注册的 DSH 事件 / 服务钩子

全部钩子只有 **3 个 waterfall + 1 个工具 + 1 组 HTTP 路由 + 2 个 client slot**。声明：
`pkg/package/src/index.js:75` — `export const inject = ['tools', 'webServer']`；`spillStore` / `compaction` 用 `ctx.get()` 惰性读、**均可缺失**。

**(a) `tools/post-execute`（`prepend: true`）— 唯一的压缩入口**（`src/index.js:244-247, 331`）：
```js
ctx.on('tools/post-execute', async function (exec, result, next) {
  var decision = await next()
  if (!decision || decision.kind !== 'accept') return decision
  if (Object.prototype.hasOwnProperty.call(decision, 'value')) return decision
  ...
}, { prepend: true })
```
返回值形状：`{ kind: 'accept', content: [{ type: 'text', text: <替换文本> }] }`（`src/index.js:289`, `:330`）；放弃时原样 `return decision`。
再入保护：`exec.parent !== undefined`（嵌套/子代理调用）直接放行，仅计数（`:252-254`）；`exec.name === 'read'` 与 `'save_token_expand'` 放行（`:260-261`）；只处理 `flattenPlainText(content)` 全为 `{type:'text'}` 的情形（`:180-189`）。

**(b) `llm/stream` — 纯计量，不改写请求**（`src/index.js:360, 421-428`）：
```js
ctx.on('llm/stream', function (options, next) {
  var rec = { ts: Date.now(), kind: options.purpose ? 'aux' : 'request', ... }
  ...
  var inner = next()
  async function* tracked() {
    try { for await (var chunk of inner) { observe(chunk); yield chunk } }
    finally { closeRecord() }
  }
  return tracked()
})
```
返回值形状：**透传异步生成器**；只读 `chunk.type === 'usage'`（`inputTokens/cacheReadTokens/cacheWriteTokens/outputTokens/reasoningTokens`）与 `chunk.type === 'finish'`（`:381-393`）。不修改 `options`、不注入 system prompt。

**(c) `agent/pre-step` — compaction 压力联动**（`src/index.js:431-456`）：
```js
ctx.on('agent/pre-step', async function (payload, next) {
  var sid = payload.agent && payload.agent.session ? String(payload.agent.session.header.id) : undefined
  if (sid !== undefined && cfg.compactAssistEnabled) {
    var level = actual > 0 ? actual : est          // 优先真实计费 input
    if (watermark > 0 && level > watermark && now - lastAt > cfg.compactCooldownMs) {
      var cs = ctx.get('compaction')
      if (cs !== undefined && typeof cs.compactIfNeeded === 'function') {
        var res = await cs.compactIfNeeded(payload.agent, 'pressure', payload.signal)
```
返回值：恒 `return next()`；失败被 try/catch 吞掉（`:454`）。

**(d) 动态工具 `save_token_expand`**（`src/index.js:459-496`），经 `ctx.tools.register(defineTool({...}))`，`import { defineTool } from '@deepseek-ai/dsh-tools'`（`:66`）。`parameters: { id: { type:'string', required:true } }`；`output.render` 返回 `[{type:'text',text}]`；`execute` 返回 `{ text, locator, truncated }` 或 `{ error, locator }`。

**(e) HTTP 路由**：`ctx.webServer.register({ kind:'prefix', path:'/save-token', handler })`（`src/index.js:527`），GET `/save-token/api/dashboard`、POST `/api/set-enabled`、`/api/reset`；`ctx.effect(...)` 包裹以便卸载。

**(f) client 半**：`src/client/index.js:20` — `export const inject = ['slots', 'locale']`；注册 `settings.section`（id `save-token`, order 430, label `Token Saver`）与 `conversation.composer.dock`（id `save-token-strip`, order 85）（`:337-346`）。

**明确否定**：全包 grep `system-prompt|assemble` **零命中**（README 也从未声称）。它也**不直接改写 session surface / 历史消息**——只在工具结果首次进入上下文时替换一次，历史字节此后不变（README「缓存稳定」红线，`README.md:215+`）。这是它有意的设计取舍，而非遗漏。

## 3. 压缩规则清单（`src/compress.js`）

路线选择：`buildCandidate`（`compress.js:586-596`）按序生成候选并逐条过闸，**首个过闸者胜出**：
`jsonRoutes`（toon-array → toon-keyed → elision）→ `compressJsonlText` → `compressLinesText`（表格 stride / 普通头尾窗口）。

**never-worse 双门控**（`compress.js:564-573`）：
```js
function gate(route, text, cfg) {
  var before = utf8Bytes(text), after = utf8Bytes(candidate)
  if (after > before * cfg.keepRatioMax) return null        // 字节门：≤72%
  if (before - after < cfg.minSavingBytes) return null       // 绝对节省 ≥500B
  if (estTokens(candidate) >= estTokens(text)) return null   // token 门：严格下降
```
触发下限还会被算术放大：`effectiveMinBytes = max(minBytes, ceil(minSavingBytes/(1-keepRatioMax)))` = `max(1400, ceil(500/0.28))` = **1786B**（`compress.js:555-558`, `index.js:303`）。错误输出用 `errorMinBytes=6000`。

规则逐条：
1. **TOON 无损表化**（默认开，最优先）。`uniformTabular`（`compress.js:110-166`）：≥8 行同构对象、键数 1..24、每行键集**完全相等**、列值为扁平原语或「单层嵌套对象且共享同一子键集」，列宽 ≤64；键名含 `"',{}[]:\n\r\t` 则拒绝。渲染 `name[N]{col1,col2{a,b}}:` + CSV 行（`toonEncodeCols:175-187`）。
2. **主导数组深搜**（`findDominantUniformArray:210-236`）：根数组 / 根直接属性 / **直接子对象的属性**（修复 v2.1.x 漏掉 `{data:{items:[...]}}`）；取最大者，其余文档以 `JSON.stringify` 保留（`jsonRoutes:490-493`）。
3. **keyed map 重编码**（`keyedMapRows:245-259`）：根对象 ≥8 个值对象且无 `key` 冲突 → 加前置 `key` 列后走 TOON，策略名 `toon-keyed`。
4. **JSONL/NDJSON 整表化**（`compressJsonlText:527-547`）：每行都能 `JSON.parse` 成 plain object、行数 ≥ `jsonlMinLines=8`、形状均匀 → TOON。任一行失败即整条路线放弃。**默认开**。
5. **有损结构化 elision**（`transformValue:397-438`）：数组 >10 → 留前 3 + `{__omitted__:"+N more items"}` + 末 2；对象 >30 键截断；长字符串 >400 且非保护键 → 留头 220 + 尾 80；**保护键**（`isProtectedKey:393` 匹配 `error|message|stack|fail|fatal|exception|warn`）阈值放宽到 2000，留头 1800。**只在无损路线未过闸时作为降级候选**。
6. **表格 stride 采样**（`looksTabular:311-328` + `windowLinesStrided:366-378`）：空行过滤后行数 ≥ `tabularHeadRows+tabularTailRows=100`，且支配分隔轮廓占比 ≥70% 且计数 ≥12，**且轮廓必须是真分隔符** `p<pipe数>` / `t<tab数>`，轮廓 `x` 明确排除（v2.1.x 把散文误判进采样器的修复）。输出：头 60 行 + `[... +N data rows omitted; every K. row sampled ...]` + 每 K 行带原始行号 `L<n>: ` + 尾 40 行；`stride = ceil(中段行数 / tabularStrideSamples=50)`。
7. **普通长文本头尾窗口**（`windowLines:330-364`）：> `maxLines=240` 时头 140 + 尾 80 + 省略标记。
8. **错误行保留**（`windowLines:339-361`）：在省略区按 `ERROR_LINE_RE`（`fatal|panic|traceback|exception|\berror\b|err:|fail(ed|ure|ing)|denied|rejected|timeout|timed out|abort|cannot|unable to|syntax error|assertion|segfault`，大小写不敏感）取最多 **25 个锚点**，每个扩 **±1 上下文行**，相邻区间合并，输出带 `L<headLines+m+1>: ` 原始行号。**日志/错误场景也有 `errorMinBytes=6000` 的更高门槛**。
9. **行级预处理**（`compressLinesText:380-390`）：先 `collapseBlanks`（≥2 连续空行压成 1）、`collapseRepeats`（同一行连续 >4 次 → 1 行 + `[xN identical lines]`，空行不参与）、`trimLongLines`（> `longLineChars=420` 的行留头 260 + `...[+N chars]...` + 尾 100）。
10. **跨轮去重**（`index.js:271-299`）：指纹 = `sessionId|toolName|fnv1a(args)|fnv1a(完整content)`（`compress.js:58-60`，**不截断**，修复旧版 4096/64KB 前缀截断可能误判「字节相同」）。命中同一指纹且距今 ≤ TTL（`dedupeTtlMs=600000`，**默认 600s**，v2.4.0 从 90s 提高）→ 落盘后替换为 stub，条件 `savedB > minSavingBytes`。`dedupeTtlOverrides[工具名] = 0` 可直接退出该工具。**ERROR 输出永不去重**（`!isError`）。进程内 `dedupeCache` 上限 800→裁到 500。
11. **spill 落盘 + expand 取回（CCR）**：`spillOriginal`（`index.js:226-241`）调 `spillStore.saveText({ owner:{sessionId}, source:{toolName, callId, label:'result'}, suggestedName, content })`，要求返回 `ref.locator` 为 string；**拿不到 locator 就放弃整次压缩**（`:307-308`）。缓存 `originals`（上限 160→120，单条文本截 262144 字符）+ 独立 `locatorIndex`（上限 4000→3200，**不随文本淘汰**，故重启后仍能给出落盘路径）。expand 未命中时若 `spillStore.readText` 存在则透明直读，否则返回 locator（`:479-493`）。
12. **通知形状**（`buildNotice:605-621`）：前 `noticeFullTrailerCount=3` 次用完整版（含省略统计 `Omitted: +N array items, ...`），之后用紧凑 trailer；两种都保留 `[save-token #<id> ` 前缀（供回放扫描正则 `MARKER_RE` 识别）与 locator 双通道。
13. **计量/校准**（`index.js:135-155, 403-413`）：按 model 维护 `billed/estimated` 的 EMA（α=0.2，LRU 上限 32，样本 ≥500 token 才学），修正 avoided-token 口径；`cacheRead/cacheWrite` 分开计量并输出 `cacheHitPct` 哨兵。

**默认开关**：`compressEnabled=true`、`dedupeEnabled=true`、`compactAssistEnabled=false`（**唯一默认关闭项**）。

## 4. Config schema 全文（字段名 + 默认值）

`src/index.js:79-103` 的兜底默认与 `cordis.patch.yml:15-38` 完全一致（23 个键）：

| 字段 | 默认 | 字段 | 默认 |
|---|---|---|---|
| `compressEnabled` | `true` | `noticeFullTrailerCount` | `3` |
| `dedupeEnabled` | `true` | `dedupeTtlMs` | `600000` |
| `minBytes` | `1400` | `dedupeTtlOverrides` | `{}` |
| `errorMinBytes` | `6000` | `compactAssistEnabled` | `false` |
| `minSavingBytes` | `500` | `compactBudgetTokens` | `120000` |
| `keepRatioMax` | `0.72` | `compactCooldownMs` | `600000` |
| `maxLines` / `headLines` / `tailLines` | `240` / `140` / `80` | `contextWindowTokens` | `0` |
| `tabularHeadRows` / `tabularTailRows` / `tabularStrideSamples` | `60` / `40` / `50` | `compactWatermarkRatio` | `0.85` |
| `longLineChars` | `420` | `jsonMaxParseBytes` | `524288` |
| `jsonlMinLines` | `8` | | |

合并逻辑是**白名单式**：只覆盖 `cfg` 已有的键（`index.js:104-108`），未知键被忽略 → 没有 Config schema 校验、没有类型检查、没有 `Config` 导出（cordis 的 `Config` schema 在本包中**未使用**）。
注意：README 配置表**漏列** `compressEnabled`、`dedupeEnabled`、`minSavingBytes`、`jsonMaxParseBytes` 四项，只有 `cordis.patch.yml` 是全的。

## 5. `cordis.patch.yml` 与 package.json 的 `dsh` 字段

`pkg/package/cordis.patch.yml`（38 行，全文即「insert 一行 + 复述全部默认值」）：
```yaml
- insert:
    - id: save-token
      name: dsh-plugin-save-token
      config:
        compressEnabled: true
        dedupeEnabled: true
        minBytes: 1400
        errorMinBytes: 6000
        minSavingBytes: 500
        keepRatioMax: 0.72
        # ...（余 16 键见 §4）
```
`pkg/package/package.json:24-32`：
```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": [], "platform": "web" }
},
"exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" }
```
`files: ["lib","src","cordis.patch.yml","README.md","README.zh-CN.md"]` — **只发 npm，不带 test/bench/manifest.json/build.mjs**。

## 6. 测试 / 基准

- **有测试，但未随 npm 发布**：`package.json:22` 有 `"test": "node --test"`；`README.md` 目录结构自述存在 `test/`（"node --test 单元测试，钉住压缩核心行为"）与 `src/compress.js:5` 的 "unit-testable with `node --test test/`"。tarball 内**无 `test/` 目录** → 单测内容**未获取到**（GitHub 在本沙箱不可达：`raw.githubusercontent.com` / `api.github.com` 均解析到非公网 IP）。
- **基准数字有，原始文件未获取到**：README 指向 `bench/report_2026-08-29.md`、`bench/report_2026-09-03.md`、`bench/results/raw2/`、`bench/results/summary-r2.md`，均**不在 npm 包内且 GitHub 不可达** → bench 原始文件内容：**未找到**。README 内的汇总表如下（`README.md:59-99`）：
  - 第一轮（2026-08-29）：24/24 集（6 任务 × 2 臂 × n=2），成功率 **100% vs 100%**，总 token 5.25M vs **4.32M（−17.6%）**，16 次压缩覆盖 8/12 集，单集中位数 **−56%**。
  - 第二轮（2026-09-03，v2.4.1）：成功率 100%(12/12)，两轮合计 48/48；缓存命中率 90.0% → **90.7%**（最重一集守 91.1%）；avoided ≈ **56 万 token**（11 次压缩覆盖 6/12 集）；SWE 长上下文（sympy/django）**−19.7% / −18.0%**。
  - 单事件：400 行管道表 41,727B → 15,191B（−64%）；300 条均匀 JSON 34,000B → 19,935B（−41%，TOON 无损）。
  - 自述局限：n=2，单集 agent 策略离群可能盖过输出节省；「写文件再读取」模式按设计不触发、无收益。

## 7. 明确的坑（README/源码自述的失败史与陷阱）

1. **盲目头尾窗口是它踩过的坑**：`README.md:100` — "an early version once applied blind head/tail windowing to a 35.5KB LiteLLM price registry; subagents couldn't locate middle rows and re-queried repeatedly — that failure is why the structure-aware strategy exists." 即**只加行号采样还不够，必须先做结构识别**。
2. **compaction 联动默认关闭，且被明确否认为省钱手段**：`README.md:158+` / `src/index.js:157-166` — 缓存价约为未命中价 1/30，把 120k 摘要成 40k 等于拿廉价缓存重放换全价输入，**需再跑约 60 个请求才回本**。原文 "do not expect it to cut cost"；只在会话逼近溢出水位时开。
3. **激进压缩会反向涨成本**：README 引用实验——保留率 0.2 的激进压缩使成本 **+1.8%**，保留率 0.5 才省 **27.9%**。所以它把 `keepRatioMax` 定在 0.72（比 RCT 的 0.5 更保守）。
4. **可逆性是硬门**：没有 `spillStore`、没有 session id、落盘失败、或 `ref.locator` 非字符串 → **压缩永久关闭**（`index.js:229, 238, 307-308`），并在 dashboard 暴露 `spillReady` / `lastSkip`。安装文档明确警告：标准部署自带 `spillStore`，"万一缺失，压缩会按设计保持关闭"。
5. **嵌套/子代理调用全部豁免**：`exec.parent !== undefined` 直接放行（`index.js:254`）。这是**已知未开发收益面**，v2.4.0 才加计数器量化它（`comp.nestedCalls`），尚未动手。
6. **`read` 与 `save_token_expand` 豁免**：后者若被压缩会造成「展开 → 又拿到被裁剪预览 → 再展开」的死循环（`index.js:22-25, 260-261`）。
7. **去重 TTL 从 90s 提到 600s** 是有意为之（指纹是全长字节精确的，相同重放不含新信息），但提供了 `dedupeTtlOverrides` 逃生口；源码注释承认旧版指纹**截断前缀**会误判字节相同（`compress.js:52-56`）。
8. **旧版计数口径错误**：v2.1.x 统计的是「尝试次数」而非「被采纳次数」，门控拒绝也被计入（`index.js:310-311`）。
9. **旧版把散文误判成表格**：`looksTabular` 曾接受轮廓 `x`（无分隔符）占优，导致普通文本被送进「数据行步进采样器」（`compress.js:323-327`）。
10. **旧版 elision 字符串截断 off-by-100**：1800 字符被保留但通知里报 `length-1700`（`compress.js:426-429`）。
11. **发布节奏断裂**：2.1.3 → 2.4.1 直接跳版，2.2.x/2.3.x 从未上 npm。

---

## 总结：它覆盖了什么 / 没覆盖什么

**已覆盖**：工具结果入口的**单点、一次性、可逆**瘦身——结构感知表格 stride 采样、TOON 无损表化（含嵌套/JSONL/keyed map）、JSON 有损 elision、行级预处理、错误行 ±1 保护、跨轮去重、never-worse 双门控（72%/500B/token 严格下降）、spill + expand 闭环、以及一套相当成熟的**计量与缓存命中率哨兵**面板。
**未覆盖（差异化空间）**：① 从不碰 `system-prompt/assemble`、工具定义、历史消息/session surface——**没有任何提示词侧、工具 schema 侧、历史重写的压缩**；② 嵌套/子代理调用 100% 豁免，收益面只被计数未被开发；③ 压缩只发生在**工具结果首次进入**那一刻，对已膨胀的长会话无回溯手段；④ 无 Config schema 校验、无类型检查，配置靠白名单合并；⑤ `read` 完全豁免——对超大文件读取没有分页/按需加载策略；⑥ 无 tokenizer，全靠字符启发式（`other/3.8 + cjk*0.75`）加在线 EMA 校准；⑦ 单测/bench 不随包发布，复现门槛高。
