# Recall × Wiki 联动升级方案（合并最终版）

> **本文件**：后续执行的**单一信息源**。从两份草稿（一份 tech-debt 列表 + 一份 pushdown-filter plan）合并而来，原稿已删除以避免分裂的真相。
>
> **基线**：Quality Sweep 完成后的 `fix/recall-quality-sweep` 分支（commit `66d84f9`，Codex 96/100 SHIP_READY）
> **创建日期**：2026-05-04

---

## 0. 背景

Quality Sweep 完成后做了一次 recall ↔ wiki 联动审查（agent 走查 30+ 文件），结论是**1 个真 bug + 3 项历史装修债**。

- 总体联动优雅度 **8.5 / 10** —— 核心做对了：召回全程通过 `hybridSearchWiki` facade 复用 wiki 搜索栈；DDL 单源；GC retention 不强行合并；timeout 不抽假复用。
- 失分集中在 1 个真问题（多项目下召回不到本项目 wiki）和 3 处遗留装修。

本文件把所有跟进事项整成一个有依赖关系的执行计划。

---

## 1. 问题清单（按优先级）

| # | 类型 | 位置 | 严重度 | 行动 |
|---|------|------|--------|------|
| **A** | 真 bug — 多项目召回盲区 | `memory-recall.js:138-173` + `core/hybrid-search.js:71-95,290` | **P0** | 见 §2 Phase A |
| **B-1** | 装修 — `getWikiTopicTags` 错位 | `memory.js:596-610` | P2 | **被 Phase A Step 5 自动淘汰** |
| **B-2** | 装修 — `applyWikiSchema` 名实不符 | `memory-wiki-schema.js:25,285-291` | P2 | 独立 PR（见 §3） |
| **B-3** | 测试 — wiki 缺 daemon 级 e2e | 缺 `daemon-wiki-e2e.test.js` | P2 | 独立 PR（见 §3） |

> **依赖关系一句话**：Phase A 执行后，B-1 自动消失；B-2 / B-3 跟 Phase A 完全正交，独立 PR 即可。

---

## 2. Phase A · Pushdown Filter（P0，修真实 bug）

### 2.1 真实代码证据（基线 `66d84f9`）

| 位置 | 现状 |
|------|------|
| `scripts/memory-recall.js:143-148` | 调 `hybridSearchWiki` 无 scope 参数 |
| `scripts/memory-recall.js:163-172` | JS 层 post-retrieval 过滤（`tagsBySlug` 交集） |
| `scripts/core/hybrid-search.js:71-74` | FTS5 SQL 无 tag 谓词 |
| `scripts/core/hybrid-search.js:91-95` | vector 全表扫，无 scope 限制 |
| `scripts/core/hybrid-search.js:290` | 硬编码 `wikiPages.slice(0, 5)` —— cap-after-rank |

**症状**：跨项目部署时全库 RRF top-5 全是别项目的页面 → JS 后过滤把 5 条全砍 → `wikiDropped:true`。本项目最匹配的页面排在第 6 名 → 永远进不了 prompt。

### 2.2 Worktree

- 新建：`/Users/yaron/AGI/MetaMe-worktrees/wiki-pushdown-filter`
- 分支：`feat/wiki-pushdown-filter`
- 起点：**`fix/recall-quality-sweep` 合到 main 之后的 main HEAD**（不基于 sweep 分支）
- 理由：sweep 已 SHIP_READY，本次会改 `wikiDropped` 语义和测试断言，不能在已锁定契约里乱动

### 2.3 六步小步快进

#### Step 1 · `hybridSearchWiki` API 表面扩展（零行为变更）

`scripts/core/hybrid-search.js:192`：

```js
async function hybridSearchWiki(db, query, {
  ftsOnly = false,
  trackSearch = true,
  filterTags = [],   // ← 新增：空数组 = 不过滤（向后兼容）
} = {}) { ... }
```

本步**只接收参数不使用**，底层 `ftsSearch` / `vectorSearch` 还按原路走。

测试：现有 `hybrid-search.test.js` 全 PASS（验证向后兼容默认值）。

#### Step 2 · FTS Pushdown

`scripts/core/hybrid-search.js:63-78` (`ftsSearch`) SQL 改为：

```sql
SELECT wp.slug, wp.title, wp.staleness, wp.last_built_at,
       snippet(wiki_pages_fts, 2, '<b>', '</b>', '...', 20) as excerpt,
       rank as ftsRank
FROM wiki_pages_fts
JOIN wiki_pages wp ON wiki_pages_fts.rowid = wp.rowid
WHERE wiki_pages_fts MATCH ?
  AND (
    ?  -- bind: filterTags.length === 0 ? 1 : 0
    OR EXISTS (SELECT 1 FROM json_each(wp.topic_tags)
               WHERE value IN (?, ?, ?))  -- placeholder 数量 = filterTags.length
  )
ORDER BY rank
LIMIT ?
```

> placeholder 动态拼接（先例：`memory.js:602`），仍走 prepared statement 的 `?` 绑定，**禁止字符串拼接**。

测试：种 3 页（tags=`['proj-a']` / `['proj-b']` / `['proj-a','proj-b']`），分别用 `filterTags=['proj-a']` / `[]` / `['nope']` 验证返回数量。

#### Step 3 · Vector Pushdown + `hasStoredEmbeddings` scope-aware

`scripts/core/hybrid-search.js:88-109` (`vectorSearch`)：

```sql
SELECT cc.page_slug, cc.chunk_text, cc.embedding
FROM content_chunks cc
JOIN wiki_pages wp ON cc.page_slug = wp.slug
WHERE cc.embedding IS NOT NULL
  AND (
    ?  -- 同 Step 2 的"无过滤"标志
    OR EXISTS (SELECT 1 FROM json_each(wp.topic_tags)
               WHERE value IN (?, ?, ?))
  )
```

**关键**：是真 SQL pushdown，**不**走"全捞 chunks 再 JS continue"的伪 pushdown。让 SQL 直接少返回行，heap 在过滤集上做 top-K。

`hasStoredEmbeddings(db)` (`hybrid-search.js:115`) 也加 `filterTags`：项目内无 embedded chunks 时返回 false，避免无谓地调 OpenAI embed API。

测试：跨项目种 chunks，验证 filter 收紧/松开两侧；项目内无 embedding 时 `hasStoredEmbeddings` → false。

#### Step 4 · 串通 + 切召回端

- `scripts/core/hybrid-search.js:192-291` 把 `filterTags` 传给 `ftsSearch` 和 `vectorSearch`
- `scripts/memory-recall.js:138-173` `_searchWiki` 重写：

```js
async function _searchWiki(query, scope, search) {
  if (!query) return { items: [], dropped: false };
  const desired = [scope.project, scope.workspaceScope, scope.agentKey].filter(Boolean);
  let wikiPages = [];
  try {
    const result = await memory.hybridSearchWiki(query, {
      ftsOnly: !!search.ftsOnly,
      trackSearch: false,
      filterTags: desired,    // ← 下推
    });
    wikiPages = (result && Array.isArray(result.wikiPages)) ? result.wikiPages : [];
  } catch { return { items: [], dropped: false }; }

  return {
    items: wikiPages.map(p => ({
      text: p.excerpt || p.title,
      source: { kind: 'wiki', slug: p.slug },
    })),
    dropped: false,    // ← Pushdown 后 "drop" 概念消失：返回为空就是真没有
  };
}
```

**砍掉**：
- `tagsBySlug = memory.getWikiTopicTags(slugs)` 整行
- `kept` 数组重组循环
- `dropped: kept.length === 0` 信号

测试：种 6 个 wiki 页面（5 proj-b + 1 proj-a），proj-a 页面在全局 RRF 第 6 名 → 不带 filter 验证 bug 重现 → 带 `filterTags=['proj-a']` 验证 proj-a 页面**出现**在结果。

#### Step 5 · 死码清理（吸收原 Tech Debt B-1）

> ⚠️ **本步淘汰原 Tech Debt P2-1**（`getWikiTopicTags` 迁回 `core/wiki-db.js`）。Pushdown 后此函数无 caller，**不迁，直接删**。

操作：
1. `rg "getWikiTopicTags"` 全仓搜，确认仅 `memory.js` 自己定义
2. 删 `scripts/memory.js:591-610` 整段 `getWikiTopicTags`
3. `recall_audit.wiki_dropped` 列**保留**（schema 不动），代码侧总是写 0
4. `scripts/core/recall-audit-db.js` 的 `wikiDropped` 字段在 `recordAudit` 里继续接但永远写 0

#### Step 6 · 测试套更新 + 源码 invariant

- `scripts/memory-recall.test.js` — 删 `wikiDropped: true` 期望，加 cross-project pushdown 测试
- `scripts/core/recall-prepare.test.js` — 同步
- `scripts/daemon-recall-e2e.test.js` — 加 e2e：mock 跨项目 wiki，验证只有 desired tag 的页面进 prompt
- 加 source-invariant：`scripts/memory-recall.js` 不能再 require `getWikiTopicTags`（防回退）

> **注意**：本步加的是**召回侧**跨项目 e2e，**不**等于原 Tech Debt P2-3（wiki 侧 `/wiki rebuild` daemon e2e）。两者正交。

#### Step 7 · Codex 全面审查

整个分支送 codex:codex-rescue：

```
审查 wiki pushdown 全部 6 步：
  1. SQL pushdown 是否正确（json_each EXISTS 的 placeholder 拼接、注入风险、filterTags=[] 的 OR 短路）
  2. 是否真消除 Top-K 盲区（构造 rank-6 case 证明能召回到）
  3. 向后兼容：memory-search.js:103 / daemon-wiki.js:134 这两个不传 filterTags 的 caller 行为是否完全没变
  4. 性能/内存/漏 chunk 等新坑
  5. 测试覆盖 + 源码 invariant 是否对得起"多项目隔离生效"承诺
```

PASS 才能 ship。目标 ≥ 90/100。

### 2.4 Critical Files（Phase A）

#### 修改

| 文件 | Step | 变化 |
|------|------|------|
| `scripts/core/hybrid-search.js` | 1, 2, 3, 4 | filterTags 参数 + FTS/vector SQL pushdown + `hasStoredEmbeddings` scope-aware |
| `scripts/memory-recall.js` | 4 | `_searchWiki` 重写，砍 JS 后过滤 |
| `scripts/core/recall-audit-db.js` | 5 | `wiki_dropped` 永远写 0（保留列） |

#### 删除

| 删除目标 | Step | 条件 |
|----------|------|------|
| `scripts/memory.js` 内 `getWikiTopicTags`（591-610） | 5 | rg 确认无 caller |

#### 不动

`scripts/core/recall-plan.js` / `recall-budget.js` / `recall-format.js` / `recall-redact.js` / `recall-audit-ddl.js` / `memory-wiki-schema.js`（Phase B-2 才动）

#### 新建

`scripts/core/hybrid-search.pushdown.test.js`（或扩展现有 `hybrid-search.test.js`）

#### 不确定 / 不动（独立 PR 评估）

- `scripts/memory-search.js:103` — `/recall search` generic facade，**默认 filterTags=[]**，行为不变。要不要也接 scope 加过滤？放独立 PR。
- `scripts/daemon-wiki.js:134` — `/wiki search <query>` 用户命令，用户视角是"搜全库"，不该自动加项目过滤。本次不动。

### 2.5 时间估算（Phase A）

| Step | 估时 |
|------|------|
| 1 — API 表面扩展 | 15 min |
| 2 — FTS pushdown | 45 min（含测试） |
| 3 — Vector pushdown + hasStoredEmbeddings | 1 hr |
| 4 — 串通 + 切召回 | 45 min |
| 5 — 死码清理 | 15 min |
| 6 — 测试套更新 + invariant | 1 hr |
| 7 — Codex review + 修问题 | 1.5 hr（含可能的一轮 fix） |
| **小计** | **~5 小时** |

---

## 3. Phase B · 装修跟进（P2，独立 PR）

> Phase B 各项**互相独立**，跟 Phase A 也独立（除了 B-1 被 Phase A 自动吸收）。可以在 Phase A merge 前/后任意时点开。

### B-1 · `getWikiTopicTags` 迁回 wiki-db ⚠️ **被 Phase A 淘汰**

| 字段 | 状态 |
|------|------|
| 原计划 | 把 `getWikiTopicTags` 从 `memory.js:596-610` 迁到 `core/wiki-db.js` |
| 现状 | **不再需要** —— Phase A Step 5 直接删除该函数（pushdown 后无 caller） |
| 行动 | 不开独立 PR；执行 Phase A 即自动闭合 |

### B-2 · `applyWikiSchema` 命名/职责拆分

**位置**：`scripts/memory-wiki-schema.js:25` (函数定义) + `285-291` (Step 7 Quality Sweep 加的 audit_state DDL)

**现状**：函数叫 `applyWikiSchema`，实际 apply 的内容已远超 wiki：
- wiki_pages / wiki_topics / wiki_pages_fts / content_chunks / embedding_queue（原本就有）
- session_sources / doc_sources（research 域）
- paper_facts / research_entities / fact_entity_links（research 域）
- recall_audit + recall_audit_state（Quality Sweep Step 7 加的）
- memory_review_decisions（reflection 域）

**为什么是债**：名字误导新接手者；未来加新表又要往这个 misleading 名字下塞。

**不是 bug 的原因**：DDL 都是 `IF NOT EXISTS`，幂等。**正确性**没问题，只是**可读性**烂。

**两种修法**：

- **方案 A（轻改名）**：把 `applyWikiSchema` 重命名为 `applyMemoryDbSchema`，update 4 个 caller（`memory.js:118`、`memory-gc.js:169`、`memory-wiki-schema.js:285` 自引、多处 test）。≤ 30 min。
- **方案 B（拆三家，推荐）**：
  ```
  applyWikiSchema(db)       — wiki_pages / wiki_topics / wiki_pages_fts / content_chunks / embedding_queue
  applyResearchSchema(db)   — session_sources / doc_sources / paper_facts / research_entities / fact_entity_links
  applyAuditSchema(db)      — recall_audit / recall_audit_state / memory_review_decisions
  ```
  在 `memory.js:118` 的 `getDb()` 里依次 apply 三个。~1 hr（含测试）。

**Blast radius**：中等。4 处 require，简单替换无逻辑改动。

**估时**：方案 A ≤ 30 min；方案 B ~1 hr。

### B-3 · Wiki daemon 级 e2e 测试

**位置**：缺失 `scripts/daemon-wiki-e2e.test.js`

**现状**：
- `daemon-wiki.test.js` —— 只测 command handler 单元层
- `wiki-reflect-build.test.js` —— 只测 buildWikiPage / writeWikiPageWithChunks 等纯函数
- **没有** daemon 级 e2e 锁住"用户飞书发 `/wiki rebuild` → daemon 调用链 → bot.sendCard 输出"全路径
- 也**没有** source-invariant 锁住 daemon-claude-engine.js 的 wiki 命令接线

**为什么是债**：召回侧已有 `daemon-recall-e2e.test.js`（fixture + source invariants），wiki 侧没有对称覆盖。未来重构 daemon 命令分发，wiki 路径可能悄悄断而无人察觉。

> **关键**：Phase A Step 6 加的是**召回侧**跨项目 e2e（在 `daemon-recall-e2e.test.js` 里加 case），**不是** wiki 侧。两者完全正交。

**修法**：参照 `scripts/daemon-recall-e2e.test.js:62-140` 的 `runDaemonRecallTurn` fixture 模式，新建 `scripts/daemon-wiki-e2e.test.js`，覆盖 2-3 条主路径：

```
1. /wiki rebuild <slug>:
   - mock bot.sendCard 验证 progress card 调用
   - 跑完 verify wiki_pages 行存在 + content_chunks 有行
   - cleanOutput 不含 marker 残留

2. /wiki list:
   - 种 3 个 wiki_pages
   - mock bot.sendCard 验证 list 内容

3. source-invariant：
   - 锁定 daemon-claude-engine.js 必须 require wiki-reflect-build
   - /wiki 命令路由必须在 SKILL_ROUTES 里
   - 关键参数（chatId / db / topic）必须 plumbed
```

**Blast radius**：零（纯新增测试文件）。

**估时**：~2 hr。fixture 已有模板，主要工作是 mock setup + 3-4 个 assertion。

---

## 4. 执行顺序与依赖

```
当前 main (sweep merge 后)
    │
    ├──► Phase A (feat/wiki-pushdown-filter)
    │      [P0 真 bug, ~5 hr, 含 Codex review]
    │      └─ Step 5 自动闭合 B-1
    │
    │   并发可启动（互不依赖）：
    ├──► Phase B-2 (chore/applywiki-rename-or-split)
    │      [P2 装修, ~30 min - 1 hr]
    │
    └──► Phase B-3 (test/wiki-daemon-e2e)
           [P2 测试补强, ~2 hr]
```

**推荐顺序**：

1. **先做 Phase A** —— 它修真 bug，价值最大。
2. **再做 B-3**（wiki e2e） —— 投入小、零 blast、给后续重构兜底。
3. **最后做 B-2**（schema 拆家） —— blast radius 最大，等其他两件落定再动避免 merge 冲突。

**总投入估算**：~8 小时（Phase A ~5 + B-2 ~1 + B-3 ~2）。三件可并行（不同 worktree），实际墙钟时间可压缩到 ~5 小时。

---

## 5. 工程纪律红线（全局）

适用于本文件下所有 PR：

1. **向后兼容硬要求** —— 已有 caller 不传新参数时行为必须完全等价旧行为。Phase A 中 `filterTags=[]` 默认值是这条的具体落实。
2. **SQL 注入防护** —— `filterTags` 是 scope 字符串，但仍走 prepared statement 的 `?` 绑定，禁止字符串拼接。
3. **byte-identical baseline 不破** —— `daemon-prompt-context.test.js` 期望应仍 PASS（recall=off 路径未变）。
4. **每个新 export 在本步内有 caller**（含测试）。
5. **每个删除的函数确认无 caller**（rg 确认 + 跑回归）。
6. **每个 fix 配测试** —— core 纯逻辑走 `core/*.test.js`，集成走 `daemon-*.test.js`。
7. **ESLint 0 errors**。
8. **schema 只增不减** —— `recall_audit.wiki_dropped` 列即便代码侧不再写也保留，避免破坏观察期数据合约。

---

## 6. 测试矩阵（Phase A）

| 维度 | 测试位置 | 覆盖点 |
|------|----------|--------|
| FTS pushdown — IN-list 命中 | `hybrid-search.test.js` | 多 tag 命中 / 单 tag 命中 |
| FTS pushdown — IN-list 未命中 | 同上 | filterTags 中无任何匹配 → 返回 0 |
| FTS pushdown — 向后兼容 | 同上 | filterTags=[] 等价于无 filter |
| Vector pushdown — JOIN 收紧 | 同上 | 跨项目 chunks 只返回项目内 |
| `hasStoredEmbeddings` scope-aware | 同上 | 全库有 embed 但项目无 → 返回 false |
| 集成 — Top-K 盲区修复证据 | `memory-recall.test.js` | rank-6 项目页能被召回 |
| daemon e2e — 多项目隔离 | `daemon-recall-e2e.test.js` | 跨项目 wiki 在 prompt 里只出现 desired |
| 源码 invariant — 死码清理 | 新增或扩展 | `_searchWiki` 不能再调 `getWikiTopicTags` |
| 向后兼容 — 非 recall caller | `memory-search.test.js` 等 | 不传 filterTags 行为不变 |

---

## 7. Codex Review Gate 模板

每步代码 + 测试 + invariants 全绿后送审：

```
Agent({
  subagent_type: "codex:codex-rescue",
  description: "Codex review wiki pushdown step N",
  prompt: "审查 wiki pushdown step N: <files>。
           worktree: /Users/yaron/AGI/MetaMe-worktrees/wiki-pushdown-filter
           对照本计划 Step N 的修复要求：
             1. SQL 是否正确（json_each EXISTS、placeholder、注入）
             2. 向后兼容（filterTags=[] 等价于不过滤）
             3. 测试是否覆盖正反两面（filter ON 收紧 / filter OFF 等价旧行为）
             4. §0.5 工程纪律（Unix / 复用 / 无死码 / 无断口 / 无冗余）
           不跑 node --test（沙箱 EPERM），允许 cat / rg / git。
           PASS / FAIL + ≤3 必修问题。"
})
```

---

## 8. 完成判定

### Phase A（P0 必须）

通过 6 步全部 Codex review PASS 后：
- 多项目下任意项目都能召回到本项目 wiki，与全局 RRF 排名无关
- 跨项目"误读他项目 wiki"的概率为 0（pushdown SQL 保证）
- 代码砍掉 ~30 行 JS 后过滤逻辑
- 全库测试 0 fail（基线 9 个 main-branch 失败保持，不引入新失败）
- 派 Codex 整体生产就绪审查 ≥ 90/100

### Phase B（P2，独立交付）

- B-2：`applyWikiSchema` 拆三家或重命名，4 处 caller 同步，全测试 PASS
- B-3：`daemon-wiki-e2e.test.js` 加 2-3 条 e2e + source invariant，wiki 路径有日级别 e2e 兜底

---

## 9. 状态跟踪

| 项目 | 状态 | 分支 | 当前归属 |
|------|------|------|----------|
| Phase A · Pushdown Filter | 📋 计划已落地，等批准执行 | `feat/wiki-pushdown-filter` (待建) | — |
| Phase B-1 · `getWikiTopicTags` 迁移 | ⚠️ **被 Phase A 淘汰** | — | 不开 PR |
| Phase B-2 · `applyWikiSchema` 拆/改名 | 📋 待领 | `chore/applywiki-rename-or-split` (待建) | — |
| Phase B-3 · Wiki daemon e2e | 📋 待领 | `test/wiki-daemon-e2e` (待建) | — |

---

## 10. 不在本方案范围

下面这些是审查里看过的、**已经做对、不要动**的：

- recall 全程通过 `hybridSearchWiki` facade 复用 wiki 搜索栈 —— 分层正确
- `recall-audit-ddl.js` 单源 DDL —— 共享机制就该这样
- `sync-plugin` stale-dest cleanup（Quality Sweep blocker fix）—— 已是真共享，wiki 部署天然受益
- `_askState` 容器 / drop counter / dual-signal —— 是为 recall 特定语义而生，wiki 无对称需求，不强凑复用
- `_withTimeout` inline 不 export —— 当前只有一个 caller，抽 `core/timeout.js` 是为复用而复用
- `topic_tags` 规范化为多对多表 + 索引 —— `json_each` pushdown 在当前 wiki 规模够用；规模上去再做 schema migration 是另一个 PR

闭眼别动。

---

## 附录 A · 修订历史

| 日期 | 动作 | 备注 |
|------|------|------|
| 2026-05-04 | 创建合并版（本文件） | 起源于 recall ↔ wiki 联动审查，合并两份草稿（tech-debt 列表 + pushdown plan）后两份原稿删除 |

后续维护 / 更新只动本文件。
