# r001-out · 开发交互载体分析（第 1 轮）

> 输入：r001-in.json（idea）。无历史轮、无 materials。本沙箱只读限制：外部仓不可直查，现状事实取自会话注入的 AGENTS.md / CLAUDE.md（2026-10-21 对齐、2026-10-28 入口约定）与 wiki recall 命中页。

## 一、先回答「底层是谁在干活」

把三层拆开，问题就清楚了：

| 层 | 是什么 | 现状 |
|---|---|---|
| **引擎层**（真正干活） | Claude Code（Claude Agent SDK），模型 glm-5.3，经 `~/.claude/settings.json` env 指向 bigmodel anthropic 兼容端点 | 与载体无关，换壳不换引擎 |
| **编排层**（谁派活） | DSH 经 `claude-code` skill 派发编码任务（print 模式优先）；Hermes 出 Change Spec，Claude（Hands）实现并回 `[STATUS][CHANGES][TESTS]` | 已有明确流程规范 |
| **交互层**（人在哪敲） | 目前＝终端会话，按目标目录（cwd）隔离分桶；明确禁「全局固定 tmux 名 + `-A` 复用」 | **本 idea 的争议点就在这层** |

关键认知：**VS Code 不是另一个开发 Agent，只是 Claude Code 的一种交互载体**（Claude Code 官方就有 CLI 终端 / desktop / web / VS Code·JetBrains 扩展多种形态）。所以问题不是「换工具」，而是「**人的开发交互放在哪个壳里、放多少**」。

## 二、核心张力

idea 里「用 VS Code 图形化终端起 claude code 做 Vibe coding」与现行硬契约存在正面冲突：

1. **契约冲突**：硬契约第 1 条「唯一输入 = Change Spec，不收口头意图」。人在 VS Code 里自由 vibe coding = 口头意图直接驱动实现，绕过 Hermes spec 与审批链。
2. **主责冲突**（R-009 单主责）：编码任务的 owner 目前是 DSH 派发 → Claude Hands；人直接在 VS Code 长会话里写码，会形成第二指挥线。
3. **会话桶兼容性是待验证前提**：终端 CLI 会话按 cwd 分桶，天然满足「按目标目录隔离」；VS Code **集成终端跑 `claude`** 本质就是 CLI 会话（cwd＝打开的项目目录），兼容；但 **VS Code 官方 IDE 扩展**有自己的会话管理面板，是否落同一 cwd 桶、是否读同一 `settings.json` env 路由、hooks/权限/skill 埋点是否全量生效——未验证，不得默认。

## 三、方案空间（供拍板参考）

- **A. 维持终端**：DSH 派发 + 人开 tmux/终端，VS Code 仅当编辑器看文件。零变更，但人的交互体验差（diff/文件树/多会话可视性弱）。
- **B. VS Code 集成终端跑 CLI**（idea 字面方案）：图形化终端里起 `claude`，会话仍是标准 CLI 会话，cwd 桶/路由/契约全兼容。变更最小。
- **C. VS Code 官方 IDE 扩展**：体验最好（diff 审查、选中文件上下文、会话面板），但会话桶/埋点/路由待验证，且更容易滑向自由 vibe（契约风险最高）。
- **D. 混合**：spec 驱动的正式实现走 DSH headless 派发（不变）；VS Code（B 或 C）作为**人的介入面**——debug、review diff、紧急修复、探索性验证——介入会话同样须持 spec 引用。

## 决策点表

| # | 决策点 | 选项 | 推荐 | 依据 |
|---|---|---|---|---|
| 1 | 开发主交互模式：谁是日常交互主体？ | a) DSH headless 派发为主，人只拍板；b) 人主导 vibe coding，DSH 退居编排；c) 混合：正式实现走派发，人经 VS Code 介入 debug/review/紧急修复 | **c** | 保住 Change Spec 契约与 R-009 单主责，同时给人的真实介入需求一个合法入口；纯 a 把人挡在门外，纯 b 架空 Hermes/DSH |
| 2 | VS Code 会话的契约边界 | a) VS Code 会话同样必须持 Change Spec（引用 spec id），无 spec 不写码；b) 划为自由 vibe 区（豁免契约）；c) 起步只读：仅 review diff + 跑测试，不落笔 | **a（保守可先 c 过渡）** | 硬契约「不收口头意图」；若开 b 等于修宪，须人显式改 AGENTS.md 而非默认放开 |
| 3 | 交互载体具体形态 | a) VS Code 集成终端跑 `claude` CLI；b) VS Code 官方 IDE 扩展；c) 保持 tmux/纯终端；d) desktop app | **a** | 图形化终端起的仍是标准 CLI 会话：cwd 桶、模型路由 env、hooks、skill 埋点全兼容，变更最小（外科式）；b 待技术验证后再升（见 RESEARCH 待验证清单） |
| 4 | 后期运维（ops）交互面放哪？ | a) 与开发同载体（VS Code 里跑 ops 会话）；b) 维持 DSH 派发 + panel/logconsole 观察，ops 不进 vibe 流；c) 建专属 ops 入口 | **b** | R-006 授权范围 + 红线「不碰生产参数、不重启在跑件除非人批」：ops 要的是审批链与留痕，不是交互爽感 |
| 5 | 若选混合（1c），人介入会话的收口方式 | a) 介入会话产出也回 `[STATUS][CHANGES][TESTS]` 回执并归档到该 spec；b) 介入会话自由格式，靠 git diff 事后追溯 | **a** | 验收看磁盘 + 回执三字段是现有闭环；介入会话不收口会形成统计盲区（同 skill-usage 漏记逻辑） |

## 下一步

- 人对上表 1–5 拍板（可只拍 1/2/3，4/5 可随后）。
- 无论选哪项，RESEARCH.md 的「待验证清单」（IDE 扩展是否吃 settings.json 路由、会话是否落 cwd 桶、埋点是否生效）需要在试点前跑通，结论回填 RESEARCH.md。
