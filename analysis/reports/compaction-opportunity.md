# 省 token 机会测量（本机真实会话数据）

- 会话 106 个（最近 14 天），schema 样本 90 个请求头

## A. 每次请求的工具 schema 构成

| 组成 | tokens（平均/请求） | 占比 |
| --- | ---: | ---: |
| 全部工具 schema 合计 | 77.2k | 100% |
| ├ 顶层 description | 7.7k | 10.0% |
| └ parameters JSON | 69.5k | 90.0% |
| &nbsp;&nbsp;&nbsp;└ 参数内 description | 4.0k | 5.2% |

**只瘦身顶层 description（截断 420 字符）**：77.2k → 75.4k tokens/请求，省 2.4%

| 工具（按 schema 成本） | description | parameters | 参数内 desc | 顶层 desc 字符 |
| --- | ---: | ---: | ---: | ---: |
| mcp__rea__compare_web_captures | 152 | 22.9k | 100 | 631 |
| mcp__rea__compare_javascript_export_shapes | 182 | 8.4k | 56 | 782 |
| mcp__rea__compare_application_versions | 102 | 8.0k | 42 | 419 |
| mcp__rea__evaluate_reconstruction_coverage | 67 | 7.8k | 24 | 272 |
| mcp__rea__compare_source_to_bundle | 108 | 6.9k | 10 | 454 |
| mcp__rea__build_reconstruction_obligation_ledger | 111 | 6.5k | 18 | 495 |
| mcp__rea__compare_process_captures | 98 | 5.3k | 46 | 406 |
| mcp__rea__trace_javascript_semantics | 59 | 5.3k | 17 | 265 |
| mcp__rea__reconcile_javascript_runtime | 121 | 5.0k | 12 | 508 |
| mcp__rea__capture_browser_scenario | 179 | 4.7k | 239 | 744 |
| mcp__rea__correlate_static_and_runtime | 74 | 4.6k | 18 | 337 |
| mcp__rea__trace_application_feature | 79 | 4.6k | 29 | 340 |
| mcp__rea__import_managed_reconstruction | 92 | 3.7k | 20 | 367 |
| mcp__rea__find_changed_behavior | 53 | 3.4k | 12 | 245 |
| mcp__rea__project_managed_application_graph | 77 | 3.3k | 99 | 333 |
| mcp__rea__verify_managed_native_boundaries | 69 | 3.2k | 16 | 300 |
| mcp__rea__compare_artifacts | 73 | 3.0k | 28 | 316 |
| mcp__rea__project_apple_application_graph | 114 | 3.0k | 7 | 473 |

## B. 工具结果压缩

- surface 内工具结果 8883 条，共 22.57M 字符
- 压缩后 20.19M 字符（-10.6%），其中错误结果按策略跳过 209 条
- 双门控（≤72% 且省 ≥200 字符 + token 严格下降）通过 193 条（2.2%），可省 562.9k tokens
- 仅字节门通过 205；仅 token 门通过 870；token 反增的条目合计 +17 tokens（会被门控拦下）

### 各规则贡献（全量）

| 规则 | 命中 | 节省字符 |
| --- | ---: | ---: |
| 去 ANSI 转义 | - | 0 |
| 折叠重复行 | 43 段 / 399 行 | - |
| 折叠 base64/hex | 0 块 | 0 |
| 折叠连续空行 | 2475 行 | - |
| JSON 单行化（默认关） | - | 0 |
| 头尾窗口截断 | 37808 行省略 | 2.08M |
| 中段错误行保留 | 913 行 | - |

### 按工具（字符节省）

| 工具 | 结果数 | 原字符 | 省字符 | 节省率 | 原 tokens | 门控通过可省 tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 2065 | 12.66M | 1.16M | 9.2% | 3.76M | 273.3k |
| pwsh | 3456 | 6.37M | 758.2k | 11.9% | 1.96M | 167.8k |
| cordis_inspect_query | 39 | 489.3k | 176.5k | 36.1% | 116.2k | 40.5k |
| web_fetch | 70 | 552.6k | 164.0k | 29.7% | 185.8k | 45.2k |
| skill | 60 | 480.1k | 54.2k | 11.3% | 130.7k | 14.0k |
| grep | 407 | 831.7k | 35.3k | 4.2% | 244.2k | 7.4k |
| job_output | 151 | 226.8k | 33.0k | 14.6% | 80.4k | 14.7k |
| glob | 68 | 168.1k | 1 | 0.0% | 59.2k | 0 |
| read_image | 31 | 5.9k | 0 | 0.0% | 2.0k | 0 |
| write | 833 | 141.3k | 0 | 0.0% | 50.7k | 0 |
| edit | 1267 | 204.6k | 0 | 0.0% | 65.8k | 0 |
| send_message | 32 | 2.3k | 0 | 0.0% | 655 | 0 |
| mnemon_memory_bodies | 7 | 9.7k | 0 | 0.0% | 3.9k | 0 |
| mnemon_recall | 8 | 5.4k | 0 | 0.0% | 2.4k | 0 |
| mnemon_remember | 5 | 20.4k | 0 | 0.0% | 10.5k | 0 |
| mnemon_subagent_result | 22 | 704 | 0 | 0.0% | 154 | 0 |
