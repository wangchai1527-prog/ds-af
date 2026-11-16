# Engineering Factory v2 · 三块管理能力（文件/git/流程）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给工厂补齐三块管理：①产品代码独立仓落位 `runs/<id>/product/`；②项目可绑 GitHub 远程、交付即推送；③目录规范机器校验 + 历史任务可重开重试（run 记录不丢）。

**Architecture:** 在现有 factory-server.js（Node 内置 http/fs，零依赖）上扩展：scaffold 增加 `product/` 标准目录并让 coding/delivery 节点绑定它为独立 git 仓；Project 索引增加 `remote` 字段与 `POST /api/projects/remote` 绑定接口，delivery 节点有 remote 则 push；新增 `checkWorkspace()` 目录巡检与 `/api/workspace/check`；新增 `POST /api/runs/open` 把历史 run 载回为当前任务以支持跨会话重试。

**Tech Stack:** Node 内置 http/fs/child_process（无新依赖）；前端 factory.html 单文件。

**Spec:** 2026-11-16 会话冻结：三项全做；repo 策略 = `runs/<id>/product/` 独立仓（可选配远程 URL 推送）。

## Global Constraints

- 端口与 API 前缀不变（8794，/api/*），不引入任何 npm 依赖。
- 磁盘根不变：run 一律落 `DS-AF/runs/`（Workspace Standard 1.0：loop/llmwiki/runtime/skills/plugins + 新增 product）。
- 现有 delete/rollback/projects API 行为不回归（`node --test panels/factory/test/` 全绿）。
- GitHub 凭证只从环境变量 `DSH_GIT_TOKEN` / git credential 读，**绝不落盘进 projects.json 或 git**。
- `run.executing=true` 时禁删、禁 open 覆盖（保持现有单流水线语义）。

## Review Focus

1. **产物外溢**：历史 demo run 产物落 /tmp、run 目录被清后 projects.json 仍留空引用 → open/delete 需容忍 run 目录缺失（404 语义，不崩服务）。
2. **remote 配了但 token 没配**：delivery push 失败不得判 blocked 住整条流水线——push 是尽力而为，失败写进 DELIVERY.md 已知限制，节点仍 PASS。
3. **旧 run 无 product/ 目录**：open 历史 run（workspace-1.0 旧布局，代码在 runtime/）→ iterate/preview 必须回退用 runtime/，不误判无产品。
4. **并发误删**：删除项目时另一 run 正在执行 → 已有 409；新增 open 不得绕过（open 到正在执行的 run 返回 409）。
5. **checkWorkspace 误报**：`projects.json`、`.gitignore` 这类 DS-AF 顶层合法文件不得判为散落垃圾（白名单：README.md、projects.json、.gitignore、panels/、runs/、samples/、archive/、docs/）。

---

### Task 1: product/ 独立产品仓布局

**Files:**
- Modify: `panels/factory/factory-server.js`（scaffold / NODES coding+delivery / findIndexHtmlRoot / preview）
- Test: `panels/factory/test/product-layout.test.mjs`

**Interfaces:**
- Produces: `scaffold(dir, flow, idea, repo)` 额外创建 `product/` 并在 manifest.json 加 `productDir:'product'`。
- Produces: build 流 coding 节点 prompt 的 cwd 与写作目标 = `path.join(run.dir,'product')`；delivery 节点在 product/ 内 `git init + commit`（不再对 run 根 init）。
- Produces: `findIndexHtmlRoot(dir)` 查找顺序改为 `product/` → `runtime/` → dir（旧布局兼容）。
- Consumes: 现有 `claudeStream(prompt, cwd, ...)`、`rf`、`execSync`。

- [ ] **Step 1: 写失败测试**：spawn server（PORT=8796, RUNDIR=tmp）→ POST /api/mission 走不完整流水线太重，直接单测函数不可行（未导出）→ 改为 HTTP 级：POST `/api/mission` 后立即断 `/api/state` 的 run.dir 下存在 `product/` 与 `manifest.json.productDir==='product'`（mission 后马上 `/api/runs/delete` 清理，避免 busy）。
- [ ] **Step 2: 跑 `node --test panels/factory/test/` 预期新测试 FAIL**（scaffold 尚无 product/）。
- [ ] **Step 3: 实现**：scaffold 循环目录列表加 `'product'`；manifest 加字段；NODES coding prompt 中「runtime/ 目录」改为「product/ 目录（它本身就是独立产品仓库根）」；delivery prompt 改为「在 product/ 内 git init（若无）+ config 本地身份 + add -A + commit 'delivery v1.0.0'」，其 accept 改查 `git -C product log`；findIndexHtmlRoot 候选顺序 `['product','runtime']` + dir。
- [ ] **Step 4: 全部测试 PASS**（含既有 delete 回归）。
- [ ] **Step 5: Commit** `git commit -m "feat: product/ independent repo layout per run"`。

### Task 2: 项目绑 GitHub 远程 + 交付推送

**Files:**
- Modify: `panels/factory/factory-server.js`（Project 字段 / delivery 节点 / 新 API）；`panels/factory/factory.html`（项目树行内「绑远程」输入框）
- Test: `panels/factory/test/remote-push.test.mjs`

**Interfaces:**
- Produces: `Project.remote: string|null`；`POST /api/projects/remote {id, remote}` → `{ok:true, remote}`（空 remote 即解绑置 null；URL 必须以 `https://github.com/` 或 `git@github.com:` 开头，否则 400）。
- Produces: `pushIfPossible(repoDir, remoteUrl): {pushed:boolean, note:string}` —— 有 remote 且 `DSH_GIT_TOKEN` 存在时 `git remote add origin` + `git push -u origin HEAD`（token 走 `https://x-access-token:$DSH_GIT_TOKEN@github.com/...` 临时 URL，**不写进 config**）；任何失败返回 `pushed:false, note:原因`，不 throw。
- Produces: delivery 节点 accept 后调用 pushIfPossible，结果 note 追加进 `emit({type:'node_check', detail})` 与 DELIVERY 检查不因 push 失败而 fail。
- Consumes: Task 1 的 product/ 布局（build 流 push product/ 仓；iterate 流 push 父 product 仓）。

- [ ] **Step 1: 写失败测试**：绑非 GitHub URL → 400；绑合法 URL → projects.json 含 remote；`pushIfPossible` 无 token 时返回 `pushed:false` 不 throw（通过 delivery 后 `/api/state` 无 blocked 验证）。用本地 bare 仓 `file:///`？——不行，限 GitHub 前缀；push 路径测「无 token 静默跳过」即可，真推送留人工验收。
- [ ] **Step 2: 跑测试预期 FAIL。**
- [ ] **Step 3: 实现** API + pushIfPossible + delivery 挂接；factory.html 项目树每行加小输入框+绑定按钮（fetch POST 后刷新 /api/projects）。
- [ ] **Step 4: 全部测试 PASS。**
- [ ] **Step 5: Commit** `feat: project github remote binding + best-effort delivery push`。

### Task 3: 目录规范机器巡检（checkWorkspace）

**Files:**
- Modify: `panels/factory/factory-server.js`；Test: `panels/factory/test/workspace-check.test.mjs`

**Interfaces:**
- Produces: `checkWorkspace(): {ok:boolean, issues:[{where,what}]}` — ①DS-AF 顶层非白名单条目=散落；②`runs/` 下不以 run-/fix- 开头的目录=违规；③每个 run 目录缺 manifest.json/nodes.json=残缺；④projects.json 引用的 runId 目录不存在=悬空引用。
- Produces: `GET /api/workspace/check` → 上述结果（只读巡检，不自动删）。
- Produces: factory.html 顶栏加「巡检」按钮，issues 非空列红点清单。
- Consumes: `loadProjects()`、`RUNDIR`。

- [ ] **Step 1: 写失败测试**：tmp 工作区造：顶层垃圾文件 `stray.html`、runs 下 `bad-dir/`、缺 manifest 的 `run-x/`、projects.json 引用不存在 run → 断言四类 issue 各出现 ≥1 且 `ok===false`；干净工作区 → `ok===true`。
- [ ] **Step 2: 跑测试预期 FAIL（404）。**
- [ ] **Step 3: 实现 checkWorkspace + 路由 + 白名单常量 `TOP_ALLOWED`。**
- [ ] **Step 4: 全部测试 PASS。**
- [ ] **Step 5: Commit** `feat: workspace directory lint (/api/workspace/check)`。

### Task 4: 流程管理——历史任务重开与按 id 重试

**Files:**
- Modify: `panels/factory/factory-server.js`；Test: `panels/factory/test/open-retry.test.mjs`

**Interfaces:**
- Produces: `POST /api/runs/open {id}` → 200 且把该 run 载入内存为当前 run（复用 bootState 的恢复逻辑，抽成 `restoreRun(dirPath): boolean` 供 bootState 与 open 共用）；run 正在执行或目标不存在或目标即当前 run → 409/404/幂等 200。
- Produces: `POST /api/retry {id?}` — 带 id 时先 open 再重试；不带 id 保持现行为（重试当前 run 的 blocked 节点）。
- Produces: `/api/runs/delete` 删除后同步从 projects.json 各项目 runs[] 移除该 id（修悬空引用，配合 Task 3 巡检④收敛为存量问题）。
- Consumes: 现有 `persist()`/`nodes.json`、`runFrom(idx)`。

- [ ] **Step 1: 写失败测试**：造 blocked run 目录（手写 nodes.json 含 'blocked'）→ open → `/api/state` 返回该 run 且 nodes 含 blocked → retry → 无 400；delete 该 run → projects.json 对应项目 runs 不再含它。
- [ ] **Step 2: 跑测试预期 FAIL。**
- [ ] **Step 3: 实现**：抽 `restoreRun`；bootState 改调它；open/retry 路由；delete 里 `loadProjects→filter runs→saveProjects`。
- [ ] **Step 4: 全部测试 PASS；重启服务（PORT 不变）验证 bootState 恢复不回归。**
- [ ] **Step 5: Commit** `feat: reopen historical run + retry-by-id + delete de-references projects`。

## Self-Review 结论

- 覆盖：三项需求 → Task 1（文件/目录落位）、Task 2（git/GitHub）、Task 3（目录规范巡检）+ Task 4（流程状态跨会话管理），无缺口。
- Review Focus 五条已分别挂到 Task 3（1/5）、Task 2（2）、Task 1（3）、Task 4（4）、Task 3（5）。
- 类型一致：`pushIfPossible`/`checkWorkspace`/`restoreRun` 命名在各 Task 内自洽，Task 2 消费 Task 1 的 product/ 布局已显式声明。
- 比例：计划 < 目标代码量，未写函数体成稿。
