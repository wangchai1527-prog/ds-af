# Factory 上线人批闸（factory-deploy-gate）· 计划 v1

> 2026-11-17 · 触发：P-016 交付后推送被静默跳过（`pushed:false`，看板仍标「✅ 已交付」），用户裁定「批准上线应是开发流程内置环节」。

## 1. 现状勘察（磁盘实证）

- 流水线定义：`panels/factory/factory-server.js` 三条节点链 `NODES`(build) / `ITERNODES`(iterate) / `FIXNODES`(fix)，均以 `delivery` 节点收尾。
- 推送现状：`delivery` 验收通过后 best-effort 调 `pushIfPossible()`，任何失败（未绑定远程 / 无 token / 推送报错）只落一行 `push` 事件 + 附注，**不阻断、不标红、不停线**（L341-345）。
- 人批闸机制已有：`rs.awaiting={gate,nodeIdx}` + `/api/approve {go|redo}`（原型闸 L346-353 在用），可直接复用。
- 远程绑定：项目 `remote` 字段（projects.json），当前 P-016 未绑定。
- 看板前端 `factory.html`：泳道按 `done → ✅ 已交付` 渲染，无「未上线」态。

## 2. 目标

上线（推送远程）从「顺手 best-effort」升级为**流水线内置的人批闸段**：
1. `delivery` 通过后，若项目绑定了远程 → 流水线暂停在 `deploy` 闸，等人批；
2. 人批 go → 执行推送，结果如实落状态（已上线 / 推送失败）；
3. 未绑定远程或人选跳过 → 状态如实显示「已交付·未上线」，永不冒充已上线。

## 3. 方案对照

| # | 方案 | 优点 | 代价 |
|---|------|------|------|
| D1 | **新增显式 `deploy` 节点**（owner=👤 人，复用 awaiting 闸），接在 delivery 后（build/iterate/fix 三链同接）；无远程时该节点验收=「跳过（未绑定远程）」如实落账 | 与原型闸同一机制、泳道/审批 UI 零新增概念 | 节点链 +1，nodes.json 历史恢复兼容（旧 run 缺该节点状态） |
| D2 | 不加节点，delivery 后仍自动推送，但失败即 `blocked` + 手动「上线」按钮 | 改动最小 | 「上线」不成为流程段，与用户裁定（应加入流程）不符 |

**建议 D1**（与「人批进流程」的裁定一致），并附带：
- 看板状态如实：`done && 无成功推送` → 显示「✅ 已交付 · ⏸ 未上线」双态徽章（无论 D1/D2 都要做）；
- `/api/approve go` 在 deploy 闸语义 = 执行 `pushIfPossible`；redo = 跳过上线（产物保持已交付）。

## 4. 兼容与不做（do-not-touch 候选）

- 旧 run 恢复：`nodeStatus` 缺 deploy 位 → restore 时按链长补 `pending`，历史已 done run 不回填不重推。
- 推送实现 `pushIfPossible` 本体不动（token 临时 URL 口径保留）。
- 不动三条链既有节点的 prompt/accept；不动 projects.json 结构（沿用 `remote` 字段）。
- 不自动重试推送；不新增自动部署目标（远程仍由人先绑定）。

## 5. 分期

- **P1**（本票）：deploy 闸节点 + 审批接线 + 看板双态徽章 + 旧 run 兼容恢复。
- **P2**（另票）：泳道详情页「绑定远程」入口内聚到项目卡；推送失败的重试按钮。
- 不做：定时/自动部署、多环境（staging/prod）路由、回滚按钮。

## 6. 确认点（待人拍板）

1. 方案选 **D1** 还是 D2？（建议 D1）
2. fix 流是否也接 deploy 闸？（建议：是，三链一致）
3. 人批 redo 在 deploy 闸的语义 =「不上线，保持已交付」（而非打回重做）——确认？
4. 存量 P-016：本票上线后绑定远程 + 过闸补推，作为首例验证。
