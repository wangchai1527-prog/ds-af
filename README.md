# DS-AF · DSH Agent Factory 工作区（目录规范 v1.0）

> 统一收纳 DSH 面板开发与 Agent 工厂产物。散落文件一律不入 /root/.dsh 顶层。

```
DS-AF/
├── panels/            # 自研面板（每面板一目录：前端 + 后端服务同址）
│   ├── workbench/     # DSH 工作台 1.0 · Cockpit 总入口        :8790
│   ├── factory/       # Engineering Factory · 双流节点管理制     :8794
│   ├── vibe-studio/   # Vibe Coding Studio · 执行直播           :8793
│   └── replay/        # 编排回放 demo（纯静态）                  :8791
├── runs/              # 工厂产出（Workspace Standard 1.0）
│   ├── run-<id>/      # 立项开发流：manifest/loop/llmwiki/runtime/skills/plugins
│   └── fix-<id>/      # 运维修复流：知识层在此，执行绑定目标仓库
├── samples/           # 样例项目
│   ├── login-app/     # ENG-UI-001 登录页优化样例               :8795
│   └── lab/           # Vibe Studio 默认工作区
└── archive/           # 历史归档（routing 旧版 html 等，只读）
```

## 端口分配
8790 工作台 · 8791 回放 · 8793 Studio · 8794 工厂 · 8795 登录样例

## 纪律
- 新面板必须建目录进 panels/，禁止顶层散放 html
- 工厂 run 一律落 runs/ 标准结构，产物不外溢
- 归档件只读不改动，需要复用先拷贝
