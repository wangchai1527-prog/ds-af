# Idea Plan 分析台 · 话题改名 + 提交双通道（plan-submit-dual）· 计划 v1

> 2026-11-17 · 触发：人令三问（改名 / 再次提交不可见 / 提交分开发·整改两类）· 目标面板 = panels/plan（:8792）

## 1. 现状（源码实证，plan-server.js 179 行 / plan.html 323 行）

- `meta.idea` 只在 `/api/new` 写入；无 rename 端点，列表/详情均直读 `meta.idea`。
- 拍板闸 `#gate` 仅 `state==='awaiting'` 显示；`renderMgmt()`：`go` 态给撤回/转修复/转升级，`open` 态给跳过收敛 GO/搁置/否决，**`no-go`/`park` 只有删除** → 历史话题无再次提交入口。
- 提交链：`decide('go')` → 立项池 → 工厂「选话题立项/转修复/转升级」三选一；`/api/dispatch` 支持 `mode=build|fix|iterate` 但仅 `go` 态 UI 可达。

## 2. 目标（人令三问 → 三改动）

| # | 改动 | 落点 |
|---|------|------|
| R1 | **话题改名**：`POST /api/analyses/:id/rename {title}`（1–80 字，写 meta.idea，轮次文件不动）；UI：详情页标题旁 ✏️ 按钮 + 列表项右键/按钮 | server + html |
| R2 | **再次提交恒可见**：`renderMgmt` 对 `awaiting/open/no-go/park/go` 一律出「🚀 提交开发」「🔧 提交升级整改」双按钮；归档态点提交 = 先自动复活（等价 reply revive）再走提交。**人令补充（2026-11-17）：提交按钮可持续提交——`go` 态（含已 spawnedRun）也保留双按钮，再提交 = 派新 run（build 重新入池 / fix 另建整改 run），旧 spawnedRun 记录不覆盖**（meta.spawnedRuns[] 追加历史，spawnedRun 首值保留兼容） | html（+server decide 放行 no-go/park 的 go、spawnedRuns 追加） |
| R3 | **提交二选一**：①🚀 提交开发 → `decide('go')` 入立项池走 build 流；②🔧 提交升级整改 → `decide('go')` + `/api/dispatch mode=fix`（prompt 目标仓路径，现 dispatchFix 逻辑前置到拍板闸）。闸上双按钮替换现单 GO | html |

## 3. 设计裁定（待人确认）

1. R2 的「再次提交」对归档态语义 = **复活并直接提交**（一轮 reply 都不发，结论即现状 BRIEF）——还是要先强制续一轮分析再提交？建议：直接提交（人已看过结论才点提交）。
2. R3 的「提交升级整改」目标仓从哪来？建议：沿用现 `prompt()` 输入仓路径；后续 P2 再做仓库选择器。
3. fix 流提交后 `spawnedRun` 回写照旧；build 提交仍入池由工厂选走。两按钮提交后状态都变 `go`，meta 加 `submitMode`（build|fix）+ `spawnedRuns[]`（历史 run 追加，不覆盖），徽章如实显示「已提交·开发/整改（n 个 run）」，旧数据无字段按 build 显示。**已 spawnedRun 态按钮不消失：显示为「🚀 再次提交开发 / 🔧 再次提交整改」，派新 run，先有 run 不阻断再提交。**

## 4. do-not_touch 候选

- 轮次协议（r*-in.json / r*-out.md 逐轮只增不改）、agentStream/roundPrompt、materials 链、/api/dispatch 与工厂 from-plan 契约、五态状态机本体（仅加 submitMode 附属字段）、工厂侧任何文件。

## 5. 分期

- P1（本票）：R1+R2+R3 如上。
- P2（另票）：仓库/项目选择器（替代 prompt()）、改名入轮次留痕、列表项内联改名。
- 不做：批量操作、话题合并、软删除/回收站。

## 6. 兼容

- rename 只动 meta.idea；列表 slice(0,80) 照旧。
- meta 无 submitMode → 按 build 兜底显示；spawnedRun 优先级不变。
- 历史归档话题直接提交时补一条 `revive` 日志事件，审计可追。
