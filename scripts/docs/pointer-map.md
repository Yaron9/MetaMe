# MetaMe 脚本/文档指针地图

> 目的：回答“这段能力在哪个文件”“当前升级做到哪一步”“先看哪个脚本”。

## 快速入口

- 主入口：`index.js`
- Daemon 主循环：`scripts/daemon.js`
- Claude 执行引擎：`scripts/daemon-claude-engine.js`
- 管理命令：`scripts/daemon-admin-commands.js`
- 命令路由：`scripts/daemon-command-router.js`
- 默认配置：`scripts/daemon-default.yaml`

## Mentor Mode（Step 1-4）定位

- Step 1 数据基建：
  - `scripts/session-analytics.js`
  - 关键点：`extractSkeleton()` 新增数值指标、`detectSignificantSession()`
  - `scripts/schema.js`：`growth.mentor_mode`、`growth.mentor_friction_level`、`growth.weekly_report_last`
  - `scripts/memory.js`：`fact_labels` 表结构

- Step 2 决策引擎：
  - `scripts/mentor-engine.js`
  - 关键 API：`checkEmotionBreaker` / `buildMentorPrompt` / `computeZone` / `registerDebt` / `collectDebt` / `detectPatterns`
  - 运行时状态文件：`~/.metame/mentor_runtime.json`

- Step 3 Hook 接入：
  - `scripts/daemon-claude-engine.js`：Pre-flight / Context / Post-flight 三段 Hook
  - `scripts/daemon-admin-commands.js`：`/mentor on|off|level|status`
  - `scripts/daemon-default.yaml`：`daemon.mentor` 配置段

- Step 4 Distiller & Memory 闭环：
  - `scripts/distill.js`：`competence_signals` 合并、significant session postmortem 产出、`bug_lesson` 回写
  - `scripts/memory-extract.js`：消费 `saveFacts().savedFacts`，写入 `fact_labels`
  - `scripts/memory.js`：`saveFactLabels()` 原子写入 API
  - `scripts/memory-nightly-reflect.js`：`synthesized_insight` 回写、知识胶囊聚合与 `knowledge_capsule` 回写

## 运行时数据位置

- 画像：`~/.claude_profile.yaml`
- 记忆数据库：`~/.metame/memory.db`
- 会话标签：`~/.metame/session_tags.json`
- 夜间反思文档：`~/.metame/memory/decisions/`、`~/.metame/memory/lessons/`
- 知识胶囊：`~/.metame/memory/capsules/`
- 复盘文档：`~/.metame/memory/postmortems/`

## 诊断顺序（推荐）

1. 先看配置：`~/.metame/daemon.yaml` 与 `scripts/daemon-default.yaml`
2. 再看命令入口：`scripts/daemon-admin-commands.js`、`scripts/daemon-command-router.js`
3. 再看执行链路：`scripts/daemon-claude-engine.js` → `scripts/mentor-engine.js`
4. 最后看离线任务：`scripts/distill.js`、`scripts/memory-extract.js`、`scripts/memory-nightly-reflect.js`

## 同步提示

- 每次改 `scripts/` 后执行：`npm run sync:plugin`
- plugin 镜像路径：`plugin/scripts/*`
