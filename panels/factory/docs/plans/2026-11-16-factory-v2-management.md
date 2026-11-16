# Idea Plan 分析台 + Factory v2 管理能力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ⓪新建「💡 Idea Plan 工作入口」（分析台）：把立项前的分析讨论阶段做成被管理的长事务——分析会话（轮次协议：Agent 出事实基线+决策点表 → 人拍板/喂料 → 下一轮）+ 四态归档（开放/待拍板/go/no-go/park）+ 历史分析库（防重复、可复活）；⓪′工厂改**多 run 并发执行制**（废除全局单例流水线，任务并行、互不阻塞）；⓪″分析台与工厂衔接（go 下传产物免重复预研 + 工厂保留原型确认闸）；①产品代码独立仓落位 `runs/<id>/product/`；②项目可绑 GitHub 远程、交付即推送；③目录规范机器校验 + 历史任务可重开重试（run 记录不丢）。

**Architecture:** 新增独立服务 `panels/plan/plan-server.js`（Node 内置 http/fs，零依赖，默认端口 8792）+ 分析数据落 `DS-AF/analyses/an-<ts>/`（逐轮落盘，单一真源=磁盘）；workbench 新增第五卡「💡 Idea Plan 工作入口」（LIVE 链接），Quant 卡保留占位退 v2.x。工厂侧核心改造：`run` 全局单例 → `activeRuns: Map<runDir, runState>`，mission 即起即跑（并发上限 `MAX_CONCURRENT` 默认 3，超限 409），/api/state 与 preview 按 runId 寻址（带兼容回退），bootState 恢复全部未完 run；随后 `POST /api/mission/from-plan` 承接分析台下传；prototype 节点验收通过后进 awaiting 待人确认；scaffold 增加 `product/` 标准目录；Project 索引增加 `remote` 字段与绑定接口；`checkWorkspace()` 目录巡检；`POST /api/runs/open` 历史任务重开。

**Tech Stack:** Node 内置 http/fs/child_process（无新依赖）；前端单文件 HTML（plan.html / factory.html / workbench.html）。

**Spec:** 2026-11-16 四轮拍板冻结：①dsh-analysis 决策点表 1–5 全按推荐（预研升级为独立分析台；Subagent-driven 执行；research 联网）；②分析会话设计四点全按推荐：独立于工厂（可并行/挂起）/ 人 reply 才跑一轮（pull 式）/ go 后产物下传跳过重复预研 / discovery 三节点撤掉改衔接；③入口定位：workbench 新增「Idea Plan 工作入口」卡，Quant 卡退 v2.x；④**工厂必须支持并发**——单流水线排队设计效率太低（实证：旧 run blocked 堵死全厂 + 新需求 409），废除全局单例；⑤并发必须有**前端可视化看板**（泳道式多 run 管理界面，人能一眼看全部在跑任务并逐个操作）。分析会话状态机：开放 →（轮次循环）→ 待拍板 → go | no-go | park；park/no-go 可复活续轮。

## Global Constraints

- 现有端口与 API 前缀不变（factory 8794 /api/*，workbench 不回归），plan-server 默认 8792（env PORT 覆盖）；不引入任何 npm 依赖。
- 磁盘根不变：run 一律落 `DS-AF/runs/`（.gitignore 已含），分析会话落 `DS-AF/analyses/`（**进 git**——小体量文本决策记录，即历史分析资产本体）。
- 分析台不占工厂并发额度（独立服务）；并发改造后旧 API 消费方（workbench /api/overview）不得回归。
- 现有 delete/rollback/projects API 行为不回归（`node --test panels/factory/test/` 全绿）。
- GitHub 凭证只从环境变量 `DSH_GIT_TOKEN` / git credential 读，**绝不落盘进 projects.json 或 git**。
- 并发安全：`projects.json` 读-改-写必须串行化（进程内写锁），防并发 attachRun 丢更新。
- 治理边界：分析台是交互与合同层；量化策略研究内容仍归 alpha-forge 会话治理（R-002/R-004/R-008 路由不绕开）。

## Review Focus

1. **产物外溢**：历史 demo run 产物落 /tmp、run 目录被清后 projects.json 仍留空引用 → open/delete 需容忍 run 目录缺失（404 语义，不崩服务）。
2. **remote 配了但 token 没配**：delivery push 失败不得判 blocked 住整条流水线——push 尽力而为，失败写进 DELIVERY.md 已知限制，节点仍 PASS。
3. **旧 run 无 product/ 目录**：open 历史 run（workspace-1.0 旧布局，代码在 runtime/）→ iterate/preview 必须回退用 runtime/，不误判无产品。
4. **并发误删**：删除项目时另一 run 正在执行 → 已有 409；open 不得绕过（open 到正在执行的 run 返回 409）。
5. **checkWorkspace 误报**：`analyses/`、`projects.json`、`.gitignore` 这类 DS-AF 顶层合法条目不得判为散落垃圾（白名单：README.md、projects.json、.gitignore、analyses/、panels/、runs/、samples/、archive/、docs/）。
6. **分析台与工厂状态脱节**：decide go 时工厂并发满 → 分析台仍置 `go` 成功，UI 提示并提供重下发按钮；下传成功才在 meta.json 记 `spawnedRun`。
7. **轮次并发重入**：一轮 Agent 进行中再 reply → 409 `{error:'一轮进行中'}`，不得并发跑两轮。
8. **闸门状态丢失/被绕过**：awaiting 只存内存 → 重启后 retry 可绕过原型确认闸 → awaiting 必须持久化进 nodes.json，retry 对 awaiting 中的 run 返回 400。
9. **闸门 redo 变整条重来**：原型被否后从 idx 0 重跑会浪费下传的预研产物 → redo 只重跑 prototype 节点（feedback 拼进 prompt）。
10. **并发状态串台**：多 run 并行时 /api/state、preview、events、`run` 闭包引用错位（runFrom/emit 捕获全局 run）→ 全部按 runId 寻址；`runFrom` 内对全局 `run` 的引用必须改为参数传递。
11. **bootState 只恢复最新一个 run**：并发下重启会丢其余未完 run → bootState 扫描全部 run 恢复为 paused 态（不自动续跑）。
12. **projects.json 并发写丢更新**：两个 run 同时 delivery → loadProjects-modify-save 竞态 → 进程内串行化（简单互斥队列即可，单进程模型够用）。

---

### Task 0: Idea Plan 分析台服务（plan-server.js + plan.html + workbench 卡片）

**Files:**
- Create: `panels/plan/plan-server.js`、`panels/plan/plan.html`、`panels/plan/test/plan.test.mjs`
- Modify: `panels/workbench/workbench.html`（新增第五卡，Quant 卡文案退 v2.x）

**Interfaces:**
- Produces: 会话磁盘布局（单一真源=磁盘，逐轮只增不改）：
  ```
  analyses/an-<ts>/
    meta.json        {id, idea, state: 'open'|'awaiting'|'go'|'no-go'|'park', round, created, updated, spawnedRun|null}
    rounds/r001-in.json   人的输入（拍板结果+自由补充）
    rounds/r001-out.md    Agent 产物（事实基线更新+决策点表 或 收敛声明+BRIEF 结论）
    IDEA.md / RESEARCH.md / BRIEF.md   活文档（随轮更新；BRIEF 在收敛时定稿）
    materials/       人喂的料（随时可加）
    events.jsonl     审计线
  ```
- Produces: `POST /api/new {idea}` → 建会话并自动跑第 1 轮（round 0 的 in = 原始想法）；prompt 注入近 10 条历史分析（idea 截断 + state），明示「若与历史分析相似，本轮必须说明差异」——防重复立项。
- Produces: `POST /api/:id/reply {answers, message?, materials?: [{filename, content}]}` → 落 rNNN-in.json 后触发一轮 Agent：读 meta+全部 rounds+活文档+materials，产出 rNNN-out.md。**人 reply 才跑，不自动连环**；一轮进行中再 reply → 409。Agent 输出二态：仍有决策点（state 保持 open，渲染决策点表）或收敛声明（state → awaiting，UI 出 go/no-go/park 三按钮）。
- Produces: `POST /api/:id/decide {decision:'go'|'no-go'|'park', note?}` → go：调工厂 `POST /api/mission/from-plan`（Task 2；并发满则成功置 go + 提示重下发）；no-go/park：直接归档，产物全保留。
- Produces: `GET /api/analyses`（磁盘派生列表：id/idea/state/round/updated）与 `GET /api/analyses/:id`（详情：meta+全部轮次+活文档内容）。
- Produces: 复活路径 = park/no-go 会话直接 `reply` 续轮（state 回 open，历史轮次全保留）。
- Produces: `claudeStream` 按节点传工具集：分析轮默认 Read/Write/Edit/受限 Bash + `WebSearch WebFetch`（外部参考是分析质量硬需求）。
- Produces: plan.html：左侧会话列表（五态筛选）+ 右侧当前轮决策点表渲染（选项/推荐/依据）、点选拍板 + 自由补充框、materials 粘贴框、活文档页签（IDEA/RESEARCH/BRIEF）。
- Produces: workbench.html 新增「💡 Idea Plan 工作入口」卡（LIVE 状态 + 链接 :8792），Quant 卡状态文案改「规划中 v2.x」。
- Consumes: 工厂并发接口（Task 1）无依赖——分析台独立服务；复用 factory-server 的 claudeStream 模式（拷贝改参，零耦合）。

**Flow:**
- [ ] **Step 1: 写失败测试**：spawn plan-server（随机 PORT + tmp ANALYSES dir，`PLAN_AGENT_CMD` 注入 mock，不依赖真模型）：`/api/new` → 会话目录 + meta.json(state:open,round:1) + rounds/r001-out.md 存在；`/api/analyses` 含它；一轮进行中 reply → 409；`/api/:id/decide no-go` → state=no-go 且目录保留；decide go 时工厂不可达 → 仍 200 + state=go + meta.spawnedRun===null；materials 带 `../` filename → 400；复活：no-go 会话 reply → state 回 open 且 round+1。
- [ ] **Step 2: 跑测试预期 FAIL。**
- [ ] **Step 3: 实现** plan-server.js（状态机 + 轮次协议 + 落盘 + 防重入 + 工具集参数化）+ plan.html + workbench 卡片。
- [ ] **Step 4: 全部测试 PASS（含 workbench 改动不破坏既有页面加载）。**
- [ ] **Step 5: Commit** `feat: idea-plan analysis workspace — session/round protocol, decision tables, state archive`。

### Task 1: 工厂多 run 并发执行制（废除全局单例）

**Files:**
- Modify: `panels/factory/factory-server.js`（activeRuns Map + 全 API 按 runId 寻址 + MAX_CONCURRENT + bootState 全量恢复 + projects 写串行化）
- Modify: `panels/factory/factory.html`（多 run 并发可视化看板）
- Test: `panels/factory/test/concurrent.test.mjs`

**Interfaces:**
- Produces: `activeRuns: Map<runDir, runState>` 取代 `let run`；`runFrom(runState, idx, res)` 全程参数传递 runState，**消除对全局 run 的闭包引用**（现 factory-server.js:185-220 的 emit/persist/节点 accept 均读全局 run——最大风险点）。
- Produces: 并发上限 `MAX_CONCURRENT`（env，默认 3）：`executing` 态 run 数达到上限时新 mission 409 `{error:'并发已满'}`；未达上限即起即跑，不再互相排队。
- Produces: API 寻址规则：`/api/state` 无参 → `{runs:[全部 active 摘要], run:最近活动 run 完整态}`（向后兼容 workbench）；`/api/state?id=<runId>` → 指定 run 完整态。`/api/retry {id}`、`/api/approve {id, ...}`、`/preview/<runId>/<rel>` 同步按 id 寻址（旧 `/preview/<rel>` 回退最近活动 run）。
- Produces: bootState 全量恢复：扫描 runs/ 下所有 nodes.json 非全 done 的 run 载入为 **paused** 态（不自动续跑、不算 executing 额度）；含 blocked/awaiting 的照常恢复各自状态。
- Produces: projects.json 写串行化：进程内 Promise 链互斥（`saveProjects`/`attachRun`/`newProject` 统一走队列），防并发 delivery 丢更新。
- Produces: factory.html **多 run 并发可视化看板**（纯原生 DOM，零依赖，30s 内自刷新）：
  - ①顶栏并发池总览：并发占用 `n/MAX_CONCURRENT` 徽标 + 各态计数（executing 🟢 / paused ⏸ / blocked ⛔ / awaiting 👤 / done ✅）；
  - ②每 run 一条**流水线泳道**：节点链横排芯片（done ✅ / running ⏳ / blocked ⛔ / pending ○ / awaiting 🔒），泳道头显示 idea 摘要、**当前节点名 + 该节点已运行时长 + 最近一条 agent 动作**（tool brief，如「读取 PRD.md」——让人不问就知道卡在哪一步），点击泳道切换下方详情；
  - ③详情区（按选中 run）：实时事件流（node_start/node_check/pipeline_blocked/pipeline_awaiting）、产物树与预览入口（/preview）、操作按钮——重试 / verify-only 重试 / approve go·redo（awaiting 时）/ 删除（非 executing）；
  - ④数据源：轮询 `/api/state` 聚合视图 + `/api/runs` 历史列表合并展示（active 置顶）。
  - ⑤进度可读性硬要求：每个在跑任务在**不开详情**的情况下就能看到「当前节点 / 已运行多久 / 最近动作」三要素——后台任务对人的状态透明是本轮用户强令，不是可选美化；workbench Engineering 卡同步显示各 active run 的节点进度条。
- Consumes: 现有 persist()/nodes.json（每 run 独立目录天然隔离，无需改）。
- 语义变更记录：`/api/mission` 的 409 从「factory busy」变为「并发已满」；单 run 内仍是串行节点流水线（本 Task 不做节点级并行）。

**Flow:**
- [ ] **Step 1: 写失败测试**：mock agent 快速完成：并发提交 2 个 mission → 两个 run 同时存在且都在推进（`/api/state` 的 runs[] 长度 2）；提交第 MAX_CONCURRENT+1 个 → 409；`/api/state?id=` 能各自取到独立进度；一个 run blocked 不影响另一个继续；重启服务（重新 spawn）→ 两个 run 均恢复 paused；并发收尾后 projects.json 无丢更新（两 run 各自登记）。
- [ ] **Step 2: 跑测试预期 FAIL。**
- [ ] **Step 3: 实现** activeRuns 重构 + runFrom 参数化 + API 寻址 + bootState 全量 + 写锁 + factory.html 多任务 UI。
- [ ] **Step 4: 全部测试 PASS（含既有单 run 回归全套）。**
- [ ] **Step 5: Commit** `feat: concurrent multi-run factory — abolish global single pipeline`。

### Task 2: 工厂衔接（from-plan 下传 + 原型确认闸）

**Files:**
- Modify: `panels/factory/factory-server.js`（`POST /api/mission/from-plan` + prototype awaiting/approve + PRD 读 BRIEF）
- Modify: `panels/factory/factory.html`（原型确认按钮 + feedback 输入框）
- Test: `panels/factory/test/from-plan.test.mjs`

**Interfaces:**
- Produces: `POST /api/mission/from-plan {analysisDir, idea}` → scaffold build run 后把 `analyses/<id>/` 的 IDEA.md/RESEARCH.md/BRIEF.md/materials/ 拷进 `runs/<id>/materials/analysis/`（分析产物是工厂的输入料，不是工厂产物）；并发满 409 语义与 mission 一致；返回 `{runId}` 供分析台写 `meta.spawnedRun`。
- Produces: `product`（PRD）节点 prompt 注入：优先读 `materials/analysis/BRIEF.md` 作为主要输入（原始想法降为附注）；无该目录时回退现状行为（裸 mission 仍可用，零回归）。
- Produces: 原型确认闸：prototype 节点验收通过 → 该 run 置 `awaiting={gate:'prototype', nodeIdx}`，流水线停住 emit `{type:'pipeline_awaiting'}`；awaiting 随 `persist()` 进 nodes.json（重启不丢）；`/api/retry {id}` 对 awaiting run 返回 400。
- Produces: `POST /api/approve {id, decision:'go'|'redo', feedback?}` → go：清 awaiting + `runFrom(runState, architectIdx)`；redo：清 awaiting + prototype 置 blocked + `runFrom(runState, prototypeIdx)` 且 feedback 拼进 prompt（只重跑原型）。
- Consumes: Task 1 的 runState 参数化与 runId 寻址；Task 0 的分析台调用约定（analysisDir 校验必须以 `DS-AF/analyses/` 开头，防路径注入）。

**Flow:**
- [ ] **Step 1: 写失败测试**：tmp 造 analysisDir（含 BRIEF.md/materials）→ `from-plan` → run 目录 `materials/analysis/` 内容齐 + PRD prompt 注入标记；prototype await（手写 nodes.json 模拟 awaiting）→ `/api/retry` 400、`/api/approve redo` 只置 prototype blocked；`/api/approve` 对非 awaiting run 400；analysisDir 带 `../` → 400。
- [ ] **Step 2: 跑测试预期 FAIL。**
- [ ] **Step 3: 实现** from-plan 路由 + 拷贝 + PRD prompt 分支 + awaiting 持久化（persist/bootState/runFrom 三处接线）+ approve 路由 + factory.html 确认/打回按钮。
- [ ] **Step 4: 全部测试 PASS（含既有 mission 回归：裸 mission 全链不受影响）。**
- [ ] **Step 5: Commit** `feat: factory accepts plan handoff + prototype confirmation gate`。

### Task 3: product/ 独立产品仓布局

**Files:**
- Modify: `panels/factory/factory-server.js`（scaffold / NODES coding+delivery / findIndexHtmlRoot / preview）
- Test: `panels/factory/test/product-layout.test.mjs`

**Interfaces:**
- Produces: `scaffold(dir, flow, idea, repo)` 额外创建 `product/` 并在 manifest.json 加 `productDir:'product'`。
- Produces: build 流 coding 节点 prompt 的 cwd 与写作目标 = `path.join(run.dir,'product')`；delivery 节点在 product/ 内 `git init + commit`（不再对 run 根 init）。
- Produces: `findIndexHtmlRoot(dir)` 查找顺序改为 `product/` → `runtime/` → dir（旧布局兼容）。
- Consumes: 现有 `claudeStream(prompt, cwd, ...)`、`rf`、`execSync`。

**Flow:**
- [ ] **Step 1: 写失败测试**：spawn server（随机 PORT, RUNDIR=tmp，mock agent）→ POST `/api/mission` 后断 `/api/state?id=` 的 run.dir 下存在 `product/` 与 `manifest.json.productDir==='product'`。
- [ ] **Step 2: 跑 `node --test panels/factory/test/` 预期新测试 FAIL**（scaffold 尚无 product/）。
- [ ] **Step 3: 实现**：scaffold 循环目录列表加 `'product'`；manifest 加字段；NODES coding prompt 中「runtime/ 目录」改为「product/ 目录（它本身就是独立产品仓库根）」；delivery prompt 改为「在 product/ 内 git init（若无）+ config 本地身份 + add -A + commit 'delivery v1.0.0'」，其 accept 改查 `git -C product log`；findIndexHtmlRoot 候选顺序 `['product','runtime']` + dir。
- [ ] **Step 4: 全部测试 PASS**（含既有 delete 回归）。
- [ ] **Step 5: Commit** `feat: product/ independent repo layout per run`。

### Task 4: 项目绑 GitHub 远程 + 交付推送

**Files:**
- Modify: `panels/factory/factory-server.js`（Project 字段 / delivery 节点 / 新 API）；`panels/factory/factory.html`（项目树行内「绑远程」输入框）
- Test: `panels/factory/test/remote-push.test.mjs`

**Interfaces:**
- Produces: `Project.remote: string|null`；`POST /api/projects/remote {id, remote}` → `{ok:true, remote}`（空 remote 即解绑置 null；URL 必须以 `https://github.com/` 或 `git@github.com:` 开头，否则 400）。
- Produces: `pushIfPossible(repoDir, remoteUrl): {pushed:boolean, note:string}` —— 有 remote 且 `DSH_GIT_TOKEN` 存在时 `git remote add origin` + `git push -u origin HEAD`（token 走临时 URL，**不写进 config**）；任何失败返回 `pushed:false, note:原因`，不 throw。
- Produces: delivery 节点 accept 后调用 pushIfPossible，note 追加进 `emit({type:'node_check', detail})`，push 失败不致节点 fail。
- Consumes: Task 3 的 product/ 布局（build 流 push product/ 仓；iterate 流 push 父 product 仓）。

**Flow:**
- [ ] **Step 1: 写失败测试**：绑非 GitHub URL → 400；绑合法 URL → projects.json 含 remote；无 token 时 delivery 后该 run 无 blocked（push 静默跳过）；真推送留人工验收。
- [ ] **Step 2: 跑测试预期 FAIL。**
- [ ] **Step 3: 实现** API + pushIfPossible + delivery 挂接；factory.html 项目树每行加小输入框+绑定按钮。
- [ ] **Step 4: 全部测试 PASS。**
- [ ] **Step 5: Commit** `feat: project github remote binding + best-effort delivery push`。

### Task 5: 目录规范机器巡检（checkWorkspace）

**Files:**
- Modify: `panels/factory/factory-server.js`；Test: `panels/factory/test/workspace-check.test.mjs`

**Interfaces:**
- Produces: `checkWorkspace(): {ok:boolean, issues:[{where,what}]}` — ①DS-AF 顶层非白名单条目=散落；②`runs/` 下不以 run-/fix- 开头的目录=违规；③每个 run 目录缺 manifest.json/nodes.json=残缺；④projects.json 引用的 runId 目录不存在=悬空引用；⑤`analyses/` 下不以 an- 开头=违规；⑥run 内产物散落（llmwiki/、runtime/、product/、materials/ 之外的一级文件=违规，README 除外）——机器约束产物落位，不再纯靠节点 prompt 自觉。
- Produces: `GET /api/workspace/check` → 上述结果（只读巡检，不自动删）。
- Produces: factory.html 顶栏加「巡检」按钮，issues 非空列红点清单。
- Consumes: `loadProjects()`、`RUNDIR`。

**Flow:**
- [ ] **Step 1: 写失败测试**：tmp 工作区造六类 issue 各 ≥1 → 断言各出现且 `ok===false`；干净工作区 → `ok===true`。
- [ ] **Step 2: 跑测试预期 FAIL（404）。**
- [ ] **Step 3: 实现 checkWorkspace + 路由 + 白名单常量 `TOP_ALLOWED`（含 analyses/）+ run 内一级白名单常量。**
- [ ] **Step 4: 全部测试 PASS。**
- [ ] **Step 5: Commit** `feat: workspace directory lint (/api/workspace/check)`。

### Task 6: 流程管理——历史任务重开与按 id 重试

**Files:**
- Modify: `panels/factory/factory-server.js`；Test: `panels/factory/test/open-retry.test.mjs`

**Interfaces:**
- Produces: `POST /api/runs/open {id}` → 200 且把该 run 载入 activeRuns（抽 `restoreRun(dirPath): runState|null` 供 bootState 与 open 共用）；run 正在执行或目标不存在或已在 activeRuns → 409/404/幂等 200。
- Produces: `POST /api/retry {id?}` — 带 id 时先 open 再重试；不带 id 重试最近活动 run 的 blocked 节点（awaiting run 仍 400，见 Task 2）。
- Produces: `/api/runs/delete` 删除后同步从 projects.json 各项目 runs[] 移除该 id（修悬空引用）；删除 activeRuns 中的 run 需其非 executing（409）。
- Produces: retry 增补 `verify-only` 模式：`POST /api/retry {id, verifyOnly:true}` 不重跑 agent，仅重跑该节点 accept 判据（产物被人工外科修复后快速解阻——本轮体检发现 #8 的整改）。
- Consumes: Task 1 的 activeRuns、现有 `persist()`/`nodes.json`、`runFrom(runState, idx)`。

**Flow:**
- [ ] **Step 1: 写失败测试**：造 blocked run 目录 → open → `/api/state?id=` 返回该 run → retry → 无 400；手修产物后 `verifyOnly:true` → 仅重验 accept 且通过则放行；delete → projects.json 不再含它。
- [ ] **Step 2: 跑测试预期 FAIL。**
- [ ] **Step 3: 实现**：抽 `restoreRun`；bootState 改调它；open/retry 路由（含 verifyOnly）；delete 里 `loadProjects→filter runs→saveProjects`（走 Task 1 写锁）。
- [ ] **Step 4: 全部测试 PASS；重启服务验证 bootState 全量恢复不回归。**
- [ ] **Step 5: Commit** `feat: reopen historical run + retry-by-id + verify-only retry + delete de-references projects`。

## Self-Review 结论

- 覆盖：六项需求 → Task 0（Idea Plan 分析台）、Task 1（多 run 并发制——第四轮拍板强制）、Task 2（衔接：下传+原型闸）、Task 3（product/ 布局）、Task 4（git/GitHub）、Task 5（目录巡检，含 run 内落位约束——体检发现补强）+ Task 6（跨会话重开 + verify-only 重试——体检发现 #8 整改），无缺口。原「历史分析库」溶解进 Task 0。
- Review Focus 十二条挂位：Task 0（6/7）、Task 1（10/11/12）、Task 2（8/9）、Task 5（1/5）、Task 4（2）、Task 3（3）、Task 6（4）。
- 关键设计决策已内建：分析台独立服务零耦合；单 run 内节点仍串行（本计划不做节点级并行，防范围膨胀）；MAX_CONCURRENT 默认 3 防失控烧 token；bootState 恢复为 paused 不自动续跑（防重启风暴）；verify-only 重试给人工外科修产物留轻通道。
- 类型一致：`pushIfPossible`/`checkWorkspace`/`restoreRun`/`activeRuns` 命名自洽；依赖方向：Task 2 消费 Task 0/1，Task 4 消费 Task 3，Task 6 消费 Task 1，无环。
- 比例：计划 < 目标代码量，未写函数体成稿。
