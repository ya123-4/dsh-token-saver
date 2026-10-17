# 回放验证：工具 schema 折叠（真实会话数据）

- 采样 90 个会话的最终请求头，共 8868 个工具条目（含重复）
- 折叠前 schema 合计 6.12M tokens → 折叠后 2.33M tokens，省 61.9%
- 平均每个请求：68.0k → 25.9k tokens（省 42.1k）
- 共折叠 851 个工具条目（平均 9.5 个/请求）

## 安全性检查

- ❌ 发现 3922 个问题：
  - dangling $ref in folded schema: mcp__rea__address_name
  - dangling $ref in folded schema: mcp__rea__address_to_file_offset
  - dangling $ref in folded schema: mcp__rea__analyze_function
  - dangling $ref in folded schema: mcp__rea__analyze_javascript_application
  - dangling $ref in folded schema: mcp__rea__analyze_swift_types
  - dangling $ref in folded schema: mcp__rea__analyze_web_bundle
  - dangling $ref in folded schema: mcp__rea__annotate_native_function
  - dangling $ref in folded schema: mcp__rea__batch_decompile
  - dangling $ref in folded schema: mcp__rea__binary_session
  - dangling $ref in folded schema: mcp__rea__capture_electron_scenario
  - dangling $ref in folded schema: mcp__rea__capture_native_ui_scenario
  - dangling $ref in folded schema: mcp__rea__capture_process_scenario
  - dangling $ref in folded schema: mcp__rea__capture_web_screenshot
  - dangling $ref in folded schema: mcp__rea__close_binary
  - dangling $ref in folded schema: mcp__rea__comment
  - dangling $ref in folded schema: mcp__rea__compare_bundles
  - dangling $ref in folded schema: mcp__rea__compare_web_screenshots
  - dangling $ref in folded schema: mcp__rea__current_address
  - dangling $ref in folded schema: mcp__rea__current_procedure
  - dangling $ref in folded schema: mcp__rea__decode_interface_builder

## 被折叠最多的工具

| 工具 | 出现次数 | 原 schema tokens（估算） |
| --- | ---: | ---: |
| mcp__rea__build_call_path | 37 | 2.1k |
| mcp__rea__build_reconstruction_obligation_ledger | 37 | 5.5k |
| mcp__rea__capture_browser_scenario | 37 | 4.2k |
| mcp__rea__compare_application_versions | 37 | 7.1k |
| mcp__rea__compare_artifacts | 37 | 2.6k |
| mcp__rea__compare_functions | 37 | 2.3k |
| mcp__rea__compare_javascript_export_shapes | 37 | 7.6k |
| mcp__rea__compare_managed_members | 37 | 2.4k |
| mcp__rea__compare_process_captures | 37 | 4.4k |
| mcp__rea__compare_source_to_bundle | 37 | 5.9k |
| mcp__rea__compare_web_captures | 37 | 19.0k |
| mcp__rea__correlate_static_and_runtime | 37 | 4.2k |
| mcp__rea__evaluate_reconstruction_coverage | 37 | 6.4k |
| mcp__rea__find_changed_behavior | 37 | 3.2k |
| mcp__rea__import_managed_reconstruction | 37 | 3.0k |
| mcp__rea__inspect_analysis_view | 37 | 2.6k |
| mcp__rea__project_android_application_graph | 37 | 2.2k |
| mcp__rea__project_apple_application_graph | 37 | 2.7k |
| mcp__rea__project_managed_application_graph | 37 | 2.7k |
| mcp__rea__reconcile_javascript_runtime | 37 | 4.3k |

## 每个会话的折叠结果（前 15）

| # | 工具数 | 折叠前 tokens | 折叠后 tokens | 省 | 折叠数 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 44 | 9.2k | 9.2k | 0.0% | 0 |
| 2 | 186 | 154.5k | 52.1k | 66.3% | 23 |
| 3 | 50 | 10.0k | 10.0k | 0.0% | 0 |
| 4 | 19 | 3.3k | 3.3k | 0.0% | 0 |
| 5 | 44 | 9.2k | 9.2k | 0.0% | 0 |
| 6 | 195 | 156.3k | 53.9k | 65.5% | 23 |
| 7 | 186 | 154.5k | 52.1k | 66.3% | 23 |
| 8 | 195 | 156.3k | 53.9k | 65.5% | 23 |
| 9 | 186 | 154.5k | 52.1k | 66.3% | 23 |
| 10 | 44 | 9.2k | 9.2k | 0.0% | 0 |
| 11 | 11 | 1.5k | 1.5k | 0.0% | 0 |
| 12 | 44 | 9.2k | 9.2k | 0.0% | 0 |
| 13 | 11 | 1.5k | 1.5k | 0.0% | 0 |
| 14 | 44 | 9.2k | 9.2k | 0.0% | 0 |
| 15 | 11 | 1.5k | 1.5k | 0.0% | 0 |

## 折叠样例（最大工具，前 600 字符）

原 schema：19.0k tokens（75148 字符）
折叠后：212 tokens
```json
{
 "name": "mcp__rea__compare_web_captures",
 "description": "Compare passive web captures by providing before and after, each with the complete inspect_web_page normalized_result in inspection and an optional complete discover_webmcp_tools normalized_result in webmcp; or compare recorded scenarios by passing complete capture_browser_scenario normalized_result objects in before_scenario and after_scenario with an optional normalization policy. Use exactly one input group. Scenario comparison aligns exact step IDs, records deterministic literal normalization, and returns every artifact-level difference plus alignment failures inline. Missing or truncated evidence never proves equality.",
 "parameters": {
  "type": "object",
  "properties": {
   "before": {},
   "after": {},
   "before_scenario": {},
   "after_scenario": {},
   "normalization": {}
  },
  "additionalProperties": true
 }
}
```

注：完整原 schema 可由 `tool_schema("mcp__rea__compare_web_captures")` 原样取回（回放验证另见单测 plugin.test.mjs）。