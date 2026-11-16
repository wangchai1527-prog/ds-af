# 任务-项目两层管理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把「run 即项目」的单层模型重构为 Project（长期载体）/ Task-Run（一次执行）两层，删除项目即清零其全部任务与当前视图。

**Architecture:** projects.json 全局索引（项目=产品仓库+版本链），每次 build/iterate/fix 生成 run 挂到 project.runs[]；工厂内存态只指向「当前 run」；视图按 项目→任务 树展示。

**Tech Stack:** Node 内置 http/fs（现有 factory-server.js），无新依赖。

**Spec:** 本会话冻结的两层模型讨论（2026-11-16）：项目=长期载体，任务=一次执行；删项目清任务，删任务留产品。

## Global Constraints

- 端口与 API 前缀不变（8794，/api/*），前端 factory.html 单文件。
- 磁盘布局不变：runs/run-*、fix-*；项目索引新增 `DS-AF/projects.json`。
- 删除项目=删其全部 run 目录 + 索引行 + 若为当前任务则内存清零。
- 正在执行（run.executing=true）的任务禁删。

## Review Focus

1. 删除当前活跃项目 → active 清零 + 列表移除（已热修，Task 1 补回归测试固化）。
2. projects.json 损坏/缺失 → 重建索引不崩溃（Task 2）。
3. iterate run 的父项目被删 → 孤儿 run 在列表标注并允许独立删除（Task 3）。
4. 同一项目并发两个 run → 后端 409（现有单流水线保持）。
5. 删除任务但保留项目 → 产品 runtime/ 不动，仅 run 记录消失（Task 3）。

---

### Task 1: 删除语义回归测试（固化热修）

**Files:** Modify: `panels/factory/factory-server.js`；Test: `panels/factory/test/delete.test.mjs`（node:test 起 server 于 8796 端口打真请求）

**Interfaces:** Produces: `DELETE /api/runs/delete {id}` → `{ok:true,clearedActive:boolean}`；`run.executing` 生命周期（runFrom 置 true，blocked/all_done 置 false）。

- [ ] Step 1: 写失败测试：造 run（blocked 状态）→ delete → `/api/state` 的 run===null 且 `/api/runs` 不含该 id。
- [ ] Step 2: 跑 `node --test`，预期 FAIL（尚未有测试基建）。
- [ ] Step 3: 测试内 spawn server（PORT=8796, RUNDIR=tmp）→ 走 HTTP 断言（热修代码已在，测试固化行为）。
- [ ] Step 4: PASS 后 commit `test: delete-clears-active regression`。

### Task 2: projects.json 项目索引层

**Files:** Create: `DS-AF/projects.json`；Modify: `factory-server.js`

**Interfaces:**
- `loadProjects(): Project[]`（损坏时返回 [] 并重建文件）
- `Project = {id:'P-xxx', name, repo, created, runs:[runId...], status}`
- mission/iterate/fix 完成交付时 `attachRun(projectId, runId)`；build 交付即建 Project。
- `GET /api/projects` → 项目树（项目+其 runs 状态聚合）。

- [ ] Step 1: 失败测试：建 project → 列表含；写坏 JSON → loadProjects 返回 [] 且文件被重建。
- [ ] Step 2-4: 实现 + PASS。
- [ ] Step 5: commit `feat: project index layer`。

### Task 3: 双层 UI 与删除语义拆分

**Files:** Modify: `factory.html`；`factory-server.js`

**Interfaces:**
- `DELETE /api/projects/delete {id}` → 删全部 runs + 索引 + 清 active（执行中禁删）。
- `DELETE /api/runs/delete {id}` → 仅删单 run 记录，项目与其余 run 保留。
- 前端「项目管理」tab 改为两级树：项目行（产品名/版本链/📊任务数）→ 展开任务行（flow/状态/迭代…/回滚/删任务）；项目行操作：➕新迭代 / 🗑删项目（整树清零，红色警示文案「将删除 N 个任务与产品代码」）。

- [ ] Step 1: 失败测试：项目含 2 run → 删任务1 → 项目剩 1 run 且 runs 目录里该 run 目录消失；删项目 → 全消失 + active 清零。
- [ ] Step 2-4: 实现 + PASS。
- [ ] Step 5: commit `feat: two-level project/task management UI`。
