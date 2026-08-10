# MetaMe 记忆基础设施问题清单与专家审查请求

> 状态：待资深专家核查  
> 目的：验证问题判断，提出不推倒现有架构的优雅完善方案  
> 审查范围：session 提炼、长期记忆、Wiki、Profile、MCP 消费接口、召回与可观测性  
> 数据快照：本机 `~/.metame/memory.db`，2026-08-09 左右状态

## 1. MetaMe 的既定定位

MetaMe 不是 Codex、Claude Code 或其他单一 Agent 的附属记忆组件，而是用户在数字世界中的统一记忆中枢：

1. 原始 session 属于各 Agent，不复制进 MetaMe 主记忆库。
2. MetaMe 从 Claude Code、Codex、Gemini、手机 daemon 等 Agent session 中提炼值得长期保存的信息。
3. MetaMe 保存和管理：
   - `facts / conventions / insights`：原子事实、约定、教训与决策；
   - `episodes`：有复用价值的经历和事件摘要；
   - `wiki`：由事实组织、综合形成的结构化知识；
   - `profile`：用户的稳定身份、偏好与认知特征；
   - `session_sources`：提炼结果与原始 Agent session 的来源关系。
4. 各 Agent 通过 MCP 按需搜索、召回和写入 MetaMe，而不是每轮被动注入全部长期记忆。
5. Codex/Claude 的 session 负责当前对话连续性；context-mode 负责运行轨迹和上下文治理；MetaMe 负责跨 Agent、跨 session 的长期个人记忆。

本次审查应在以上边界内完善系统，不建议把 MetaMe 改造成另一套完整聊天记录仓库。

---

## 2. 当前架构概览

```text
Agent 原始 sessions
  ├── Claude Code sessions
  ├── Codex sessions
  ├── Gemini / agy sessions
  └── 手机 daemon sessions
            │
            ▼
      session_sources（来源索引）
            │
            ▼
      memory-extract / distill
            │
       ┌────┴───────────────┐
       ▼                    ▼
 memory_items             wiki_pages
 facts/conventions        topic hubs
 insights/episodes        dossiers/decisions/playbooks
 profile
       │                    │
       └──────────┬─────────┘
                  ▼
       metame-mcp-server.js
       memory_search / memory_recall /
       memory_write / profile_get / ...
                  │
                  ▼
          Claude / Codex / Pi / 其他 Agent
```

### 现有 MCP 工具

- `memory_search`
- `memory_recall`
- `memory_write`
- `profile_get`
- `skill_list`
- `skill_get`
- `agent_context`

---

## 3. 数据现状（用于辅助判断，不等同于质量结论）

当前 `~/.metame/memory.db` 约 20 MB。

### Active memory_items

| Kind | 数量 |
|---|---:|
| convention | 1,590 |
| episode | 421 |
| insight | 361 |
| profile | 6 |
| **合计** | **2,378** |

### 来源分布

| 来源 | 数量 |
|---|---:|
| session | 2,715（含非 active） |
| codex | 406（含非 active） |
| manual | 79（含非 active） |
| distill | 6 |

### Wiki

| 类型 | 数量 |
|---|---:|
| memory topic hub | 157 |
| memory project dossier | 76 |
| doc topic hub | 45 |
| knowledge artifact playbook | 8 |
| knowledge artifact decision | 3 |
| 其他 | 9 |
| **合计** | **298** |

### 重复内容

对 active `memory_items` 按 `title + content` 做精确比较：

- active 总数：2,378
- 唯一内容：2,284
- 重复组：78
- 超额重复记录：94

注意：这些数字只能证明存在精确重复，不能直接判断重复产生于当前 pipeline、历史迁移、不同 scope，还是合理的多来源保留。

---

# 4. 已验证问题

## P0：MCP `memory_search` 的公开描述与实际实现不一致

### 工具描述

`memory_search` 声称：

> Search MetaMe long-term memory (facts + knowledge wiki) with hybrid FTS/vector ranking.

### 实际实现

当前 handler 调用：

```js
memory.searchFactsAsync(query, {
  limit,
  project,
  trackSearch: false,
})
```

`searchFactsAsync()` 实际只是同步 `searchFacts()` 的包装；后者仅从 `memory_items` 中返回 active `insight` 和 `convention`。

### 后果

1. `memory_search` 不直接返回 `wiki_pages`。
2. 没有使用描述中承诺的 Wiki hybrid FTS/vector ranking。
3. MCP 消费者可能误以为“搜索不到即不存在”，而实际知识可能只在 Wiki。
4. 已投入生成的 298 个 Wiki 页面没有统一、直接的 MCP 搜索入口。

### 已存在但未接入的底层能力

底层已有：

```js
memory.hybridSearchWiki(query, ...)
```

可返回：

```js
{
  wikiPages,
  facts,
  sourceHitCounts
}
```

因此该问题更像“消费接口未接通”，而不是底层搜索能力缺失。

### 专家需核查

- 是否应把 `memory_search` 改成统一、分型结果：`facts + wiki_pages + episodes`？
- 是否应保留单入口，还是增加 `wiki_search` / `episode_search`？
- 排名是否应该跨类型统一，还是每类独立排名？

初步建议：保留单一 `memory_search`，返回明确分型结果，避免增加 Agent 工具选择负担。

---

## P0：MCP 消费缺乏可靠可观测性

### 已验证事实

`memory_search` 明确传入：

```js
trackSearch: false
```

这是为了避免外部读取影响 memory promotion/search_count。

### 后果

1. `memory_items.search_count` 不能代表 MCP 的真实消费量。
2. “有多少记忆从未被消费”目前无法可靠回答。
3. 现有 search_count 与 promotion 语义耦合，导致为了避免污染 promotion 而牺牲消费审计。
4. MCP 调用 `memory_recall` 的使用情况，也缺少一个清晰、独立的 MCP consumption audit 视图。

### 重要纠正

当前 2,378 条 active memory 中有 685 条 `search_count > 0`，但不能据此断言其余 71% 从未被消费，因为 MCP 查询被刻意设置为不增加 `search_count`。

### 专家需核查

建议将以下概念拆开：

- `promotion_search_count`：影响记忆晋级/保留；
- `consumer_hit_count`：真实被 Agent/MCP 命中的次数；
- `consumer_last_hit_at`：最后消费时间；
- `consumer_type`：daemon / mcp / cli / wiki / recall；
- `engine`：Claude / Codex / Gemini / Pi。

应避免把“质量信号”和“使用审计”继续复用一个字段。

---

## P1：精确重复内容仍存在于 active memory

### 证据

active `memory_items` 中有 94 条超额精确重复记录。抽样可见同一 workflow rule 或 bug lesson 多次出现。

### 可能影响

- 搜索结果重复；
- 召回上下文浪费 token；
- Wiki 投影重复；
- 用户误以为重复次数代表更高置信度；
- GC、反思、聚类成本增加。

### 尚未确认的根因

- 不同 session 多次提取同一内容；
- `source_type` 或 project/scope 不同导致去重失效；
- 历史 schema 迁移遗留；
- 相同事实允许多来源 provenance，但内容层未归并；
- candidate → active 晋级时未做 canonical merge。

### 专家需核查

建议评估“事实实体”和“来源证据”分离：

```text
canonical memory item（唯一内容）
  └── provenance / evidence links（多个 session 来源）
```

这样既保留多来源证据，又不复制事实正文。

---

## P1：MCP `memory_recall` 的能力边界容易被误解

### 实际行为

`memory_recall` 首先调用 `planRecall(text)`。只有以下情况才召回：

- 明确历史语义，如“上次、之前、还记得”；
- recurrence / decision / procedural 语义；
- 文件路径、错误码等强 anchor；
- 多个一般 anchor。

普通知识问题可能返回：

```text
no trigger — message does not reference past context
```

### 风险

- Agent 已主动决定调用 `memory_recall`，工具内部又拒绝搜索，形成“双重 gating”。
- 工具名称像通用召回接口，实际是“意图门控的历史召回器”。
- Agent 可能因一次 `recalled: false` 而停止尝试 `memory_search`。

### 专家需决策

可选方向：

1. 保持严格门控，但把工具改名为 `memory_recall_if_relevant`；
2. Agent 显式调用时绕过 trigger planner，planner 只用于自动 hook/daemon；
3. 增加 `force` 参数，但默认 false；
4. 工具返回明确建议：`use memory_search for direct knowledge lookup`。

初步建议：**显式 MCP 调用本身已经是需求信号，应减少二次拒绝；自动注入路径才需要严格 trigger planner。**

---

## P1：运行时配置分散，跨宿主接入缺少单一声明源

### 当前状态

- Codex MCP：`~/.codex/config.toml`
- 通用/部分客户端 MCP：`~/.mcp.json`
- Claude Code 可能有自己的 MCP 注册方式
- Gemini/agy 有独立 plugin/MCP 配置
- MetaMe daemon 有自身 runtime 配置

### 风险

1. 某个 Agent 有 MetaMe MCP，另一个没有。
2. 工具文档要求调用 `memory_write`，但当前宿主未实际注册该工具。
3. 升级或重装后配置漂移。
4. 无法快速回答“哪些 Agent 当前真正拥有 MetaMe 能力”。

### 专家需核查

建议由 MetaMe 提供统一命令，例如：

```text
metame mcp status
metame mcp install --host codex
metame mcp install --host claude
metame mcp doctor
```

并输出宿主能力矩阵，而不是人工编辑多个配置文件。

---

# 5. 高概率问题，但需要进一步证据

## H1：Session 自动提炼量可能高于长期价值密度

active memory 中，session 来源占比很高；convention 有 1,590 条，明显多于 insight 361 条。

这可能说明系统擅长抽取规则，但也可能存在：

- 临时操作被提升为长期 convention；
- 单次需求被误判为永久偏好；
- 项目局部约束缺失 scope；
- 多个 session 重复强化同一结论；
- 过多低价值内容停留在 active。

目前仅凭数量不能下结论，需要抽样审计：

- 按项目分层随机抽取 100 条 active conventions；
- 标注：正确、过期、重复、scope 错误、临时信息、真正长期规则；
- 计算 precision，而不是只看数量。

建议专家设计一套可重复的 memory quality benchmark。

---

## H2：Wiki 的生产能力可能强于实际消费能力

Wiki 已有 298 页，并存在 topic hub、project dossier、decision、playbook 等结构，但 MCP 直接搜索未接通。

可能后果：

- Wiki 持续生成但很少被 Agent 使用；
- topic hub 数量增长，却没有证据证明帮助完成任务；
- Wiki 与原子事实之间存在内容重复；
- 导航结构对人类有价值，但对 MCP/Agent 检索未必最优。

需采集：

- Wiki 页面命中次数；
- 命中后是否进入最终回答；
- Wiki 对任务成功率的增益；
- Wiki 页面陈旧率与重复率；
- facts 命中与 wiki 命中的互补程度。

---

## H3：Profile、Agent Context 等能力可能存在“已建设、少消费”

当前有 6 个 active profile sections；MCP 提供 `profile_get` 和 `agent_context`。

但尚无统一审计证明：

- 哪些宿主调用过它们；
- 调用后是否改善回答；
- profile 是否被重复注入到 AGENTS/system prompt；
- agent snapshot 是否及时更新。

建议在不记录敏感正文的前提下，增加工具级 usage audit。

---

## H4：Facts、Episodes、Wiki 的晋级与派生关系可能不够显式

理想关系应接近：

```text
session observation
  → episode（发生了什么）
  → canonical fact / decision / convention（可复用结论）
  → wiki synthesis（多事实组织后的知识）
```

当前数据库已有 lineage、source、evidence 等结构，但需要核查实际 pipeline 是否始终维护：

- Wiki 页面由哪些 memory items 支撑；
- 事实被归并后，Wiki 是否自动更新；
- 事实归档或失效后，Wiki 是否标记陈旧；
- 同一正文是否在多个层级无差别复制；
- episode 是否有明确的保留期限和复用标准。

---

# 6. Token 与错乱风险

## 已解决：Codex 被动自动召回

此前 Codex `UserPromptSubmit` hook 可运行 `memory-recall-context.js`。该 hook 不是无条件注入，但会每轮执行意图检查，并在命中时自动加入历史上下文。

当前默认已调整为：

- 通过 MetaMe MCP 按需调用 `memory_search` / `memory_recall`；
- 不默认安装自动 recall hook；
- 只有设置 `METAME_CODEX_MEMORY_RECALL=on` 才启用 legacy 自动召回。

这降低了隐式上下文污染风险。

## 仍需控制的风险

1. 搜索返回重复 facts，浪费 token。
2. Wiki 与 facts 同时返回相同内容，造成重复。
3. 当前 thread 已包含某事实，MCP 又召回一次。
4. 错误 scope 的长期规则注入其他项目。
5. 过期事实和新事实同时命中，导致模型冲突。
6. Agent 在无明确需求时过度调用多个记忆工具。

建议搜索结果包含：

```json
{
  "type": "fact | episode | wiki | profile",
  "id": "...",
  "title": "...",
  "content": "...",
  "project": "...",
  "scope": "...",
  "confidence": 0.9,
  "freshness": "...",
  "provenance": [...],
  "canonical_id": "...",
  "score": 0.82
}
```

并在返回 MCP 前做跨类型去重与 token budget 控制。

---

# 7. 建议专家重点回答的问题

## 查询与消费接口

1. `memory_search` 应统一搜索 facts、episodes、Wiki，还是拆分为多个工具？
2. 如果统一，跨类型结果如何排名、去重和预算分配？
3. 显式调用 `memory_recall` 时是否还应该由 `planRecall` 二次拒绝？
4. Wiki 应返回摘要、excerpt，还是完整页面？
5. 如何避免当前对话已有内容被长期记忆重复召回？

## 提炼与质量治理

6. Session observation 晋级为 episode/fact/convention 的标准是什么？
7. 多个 session 提取出相同事实时，应该合并正文还是保留多条记录？
8. 如何设计 provenance，使合并不损失证据？
9. convention 是否需要更高门槛、用户确认或跨 session 复现？
10. episode 的保留期限和 GC 策略应该是什么？

## Wiki

11. Wiki 应是事实的派生视图，还是独立可编辑知识资产？
12. 事实更新、归档、冲突时，Wiki 如何同步？
13. topic hub / dossier 是否真的适合 Agent 检索？
14. 如何衡量 Wiki 的实际消费率和任务增益？

## 可观测性

15. 如何分离 promotion 信号与 consumption audit？
16. 如何统计不同宿主的 MCP 工具命中、空结果、延迟和 token 返回量？
17. 应建立哪些离线 benchmark 来评估 precision、recall、staleness、duplication？
18. 如何在不保存额外敏感正文的前提下完成审计？

## 跨宿主治理

19. 是否应由 MetaMe 统一安装和检测 Claude/Codex/Gemini/Pi 的 MCP 配置？
20. 如何保证 Agent 指令里提到的工具与宿主实际可用工具一致？

---

# 8. 建议的优雅完善目标

专家方案应尽量满足：

1. 不复制各 Agent 的原始 session。
2. 不推倒现有 `memory_items + wiki_pages + session_sources` 架构。
3. MCP 保持较少、语义清晰的工具数量。
4. 所有记忆默认按需消费，不默认每轮注入。
5. 事实正文 canonical 化，多来源通过 provenance 表达。
6. Wiki 成为可搜索、可追溯、可更新的综合知识层。
7. 搜索结果跨类型去重，并受 token budget 控制。
8. 质量晋级信号与真实消费审计解耦。
9. 各宿主通过统一安装/doctor 命令接入。
10. 每项优化能够通过指标验证，而非凭感觉判断。

---

# 9. 建议的实施优先级（供专家调整）

## Phase 1：修正消费契约

- 修复 `memory_search` 描述与实现不一致；
- 接入 Wiki 搜索；
- 设计统一分型结果；
- 改善 `memory_recall` 显式调用语义；
- 添加 MCP consumption audit。

## Phase 2：质量治理

- 审计 100 条 convention 样本；
- 修复 exact duplicate；
- canonical item 与 provenance 分离；
- 明确 episode/fact/convention 晋级规则；
- 加强 project/scope 隔离。

## Phase 3：Wiki 消费闭环

- Wiki 直接搜索；
- facts ↔ Wiki lineage 校验；
- Wiki staleness 和自动更新；
- 评估 topic hub/dossier 的真实任务增益。

## Phase 4：跨宿主产品化

- `metame mcp install/status/doctor`；
- Claude/Codex/Gemini/Pi 能力矩阵；
- 配置漂移检测；
- 统一使用与质量仪表盘。

---

# 10. 审查时请避免的误判

1. `facts` legacy 表为空，不代表 MetaMe 没有 facts；当前事实主要在 `memory_items`。
2. `search_count = 0` 不代表从未被 MCP 消费；MCP 搜索当前明确使用 `trackSearch: false`。
3. Wiki 与 facts 内容相似不必然是冗余；关键是 Wiki 是否承担综合、组织和解释职责。
4. 记忆数量多不必然表示质量差；需要抽样 precision 和实际任务增益。
5. Context-mode FTS5、Codex session 和 MetaMe memory 服务不同职责，不应简单合并。
6. 当前问题主要在消费契约、质量治理和可观测性，而不是总体架构方向错误。

---

## 附：关键代码入口

- MCP 服务：`scripts/metame-mcp-server.js`
- 记忆 API：`scripts/memory.js`
- 召回编排：`scripts/memory-recall.js`
- 召回计划：`scripts/core/recall-plan.js`
- 召回准备与审计：`scripts/core/recall-prepare.js`
- Hybrid Wiki 搜索：`scripts/core/hybrid-search.js`
- Wiki DB：`scripts/core/wiki-db.js`
- 主动写入：`scripts/memory-write.js`
- Session 提炼：`scripts/memory-extract.js`
- 记忆清理：`scripts/memory-gc.js`
- 来源索引：`scripts/core/session-source-db.js`
- Codex 宿主接入：`scripts/core/codex-host.js`
