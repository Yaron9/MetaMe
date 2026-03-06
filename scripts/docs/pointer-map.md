# MetaMe 脚本/文档指针地图

> 目的：回答“这段能力在哪个文件”“当前升级做到哪一步”“先看哪个脚本”。

## 快速入口

- 主入口：`index.js`
- CLI 双入口：`metame`（Claude）/`metame codex [args]`（Codex）
- Daemon 主循环：`scripts/daemon.js`
- 多引擎 runtime 适配层：`scripts/daemon-engine-runtime.js`
- 会话执行引擎（Claude/Codex 共用入口）：`scripts/daemon-claude-engine.js`
- 管理命令：`scripts/daemon-admin-commands.js`
- 命令路由：`scripts/daemon-command-router.js`
- 执行命令（`/stop`、`/compact` 等）：`scripts/daemon-exec-commands.js`
- 会话存储：`scripts/daemon-session-store.js`
- 默认配置：`scripts/daemon-default.yaml`
- Provider/蒸馏模型配置：`scripts/providers.js`（`/provider`、`/distill-model`）
- 跨平台基础设施：`scripts/platform.js`（`killProcessTree`、`socketPath`、`sleepSync`、`icon`）
- 热重载安全机制：`scripts/daemon-runtime-lifecycle.js`（语法预检、last-good 备份、crash-loop 自愈）
- 维护手册：`scripts/docs/maintenance-manual.md`

## 多引擎（Claude/Codex）定位

- Runtime 工厂与事件归一化：
  - `scripts/daemon-engine-runtime.js`
  - 关键点：`normalizeEngineName()`、`buildClaudeArgs()`、`buildCodexArgs()`、`parseCodexStreamEvent()`

- 会话与引擎选择：
  - `scripts/daemon-claude-engine.js`
  - 关键点：`askClaude()` 按 `project.engine`/session 选择 runtime；`patchSessionSerialized()` 串行回写 session
  - Codex 规则：`exec`/`resume`、10 分钟窗口内一次自动重试、`thread_id` 迁移回写

- Agent Soul 身份层（新）：
  - `scripts/agent-layer.js`
  - 关键点：`ensureAgentLayer()` 创建 `~/.metame/agents/<id>/`（soul.md、memory-snapshot.md、agent.yaml）；
    `createLinkOrMirror()` Windows 兼容（symlink → hardlink → copy 降级）；
    `ensureClaudeMdSoulImport()` 在 CLAUDE.md 头部注入 `@SOUL.md`（Claude CLI 自动加载）；
    Codex 引擎在每次新 session 时将 CLAUDE.md + SOUL.md 合并写入 AGENTS.md（见 daemon-claude-engine.js:957）；
    `repairAgentLayer()` 懒迁移：老项目补建 soul 层，幂等安全

- Agent 命令处理（新）：
  - `scripts/daemon-agent-commands.js`
  - 关键点：`createAgentCommandHandler()` 处理 `/agent`、`/activate`、`/resume`；
    `/agent soul [repair|edit]`；`pendingActivations` 无 TTL（消费即删）；防止创建群自激活

- 路由与 Agent 创建：
  - `scripts/daemon-command-router.js`
  - `scripts/daemon-agent-tools.js`
  - 关键点：自然语言提取 `codex` 关键词；默认 `claude` 不写 `engine` 字段，仅 `codex` 持久化 `engine: codex`；
    `bindAgentToChat()` 自动调用 `ensureAgentMetadata()` 建立 soul 层

- 会话命令与兼容边界：
  - `scripts/daemon-exec-commands.js`
  - 关键点：`/stop` 引擎中性；`/compact` 在 codex 会话返回“暂不支持”

- 运行时引擎切换与诊断：
  - `scripts/daemon-admin-commands.js`
  - 关键点：`/engine` 切换默认引擎；`/doctor` 按默认引擎检查 CLI 可用性（Claude/Codex）并兼容自定义 provider 模型名

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
- 进程 PID 记录：`~/.metame/active_agent_pids.json`
- 夜间反思文档：`~/.metame/memory/decisions/`、`~/.metame/memory/lessons/`
- 知识胶囊：`~/.metame/memory/capsules/`
- 复盘文档：`~/.metame/memory/postmortems/`
- **Agent Soul 层**：`~/.metame/agents/<agent_id>/`
  - `agent.yaml` — id / name / engine / aliases
  - `soul.md` — 身份定义（主文件，项目目录的 SOUL.md 是其链接）
  - `memory-snapshot.md` — 近期记忆快照（注入 session prompt）
  - 项目视图：`<cwd>/SOUL.md`（symlink/hardlink/copy）、`<cwd>/MEMORY.md`（同）
  - `<cwd>/AGENTS.md` — Codex 专用，每次新 session 由 daemon 合并 CLAUDE.md + SOUL.md 写入

## 诊断顺序（推荐）

1. 先看配置：`~/.metame/daemon.yaml` 与 `scripts/daemon-default.yaml`
2. 再看命令入口：`scripts/daemon-admin-commands.js`、`scripts/daemon-command-router.js`、`scripts/daemon-exec-commands.js`
3. 再看执行链路：`scripts/daemon-engine-runtime.js` → `scripts/daemon-claude-engine.js` → `scripts/mentor-engine.js`
4. 最后看离线任务：`scripts/distill.js`、`scripts/memory-extract.js`、`scripts/memory-nightly-reflect.js`

## 同步提示

- 每次改 `scripts/` 后执行：`npm run sync:plugin`
- plugin 镜像路径：`plugin/scripts/*`
