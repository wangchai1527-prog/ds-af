# Change Spec · plan-submit-dual（Idea Plan 分析台：改名 + 提交双通道 + 可持续再提交）

> 票：plan-submit-dual · 2026-11-17 · 人批：demo v2 方向 + 三裁定（直接提交 / prompt 仓路径 / submitMode）+ 补充裁定（提交按钮永不消失）
> 唯一交付物：`/root/.dsh/ds-af/panels/plan/` 下 `plan-server.js` + `plan.html` 两文件改动（面板服务重启验收由人/DSH 执行，spec 只交付代码）

## 1. 目标

1. **R1 话题改名**：新端点 `POST /api/analyses/(an-[\w-]+)/rename`，body `{title}`；trim 后 1–80 字，写 `meta.idea`（其余 meta 字段不动，`updated` 照常刷新）；UI：详情页 `#top` 标题旁「✏️ 改名」按钮 → `prompt()` 输入新名 → 保存后刷新列表与详情。
2. **R2 再次提交恒可见 + 可持续**：
   - `renderMgmt()` 重写：`spawnedRun/awaiting/open/no-go/park/go` 全态出「🚀（再次）提交开发」「🔧（再次）提交升级整改」；`no-go/park` 点提交先 `confirm` 复活提示（直接提交，不续轮）再走 decide('go')（后端放行归档态，落 revive 日志事件）；`go` 态按钮文案带「再次」，已 spawnedRun 的显示 run 历史（`spawnedRuns[]` count）。
   - server `decide`：`no-go/park` 状态收到 `go` 时先自动复活（补 `{ev:'revive',round}` 日志行）再置 `go`；`spawnedRun` 已存在时**允许再次 go**（撤回/delete 的既有拦截保持不变）。
   - server dispatch：fix 模式成功建 run 后把新 runId 追加进 `meta.spawnedRuns[]`（数组，无则建；`spawnedRun` 首值保留不覆盖）；build 模式不改回写逻辑（仍由工厂回写）。
3. **R3 提交二选一**：拍板闸 `#gate` 的单 GO 换成双按钮：「🚀 提交开发」= `decide('go')`（submitMode='build'）；「🔧 提交升级整改」= 先 `decide('go')`（submitMode='fix'）再走现 `dispatchFix()` 的 prompt 仓路径 + `/api/dispatch mode=fix`。NO-GO / PARK 按钮保留在闸上。
4. **submitMode 徽章**：meta 加 `submitMode`（'build'|'fix'）；列表/详情徽章：build→「🟢 已提交 · 开发」，fix→「🟠 已提交 · 整改」+ spawnedRuns 数量；旧数据无字段按 build 兜底。`STN` 映射与 `FLOWS` 过滤相应微调（go 态两种文案，过滤 key 仍 'go'）。

## 2. inScope

- `plan-server.js`：新增 `/rename` 路由；`decide` 放行归档态 go（revive 日志）；dispatch 追加 `spawnedRuns[]`；`listAnalyses` 返回值带上 `submitMode`/`spawnedRuns` 供列表徽章。
- `plan.html`：闸双按钮、`renderMgmt` 全态提交按钮、改名按钮与 `renameTopic()`、`STN`/徽章渲染、按钮文案随状态切换。
- 零新依赖、零构建，改完 `node --check` 通过。

## 3. do_not_touch（冻结件）

- 轮次协议：`rounds/r*-in.json` / `r*-out.md` 逐轮只增不改；`roundPrompt` / `agentStream` / `historyBlock`。
- 五态状态机本体字段（`state: open|awaiting|go|no-go|park`）；`/api/new`、`/reply`、`/delete`、`/withdraw` 语义与拦截（spawnedRun 存在禁 withdraw/no-go/park/delete）。
- `/api/dispatch` 与工厂 `/api/mission/from-plan` 的请求/响应契约（mode/repo/projectId 字段、错误透传）。
- `spawnedRun` 字段名与首值语义（工厂回写目标，只增 `spawnedRuns[]` 附属）。
- materials 链、历史防重复立项、CSS 主题变量、6 秒轮询骨架。

## 4. 验收判据（1.[step]→verify:[check]）

1. [rename] `curl -XPOST /api/analyses/<id>/rename -d '{"title":"新名"}'` → meta.idea 变更、rounds/ 文件数不变 →verify: 再 GET 详情确认；超 80 字/空串 422。
2. [归档复活提交] 对 `park` 态话题 decide('go') → 200、state=go、events.jsonl 末尾有 revive 行 →verify: GET 详情。
3. [fix 再提交] 已 spawnedRun 话题 dispatch fix → 新 runId 追加 `spawnedRuns[]`（长度+1，spawnedRun 不变）→verify: meta.json 落盘内容。
4. [闸双按钮] awaiting 态页面渲染「提交开发」「提交升级整改」两个按钮；go/spawnedRun 态文案变「再次提交…」且仍可见 →verify: plan.html 源码路径 + 人实看。
5. [徽章] submitMode=fix 显示「已提交 · 整改」；无字段旧数据显示「已提交 · 开发」→verify: 代码路径 + 人实看。
6. [回归] `node --check plan-server.js` 零错；`/api/new`、reply、decide、delete、withdraw 行为与改前一致（未触碰代码段 diff 为空）→verify: git diff 仅限两文件非冻结段。

## 5. 回滚方案

两文件改动均为本票新 diff；回滚 = `git -C /root/.dsh/ds-af/panels/plan checkout -- plan-server.js plan.html`（若仓在）或按备份副本还原；重启面板服务即回旧版。meta 新增字段（submitMode/spawnedRuns）对旧代码无副作用（多余字段被忽略）。
