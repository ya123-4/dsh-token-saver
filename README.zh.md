# dsh-token-saver

给 DeepSeek Harness（DSH）用的省 token 插件：**在不牺牲任务成功率的前提下，削减每一次请求都要付的那部分 token**。

它不靠"猜哪些内容不重要"，而是靠两条可验证的确定性手段，并且用**双门控**保证任何一次改动都必须真的更省——否则原样放行。

---

## 一、为什么是这两处（本机实测）

对最近 14 天、106 个真实会话日志（含 9670 个模型步）做离线统计后，token 花在这些地方：

| 观察项 | 实测值 |
| --- | --- |
| 每步真实上下文（input + cache read） | ≈ 359k tokens |
| **每次请求的工具 schema 固定开销** | **平均 77.2k，最高 185k tokens** |
| 其中 parameters 结构本身 | 90%（顶层描述只占 10%） |
| 活动上下文里工具结果占比 | 45.2% |
| 活动上下文里历史推理（reasoning）占比 | 31.7% |
| 全窗口字节级完全重复的工具结果 | 仅 0.2%（所以**没做**去重） |

结论：**最大的单项浪费是每请求 77k～185k 的工具 schema**，而它 90% 是参数结构而不是描述——所以"精简工具描述"毫无意义（实测只值 2.4%），唯一有效的办法是**不要每次都把整份 schema 发出去**。

---

## 二、两个杠杆

### 杠杆 1：工具 schema 渐进披露（`system-prompt/assemble`）

- 超过阈值（默认 2000 tokens）的工具 schema 折叠成**仍可调用**的骨架：属性名、基础类型、小枚举、required 保留，`$defs`/深层嵌套/长描述去掉，`additionalProperties: true` 保持宽松。
- 该工具的**名字与一句话说明仍然出现在工具表里**，说明中明确追加提示：调用前先用 `tool_schema` 查询完整参数。
- 新增 `tool_schema(name)` 工具：按需返回**原始完整 schema**。
- **单调展开**：某工具一旦被查询过，本次会话（拿不到会话时退化为本进程）内**永不再折叠**——请求前缀不会来回抖动，DeepSeek 的 prefix cache 命中率不受损。
- fail-open：低于阈值的工具**一个字节都不动**；任何异常都返回原始 assembly。

真实回放（90 个会话的最终请求头，8868 个工具条目）：

| 指标 | 结果 |
| --- | --- |
| 平均每请求 schema | 68.0k → **25.9k tokens（-61.9%）** |
| 发生折叠的 37 个会话 | 155.5k → **53.1k tokens/请求（-65.9%，省 102.4k）** |
| 其余 53 个会话 | 无超阈值工具，零改动 |
| 安全校验 | 工具数量/顺序不变、无 schema 变大、无悬空 `$ref`、骨架合法 |

单例：`mcp__rea__compare_web_captures` 19.0k tokens → 212 tokens。

### 杠杆 2：工具结果压缩（`tools/post-execute`）

在结果写入会话日志**之前**做确定性、保语义的压缩：

- 头尾窗口 + **中段错误/失败行救援**（省略多少行/字符都写在标记里，模型能分辨"没输出"和"被省略"）；
- 连续重复行折叠（`上一行重复 N 次`）；
- 长 base64/hex 数据块折叠；
- 连续空行折叠、行尾空白清理（可选 ANSI 去除、JSON 单行化）。

**双门控**：只有同时满足「字符降到 75% 以下且至少省 500 字符」与「估算 token 严格下降」才替换，否则原样放行。
**失败结果永不动**：`isError` 的结果保持完整，错误文本就是有效载荷。

### 杠杆 3：历史思考清理 —— **当前 DSH 版本不可用，默认关闭**

> **撤回说明（v0.2.1）**：这一项在真实环境里一次都没成功过（`失败 1189 次 / 成功 0`）。读 DSH 源码后确认这是**架构层的死锁**，不是调用写法问题：
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
> 不带 `sourceEventSeqs` → 必然缺节点被拒；带上它 → 直接对 `assistant/message` 抛错。两条路都堵死。DSH 的设计意图是不允许改写 assistant 消息（它自带完整生成流，是"历史可重建"的权威记录）——`tool/result` 被特别豁免，`assistant/message` 没有。
>
> 因此：`elideThinking` **默认关闭**；一旦检测到拒绝会**立即熔断**并停止重试，`token_saver_report` 里会写明原因。代码保留，等上游放开该约束后可直接启用。**收益测算（本机 90 个会话：可清理 5.50M 字符 ≈ 2.64M tokens，占长会话可见上下文 21.9%）只能等那一天。**

原本的设计（失效，仅作记录）：进入新 turn 时，把**更早 turn** 的 assistant 消息里的 `reasoning` 块从会话 surface 上摘掉，保留结论、工具调用、原始 `stream` 记录，以及最近 `keepRecentTurns` 个 turn 的完整思考。

| 指标 | 回放测算（当时） |
| --- | --- |
| 可清理历史思考 | 5.50M 字符 ≈ **2.64M tokens** |
| 受影响会话（多 turn） | 14 个，清理量平均占可见上下文 **21.9%**（最高 32.6%） |
| 保留不动 | assistant 正文 1774 块、工具调用 4780 块 |
| 安全保护 | 真实数据里 **23 条**消息清掉思考后就没有内容了 —— 逻辑会识别并跳过 |

**为什么这是安全的**：单调（一个 turn 只清一次、清了不恢复，前缀最多在 turn 边界变一次，而那里本来就会变）、可追加（替换是一次普通的 surface op，日志仍可重放、原始字节仍在磁盘上）、fail-open（任何异常都不动会话）。

### 杠杆 4（实验，实测失败）：请求级思考清理 —— 默认关闭

> **实测结论（2026-10-17）：净亏损，已关闭。** 同会话 A/B（关闭 204 步 vs 开启 9 步）：
> 缓存命中率 **97.3% → 78.3%**，每步等效成本 **38.9k → 121.4k（+212%）**。
> 逐步骤最直观：每个 turn 的第一步 input 从几百 tokens 暴涨到约 40 万、命中率跌到 1–4%，
> 而同 turn 的后续步才回到 99.9%。原因不是实现 bug，而是**设计假设错了**：
> `keepRecentTurns` 让删除范围逐轮扩大 → 请求前缀每轮都变 → 每个 turn 边界都要
> 全价重建一次缓存。删除只换来每步省约 13k，重建要付约 355k，**回本需连续约 25 步**，
> 而一个 turn 只有 5–12 步，任何触发频率都不划算。
>
> 教训：**DeepSeek 的缓存是前缀精确匹配，"改写前缀"这件事本身极难回本**。
> 官方 compaction 只在接近窗口上限时才做，正是同一个原因。
> token-saver 的 schema 折叠之所以能赚，恰恰是因为折叠集合**稳定**、不逐轮扩张。
> 若要复活此方向，必须先解决前缀稳定性（水位线一次前行后固定），否则不要打开。

原本的设计记录（已停用）：不改会话日志，只在 `llm/stream` 里构造一份去掉旧轮次 reasoning 的请求对象，再通过 `LlmRuntime.stream()` 重新派发；重入由对象身份识别，请求只发一次；首包前失败自动回退原请求；`compaction`/`session-title` 请求跳过。

---

## 三、配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `foldToolSchemas` | `true` | 是否启用工具 schema 折叠 |
| `foldThresholdTokens` | `2000` | 超过多少估算 tokens 才折叠 |
| `minVisibleTools` | `4` | 目录里至少保留多少个完整渲染的条目；目录小于它则不折叠 |
| `alwaysKeepTools` | `[]` | 永不折叠的工具名 |
| `compactResults` | `true` | 是否压缩工具结果 |
| `maxChars` | `24000` | 单条结果压缩后的字符上限 |
| `minSavingChars` | `500` | 至少省这么多字符才替换 |
| `keepRatioMax` | `0.75` | 压缩后不得超过原大小的这个比例 |
| `keepErrorsIntact` | `true` | 失败结果不压缩 |
| `skipTools` | `[]` | 结果永不压缩的工具（如 `read`） |
| `elideThinking` | `false` | 清理更早 turn 的思考文本（**当前 DSH 不支持，见杠杆 3**） |
| `requestThinkingElision` | `false` | **实验已证伪**：改写前缀导致缓存命中率暴跌，见杠杆 4 |
| `requestThinkingElisionKeepTurns` | `1` | 请求级清理时保留最近几轮 |
| `keepRecentTurns` | `1` | 最近多少个 turn 的思考保持完整 |
| `lookupTool` | `true` | 注册 `tool_schema` |
| `reportTool` | `true` | 注册 `token_saver_report`（查看累计收益与被折叠名单） |
| `verbose` | `false` | 每次折叠/压缩打日志 |

在 profile 的 `cordis.patch.yml` 里按 `id: token-saver` 覆盖任意一项即可。

---

## 四、安全边界（刻意保留的不变量）

1. **fail-open**：任何异常都不阻断请求，原样放行并记一条 warn。
2. **单调决策**：不会出现"这轮折叠、下轮展开"的抖动，避免缓存写惩罚吃掉收益。
3. **明示省略**：所有省略都带标记与数量，绝不静默丢弃。
4. **不碰请求本身**：`llm/stream` 的请求体是 deep-frozen 的（DSH 的可重建性保证），本插件只在 `system-prompt/assemble` 与 `tools/post-execute` 两个文档化的可变点上工作，**不改写历史消息、不改 session surface**。
5. **不改工具身份**：折叠只改呈现，工具注册、调用、结果投影全都不动。

---

## 五、与其它省 token 插件的关系

- `@yilinxiao/dsh-mcp-lazy`：解决"MCP 工具**要不要注册**"；本插件解决"已注册工具的**schema 要不要整份发**"。两者叠加不冲突。
- `dsh-plugin-save-token`：把**工具结果单点压缩**做到了极致（TOON、表格 stride、spill+expand、去重）。本插件的结果压缩更保守（默认上限 24k 字符、无 TOON），两者同时开启也不冲突（第二次压缩几乎无变化）；本插件的**独有价值在 schema 侧**，那是它完全没有覆盖的（全包 grep `system-prompt|assemble` 零命中）。

---

## 六、安装

```powershell
# 在 DSH 里
plugin_manager install_bundle  <本包 tgz 路径>
```

或写进 profile 的 `package.json` 依赖后用 pnpm 安装，并在 `cordis.patch.yml` 中保留 bundle 层。

## 七、开发与验证

```bash
node --test test/        # 66 个单测：压缩规则、门控、折叠安全性、思考清理、请求级清理重入保护、插件事务
```

离线测量工具在构建仓库的 `tools/` 下：`analyze-usage.mjs`（token 去向）、`measure-opportunity.mjs`（压缩收益与门控通过率）、`measure-thinking.mjs`（思考清理收益与安全校验）、`measure-dedup.mjs`（重复率）、`inspect-schema.mjs`（schema 解剖）、`replay-verify.mjs`（真实数据回放 + 安全校验）。

## License

MIT
