# MetaMe Loop Engineering 升级改造规格

> 状态：Proposed
> 日期：2026-06-23
> 修订：v2，已纳入独立架构审查意见
> 范围：MetaMe daemon 的自动化、长期目标、调度、Agent 执行、验证、恢复与观测
> 输入依据：`loop engineering.md` 与当前 `scripts/` 实现

## 1. 结论

MetaMe 不应继续扩展当前“heartbeat task + persistent session + reactive project”三套并行机制。最优升级路径是建立一个统一的 Loop Control Plane：

```text
Trigger -> Goal -> Run -> Agent Runtime -> Verifier -> Transition
   ^                                                   |
   +---------------- next wake / event ----------------+
```

核心原则：

1. **永续的是 Goal，不是进程或 session。** 每个 Run 都是有预算、有截止时间、可恢复的有限执行。
2. **触发器只负责唤醒。** Heartbeat、Cron、Hook、Manual 都转换成统一 WakeEvent，不直接启动模型。
3. **SQLite 是唯一控制面事实源。** 由单一 `control-db.js` 拥有连接、migration 和 transaction；状态文件和 Markdown 只作为可重建投影。
4. **复用原生 Agent 内核。** MetaMe 不解析模型工具协议、不自研上下文压缩；只保存 runtime/thread/session 引用。
5. **完成必须经过独立验证。** Maker 的“完成”只是候选状态，Verifier 才能提交完成或产生下一轮反馈。
6. **原生优先，控制面补位。** 结构化输出、session、sandbox、工具审批和原生子 Agent 优先委托 Claude/Codex；MetaMe 只管理跨运行时生命周期与业务风险。
7. **首版服从单 daemon 现实。** 使用 execution ownership 和崩溃核查，不提前引入分布式 lease/fencing、通用多 Agent DAG 或 Level-4 自动演化。

最终应废弃 `perpetual: true`、`persistent_session` 和 `projects.<key>.reactive` 作为三种不同生命周期语义。它们只保留一段迁移期，统一编译成 Goal、Trigger、Policy。首版最小闭环严格限定为：

```text
Trigger -> Goal -> finite Run -> native Claude/Codex Runtime
        -> deterministic Verifier -> persisted Transition + Outbox
```

## 2. 当前实现核查

### 2.1 已有能力中应保留的部分

| 能力 | 当前位置 | 处理 |
|---|---|---|
| Claude/Codex runtime 归一化 | `scripts/daemon-engine-runtime.js` | 保留并扩成后台 Run 共用的 `AgentRuntimeAdapter` |
| 子进程生命周期和超时 | `scripts/core/handoff.js` | 保留为唯一执行原语，scheduler 不再自行 spawn |
| 任务数据库与事件 | `scripts/task-board.js` | 保留 API；数据库连接与 migration 下沉到唯一 `control-db.js` |
| Task Envelope | `scripts/daemon-task-envelope.js` | 扩展 `goal/run` 关联，继续用于 worker handoff |
| 预算、深度、无信号熔断 | `scripts/daemon-reactive-lifecycle.js` | 提炼为纯 Policy Engine |
| 独立 verifier hook | `scripts/daemon-reactive-lifecycle.js` | 泛化为每个 Goal 可配置的 Verification Contract |
| append-only 事件及投影 | `scripts/daemon-reactive-lifecycle.js` | 事件迁入 SQLite；Markdown/TSV 继续作为投影 |
| worktree 隔离 | `scripts/daemon-worktrees.js` | 作为 Codex/通用 fallback；Claude 可委托原生 worktree capability |
| stale reconciliation | `scripts/daemon-reactive-lifecycle.js` | 改为基于 boot/process/session/workspace 证据的 Reconciler |

### 2.2 当前结构性问题

#### P0：三个状态源表达同一件事

- `daemon_state.json.tasks` 保存 heartbeat 执行结果和 persistent session。
- `daemon_state.json.reactive` 保存永续项目 depth/status。
- `~/.metame/reactive/<key>/events.jsonl` 又保存 mission/phase 状态。
- `task_board.db` 保存 team task/handoff/event，却没有纳入 reactive 生命周期。

结果是状态更新无法原子提交，崩溃恢复必须猜测哪个状态更新得更晚；`progress.tsv`、`state.md`、JSONL、daemon state 之间存在漂移空间。

#### P0：后台调度绕过了现有多引擎 runtime

`scripts/daemon-task-scheduler.js` 内部直接构造 `claude -p` 参数并维护另一套 spawn/watchdog；workflow 同样硬编码 Claude。交互会话已支持 Claude/Codex，但后台自动化没有真正接入同一适配层，造成模型、权限、超时、stream event、resume 语义分叉。

#### P0：所谓“永续”依赖输出文本协议

Reactive loop 通过正则读取 `NEXT_DISPATCH` 和 `MISSION_COMPLETE`。这适合作为兼容输入，不适合作为控制面协议：自然语言漏写、重复写、引用旧文本都可能改变状态。当前 no-signal retry 只能缓解，不能消除歧义。

#### P1：调度、执行、状态记录耦合在单个大模块

`scripts/daemon-task-scheduler.js` 同时负责 schedule 解析、precondition、spawn、session、token 估算、状态写入、通知和 skill evolution；`scripts/daemon-reactive-lifecycle.js` 同时负责 signal、队列、归档、验证、记忆、事件、投影和 dispatch。两者难以共享策略，也难以做 crash-window 测试。

#### P1：恢复语义不够强

- `runningTasks` 是进程内 `Set`，重启后丢失。
- reactive stale 检测依赖 `updated_at` 和 active process 扫描，没有持久化 execution owner、PID、boot id 和恢复证据。
- heartbeat 的下次运行时间主要在内存中，重启后的 catch-up 规则分散。
- 任务状态和外部通知之间没有 transactional outbox，可能“已完成但没通知”或重复通知。

#### P1：worktree 粒度不匹配任务生命周期

当前 worktree 按 actor 长期复用。不同 Goal/Run 可能继承上次未提交修改；也没有正式的 execution ownership、base SHA、dirty check、回收状态和合并门控。代码循环应默认 run 级隔离，而非 actor 级永久目录。

#### P2：配置语义重叠

`heartbeat.tasks`、`projects.*.heartbeat_tasks`、`projects.*.reactive`、`perpetual.yaml`、`persistent_session` 分别承担部分调度、生命周期和验证语义。用户需要理解实现细节才能表达“每天检查一次，发现问题后持续修到验证通过”。

### 2.3 对白皮书建议的取舍

采纳其控制论闭环、四类触发、worktree、adapter、独立 verifier 和 telemetry 思路，但不把文中对 Claude/Codex 私有内部实现的描述作为稳定接口。MetaMe 只依赖 CLI/SDK 对外暴露的 runtime contract；原生 compaction、tool protocol、thread storage 均由后端负责。Manager/Worker 只作为未来跨引擎、跨进程编排能力，不进入首版主线。

另外两点需要收敛：

- Plan-first 不应对所有任务强制人工审批；应由风险策略决定，否则低风险自动化会退化成排队系统。
- Level-4 自我改进不能直接自动改写 system prompt 或 verifier。生产默认只生成 proposal，经离线回放、canary 和人工批准后发布。
- Claude/Codex 已提供结构化最终输出能力；控制面结果必须映射原生 JSON Schema 参数，而不是新造文本协议。

### 2.4 原生能力边界

| 能力 | Claude/Codex 原生职责 | MetaMe 职责 |
|---|---|---|
| session/thread | 创建、resume、内部持久化 | 只保存 engine + session reference |
| context compaction | 后端原生处理 | 不读写 transcript，不自行摘要压缩 |
| tool protocol/events | 后端解析与执行 | 仅消费 runtime 标准事件 |
| structured final output | Claude `--json-schema`、Codex `--output-schema` 或等价 capability | 维护统一 schema 并由 adapter 映射 |
| sandbox/tool approval | 后端权限系统 | 选择最低权限 profile，不复制工具级审批 |
| runtime 内子 Agent | 后端内部调度 | 默认不干预；仅跨进程/跨引擎时用 Task Envelope |
| worktree | 有原生 capability 时由后端创建 | capability 探测、审计和 fallback |
| PR/push/publish/外部写入 | 不表达 MetaMe 业务授权 | Plan hash、人工审批和 outbox 幂等 |

Runtime 启动时应做 capability probe，不把某一 CLI 版本的具体 flag 当成永恒接口；flag 映射集中在 `daemon-engine-runtime.js`。

## 3. 目标与非目标

### 3.1 目标

- 一个数据模型覆盖一次性任务、定时任务、事件任务和长期目标。
- daemon 重启、Mac 睡眠、CLI 退出、网络失败后可确定性恢复。
- Claude 与 Codex 后台任务使用同一控制面和执行契约。
- 每轮执行可追踪输入、预算、workspace、runtime session、产物和 verifier 结果。
- 同一 Goal 不重入；多 Goal 可受控并发。
- 用户可查询、暂停、恢复、取消、立即运行，且状态含义一致。
- 兼容现有配置并允许无停机迁移。

### 3.2 非目标

- 不重写 Claude/Codex 的微观 agent loop、工具解析或上下文压缩。
- 不在首版实现通用分布式队列、完整 lease/fencing 或多 daemon 竞争协议。
- 不在首版实现通用 Manager/Worker DAG；运行时内部子 Agent 使用 Claude/Codex 原生能力，跨进程协作继续复用现有 Task Envelope。
- 不实现第二套工具级 sandbox、approval、session、compaction、worktree 或结构化输出系统。
- 不自动 merge、push、publish 或执行不可逆外部动作；这些仍受现有确认边界约束。

## 4. 统一领域模型

### 4.1 四层对象

#### Automation

定义“何时检查”，不定义任务进度。

```yaml
id: repo-health-wake
trigger:
  type: cron                 # cron | interval | event | manual
  expression: "0 9 * * 1-5"
  timezone: Asia/Shanghai
  misfire_policy: run_once   # skip | run_once | catch_up
goal_id: repo-health
coalesce: true
```

Heartbeat 不再是业务任务类型，而是一个低成本 interval trigger；生理 heartbeat 只做 daemon liveness 和队列 drain。

#### Goal

定义“最终要达到什么状态”。Goal 可以长期存在，但必须有明确完成合约和停止策略。

```yaml
id: repo-health
title: 保持 MetaMe 主干健康
objective: 发现回归后修复，直到所有必需检查通过
mode: continuous             # once | recurring | continuous
definition_of_done:
  - required tests pass
  - eslint has zero errors
owner: personal
target:
  project: metame
  cwd: ~/AGI/MetaMe
execution:
  engine: codex
  model: auto
  workspace: auto             # auto | none | directory | worktree
verification:
  command: node scripts/ops-verifier.js
policy:
  max_attempts_per_run: 3
  max_turns_per_run: 20
  max_wall_time: 45m
  daily_token_budget: 200000
  approval: risk_based
  cooldown_after_failure: 2h
```

#### Run

一次由 WakeEvent 创建的有限执行。Run 是恢复、预算、worktree 和通知的基本单元。

```text
queued -> planning -> awaiting_approval -> executing -> verifying
   |          |              |                |            |
   +-------> skipped      cancelled        blocked      succeeded
                                                   \-> retry_wait
                                                   \-> failed
```

`continuous` 不是 Run 的状态。一个 continuous Goal 在 Run 结束后，由 transition policy 决定 `wait`、`retry_at`、`complete` 或 `pause`。

#### Attempt

Run 内的一次 maker→verifier 尝试。Verifier 失败产生结构化 feedback，下一 Attempt 可以 resume 同一 runtime session；新 Run 默认 fresh session，避免跨天上下文污染。

### 4.2 状态与事件

Goal 状态：`active | paused | completed | cancelled | archived`。
Run 状态：`queued | planning | awaiting_approval | executing | verifying | awaiting_review | retry_wait | succeeded | failed | blocked | cancelled | skipped`。

所有变更通过命令函数在一个 SQLite transaction 中同时写：

1. 当前状态行；
2. append-only `loop_events`；
3. 需要执行的 `outbox` 消息。

禁止调用方直接写 status 字段。状态机拒绝非法转换，并使用 `version` 做 optimistic concurrency。

### 4.3 SQLite schema 与数据库所有权

在现有 `task_board.db` 上迁移，避免再造第四个状态库。新增 `scripts/control-db.js` 作为**唯一数据库 owner**，独占连接创建、PRAGMA、migration 和 transaction。`task-board.js` 与 `loop-store.js` 只能通过显式传入的 control DB 访问数据，禁止各自隐藏创建连接；这样 Goal/Run 与 task/handoff 才能原子提交。

```sql
CREATE TABLE goals (
  goal_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  project_key TEXT,
  cwd TEXT,
  execution_spec TEXT NOT NULL,
  verification_spec TEXT NOT NULL,
  policy_spec TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE automations (
  automation_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_spec TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_fire_at TEXT,
  last_fire_at TEXT,
  FOREIGN KEY(goal_id) REFERENCES goals(goal_id)
);

CREATE TABLE wake_events (
  wake_id TEXT PRIMARY KEY,
  automation_id TEXT,
  goal_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  coalesce INTEGER NOT NULL DEFAULT 1,
  attached_run_id TEXT,
  disposition TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  FOREIGN KEY(goal_id) REFERENCES goals(goal_id),
  FOREIGN KEY(automation_id) REFERENCES automations(automation_id),
  FOREIGN KEY(attached_run_id) REFERENCES runs(run_id)
);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  primary_wake_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempt_no INTEGER NOT NULL DEFAULT 0,
  execution_boot_id TEXT,
  execution_pid INTEGER,
  execution_started_at TEXT,
  execution_heartbeat_at TEXT,
  workspace_id TEXT,
  base_revision TEXT,
  result TEXT NOT NULL DEFAULT '{}',
  last_error TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY(goal_id) REFERENCES goals(goal_id),
  FOREIGN KEY(primary_wake_id) REFERENCES wake_events(wake_id)
);

CREATE UNIQUE INDEX one_active_run_per_goal
ON runs(goal_id)
WHERE status IN ('queued','planning','awaiting_approval','executing','verifying','awaiting_review','retry_wait');

CREATE TABLE run_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  runtime_engine TEXT NOT NULL,
  runtime_session_id TEXT,
  input_summary TEXT NOT NULL DEFAULT '{}',
  maker_result TEXT NOT NULL DEFAULT '{}',
  verifier_result TEXT NOT NULL DEFAULT '{}',
  verification_spec_hash TEXT NOT NULL DEFAULT '',
  workspace_revision TEXT NOT NULL DEFAULT '',
  error_class TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(run_id, attempt_no),
  FOREIGN KEY(run_id) REFERENCES runs(run_id)
);

CREATE TABLE run_plans (
  plan_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  plan_body TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  UNIQUE(run_id, plan_hash),
  FOREIGN KEY(run_id) REFERENCES runs(run_id)
);

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  action_scope TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, plan_hash, action_scope),
  FOREIGN KEY(run_id) REFERENCES runs(run_id),
  FOREIGN KEY(run_id, plan_hash) REFERENCES run_plans(run_id, plan_hash)
);

CREATE TABLE usage_ledger (
  usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT NOT NULL,
  run_id TEXT,
  attempt_id TEXT,
  engine TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY(goal_id) REFERENCES goals(goal_id),
  FOREIGN KEY(run_id) REFERENCES runs(run_id),
  FOREIGN KEY(attempt_id) REFERENCES run_attempts(attempt_id)
);

CREATE TABLE loop_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT NOT NULL,
  run_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(goal_id) REFERENCES goals(goal_id),
  FOREIGN KEY(run_id) REFERENCES runs(run_id)
);

CREATE TABLE outbox (
  outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT,
  run_id TEXT,
  topic TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  available_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(goal_id) REFERENCES goals(goal_id),
  FOREIGN KEY(run_id) REFERENCES runs(run_id)
);
```

首版必须启用 `foreign_keys`、WAL 和 busy timeout。`wake_events` 保存原始 payload，支持多个 WakeEvent coalesce 到一个 active Run；不能只把 wake key 塞在 `runs` 中。

现有 `tasks/handoffs/task_events` 保留。新增 nullable `goal_id`、`run_id`，因为交互式 team dispatch 不一定属于 Goal Run；只有 Loop 触发的跨进程工作才建立关联。数据库 schema migration 必须先备份、幂等且可由旧代码安全忽略。

## 5. 目标架构

```text
┌──────────────── Trigger Adapters ────────────────┐
│ interval/cron │ event (P2) │ manual │ recovery │
└──────────────────────┬───────────────────────────┘
                       v
                 WakeEvent Inbox
                 (dedupe/coalesce)
                       |
                       v
┌──────────────── Loop Control Plane ───────────────────────────┐
│ GoalStore │ StateMachine │ PolicyEngine │ Owner │ Outbox      │
│ Reconciler│ RunCoordinator│ ProjectionBuilder │ Telemetry     │
└───────┬──────────────┬───────────────┬───────────────┬────────┘
        |              |               |               |
        v              v               v               v
 WorkspaceBroker  RuntimeAdapter  VerifierAdapter  Notifier
 (worktree/none)  (Claude/Codex)  (command/agent)  (Feishu/...)
```

### 5.1 模块边界

新增纯逻辑模块，遵守 `scripts/core/` 无副作用约束：

- `scripts/core/loop-state.js`：状态转换和不变量。
- `scripts/core/loop-policy.js`：预算、重试、熔断、审批、下一动作计算。
- `scripts/core/loop-schedule.js`：cron/interval、timezone、misfire 纯计算。
- `scripts/core/loop-contract.js`：Goal/Run/WakeEvent schema 归一化与校验。

副作用模块：

- `scripts/control-db.js`：唯一 SQLite 连接、migration 与 transaction owner。
- `scripts/loop-store.js`：Goal、Wake、Run 状态与 projection repository。
- `scripts/loop-execution-store.js`：execution owner、Attempt 与原子 verifier completion。
- `scripts/loop-governance-store.js`：Plan/Approval、Usage 与 Outbox。
- `scripts/daemon-loop-coordinator.js`：领取 Run 并编排一次有限闭环。
- `scripts/daemon-loop-triggers.js`：只生成幂等 WakeEvent。
- `scripts/daemon-loop-reconciler.js`：核查中断 execution、补投 outbox、重建投影。
- `scripts/daemon-workspace-broker.js`：根据 runtime capability 委托或提供 run 级 workspace。
- `scripts/daemon-verifier.js`：首版只实现 deterministic command verifier；agent verifier 作为 P2 capability。

复用并调整：

- `daemon-engine-runtime.js` 提供统一 `AgentRuntimeAdapter`。
- `core/handoff.js` 负责所有 Claude/Codex 子进程执行和 watchdog。
- `task-board.js` 保留原 API，改为接收 `control-db.js` 提供的连接/transaction。

### 5.2 Runtime Adapter contract

```js
{
  startTurn({ run, prompt, outputSchema, workspace, sessionRef, permissions, signal }),
  cancel({ executionRef, reason }),
  normalizeResult(nativeResult),
  classifyError(error),
  supports: { resume, planMode, structuredOutput, nativeWorktree, nativeSubagents }
}
```

要求：

- 不在控制面保存完整 transcript，只保存 `engine + session/thread id + compact result summary`。
- Claude/Codex 参数只能由 `daemon-engine-runtime.js` 生成。
- background、interactive、dispatch 共用 `core/handoff.js` 的 timeout/kill/result 语义。
- Completion Contract 必须编译为原生 JSON Schema：Claude 通过 `--json-schema`，Codex 通过 `--output-schema`；具体参数只在 `daemon-engine-runtime.js` 构造。
- `NEXT_DISPATCH`/`MISSION_COMPLETE` 仅由 legacy adapter 解析，并记录 `legacy_signal_used`；新 Goal 不允许选择文本协议。
- 原生 session resume、sandbox/approval、compaction、工具事件和运行时内子 Agent 均由 adapter 委托后端，不在控制面复制实现。

### 5.3 WakeEvent 与幂等

WakeEvent 最少包含：

```json
{
  "wake_id": "sha256(automation_id + scheduled_at + event_id)",
  "goal_id": "repo-health",
  "trigger_type": "cron",
  "scheduled_at": "2026-06-23T09:00:00+08:00",
  "observed_at": "2026-06-23T09:00:03+08:00",
  "payload": {}
}
```

`wake_events.wake_id PRIMARY KEY` 保证重复 tick、daemon 重启、webhook 重投不会重复处理。`runs.primary_wake_id UNIQUE` 保证首次唤醒只创建一个 Run；`coalesce=true` 时，Goal 已有 active Run 则把 WakeEvent 的 `attached_run_id` 指向现有 Run，并记录 disposition，不并行启动。

### 5.4 单 daemon Execution Ownership 与崩溃恢复

- MetaMe 当前已有 daemon 单实例锁与 orphan process 清理，首版不引入分布式 lease/fencing。
- 每次 daemon 启动生成 `boot_id`。Coordinator 以 transaction 原子领取 queued/retry_wait Run，记录 `execution_boot_id/pid/started_at/heartbeat_at`。
- SIGTERM 先停止领取新 Run，再取消并持久化当前 Attempt，最后写入 interrupted/finished 状态。
- 启动和周期 Reconciler 对非本 boot 的 executing Run 依次检查：PID/进程组、runtime session、workspace diff、最后事件和 outbox。
- 只有确定没有不可逆副作用，或外部动作具备幂等键时，才自动 retry；否则进入 `blocked: recovery_review_required`，不得盲目重跑。
- 文件写入通过 workspace/base SHA/diff 判断；PR、通知、Webhook 等外部动作必须使用 outbox dedupe key。
- 未来引入多 daemon 或远程 worker 后，再以 schema migration 增加 lease token、expiry 和 fencing；该能力列为 P2。

### 5.5 Workspace contract

代码任务的 workspace id 为 `run_id`，路径建议：

```text
~/.metame/worktrees/<repo>/<goal-id>/<run-id>/
branch: metame/loop/<goal-id>/<run-id>
```

WorkspaceBroker 使用 capability delegation：

- Claude runtime 支持原生 worktree 时优先委托原生能力，MetaMe 只记录路径、base SHA、branch 和清理状态。
- Codex 或缺少原生能力的 runtime，复用并改造 `scripts/daemon-worktrees.js`，从 actor-scoped 改成 run-scoped。
- 只读或非代码任务使用 `workspace: none|directory`；非 Git 项目不再伪造空 Git 仓库。

获取时记录 `repo_root/base_sha/branch/path/dirty_before/provider`；释放前运行 verifier 并记录 diff。只有通过验证且获得业务审批后才能创建 PR、merge、push 或 publish。失败 workspace 默认保留 24 小时用于诊断，成功且无待审批动作可回收。

### 5.6 Plan 与审批策略

风险分级：

| 风险 | 示例 | 默认处理 |
|---|---|---|
| R0 | 读取、检索、状态探针 | 自动执行 |
| R1 | 隔离 worktree 内修改、运行测试 | 记录 plan 后自动执行 |
| R2 | 修改主工作区、外部写操作、创建 PR | 执行前审批 |
| R3 | merge、push、publish、删除数据、凭证/权限变更 | 明确人工审批，不能由 Goal policy 放宽 |

Plan 是结构化 artifact：`intent/scope/owned_paths/commands/risks/verification`。审批绑定 `plan_hash + run_id`；plan 发生实质变化后旧审批失效。

R0-R3 是 **MetaMe 业务动作策略**，不是第二套工具权限引擎。Adapter 应把最低必要权限映射到 Claude/Codex 原生 sandbox/approval；MetaMe 额外门控的是原生权限无法表达的跨进程动作，例如修改主工作区、创建 PR、push/publish、删除数据和外部系统写入。

### 5.7 Completion Contract

Maker 通过 runtime 原生 JSON Schema 返回：

```json
{
  "status": "candidate_complete",
  "summary": "...",
  "artifacts": ["..."],
  "claims": ["eslint passed", "tests passed"],
  "next": null
}
```

Verifier 独立执行，不信任 claims：

1. 先运行确定性 verifier（syntax/lint/test/schema/security policy）。
2. 首版不启动 verifier agent；rubric 无法程序化时进入 `awaiting_review`。独立 read-only agent verifier 属于 P2。
3. 输出固定 schema：`passed/checks/failures/evidence/retryable/infra_failure`。
4. `infra_failure` 不计 maker 失败次数；进入带退避的 `retry_wait`。
5. verifier failure 生成最小反馈，回到同一 Run 的下一 Attempt。
6. 达到 attempt/budget/time 上限后 `blocked` 或 `failed`，绝不无限重试。

### 5.8 Manager/Worker

不进入首版。单 runtime 内分工优先使用 Claude/Codex 原生子 Agent，MetaMe 不复制其内部调度器。现有 Task Envelope、task board 和 handoff 继续服务于明确的跨进程、跨引擎或跨设备协作。

未来只有满足以下条件才增加 MetaMe Manager/Worker DAG：任务跨 runtime；需要 MetaMe 独立持久化每个子任务；owned paths 和验收标准可隔离。即便如此也复用现有 `daemon-task-envelope.js` 与 `task-board.js`，不新造第二套任务协议。

### 5.9 Telemetry 与未来改进

每个 Run 记录：排队/执行/验证时长、turn/attempt、token/cost、tool error 分类、resume 成功率、verifier failure、workspace diff、notification 状态。默认不保存隐私敏感的完整 prompt/transcript。

首版只采集可操作 telemetry，不实现自动改写。Level-4 作为 P2 研究方向，若未来启用必须遵循：

```text
trace aggregation -> failure cluster -> proposal -> replay evaluation
-> canary -> human approval -> versioned rollout -> rollback
```

Verifier、system instructions、tool policy 均版本化并写入 Run。禁止在线任务直接修改自己的 verifier 或控制面策略。

### 5.10 首版与 P2 边界

首版包含：Goal/finite Run、clock/interval/manual WakeEvent、单 DB owner、execution ownership、原生结构化输出、统一 runtime/handoff、deterministic verifier、outbox、legacy migration。

P2 明确包含：

- 通用 webhook/event adapter；
- 完整 lease/fencing 与远程 worker；
- MetaMe Manager/Worker DAG；
- LLM verifier、多模型交叉评审；
- Level-4 自动改进管道；
- 自动 PR/merge/publish。

## 6. 配置与用户接口

### 6.1 新配置

仓库继续只提供无凭证模板；用户实例存于 `~/.metame/daemon.yaml`。

```yaml
loop:
  enabled: true
  max_concurrent_runs: 2
  reconcile_interval: 30s
  retention_days: 30

goals:
  repo-health:
    mode: continuous
    objective: 保持 MetaMe 必需检查为绿色
    target: { project: metame, cwd: ~/AGI/MetaMe }
    execution: { engine: codex, model: auto, workspace: auto }
    verification: { command: node scripts/ops-verifier.js }
    policy:
      max_attempts_per_run: 3
      max_wall_time: 45m
      approval: risk_based
    automations:
      - id: weekday-check
        cron: "0 9 * * 1-5"
        timezone: Asia/Shanghai
        misfire_policy: run_once
```

配置加载必须执行 schema validation；未知字段告警，非法 schedule、cwd、verifier command 或不支持的 engine 使该 Goal disabled，不允许 daemon 带病启动该 Goal。

### 6.2 命令

- `/goals`：列出目标、下一唤醒、最近 Run、预算和阻塞原因。
- `/goal <id>`：展示 Goal、active Run、attempt、verifier evidence。
- `/goal run <id>`：创建 manual WakeEvent，不绕过并发/预算策略。
- `/goal pause|resume|cancel <id>`：显式生命周期操作。
- `/run <run-id>`：查看单轮 timeline。
- `/approve <run-id> <plan-hash>`：批准精确计划。

保留 `/tasks` 展示 Automation；不再把长期 Goal 伪装成一直运行的 task。`/status perpetual` 在迁移期重定向到 `/goals`。

## 7. 迁移方案

### Phase 0：行为锁定

- 为现有 heartbeat、reactive、worktree、restart 恢复建立 golden tests。
- 建立 crash-window 测试：spawn 前、spawn 后、verifier 前、状态提交后、通知前分别终止进程。
- 记录现有配置解析结果作为迁移 fixture。

完成条件：现有行为有可重复基线，尚不切换生产路径。

### Phase 1：控制面骨架

- 新增 `control-db.js`、`core/loop-*`、`loop-store.js` 和 schema migration。
- `task-board.js` 改为使用唯一 control DB，不再隐藏创建自己的连接。
- 实现完整 schema、状态机、WakeEvent dedupe、execution ownership、outbox、projection。
- `task_board.db` 自动备份后 migration；migration 幂等。

完成条件：纯单元测试覆盖合法/非法转换、active Run 唯一约束、Attempt、Approval、Usage 和跨表 transaction。

### Phase 2：先统一执行器与结构化输出

- 后台任务改用 `daemon-engine-runtime.js + core/handoff.js`。
- 删除 scheduler 内 `spawnClaude` 和重复 watchdog。
- Claude `--json-schema`、Codex `--output-schema` 接入统一 Completion Contract。
- Claude/Codex 对同一 contract 跑 contract tests。

完成条件：interactive/dispatch/background 共享 runtime 错误、取消和 structured result 语义；现有 heartbeat 行为不变。

### Phase 3：统一触发

- 新 trigger adapters 仅接管 interval/clock/manual；通用 webhook 留到 P2。
- 旧 `heartbeat.tasks` 在内存编译成 legacy Goal + Automation。
- WakeEvent 和 Run 由新控制面记录，执行仍可通过 compatibility adapter 调用已统一的 executor。

完成条件：同一 schedule 不重复执行，sleep/restart 的 misfire 行为确定。

### Phase 4：Verifier 与 run 级 worktree

- 引入 capability-aware WorkspaceBroker 和业务 risk gate。
- 先迁移代码类 Goal；非代码 heartbeat 保持 directory/none。
- outbox 接管成功、失败、审批通知。

完成条件：maker 无法自行标记 succeeded；重复通知可去重；失败 worktree 可诊断和回收。

### Phase 5：迁移 reactive/perpetual

迁移映射：

| 旧字段/文件 | 新位置 |
|---|---|
| `projects.<key>.reactive: true` | `goals.<key>.mode: continuous` |
| `perpetual.yaml.max_depth` | `policy.max_turns_per_run` |
| `no_signal_max_retries` | legacy signal adapter policy |
| `completion_signal` | legacy completion adapter；最终改 structured result |
| verifier path | `verification.command` |
| mission queue | Goal backlog / child task DAG |
| reactive `events.jsonl` | 导入 `loop_events` |
| `state.md/progress.tsv/memory.md` | 由数据库重建的只读投影 |
| `persistent_session` | `execution.resume_policy: within_run` |

提供 `metame loop migrate --dry-run`，输出转换 diff、冲突和无法自动映射项；用户确认后才写本地配置。旧文件保留只读备份。

完成条件：同一长期项目仅有一个事实源；重启后从 SQLite 恢复。

### Phase 6：收口与删除

- 默认关闭 legacy reactive handler 和 scheduler direct spawn。
- 连续两个发布周期无回滚后删除 `NEXT_DISPATCH` 主路径、`daemon_state.tasks/reactive` 写入和 actor 级代码 worktree。
- `daemon-reactive-lifecycle.js` 中仍有价值的纯策略迁入 `core/loop-policy.js` 后删除大模块。

## 8. 不变量

实现和 code review 必须检查：

1. 首版一个 Goal 同时最多一个 active Run；未来并发语义必须先替换数据库约束，不能只改配置。
2. 一个 WakeEvent 最多创建一个 Run。
3. 非当前 `boot_id + execution_pid` 所有者不能提交 executing/verification 结果。
4. `succeeded` 必须存在 passed verifier event。
5. `continuous` Goal 不允许无限单 Run；每个 Run 必须受 attempt/turn/time/budget 限制。
6. notification/outbound action 必须有 dedupe key。
7. 代码 Run 不得修改主 working tree。
8. verifier 不能由当前 Run 修改；检测到相关 diff 立即 blocked。
9. R3 动作必须有与当前 plan hash 匹配的人工审批。
10. Markdown、TSV、卡片均不是事实源，删除后可从 DB 重建。

## 9. 验收测试

### 9.1 核心测试

- schedule：timezone/DST、weekday、interval、misfire、sleep resume。
- dedupe：重复 tick、重复 manual wake、coalesce、daemon 重启。
- ownership：boot id、PID/orphan、SIGTERM、崩溃后副作用不明时 blocked。
- runtime：Claude/Codex fresh/resume/cancel/timeout/auth/rate-limit/output schema。
- verifier：pass/fail/infra failure/timeout/恶意输出/修改 verifier。
- workspace：dirty main repo、branch 已存在、创建失败、保留与 GC。
- policy：预算、attempt、turn、wall time、cooldown、approval。
- outbox：通知失败重试、重复投递、进程在提交后崩溃。
- migration：旧 heartbeat/reactive 配置 dry-run、幂等导入、回滚。

### 9.2 端到端场景

1. Cron 唤醒只读巡检；无变化时零 maker token 或最小探针成本并 `skipped`。
2. 巡检发现回归；创建 worktree，maker 修复，deterministic verifier 通过，等待 PR 审批。
3. verifier 失败两次后第三次通过；timeline 完整且只通知一次。
4. 执行中 daemon 重启；Reconciler 核查 PID/session/workspace/outbox，且不重复外部写操作。
5. Mac 睡眠跨过三个 interval；`coalesce/run_once` 只补一轮。
6. Codex resume 失败；同一 Attempt 按 policy fresh retry，保留错误分类。
7. Goal 达到预算；进入 paused/blocked，不在每个 heartbeat 重试烧 token。

### 9.3 项目交付门槛

每个实施 PR 至少运行相关定向测试；修改 `scripts/daemon*.js` 后必须：

```bash
npx eslint scripts/daemon*.js
node --test scripts/daemon-*.test.js
```

最终切流前再执行全量测试、migration fixture 和 24 小时 shadow mode。Shadow mode 只计算新控制面的决策，不实际启动第二份 Run；对比旧路径的触发时间、状态和通知结果。

## 10. 回滚与兼容

- feature flags：`loop.enabled`、`loop.execute_v2`、`loop.reactive_v2` 分阶段开启。
- schema 只做向前兼容的 add migration；旧代码仍可忽略新增表。
- 切流期所有 legacy 配置保持原样，新配置由 compiler 生成运行时对象，不自动覆盖用户文件。
- v2 每次状态变更写审计事件；出现 P0 故障可关闭 execute flag，旧 executor 继续消费 legacy 配置。
- 不做双执行。Shadow mode 只能比较决策，不能同时运行旧、新 executor。

## 11. 关键决策记录

### ADR-1：用现有 task_board.db 扩展控制面

选择扩表现有 SQLite，而非新建 `loop.db`。由 `control-db.js` 作为唯一连接与 transaction owner，`task-board` 和 `loop-store` 只是 repository。Loop 产生的 team task 可关联 Goal/Run，普通交互 dispatch 保持 nullable 关联。

### ADR-2：永续 Goal + 有限 Run

拒绝永久进程和无限 session。有限 Run 提供清晰预算、恢复、验证和审计边界；Goal 通过 trigger/transition 实现长期连续性。

### ADR-3：事件是审计，状态行是读取模型

同一 transaction 同时更新当前状态和 append event。避免纯 event sourcing 带来的实现复杂度，也避免仅 mutable JSON 无审计的问题。

### ADR-4：确定性 verifier 优先

测试、lint、schema、安全策略先于 LLM judge。LLM verifier 只补充主观 rubric，且默认 read-only、fresh session。

### ADR-5：控制面不依赖后端私有内核细节

Claude/Codex 原生 loop、compaction 和 thread 由各自 runtime 管理。MetaMe 的稳定边界是 adapter contract，而不是对白皮书中未公开内部函数或存储格式的绑定。

### ADR-6：首版使用 execution ownership，不使用分布式 lease

当前 MetaMe 是受单实例锁保护的单 daemon。首版以 boot id、PID、session、workspace 和 outbox 证据恢复，副作用不明时阻塞等待审查。完整 lease/fencing 只有在多 daemon 或远程 worker 成为真实需求后引入。

### ADR-7：原生 capability delegation

JSON Schema 输出、session resume、sandbox/approval、runtime 内子 Agent 和可用的原生 worktree 优先委托 Claude/Codex。MetaMe 只统一配置、证据、跨运行时生命周期和业务动作门控。

## 12. 预期代码收敛结果

完成后应形成以下清晰分工：

```text
control-db               唯一数据库连接与事务
daemon-loop-triggers     何时唤醒
daemon-loop-coordinator  一轮如何编排
loop-store               Loop 领域数据访问
core/loop-policy         下一步是否继续
daemon-engine-runtime    用哪个 Agent 后端
core/handoff             子进程如何安全运行
daemon-workspace-broker  在哪里运行
daemon-verifier          如何证明完成
task-board               交互及 Run 内跨进程子任务如何协作
```

旧的 scheduler 和 reactive lifecycle 最终退出业务编排，只留下短期兼容 adapter。这样 MetaMe 的“永续任务”不再是一项特殊功能，而是统一 Loop Control Plane 上 `mode: continuous` 的一种 Goal 策略。
