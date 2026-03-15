# MetaMe 脚本/文档指针地图

> 目的：回答"这段能力在哪个文件""当前升级做到哪一步""先看哪个脚本"。

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
    `/agent soul [repair|edit]`；`pendingActivations` 无 TTL（消费即删）；防止创建群自激活；
    `/agent new team` 三步向导（name → members → cwd）；
    `/agent-team-dir` 回调处理目录选择并最终写入 daemon.yaml `team` 段；
    `pendingTeamFlows` Map 维护向导中间状态

- 路由与 Agent 创建：
  - `scripts/daemon-command-router.js`
  - `scripts/daemon-agent-tools.js`
  - 关键点：自然语言提取 `codex` 关键词；默认 `claude` 不写 `engine` 字段，仅 `codex` 持久化 `engine: codex`；
    `bindAgentToChat()` 自动调用 `ensureAgentMetadata()` 建立 soul 层；
    `_detectTeamIntent()` 自然语言意图识别（含负样本过滤），识别"建团队"意图后自动路由到 `/agent new team` 向导

- 会话命令与兼容边界：
  - `scripts/daemon-exec-commands.js`
  - 关键点：`/stop` 引擎中性；`/compact` 在 codex 会话返回"暂不支持"

- 运行时引擎切换与诊断：
  - `scripts/daemon-admin-commands.js`
  - 关键点：`/engine` 切换默认引擎；`/doctor` 按默认引擎检查 CLI 可用性（Claude/Codex）并兼容自定义 provider 模型名

## 团队 Dispatch 与跨设备通信定位

- 共享 Dispatch 工具：
  - `scripts/daemon-team-dispatch.js`
  - 关键点：`resolveProjectKey()` 名称/昵称解析（含 team member `parent/member` 复合键）；
    `findTeamMember()` 文本前缀匹配团队成员昵称；
    `buildTeamRosterHint()` 生成团队上下文块（远端成员自动带 `peer:key` 前缀）；
    `buildEnrichedPrompt()` 注入共享上下文（now.md + _latest.md + inbox）

- 远端 Dispatch 协议：
  - `scripts/daemon-remote-dispatch.js`
  - 关键点：`normalizeRemoteDispatchConfig()` 解析 `feishu.remote_dispatch` 配置；
    `parseRemoteTargetRef()` 解析 `peer:project` 格式；
    `encodePacket()`/`decodePacket()` Base64 + HMAC-SHA256 编解码；
    `verifyPacket()` 签名验证；
    `isDuplicate()` 5 分钟 TTL 去重；
    `isRemoteMember()` 检测 `member.peer` 字段

- Daemon 远端 Dispatch 入口：
  - `scripts/daemon.js`
  - 关键点：`sendRemoteDispatch()` 构造签名 packet → 飞书 bot 发 relay 群；
    `handleRemoteDispatchMessage()` 接收端逻辑（decode → verify → dedup → 按 type 路由）；
    `remote-pending.jsonl` drain（heartbeat 中处理 dispatch_to CLI 写入的远端队列）

- Bridge 集成：
  - `scripts/daemon-bridges.js`
  - 关键点：Feishu bridge `startReceiving` 回调最前面拦截 relay 群消息 → `handleRemoteDispatchMessage`；
    `_dispatchToTeamMember` 检测 `isRemoteMember(member)` → 走 `sendRemoteDispatch` 而非本地 handleCommand

- Dispatch CLI：
  - `scripts/bin/dispatch_to`
  - 关键点：支持 `peer:project` 格式 → `sendRemoteViaRelay()`；
    `--team` broadcast 自动分流远端成员写 `remote-pending.jsonl`；
    本地走 Unix socket / `pending.jsonl` 降级

- 管理命令：
  - `scripts/daemon-admin-commands.js`
  - 关键点：`/dispatch peers` 查看远端配置；
    `/dispatch to peer:project` 手动远端派发；
    按昵称解析到远端 member 时自动走 `sendRemoteDispatch`

- Intent Hook：
  - `scripts/hooks/team-context.js`
  - 关键点：检测通信意图 → 注入 dispatch_to 命令提示；远端成员自动带 `peer:key` 前缀

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
- Dispatch 队列：`~/.metame/dispatch/pending.jsonl`（本地 socket 降级）
- 远端 Dispatch 队列：`~/.metame/dispatch/remote-pending.jsonl`（跨设备中继）
- 共享进度白板：`~/.metame/memory/now/shared.md`
- Agent 最新产出：`~/.metame/memory/agents/{key}_latest.md`
- Agent 收件箱：`~/.metame/memory/inbox/{key}/`（未读），`read/`（已归档）
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
4. 团队/跨设备：`scripts/daemon-team-dispatch.js` → `scripts/daemon-remote-dispatch.js` → `scripts/daemon-bridges.js`
5. 最后看离线任务：`scripts/distill.js`、`scripts/memory-extract.js`、`scripts/memory-nightly-reflect.js`

## 同步提示

- 每次改 `scripts/` 后执行：`npm run sync:plugin`
- plugin 镜像路径：`plugin/scripts/*`
