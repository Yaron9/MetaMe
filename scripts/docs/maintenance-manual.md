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

- 引擎 runtime 工厂：`scripts/daemon-engine-runtime.js`
- 会话执行入口：`scripts/daemon-claude-engine.js`（Claude/Codex 共用）
- Session 回写：`patchSessionSerialized()` 串行化，避免 thread.started 竞态覆盖

### Codex 会话策略

- 首轮：`codex exec --json -`
- 续轮：`codex exec resume <thread_id> --json -`
- `resume` 失败自动重试：同一 `chatId` 在 10 分钟内最多 1 次
- 收到新 `thread_id` 时自动迁移 session id

## 4. 命令行为差异

- `/stop`：引擎中性，按 `activeProcesses.killSignal` 停止
- `/compact`：
  - Claude 会话：正常压缩
  - Codex 会话：返回“暂不支持，请继续同会话”
- `/engine`：
  - 查询当前默认引擎：`/engine`
  - 切换默认引擎：`/engine claude` 或 `/engine codex`
- `/distill-model`：
  - 查询当前蒸馏模型：`/distill-model`
  - 设置蒸馏模型：`/distill-model gpt-5.1-codex-mini`
  - 也支持严格自然语言：`把蒸馏模型改成 5.1mini`
- `/doctor`：
  - 同时检查 Claude/Codex CLI 可用性
  - 仅在“当前默认引擎对应 CLI 不可用”时判为故障
  - 自定义 provider 下允许任意合法模型名（不再强制 sonnet/opus/haiku）

## 5. Agent Soul 身份层

- 集中存储：`~/.metame/agents/<agent_id>/`（soul.md、memory-snapshot.md、agent.yaml）
- 项目视图：`<cwd>/SOUL.md`、`<cwd>/MEMORY.md` 是指向集中存储的链接
- Claude：`@SOUL.md` 写入 CLAUDE.md 头部，CLI 每次 session 自动加载（引用式，改源文件立即生效）
- Codex：每次新 session 合并 CLAUDE.md + SOUL.md 写入 `<cwd>/AGENTS.md`（快照式，需新 session 生效）
- 老项目迁移：`/agent soul repair` 幂等补建 soul 层
- 注意：Windows 上 copy 模式的 SOUL.md 不会自动同步源文件变更，需 `/agent soul repair` 刷新

## 6. 运行时文件与状态

- 配置：`~/.metame/daemon.yaml`
- daemon 状态：`~/.metame/daemon_state.json`
- 活跃子进程：`~/.metame/active_agent_pids.json`
- 热重载备份：`~/.metame/.last-good/`（daemon 稳定运行 60s 后自动备份）
- 崩溃计数：`~/.metame/.crash-count`（连续 2 次快速崩溃触发自动恢复）

## 7. 热重载安全机制（三层防护）

1. **部署前预检**（`index.js`）：`node -c` 语法检查所有 `.js`，不通过则拒绝部署到 `~/.metame/`
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

## 9. 双平台/双引擎维护矩阵

### 统一维护（改一处即可）
- agent-layer.js / daemon-agent-tools.js / daemon-agent-commands.js / daemon-user-acl.js
- ENGINE_MODEL_CONFIG（daemon-engine-runtime.js 集中管理）
- daemon-runtime-lifecycle.js 的语法检查和备份机制

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
```

### 路由规则（按优先级）

1. **引用回复** → 路由到原 agent + 设置 sticky
2. **显式昵称**（如"乙 帮我查下"）→ 路由到对应成员 + 设置 sticky
3. **主项目昵称**（如"贾维斯"）→ 清除 sticky，路由到主项目
4. **Sticky**：无昵称时 → 路由到上次显式指定的成员
5. **Auto-dispatch**：主忙时自动分配给空闲的 `auto_dispatch` 成员

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

## 11. 私人配置保护

- `daemon.yaml` 是用户私人配置，包含 API keys、chat IDs、个人项目配置
- **绝不上传**到代码仓库，已加入 `.gitignore`
- 仓库只追踪 `scripts/daemon-default.yaml`（模板文件）
- 部署流程（`node index.js`）不会覆盖用户的 `~/.metame/daemon.yaml`
- 同样不应上传的文件：`MEMORY.md`、`SOUL.md`、`.env*`
- Agent 在执行任务时，**绝不能** `cp scripts/daemon.yaml ~/.metame/daemon.yaml`，这会覆盖用户私人配置

## 12. 变更后维护动作

1. `npm test`
2. `npm run sync:plugin`
3. 更新文档：
   - `scripts/docs/pointer-map.md`
   - `README.md`
   - `README中文版.md`
