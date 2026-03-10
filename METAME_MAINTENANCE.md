# MetaMe 项目维护手册（入口版）

> 最后同步：2026-03-10  
> 版本基线：`metame-cli@1.5.3`

本文件只保留“入口与索引”，避免历史大文档长期漂移。
具体维护细节以 `scripts/docs/*` 与当前代码为准。

## 1) 一线维护文档（权威）

- 运行维护手册：`scripts/docs/maintenance-manual.md`
- 脚本/模块指针地图：`scripts/docs/pointer-map.md`
- Agent 手机端指南：`scripts/docs/agent-guide.md`
- 文件互传说明：`scripts/docs/file-transfer.md`

## 2) 关键目标（当前）

- Claude/Codex 双引擎都可用，且行为一致。
- `project.engine` 路由稳定：默认 `claude`，显式 `codex` 可持久化。
- 手机端（Telegram/Feishu）与桌面端能力对齐，不冲突。
- 新用户只装 Claude 或只装 Codex 时，诊断与路由都能正确识别。

## 3) 快速排查顺序

1. 配置：`~/.metame/daemon.yaml`、`scripts/daemon-default.yaml`
2. 路由：`scripts/daemon-command-router.js`、`scripts/daemon-agent-tools.js`
3. 执行：`scripts/daemon-engine-runtime.js`、`scripts/daemon-claude-engine.js`
4. Hook拦截：`scripts/hooks/intent-engine.js`
5. 管理命令：`scripts/daemon-admin-commands.js`（`/engine`、`/doctor`、`/distill-model`）
6. 会话存储：`scripts/daemon-session-store.js`

## 4) 变更后最小动作

1. 运行测试：`npm test`
2. 同步 plugin 副本：`npm run sync:plugin`
3. 文档同步：
   - `scripts/docs/maintenance-manual.md`
   - `scripts/docs/pointer-map.md`
   - `README.md`
   - `README中文版.md`

## 5) 历史说明

旧版长文档已下线（内容曾包含过时结构和版本信息）。
如需追溯历史实现，请直接用 `git log -- METAME_MAINTENANCE.md` 查看。
