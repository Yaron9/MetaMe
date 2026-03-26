# MetaMe 维护手册（Claude/Codex 双引擎）

> 适用范围：`scripts/daemon.js` 后台 daemon 链路（飞书/Telegram 路由、会话执行、Agent 绑定）。

## 1. 引擎路由规则

### 手机端（daemon 生效）

- 路由入口：`chat_agent_map -> project -> project.engine`
- `project.engine` 可选值：`claude`（默认）/`codex`
- 未配置 `engine` 时等价 `claude`

示例：

```yaml
projects:
  reviewer:
    name: "Reviewer"
    cwd: "~/AGI/MetaMe"
    engine: codex

feishu:
  chat_agent_map:
    "oc_xxx": "reviewer"
```

### 电脑端（CLI）

- Claude 入口：`metame`（等价启动 Claude + MetaMe 初始化）
- Codex 入口：`metame codex [args]`
- 也可直接用原生命令：`claude` / `codex`

## 2. Agent 创建与引擎写入

- 默认创建 Agent：不写 `engine` 字段（保持兼容）
- 创建语句中包含 `codex` 关键词：写入 `engine: codex`
- 绑定语句包含 `codex` 时同样支持写入 `engine: codex`

示例：

- `创建一个 codex agent，目录是 ~/projects/reviewer`
- `用 codex 建个代码审查 agent，目录 ~/projects/pr-review`

## 3. 会话与执行规则

- Runtime 工厂：`daemon-engine-runtime.js`
- 执行编排：`daemon-claude-engine.js`，streaming 纯逻辑委托 `core/handoff.js`（引擎中性），审计状态在 `core/audit.js`
- 架构纪律见 CLAUDE.md「代码架构纪律（Unix 哲学）」

### Codex 会话策略

- 首轮：`codex exec --json -`
- 续轮：`codex exec resume <thread_id> --json -`
- `resume` 失败自动重试：同一 `chatId` 在 10 分钟内最多 1 次

## 4. 命令行为差异

- `/stop`：引擎中性，按 `activeProcesses.killSignal` 停止
- `/compact`：
  - Claude 会话：正常压缩
  - Codex 会话：返回"暂不支持，请继续同会话"
- `/engine`：
  - 查询当前默认引擎：`/engine`
  - 切换默认引擎：`/engine claude` 或 `/engine codex`
- `/distill-model`：
  - 查询当前蒸馏模型：`/distill-model`
  - 设置蒸馏模型：`/distill-model gpt-5.1-codex-mini`
  - 也支持严格自然语言：`把蒸馏模型改成 5.1mini`
- `/doctor`：
  - 同时检查 Claude/Codex CLI 可用性
  - 仅在"当前默认引擎对应 CLI 不可用"时判为故障
  - 自定义 provider 下允许任意合法模型名（不再强制 sonnet/opus/haiku）

## 5. Agent Soul 身份层

- 集中存储：`~/.metame/agents/<agent_id>/`（soul.md、memory-snapshot.md、agent.yaml）
- 项目视图：`<cwd>/SOUL.md`、`<cwd>/MEMORY.md` 是指向集中存储的链接
- Claude：`@SOUL.md` 写入 CLAUDE.md 头部，CLI 每次 session 自动加载（引用式，改源文件立即生效）
- Codex：每次新 session 合并 CLAUDE.md + SOUL.md 写入 `<cwd>/AGENTS.md`（快照式，需新 session 生效）
- 老项目迁移：`/agent soul repair` 幂等补建 soul 层
- 注意：Windows 上 copy 模式的 SOUL.md 不会自动同步源文件变更，需 `/agent soul repair` 刷新

## 6. 运行时文件与状态

- 源码目录：`scripts/`
- 运行副本目录：`~/.metame/`（由 `node index.js` 部署生成，只读看状态，不直接改）
- 配置：`~/.metame/daemon.yaml`
- daemon 状态：`~/.metame/daemon_state.json`
- 活跃子进程：`~/.metame/active_agent_pids.json`
- 热重载备份：`~/.metame/.last-good/`（daemon 稳定运行 60s 后自动备份）
- 崩溃计数：`~/.metame/.crash-count`（连续 2 次快速崩溃触发自动恢复）
- Dispatch 队列：`~/.metame/dispatch/pending.jsonl`（本地 socket 降级）
- 远端 Dispatch 队列：`~/.metame/dispatch/remote-pending.jsonl`（跨设备中继）
- Dispatch 签名密钥：`~/.metame/.dispatch_secret`（自动创建）
- 自动更新策略：发布版 npm 安装默认开启；源码 checkout / `npm link` 默认关闭，可用 `METAME_AUTO_UPDATE=on|off` 覆盖

说明：
- `daemon_state.json` 仍保存 session 元数据（如 `last_active`），用于路由、恢复和状态判断。
- 不再缓存或注入“闲置后恢复摘要”；如果需要压缩上下文，只走显式 `/compact`。

## 7. 热重载安全机制（三层防护）

1. **部署前预检**（`index.js`）：`node -c` 语法检查所有 `.js`，不通过则拒绝以 copy 模式部署到 `~/.metame/`
2. **重启前预检**（`daemon-runtime-lifecycle.js`）：daemon.js 变更触发重启前再次语法校验，不通过则阻止重启并通知 admin
3. **崩溃循环自愈**：连续 2 次在 30s 内崩溃 → 自动从 `.last-good/` 恢复 → 通知 admin

## 8. 常见故障排查

### Codex 认证失败

症状：返回 `AUTH_REQUIRED`

处理：

1. 执行 `codex login`
2. 或配置 `OPENAI_API_KEY`
3. 重新发送同一条消息

### Codex 频率限制

症状：返回 `RATE_LIMIT`

处理：

1. 等待限流窗口恢复
2. 降低并发或切回 Claude 路由

### 会话续接异常

症状：Codex `resume` 报错后反复失败

处理：

1. daemon 已自动做一次 fresh `exec` 重试
2. 若仍失败，手动 `/new` 新开会话
3. 检查 `~/.metame/active_agent_pids.json` 是否残留异常进程

### 远端 Dispatch 失败

症状：`/dispatch to peer:project` 返回 `feishu bot not connected`

处理：

1. 确认 `daemon.yaml` 中 `feishu.remote_dispatch.enabled: true` 且 `self`/`chat_id`/`secret` 非空
2. 确认飞书 bot 已连接：`/doctor` 查看飞书状态
3. 确认 relay 群已加入 `allowed_chat_ids`（relay 群消息需被 daemon 接收）
4. 两端的 `secret` 必须完全一致

## 9. 双平台/双引擎维护矩阵

### 统一维护（改一处即可）
- **core/handoff.js**（引擎中性、平台中性的纯逻辑，通过参数接收平台/引擎差异）
- **core/audit.js**（纯状态管理，无平台差异）
- agent-layer.js / daemon-agent-tools.js / daemon-agent-commands.js / daemon-user-acl.js
- ENGINE_MODEL_CONFIG（daemon-engine-runtime.js 集中管理）
- daemon-runtime-lifecycle.js 的语法检查和备份机制
- daemon-remote-dispatch.js（纯逻辑，无平台差异）
- daemon-team-dispatch.js（共享解析/hint/enrichment）

### 需分别维护（有平台/引擎特殊分支）

| 模块 | 差异点 | 注意事项 |
|------|--------|----------|
| platform.js `killProcessTree` | POSIX: `kill(-pid)` / Windows: `taskkill /T /F` | 所有进程杀死调用点应统一使用此函数 |
| daemon-engine-runtime.js `resolveBinary` | macOS: `which` + homebrew / Windows: `where` + `.cmd` | 新增引擎需两端测试 |
| daemon-engine-runtime.js `buildArgs` | Claude: `--resume`/`--continue` / Codex: `exec resume`，Codex resume 不能传权限 flag | 改参数结构时两端验证 |
| daemon-claude-engine.js Soul 注入 | Claude: `@SOUL.md` import（引用式）/ Codex: AGENTS.md 合并写入（快照式） | 改 soul 加载方式需两端测试 |
| agent-layer.js `createLinkOrMirror` | macOS: symlink / Windows: hardlink → copy 降级 | copy 模式不会自动同步源文件变更 |
| daemon.js `spawnReplacementDaemon` | POSIX: `detached: true` / Windows: `detached: false` | 改 spawn 参数时注意平台分支 |
| NL Mac 控制（command-router） | macOS only，`process.platform === 'darwin'` 守卫 | Windows 天然跳过 |

## 10. 团队路由（Team Routing）

### 概念

一个项目可以有多个 team 成员（数字分身），共享同一个 `cwd`，通过虚拟 chatId 并行工作。

### 创建团队成员（向导）

在手机端（飞书/Telegram）发送以下任一方式触发创建向导：

- 自然语言：`创建团队`、`新建工作组`、`建个团队` 等（`_detectTeamIntent` 识别，位于 `daemon-command-router.js`）
- 命令：`/agent new team`

向导分三步，全部在 `daemon-agent-commands.js` 中实现：
1. **name**：输入团队名称
2. **members**：输入成员列表，格式 `名称:icon:颜色`，一行或逗号分隔多个
3. **cwd**：通过文件浏览器（`daemon-file-browser.js` `team-new` 模式）选择父目录

目录确认（`/agent-team-dir` 回调）后：
- 在 `<父目录>/team/<成员key>/` 下创建工作目录及 CLAUDE.md
- 自动执行 `git init`（支持 checkpoint）
- 若父目录对应已有项目，自动写入 `daemon.yaml` 的 `team` 数组；否则提示手动注册

中间状态保存在 `pendingTeamFlows` Map（`daemon.js` 中定义）。

### 配置

在 `~/.metame/daemon.yaml` 的项目下添加 `team` 数组和 `broadcast: true`：

```yaml
  metame:
    name: 超级总管 Jarvis
    icon: 🤖
    broadcast: true
    team:
      - key: jia
        name: Jarvis · 甲
        icon: 🤖
        color: green
        cwd: ~/AGI/MetaMe
        nicknames:
          - 甲
        auto_dispatch: true
      - key: hunter
        name: 猎手
        icon: 🎯
        peer: windows          # ← 远端成员，运行在 Windows 设备上
        nicknames:
          - 猎手
```

### 路由规则（按优先级）

1. **引用回复** → 路由到原 agent + 设置 sticky
2. **显式昵称**（如"乙 帮我查下"）→ 路由到对应成员 + 设置 sticky
3. **主项目昵称**（如"贾维斯"）→ 清除 sticky，路由到主项目
4. **Sticky**：无昵称时 → 路由到上次显式指定的成员
5. **Auto-dispatch**：主忙时自动分配给空闲的 `auto_dispatch` 成员

**远端成员**：检测到 `member.peer` 时，bridges 自动走 `sendRemoteDispatch()` → relay 群 → 对端 daemon 接收执行，结果通过 relay 群回传。路由优先级不变，只是传输链路不同。

### /stop 精准路由

- `/stop 乙`：停止指定成员
- `/stop`：停止 sticky 成员
- 引用回复 `/stop`：停止对应成员

### /msg — 团队直接消息

格式：`/msg <agent昵称> <消息内容>`

- 例如：`/msg 乙 帮我看看这个文件`
- 按昵称解析目标（先查 team 成员，再查 projects）
- 以 `type='message', priority='normal'` 调度
- 实现文件：`daemon-admin-commands.js` resolveProjectKey 函数

### Team Broadcast（团队广播 = 可观察模式）

`broadcast: true` 时，team 成员之间通过 `dispatch_to` 互发消息会在群里用卡片广播。

**这就是"观察模式"**：开启 broadcast 后，你在群里可以实时看到成员之间互相传递任务的全过程（哪个成员发给了哪个成员、发了什么内容），以飞书卡片形式展示。

切换命令：`/broadcast on` / `/broadcast off`（实时生效，写入 daemon.yaml）

实现入口：`daemon.js` `_findTeamBroadcastContext()` + `handleDispatchItem()` 的广播分支。

### 虚拟 chatId

team 成员使用 `_agent_{key}` 格式的虚拟 chatId，与物理群 chatId 隔离。

### 卡片标题

由 `icon + name` 拼成，如 `🤖 Jarvis · 乙`。

## 11. 跨设备 Dispatch（Remote Peer Dispatch）

### 概念

team 成员可以通过 `peer` 字段标记为"远端成员"——运行在另一台机器上的 daemon。用户在飞书群里对远端成员的操作体验与本地成员完全一致（昵称路由、sticky follow 等），底层通过飞书 relay 群实现跨设备通信。

### 配置

两台设备的 `daemon.yaml` 需要配置相同的 relay 群和共享密钥，不同的 `self` 标识；但不能共用同一个飞书 bot。每台机器都必须使用自己独立的飞书应用 / bot 凭据。

```yaml
# Mac 端
feishu:
  remote_dispatch:
    enabled: true
    self: mac                    # 本机标识（唯一）
    chat_id: oc_relay_xxx        # 专用中继群（两端相同）
    secret: shared-secret-key    # HMAC 签名密钥（两端相同）

# Windows 端
feishu:
  remote_dispatch:
    enabled: true
    self: windows
    chat_id: oc_relay_xxx        # 同一个 relay 群
    secret: shared-secret-key    # 同一个密钥
```

注意：

- 可以共用同一个 relay 群。
- 可以共用同一个 `secret`。
- 不能共用同一个飞书 bot / `app_id` / `app_secret`。
- 原因是飞书对同一 bot 的事件投递可能随机落到任一在线客户端；而当前代码在收到 `to_peer !== self` 的 relay 包时会直接忽略，错误机器会把包吞掉。

team 成员添加 `peer` 字段指向远端设备：

```yaml
projects:
  business:
    team:
      - key: writer
        name: 编剧              # 无 peer → 本地执行
      - key: hunter
        name: 猎手
        peer: windows            # 远端设备
```

### 数据流

#### 用户消息 → 远端 team member

```
飞书群消息 "猎手 去调研竞品"
→ bridges.js findTeamMember → { member: { key:'hunter', peer:'windows' } }
→ _dispatchToTeamMember 检测 member.peer
→ sendRemoteDispatch → encodePacket + HMAC 签名 → relay 群
→ Windows daemon bridges 拦截 → decodePacket + verifyPacket + isDuplicate
→ handleDispatchItem(local) → Claude 执行
→ _replyFn → encode result → relay 群
→ Mac daemon 拦截 → decode → sendMarkdown 到用户飞书群
```

#### Claude session 内跨设备 dispatch

```
Claude 看到 hook 注入:
  - hunter（猎手 [远端:windows]）: `dispatch_to --from writer windows:hunter "消息"`
→ dispatch_to 解析 peer:project 格式
→ 写 remote-pending.jsonl → daemon heartbeat drain → bot 发 relay 群
→ 对端 daemon 接收执行
```

### Packet 协议

- 前缀：`[METAME_REMOTE_DISPATCH]`
- 编码：Base64(JSON)
- 签名：HMAC-SHA256，payload = packet body 去掉 sig 字段
- 去重：5 分钟 TTL Map，按 packet.id 去重

### 关键模块

| 模块 | 职责 |
|------|------|
| `daemon-remote-dispatch.js` | 编解码、签名验签、去重、配置解析、`parseRemoteTargetRef` |
| `daemon.js:sendRemoteDispatch()` | 构造签名 packet → 通过飞书 bot 发 relay 群 |
| `daemon.js:handleRemoteDispatchMessage()` | 接收端：decode → verify → dedup → 执行或投递结果 |
| `daemon-bridges.js` | Feishu bridge 拦截 relay 群消息 + `_dispatchToTeamMember` 远端分流 |
| `daemon-admin-commands.js` | `/dispatch peers` 查看配置 + `/dispatch to peer:project` 手动派发 |
| `scripts/bin/dispatch_to` | 支持 `peer:project` 格式 → 写 `remote-pending.jsonl` |
| `daemon-team-dispatch.js` | `buildTeamRosterHint()` 为远端成员生成 `peer:key` 格式命令 |
| `hooks/team-context.js` | intent hook 注入远端 `peer:key` dispatch 命令 |

### 管理命令

- `/dispatch peers`：查看远端配置（self peer、relay chat、所有远端成员列表）
- `/dispatch to windows:hunter <任务>`：手动跨设备派发
- `/dispatch to 猎手 <任务>`：按昵称解析，自动检测 `member.peer` 走远端

## 12. 永续任务系统（Perpetual Task Engine）

### 概念

永续任务系统允许任何项目作为 reactive 永续循环运行。Agent 产出信号 → daemon 解析 → 门控检查 → 调度下一步。平台完全领域无关，科研、代码审计、文档维护等任何长期任务均可接入。

### 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| Reactive Lifecycle | `daemon-reactive-lifecycle.js` | 信号解析、budget/depth gate、事件溯源、verifier 调用、state 生成 |
| Event Log | `~/.metame/events/<key>.jsonl` | 唯一 Source of Truth，daemon 独占写入 |
| Manifest | `<cwd>/perpetual.yaml` | 可选项目清单（completion_signal、脚本路径、约束） |
| Reconciliation | `reconcilePerpetualProjects()` | heartbeat 中零 token 停滞检测 |
| Status 命令 | `/status perpetual` | 查看所有永续项目的 phase/depth/mission/status |

### 接入一个新永续项目

1. 在 `daemon.yaml` 中注册项目，添加 `reactive: true`
2. 在项目目录创建 `CLAUDE.md`（定义 agent 行为）
3. 可选：创建 `scripts/verifier.js`（阶段门控）
4. 可选：创建 `perpetual.yaml`（覆盖默认约定）
5. 可选：创建 `scripts/archiver.js` + `scripts/mission-queue.js`（归档与任务队列）

不创建 perpetual.yaml 时，平台使用默认约定：
- Verifier: `scripts/verifier.js`
- Archiver: `scripts/archiver.js`
- Mission Queue: `scripts/mission-queue.js`
- 完成信号: `MISSION_COMPLETE`

### 事件溯源协议

所有状态变更记录在 `~/.metame/events/<projectKey>.jsonl`，一行一个 JSON 事件。`now/<key>.md` 和 `workspace/progress.tsv` 都是 event log 的投影（Projection），可随时从 event log 重建。

Event 类型：`MISSION_START` / `DISPATCH` / `MEMBER_COMPLETE` / `PHASE_GATE` / `DEPTH_LIMIT` / `BUDGET_LIMIT` / `MISSION_COMPLETE` / `ARCHIVE` / `STALE` / `INFRA_PAUSE`

### 设计契约

1. **Tolerant Reader**：`replayEventLog` 逐行解析，损坏行 WARN + skip，绝不 crash
2. **Error Semantic Isolation**：verifier L2b 区分 404（幻觉，打回 agent）和 50x（基建故障，挂起项目通知人类）
3. **State 由 daemon 生成**：agent 只读 `now/<key>.md`，不负责维护

### 故障排查

| 症状 | 检查 |
|------|------|
| 永续项目不启动 | `daemon.yaml` 中是否有 `reactive: true`？ |
| 完成信号不触发 | 检查 `perpetual.yaml` 中的 `completion_signal` 是否与 CLAUDE.md 一致 |
| Verifier 不运行 | 检查 `scripts/verifier.js` 路径（或 manifest 中的自定义路径）是否存在 |
| 项目挂起 (infra_failure) | 外部 API 不可用，检查网络。非 agent 错误。 |
| Event log 损坏 | 重启后 replay 会跳过损坏行。`progress.tsv` 和 `now/<key>.md` 可从 event log 重建 |
| `/status perpetual` 无输出 | 确认项目配置了 `reactive: true` |

## 13. 私人配置保护（原 §12）

- `daemon.yaml` 是用户私人配置，包含 API keys、chat IDs、个人项目配置
- **绝不上传**到代码仓库，已加入 `.gitignore`
- 仓库只追踪 `scripts/daemon-default.yaml`（模板文件）
- 部署流程（`node index.js`）不会覆盖用户的 `~/.metame/daemon.yaml`
- 同样不应上传的文件：`MEMORY.md`、`SOUL.md`、`.env*`
- Agent 在执行任务时，**绝不能** `cp scripts/daemon.yaml ~/.metame/daemon.yaml`，这会覆盖用户私人配置

## 14. 变更后维护动作

1. 测试：
   - `npm test`（全量）
   - 改 `core/handoff.js` 时：`node --test scripts/core/handoff.test.js scripts/daemon-claude-engine.test.js`
   - 改 `daemon.js` 审计相关时：`node --test scripts/daemon-audit.test.js`
2. Lint：`npx eslint scripts/daemon*.js scripts/core/*.js`
3. `npm run sync:plugin`
4. 更新文档：
   - `scripts/docs/pointer-map.md`
   - `scripts/docs/maintenance-manual.md`
   - `README.md` / `README中文版.md`
