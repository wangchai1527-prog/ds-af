# RESEARCH（活文档 · 逐轮只增）

## 已确认事实（r001，来源＝会话注入的 AGENTS.md/CLAUDE.md + wiki recall）

1. **引擎**：Claude Code（Claude Agent SDK）；模型路由 glm-5.3，经 `~/.claude/settings.json` env 指向 `https://openradio…/bigmodel anthropic` 兼容端点（2026-10-21 起）；模型路由变更须人批。
2. **Claude Code 官方载体形态**：CLI 终端 / desktop app（Mac/Win）/ web（claude.ai/code）/ VS Code·JetBrains IDE 扩展。VS Code 不是独立 Agent，只是壳。
3. **现行编排**：DSH 经 `claude-code` skill 派发编码任务（print 模式优先）；Hermes 出 Change Spec → Claude（Hands）实现 → 回 `[STATUS][CHANGES][TESTS]`；会话按目标目录（cwd）隔离分桶，禁全局固定 tmux 名 + `-A` 复用。
4. **硬契约相关**：唯一输入 = Change Spec、不收口头意图；验收看磁盘；外科式改动。ops 侧有 R-006（授权运维）、R-008（生产/资金 ANY 闸）、红线「不重启在跑件除非人批」。
5. **路由映射**：本议题命中话题 `agent-carrier-design → PROJECT_COORDINATION → R-009`（多角色协作单主责）——载体之争本质是主责划分之争。
6. **本分析沙箱限制**：会话目录外只读被禁，无法直查 `/root/.dsh/skills/` 与 alpha-forge 仓内细节；上述事实以注入上下文为准。

## 待验证清单（试点 VS Code 方案前必须跑通，结论回填于此）

| # | 验证项 | 为什么重要 | 方法 |
|---|---|---|---|
| V1 | VS Code 官方 IDE 扩展是否读 `~/.claude/settings.json` 的 env（模型路由） | 不读则扩展会话走错模型/端点，违反「路由变更须人批」 | 扩展里起会话，问模型身份 / 查请求端点 |
| V2 | 扩展会话是否落入与 CLI 相同的 cwd 分桶（sessions 按目录隔离） | 桶错位 = 会话记忆与 AGENTS.md 注入错乱（/root/.dsh 入口守则防的就是这个） | 对比扩展会话与终端会话的 session 存储路径 |
| V3 | 扩展会话下 hooks / 权限 / skill 埋点（skill-usage.jsonl）是否全量生效 | 埋点漏记 = 统计盲区、归因失真 | 触发一次闸 skill，查 jsonl 落行 |
| V4 | VS Code 集成终端跑 `claude` CLI 与裸终端行为是否完全一致（cwd、env 继承） | 这是推荐方案 a 的前提 | 集成终端起会话，验证 cwd 桶 + 模型路由 |
| V5 | print/headless 模式在 IDE 场景有无对应物（DSH 派发侧与人工侧的衔接口） | 混合模式下派发与介入要在同一 spec 上收口 | 查 claude-code skill 派发协议 |

## 已排除项

- 「换掉 Claude Code 引擎」：idea 字面未主张，且引擎层与载体无关，不在本轮决策范围。
