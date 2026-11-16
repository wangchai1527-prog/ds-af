# BRIEF（活文档 · 未定稿）

> 状态：**草稿占位**——r001 未收敛，5 个决策点待人拍板（rounds/r001-out.md）。以下为当前推荐取向，拍板后据此定稿。

## 推荐取向（待拍板确认）

- **主交互模式（决策点 1）**：混合——spec 驱动的正式实现维持 DSH headless 派发；VS Code 作为**人的介入面**（debug / diff review / 紧急修复 / 探索验证）。
- **载体形态（决策点 3）**：起步用 **VS Code 集成终端跑 `claude` CLI**（标准 CLI 会话，cwd 桶 / 模型路由 / hooks / 埋点全兼容）；官方 IDE 扩展待 RESEARCH V1–V3 验证通过后再评估升级。
- **契约边界（决策点 2）**：VS Code 会话不豁免——写码须持 Change Spec 引用（无 spec 不写码）；保守起步可先只读（review + 跑测试）。
- **运维交互（决策点 4）**：ops 不进 vibe 流，维持 DSH 派发 + panel/logconsole 观察（R-006 授权 + 生产红线）。
- **收口（决策点 5）**：人介入会话的产出同样回 `[STATUS][CHANGES][TESTS]` 并归档到对应 spec。

## 定稿条件

决策点 1/2/3 拍板 + RESEARCH 待验证清单（至少 V4；若涉 IDE 扩展加 V1–V3）跑通 → 本文件改写为最终 BRIEF 结论。
