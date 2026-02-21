# MetaMe：架构重构与交互演进计划

> 基于两轮架构评审（2026-02-22）的完整技术实现地图。
> 生物学隐喻仅供理念参考，代码层严格使用工程术语。

---

## 1. 核心目标

三个并行方向：

1. **IPC 升级**：废弃 `pending.jsonl` 文件轮询，换 Unix Socket 实现 0 延迟 Agent 间通信
2. **记忆质量**：Sleep mode 触发结构化记忆压缩，facts 带 tag，支持分层检索
3. **Session 路由**：Agent 间对话和人与 Agent 对话具备长期记忆 + 自动路由到最相关历史 Session

---

## 2. 已确认的架构缺陷与修复方向

### 2.1 IPC 错配（最高优先级）

**错误方案**：原计划用 `EventEmitter` 替代 `pending.jsonl`。`claude -p` 启动的 session 是独立子进程，内存隔离，EventEmitter 根本跨不了进程边界。

**正解**：Unix Domain Socket。daemon 作 server（`~/.metame/daemon.sock`），`dispatch_to` CLI 改为 socket client。延迟从最坏 60 秒 → <100ms。

**兼容策略**：保留 `pending.jsonl` 轮询作 fallback，稳定运行 2 周后再移除。

### 2.2 Phase 4 免疫自愈（废弃）

"用 LLM 生成 patch 并运行时热重载"在生产 daemon 里不可行：
- LLM patch 可能引入新 bug
- 热重载中间态可能崩溃
- 调试时无法对齐源码版本

**替代方案**：加强健康遥测 + 降级保护，不做自修改代码。

### 2.3 Session 连贯性（新发现）

**当前痛点**：每次对话本质上是无状态的，仅靠 `memory-search` 注入 facts 作为记忆。虽然 `--resume` 机制已实现，但缺少：
- Session idle > 2 小时后的**摘要桥接**（context compact 后细节丢失）
- 多 session 之间的**自动路由**（哪条消息该接续哪个历史 session）

---

## 3. 现有能力盘点（避免重复造轮子）

| 能力 | 现状 | 代码位置 |
|------|------|---------|
| `--resume` session 恢复 | ✅ 完整实现 | daemon.js:3978 |
| Sleep mode 检测 | ✅ 有骨架，未接行为 | daemon.js:912-930 |
| `require_idle` 任务类型 | ✅ 支持 | daemon.js:927 |
| dispatch 虚拟 chatId 隔离 | ✅ `_agent_*` 格式 | daemon.js:700 |
| session tag 提取 | ❌ 无 | — |
| session 摘要缓存 | ❌ 无 | — |
| session 路由算法 | ✅ metame-desktop 已有完整实现 | session.ts:738 |

**关键发现**：metame-desktop 的 `session.ts`（1569行）已有生产级路由算法，包含 5 维打分、动态阈值、学习反馈、105 个测试用例，可直接移植。

---

## 4. 分阶段实施地图

### P0 — Sleep Mode 接通记忆压缩（基础，最快收益）

**改动文件**：`scripts/daemon.js`
**改动位置**：`physiologicalHeartbeat()` 第 913 行
**改动量**：+15 行

```js
if (idle && !_inSleepMode) {
  _inSleepMode = true;
  log('INFO', '[DAEMON] Entering Sleep Mode');
  const st = loadState();
  const lastConsolidate = st.last_memory_consolidate || 0;
  if (Date.now() - lastConsolidate > 4 * 60 * 60 * 1000) { // 4小时一次
    st.last_memory_consolidate = Date.now();
    saveState(st);
    spawnConsolidation(); // spawn memory-extract.js, detached
  }
}
```

**验收**：连续 30 分钟无消息，`daemon.log` 出现 memory-extract 执行记录。

---

### P1 — Unix Socket IPC 替代 pending.jsonl 轮询

**改动文件**：`scripts/daemon.js` + `~/.metame/bin/dispatch_to`

**daemon.js 新增**（main 函数启动时）：
```js
const net = require('net');
const SOCK_PATH = path.join(METAME_DIR, 'daemon.sock');

function startSocketServer() {
  try { fs.unlinkSync(SOCK_PATH); } catch {}
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', d => buf += d);
    conn.on('end', () => {
      try {
        const msg = JSON.parse(buf);
        handleDispatchMessage(msg); // 复用现有 pending.jsonl 处理逻辑
        conn.write(JSON.stringify({ ok: true }));
      } catch (e) {
        conn.write(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  });
  server.listen(SOCK_PATH);
}
```

**dispatch_to 改动**：优先 socket 连接（timeout 2s），失败 fallback 到写 `pending.jsonl`。

**验收**：dispatch_to 发送后 <100ms 收到响应，无文件轮询日志。

---

### P2-A — memory-extract 输出结构化 tags（session 路由前提）

**改动文件**：`scripts/memory-extract.js`

**输出扩展**：在现有 facts 之外要求 Haiku 给 session 取名：
```json
{
  "session_name": "优化微信登录架构",
  "facts": [...]
}
```

**存储**：`~/.metame/session_tags.json`，扩展存储包含 name 的映射关系，以供推荐使用。
```json
{
  "session-uuid-1": {
    "name": "优化微信登录架构",
    "tags": ["coding", "MetaMe", "daemon", "bug_fix"]
  }
}
```

**存储**：`~/.metame/session_tags.json`，每次 merge 不覆盖。
**成本**：每 session 0 token（随 facts 提取一起返回，无额外开销）。
**验收**：`session_tags.json` 出现带 `name` 和 `tags` 的结构。

---

### P2-B — Session 摘要缓存（中期连贯性桥接）

**问题**：Session idle > 2 小时再 resume，Claude 内部 context 已 compact，细节丢失。

**改动文件**：`scripts/daemon.js`（sleep mode 触发处）

**daemon_state.json 扩展**：
```json
{
  "sessions": {
    "chat_id_1": {
      "id": "uuid",
      "last_summary": "讨论了 Unix Socket IPC 方案，决定保留 pending.jsonl 作 fallback...",
      "last_summary_at": "2026-02-21T23:00:00Z",
      "last_summary_session_id": "uuid"
    }
  }
}
```

**摘要生成**：`spawnSummary()` — 读 session 最后 30 轮对话，claude -p --model haiku 生成 3-5 句总结。

**注入时机**：`askClaude` 调 `--resume` 前，检测到 `last_summary` 存在时 prepend 到 system prompt：
```
[上次对话摘要]: {last_summary}
```

**验收**：idle 2 小时后的 session 在 daemon_state.json 出现 `last_summary` 字段。

---

### P3（降级）— Session 检索推荐（不自动切换）

> ⚠️ **架构评审结论（2026-02-22）**：原 P3-A/B/C 的"自动切换 session"方案被降级。
>
> **废弃自动切换的核心原因**：
> 1. **UX 灾难**：daemon 是异步消息场景，用户几分钟后才看到"切错了"，此时上下文已跑偏，代价比 desktop 更高
> 2. **纠错机制的存在本身是警告信号**：P3-C 的学习反馈/回滚设计的复杂度，证明 P3-B 的自动切换违背用户直觉
> 3. **Daemon 应保持"哑管道"原则**：NLP 分词 + 语义打分引擎不属于守护进程的职责，易引发内存泄漏或崩溃
> 4. **已有显式路由**：`_agent_*` 虚拟 chatId 和 `dispatch_to` 已覆盖意图明确的跨 agent 场景

**保留形式：只推荐，不代扣扳机**

当用户发送无明显上下文的消息，且 P2-A 的 session tags 命中历史会话时，daemon 发出推荐通知，由用户决定：

```
用户：帮我看下上次那个数据库备份的方案

daemon 不自动切换，而是回复：
📎 发现相关历史会话 [数据库备份方案 · 2026-01-15]
   要怎么处理？
   [切换过去继续] [把摘要调入当前聊天] [忽略]
```

**实现方式**：
- `session-router.js` 作为**离线工具模块**存在，不集成进 askClaude 主流程
- P2-A 的 session tags 驱动检索，给出推荐列表
- 用户选择 `[把摘要调入]` → 将对应 session 的 `last_summary` prepend 到当前 prompt
- 用户选择 `[切换过去]` → 显式执行 session 切换（用户授权）

**触发条件（保守）**：
- 消息明确包含"上次"、"之前"、"那个...的方案"等回指词
- 命中的历史 session 置信度 > 0.80（高阈值，宁缺毋滥）

**验收**：用户说"上次那个XX"，daemon 发出推荐卡片，不自动切换任何 session。

---

## 5. 优先级与依赖关系

```
P0 ──────────────────────────────────────────► [接通sleep→记忆压缩]
P1 ──────────────────────────────────────────► [Unix Socket IPC]
P0 → P2-A ──────────────────────────────────► [session tags提取]
P0 → P2-B ──────────────────────────────────► [session摘要缓存]
P2-A → P3-A ────────────────────────────────► [路由算法移植]
P3-A + P2-B → P3-B ─────────────────────────► [路由集成daemon]
P3-B → P3-C ────────────────────────────────► [学习反馈]
```

| 优先级 | 任务 | 依赖 | 核心改动量 | 预期收益 |
|--------|------|------|----------|---------|
| **P0** ✅ | sleep → memory-extract | 无 | +15行 daemon.js | 记忆质量保障 |
| **P1** ✅ | Unix Socket IPC | 无 | +50行 daemon.js，改 dispatch_to | Agent延迟 60s→0 |
| **P2-A** ✅ | session tags | P0 | memory-extract.js 扩展 | 路由前提 |
| **P2-B** ✅ | session 摘要缓存 | P0 | daemon_state 扩展 | 对话连贯性 |
| ~~P3-A~~ | ~~路由算法移植~~ | — | ~~自动切换，废弃~~ | — |
| ~~P3-B~~ | ~~路由集成 daemon~~ | — | ~~自动切换，废弃~~ | — |
| ~~P3-C~~ | ~~学习反馈~~ | — | ~~自动切换，废弃~~ | — |
| **P3↓** ⏳ | Session 检索推荐 | P2-A | 推荐卡片，用户授权切换 | 找回历史上下文 |

---

## 6. 架构备忘：待评估技术债

### T1 — Profile 注入无痕化（低优先级，多 Agent 并行时再做）

**背景（2026-02-22 Gemini 评审 + Jarvis 补充）**

当前 `index.js` 将 ~180 行 `PROTOCOL_NORMAL` 写入工程目录 `CLAUDE.md` 头部。
已知副作用：Task subagent 会读到这段内容，造成"打工仔 Agent 看到一堆主人格指令"的认知干扰。

**Gemini 建议**：切换到 `--append-system-prompt`，让注入不落文件、事后无痕。

**Jarvis 补充的关键盲点**：`--append-system-prompt` 只在 `metame` 命令启动时生效；Task subagent 不继承该参数，只读 CLAUDE.md。直接切换会导致 subagent 完全看不到用户画像，认知连续性断掉。

**正确方向（分层注入）**：

| 层 | 内容 | 目标 | 方式 |
|----|------|------|------|
| `~/.claude_profile.yaml` | 用户身份+偏好 | 所有会话含 subagent | 全局 CLAUDE.md 引用（现状） |
| 项目 CLAUDE.md | 项目规范+架构约定 | 该目录所有 Claude | 文件，用户维护 |
| MetaMe 协议 PROTOCOL_NORMAL | 进化机制+行为指令 | 只需主会话 | 改用 `--append-system-prompt` |

**触发条件**：当 P3↓ Session 推荐卡片上线，subagent 上下文干净度变成刚需时，做这个重构才值得。

**当前状态**：记录为技术债，不急于实施。

---

### T2 — Agent 定义与 CLAUDE.md 隔离（已决策，无需修改）

**结论（2026-02-22）**：MetaMe 的"环境投影派"架构设计已足够，不需要向 openclaw 的多文件方向演进。

- openclaw 的 `soul.md / identification.md / skills/` 属于"实体派"，适合多人团队维护、有强命名空间需求的场景
- MetaMe 用 **CWD 即上下文** 实现 Agent 隔离：不同 Agent 绑定不同工作目录，自然读各自的 CLAUDE.md；`~/.claude_profile.yaml` 提供统一用户身份
- 一个 CLAUDE.md + 中枢 profile，两层已覆盖 openclaw 四五个文件的职责，且无同步负担
- **结论**：无需修改现有设计，记录为已决策。

---

## 7. 明确废弃的方案

| 原计划 | 废弃原因 |
|--------|---------|
| `biorhythm.js` 独立模块 | 无净收益，直接扩展 daemon.js 已有函数 |
| EventEmitter 替代 pending.jsonl | 跨进程边界，技术不可行 |
| Phase 4 免疫自愈热重载 | 自修改运行时代码，生产环境不可接受 |
| 生物学命名（SynapseBus 等） | 增加认知负担，保留为注释/文档隐喻 |
| P3-B 自动切换 session | UX 灾难：daemon 异步场景用户无法及时干预；纠错机制复杂度证明设计违背直觉；daemon 应保持哑管道 |
| P3-C 路由学习反馈 | 依赖 P3-B，随 P3-B 一起废弃 |

---

## 7. 生物隐喻对应表（仅供理解，不进入代码）

| 工程术语 | 原生物学隐喻 |
|---------|------------|
| Idle Memory Consolidation | 睡眠 / 慢波睡眠 |
| Data Distillation | 做梦 / 认知升维 |
| Unix Domain Socket | 神经突触 / 神经总线 |
| Socket Message Payload | 神经递质 |
| Session Route Decision | 场景路由 / 专属海马体 |
| Memory Weight Decay | 艾宾浩斯遗忘曲线（暂缓，QMD 已有语义 rank） |
