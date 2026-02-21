# MetaMe 重构任务书

## 背景

MetaMe 的认知蒸馏、记忆提取、技能演化三套系统目前全部耦合在 `distill.js` 里，共享同一个触发条件（`raw_signals.jsonl` 非空）。核心 bug：纯技术型会话（无偏好信号）→ signals 为空 → 记忆提取和技能演化全部跳过，哪怕这次会话有重要技术决策。

---

## 阶段一：写入管道重构（当前）

**目标**：三套系统独立心跳，互不影响。

### 已完成

- [x] `providers.js` 新增 `callHaiku(input, extraEnv, timeout)`，统一 Haiku 调用入口，自动处理 `CLAUDECODE` 环境变量
- [x] `distill.js` 删除本地 `callClaude`，改用 `callHaiku`；`extractFacts` 加入 exports；两次 `require('./providers')` 合并为一
- [x] `skill-evolution.js` 删除本地 `callClaude`，改用 `callHaiku`；删除冗余内部 require；加 `if (require.main === module)` 入口
- [x] `daemon-default.yaml` 注释里加入 `skill-evolve` script 任务示例

### 待完成

#### 1. 新建 `scripts/memory-extract.js`（~80行）

独立的记忆提取脚本，完全不依赖 `raw_signals.jsonl`。

```
findLatestUnanalyzedSession()     → { path, session_id }
  ↓
extractSkeleton(path)             → skeleton（纯本地解析，零 API）
  ↓
extractFacts(skeleton, null, ...) → Haiku（唯一 API 成本）
  ↓
memory.saveFacts(facts)           → memory.db
  ↓
markAnalyzed(session_id)          → analytics_state.json
```

关键实现细节：
- `FACT_EXTRACTION_PROMPT` 和 `extractFacts` 从 `distill.js` 迁移过来，distill.js 不再 export 这两个
- 处理 `CLAUDECODE` 环境变量（通过 `callHaiku` 自动处理）
- 支持 `findAllUnanalyzedSessions()` 批量处理，不只处理最新一条
- 末尾加 `if (require.main === module)` 入口，支持心跳任务直接调用

#### 2. 清理 `distill.js` 的 `__main__` 块

把 `__main__` 块里关于 memory、extractFacts、skillEvo 的调用全部删掉，只保留：
- `distill()`
- `detectPatterns()`

distill.js 从此只做认知蒸馏这一件事。

#### 3. 瘦身 `lazyDistill()`（daemon.js）

**不删除**，保留"会话结束后立即触发"的语义（相比 4h 心跳更及时）。

但只保留认知蒸馏部分，删掉其中 memory/skill 相关逻辑（如果有的话）。

#### 4. 启用三个独立心跳任务（`~/.metame/daemon.yaml`）

```yaml
heartbeat:
  tasks:
    # 认知蒸馏：有偏好信号才触发，4小时冷却
    - name: "cognitive-distill"
      type: "script"
      command: "node ~/.metame/distill.js"
      interval: "4h"
      precondition: "test -s ~/.metame/raw_signals.jsonl"
      notify: false
      enabled: true

    # 记忆提取：独立于信号，30分钟扫描一次未分析 session
    - name: "memory-extract"
      type: "script"
      command: "node ~/.metame/memory-extract.js"
      interval: "30m"
      notify: false
      enabled: true

    # 技能演化：有技能信号才触发，6小时冷却
    - name: "skill-evolve"
      type: "script"
      command: "node ~/.metame/skill-evolution.js"
      interval: "6h"
      precondition: "test -s ~/.metame/skill_signals.jsonl"
      notify: false
      enabled: true
```

注意：修改 `~/.metame/daemon.yaml`（运行时配置），而非 `daemon-default.yaml`（安装模板）。存量用户需要手动或通过迁移脚本追加这三个任务。

#### 5. 初步记忆检索与动态注入 (RAG) [已完成]

在 `daemon.js` 发送每次请求前，拦截 prompt 并调用 `memory.searchFacts(prompt, { limit: 3 })`，将 SQLite 检索到的原子事实拼接成 `<!-- FACTS:START -->...<!-- FACTS:END -->` 注入系统提示词。

### 验收标准

- [x] 纯写代码的会话（无偏好信号）→ 30分钟内 `memory-extract` 自动运行，facts 入库
- [x] `node ~/.metame/memory-extract.js` 单独运行不报错，返回 `X facts saved`
- [x] `node ~/.metame/skill-evolution.js` 单独运行不报错
- [x] `daemon.log` 里能看到三个任务各自的调度日志
- [x] `lazyDistill` 保留且正常触发认知蒸馏，daemon 收发消息无报错
- [x] 移除 `schema.js`/`distill.js` 中的过时/冗余认知记忆属性 (`anti_patterns`, `milestones`)
- [x] 在 `daemon.js` 中实装基于 SQLite 的动态原子事实 RAG 注入。

---

## 阶段二：检索层升级（下一阶段）

**目标**：用 QMD 替换 `memory.db` 的 FTS5 检索，实现语义搜索。

**背景**：当前 `memory-search.js` 基于 SQLite FTS5，纯关键词匹配。搜"环境变量隔离"找不到"用 `delete` 清理 env"这类 facts。QMD 的混合检索（BM25 + 向量 + LLM 重排）能解决这个问题。

### 方案

```
写入不变：memory-extract.js → memory.db（facts 表）
                ↓ 新增同步
          QMD Collection（facts as documents）
                ↓
检索升级：searchFacts() 从 FTS5 → QMD HTTP/MCP 接口
```

### 具体改动 (To Next Agent)


#### 1. Facts 写入时同步到 QMD

在 `memory.js` 的 `saveFacts()` 里，写入 SQLite 后同步推送到 QMD Collection：

```js
// memory.js saveFacts() 末尾追加
await qmdClient.upsert('metame-facts', facts.map(f => ({
  id: f.id,
  content: `[${f.type}] ${f.value}`,
  metadata: { date: f.date, project: f.project, source: f.source }
})));
```

#### 3. `searchFacts()` 升级为混合检索

```js
// 现在：FTS5 关键词
// 改为：QMD 混合检索（BM25 + 向量 + LLM重排）
async function searchFacts(query, limit = 5) {
  return qmdClient.search('metame-facts', query, { limit, rerank: true });
}
```

#### 4. QMD 本地部署配置

- QMD daemon 作为 sidecar 进程，随 MetaMe daemon 启动
- Collection 名：`metame-facts`
- 模型：轻量 GGUF（<2GB），端侧运行，隐私自主

### 依赖

- 阶段一完成（facts 持续稳定入库）
- QMD 仓库：https://github.com/Yaron9/qmd
- QMD 支持 HTTP daemon 模式，接口已稳定

### 验收标准

- [ ] `daemon.js` 能够在用户提问时成功检索记忆，且通过日志能看到 `[MEMORY] Injected N facts`
- [ ] `memory-search.js "环境变量隔离"` 能找到语义相关 facts（不只关键词匹配）
- [ ] QMD daemon 随 MetaMe 自动启动/停止
- [ ] facts 写入延迟 < 1s（本地调用）
- [ ] 历史 facts 批量迁移到 QMD Collection

---

## 架构演进路径

```
现在：
  会话 → raw_signals → distill.js（认知+记忆+技能 全耦合）→ 检索（FTS5）

阶段一完成：
  会话 → raw_signals → distill.js（只做认知）
       → session JSONL → memory-extract.js（只做记忆）  → 检索（FTS5）
       → skill_signals → skill-evolution.js（只做技能）

阶段二完成：
  会话 → raw_signals → distill.js（只做认知）
       → session JSONL → memory-extract.js（只做记忆）  → 检索（QMD 混合）
       → skill_signals → skill-evolution.js（只做技能）
```

---

## 阶段三：睡眠心跳与认知闲时调度 (Dream Tasks)

**目标**：解决后台认知（distill）与记忆（memory-extract）任务可能抢占用户 API 速率、带宽和本地机器资源的问题，实现“只在用户闲置时做梦（处理认知）”的优雅调度。

**背景**：当前 `daemon.yaml` 使用死板的时钟间隔（如 `interval: 30m`）。如果在 30 分钟刻度时用户正在高强度和 MetaMe 对话，后台突然启动 `memory-extract.js` 调用 Haiku，可能会造成速率限制冲突或延迟。结合 `agent-dispatch-design.md` 的双心跳模型，将重度认知任务剥离到“睡眠态”执行。

### 具体方案

#### 1. 活跃度追踪 (Activity Tracking)
- `daemon.js` 内部增加 `lastInteractionTime` 的活跃度追踪器。
- 每次收到来自飞书、Telegram 的消息或 CLI 发起的会话请求时，自动更新此时间戳。

#### 2. 生理心跳扩展 (Physiological Tick)
- 在现有的守护心跳（每 60s 或 5m）中，加入 `isUserIdle()` 检查。
- 当 `Date.now() - lastInteractionTime > 30分钟` 且**没有进行中的高频会话 (activeSessions)** 时，系统正式进入 **"睡眠态 (Sleep Mode)"**。

#### 3. “梦境任务” (Dream Tasks) 调度
- 废弃原来瞬间触发的 `lazyDistill()`（会话一结束马上蒸馏容易漏掉追问上下文且打断思路）。
- 将 `cognitive-distill`、`memory-extract`、`skill-evolve` 定义为 `require_idle: true` 类型的任务。
- **只有在进入“睡眠态”后**，调度器才会去按序唤醒这些任务。如果这些任务在“梦境”中执行时用户突然发来消息，主进程正常响应，打断或挂起后台梦境任务的新一轮调度。

### 验收标准

- [ ] `daemon.js` 能够准确统计用户的最后交互时间。
- [ ] 后台日志中能够清晰观察到 `[DAEMON] Entering Sleep Mode` 的状态切换记录。
- [ ] `memory-extract` 和 `distill` 等高消耗任务，绝对不会在用户高频对话（Idle < 30m）的期间被强行触发。
- [ ] 移除 `lazyDistill` 的“立即触发”逻辑，交由闲时心跳统一接管。
