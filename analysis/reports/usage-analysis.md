# DSH token 花费分析（离线，来自本机会话日志）

- 统计窗口：最近 14 天；会话数：89；日志体积：75.7 MiB
- 采样步数：9670；模型请求（有 usage 的步）：9663

## 1. 真实计费 token（provider usage）

| 指标 | 合计 | 每步均值 |
| --- | ---: | ---: |
| input tokens | 24.28M | 2.5k |
| of which cache read | 3446.36M | 356.7k |
| of which cache write | 0 | 0 |
| output tokens | 10.31M | 1.1k |
| of which reasoning | 0 | 0 |

## 2. 活动上下文（surface）构成

| 组成 | tokens（估算） | 占比 |
| --- | ---: | ---: |
| 工具结果 tool/result | 6.70M | 45.2% |
| assistant 推理 reasoning | 4.70M | 31.7% |
| assistant 文本 + 工具调用参数 | 3.14M | 21.1% |
| 系统提示 system | 274.7k | 1.9% |
| 图片（按保留张数估） | 29.7k | 0.2% |
| 开发消息 developer | 0 | 0.0% |
| 用户消息 user | 0 | 0.0% |
| **合计** | 14.84M | 100% |

图片张数（surface 内）：29

## 3. 每次请求的固定开销（工具 schema + 系统提示）

- 平均工具 schema：80.0k tokens / 请求，覆盖 89 个会话
- 最大工具 schema：185.0k tokens
- 平均系统提示：3.1k tokens

## 4. 工具输出排行（surface 内累计 tokens）

| 工具 | 调用 | surface 结果 tokens | 平均每次 | 单次最大 | 错误结果 |
| --- | ---: | ---: | ---: | ---: | ---: |
| read | 2674 | 3.72M | 1.8k | 21.2k | 12 |
| pwsh | 4620 | 1.95M | 567 | 22.5k | 1 |
| grep | 617 | 243.8k | 602 | 12.8k | 12 |
| web_fetch | 64 | 143.5k | 2.4k | 18.8k | 29 |
| skill | 72 | 130.7k | 2.2k | 10.2k | 6 |
| cordis_inspect_query | 36 | 105.0k | 2.9k | 11.9k | 2 |
| job_output | 245 | 80.4k | 532 | 24.5k | 0 |
| edit | 2346 | 65.8k | 52 | 75 | 96 |
| glob | 116 | 59.2k | 871 | 4.8k | 1 |
| plugin_manager | 52 | 50.8k | 1.0k | 5.1k | 1 |
| write | 1371 | 50.5k | 61 | 83 | 15 |
| mnemon_runtime_memory | 45 | 16.8k | 510 | 1.9k | 2 |
| cordis_inspect_list | 8 | 14.2k | 1.8k | 1.8k | 0 |
| subagent | 58 | 11.4k | 317 | 4.4k | 7 |
| mnemon_remember | 7 | 10.5k | 2.1k | 5.2k | 0 |
| web_search | 21 | 9.3k | 519 | 792 | 0 |
| mnemon_document_manage | 2 | 5.3k | 2.7k | 2.9k | 0 |
| mnemon_memory_bodies | 11 | 3.9k | 561 | 898 | 0 |
| get_goal | 25 | 3.7k | 288 | 811 | 0 |
| update_goal | 25 | 3.7k | 232 | 811 | 4 |

## 5. 单条最贵工具结果（全窗口）

| # | 工具 | tokens | 字符 | 错误 | 会话 |
| ---: | --- | ---: | ---: | --- | --- |
| 1 | job_output | 24.5k | 49.9k |  | session-fab6592c-fd0d-490b-a |
| 2 | pwsh | 22.5k | 32.7k |  | 8fe5d22e-5bc0-4213-92e5-3676 |
| 3 | read | 21.2k | 26.8k |  | a967b1e0-3f28-4ef5-a0ae-4050 |
| 4 | pwsh | 21.1k | 49.9k |  | ff2010e5-3fb8-48d3-819b-16ed |
| 5 | pwsh | 21.0k | 49.9k |  | session-8ed17600-c1b1-4a7f-a |
| 6 | read | 19.0k | 25.8k |  | a967b1e0-3f28-4ef5-a0ae-4050 |
| 7 | web_fetch | 18.8k | 33.6k |  | 7368cb66-e3f9-4020-b1e2-9476 |
| 8 | read | 18.8k | 59.4k |  | d504697d-1ff9-4637-a14c-7e45 |
| 9 | read | 18.5k | 29.8k |  | 36ea0230-9cfe-4a71-8ac7-b56c |
| 10 | read | 18.5k | 30.9k |  | 8fe5d22e-5bc0-4213-92e5-3676 |
| 11 | read | 18.4k | 29.8k |  | 8740ac0e-c7a1-4749-9846-1aae |
| 12 | pwsh | 18.2k | 49.9k |  | session-6cf792e1-a8ca-40d9-8 |

## 6. 已有节流机制的实际使用

- compaction 次数：18
- tool-result prune（replace 落地）次数：96
