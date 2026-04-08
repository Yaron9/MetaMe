# MetaMe LLM Wiki 集成规划
> 状态: v0.4 — 第三轮 Codex 审查修订  
> 作者: Jarvis  
> 日期: 2026-04-08

---

## 一、问题定义

MetaMe 的记忆系统已能沉淀原子事实（`memory_items`）和实体剧本（`capsules/`），但缺少一个**面向用户的、主题式知识页层**。用户问"session 管理是怎么工作的"，系统能搜到 10 条分散的 insight，但没有一篇连贯的、可沉淀的知识页。

**目标：** 用 LLM Wiki 模式在现有记忆层之上构建主题知识页层，以 Obsidian 格式输出，让用户的知识真正可以积累、可以检索。

---

## 二、核心设计原则

1. **DB 为真相源，Markdown 为导出缓存**：`wiki_pages` 表是 authoritative，`.md` 文件是可重建的导出物，任何时候 `rebuildWikiFiles()` 可完整重建。
2. **来源白名单防闭环**：Wiki 来源只取 `relation NOT IN ('synthesized_insight','knowledge_capsule')` 的 raw facts，capsule 仅作辅助摘要。
3. **staleness 写在统一入口**：`memory.js::saveFacts` 批次聚合 dirty tags，一次 UPDATE，不逐条触发。
4. **受控主题三重门槛**：active raw facts ≥ 5 AND 30d 内有新增 AND（已在 wiki_topics 中 OR 用户手工 pin）。
5. **整页重建 + 程序保留 frontmatter**：不把旧页全文喂给 LLM，消除累积重复。
6. **trackSearch 语义明确**：用户命令 `true`，系统内部（wiki-reflect / nightly-reflect）`false`。
7. **进程锁 + 单页事务**：wiki-reflect 用文件锁防并发，每页写入用 BEGIN/COMMIT，失败不影响其他页。

---

## 三、现有系统层次与边界

```
对话 JSONL
   ↓  memory-extract.js
memory_items (SQLite, FTS5)
   ├── raw facts:    relation ∉ {synthesized_insight, knowledge_capsule}
   └── derived:      relation ∈ {synthesized_insight, knowledge_capsule}  ← nightly-reflect 回写
   ↓  memory-nightly-reflect.js (按 entityPrefix 分组)
capsules/  (实体剧本)
   ↓  wiki-reflect.js (按受控主题，NEW)
wiki/  (主题知识页, Obsidian .md)
```

**关键边界：**
- nightly-reflect 产物（derived）会回写 `memory_items`，wiki 来源过滤必须用 `relation` 字段，而非 `source_type`。
- capsule 按 `entityPrefix` 组织，不是按 tag；wiki 不能把 capsule tag 当 wiki topic。

---

## 四、数据模型

### 4.1 wiki_pages 表

```sql
CREATE TABLE IF NOT EXISTS wiki_pages (
  id              TEXT PRIMARY KEY,        -- wp_<timestamp>_<random>
  slug            TEXT UNIQUE NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,           -- 纯正文，不含 frontmatter
  primary_topic   TEXT NOT NULL,           -- 归属主题 tag（与 wiki_topics.tag 1:1，staleness 的唯一计算依据）
  topic_tags      TEXT DEFAULT '[]',       -- JSON array，含 primary_topic + 次级 tag（仅供检索命中，不触发 staleness）
  raw_source_ids  TEXT DEFAULT '[]',       -- JSON array，来源 memory_item IDs
  capsule_refs    TEXT DEFAULT '[]',       -- JSON array，辅助 capsule 文件名
  staleness       REAL DEFAULT 0.0,        -- [0, 1.0]
  raw_source_count INTEGER DEFAULT 0,      -- wiki-reflect 建页时 primary_topic 的 raw facts 数（staleness 分母）
  new_facts_since_build INTEGER DEFAULT 0, -- 建页后 primary_topic 新增 raw facts 数（staleness 分子）
  word_count      INTEGER DEFAULT 0,
  last_built_at   TEXT,                    -- wiki-reflect 最后一次重建内容的时间（用户可见"更新于"）
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))  -- 行最后修改时间（含 staleness 更新），不对外展示
);

-- FTS5：content table 模式，依赖 trigger 同步
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts USING fts5(
  slug, title, content, topic_tags,
  content='wiki_pages',
  content_rowid='rowid',
  tokenize='trigram'
);

-- FTS5 同步 triggers
CREATE TRIGGER IF NOT EXISTS wiki_pages_fts_insert
  AFTER INSERT ON wiki_pages BEGIN
  INSERT INTO wiki_pages_fts(rowid, slug, title, content, topic_tags)
    VALUES (new.rowid, new.slug, new.title, new.content, new.topic_tags);
END;

CREATE TRIGGER IF NOT EXISTS wiki_pages_fts_update
  AFTER UPDATE ON wiki_pages BEGIN
  DELETE FROM wiki_pages_fts WHERE rowid = old.rowid;
  INSERT INTO wiki_pages_fts(rowid, slug, title, content, topic_tags)
    VALUES (new.rowid, new.slug, new.title, new.content, new.topic_tags);
END;

CREATE TRIGGER IF NOT EXISTS wiki_pages_fts_delete
  AFTER DELETE ON wiki_pages BEGIN
  DELETE FROM wiki_pages_fts WHERE rowid = old.rowid;
END;
```

**Staleness 公式：**
```
staleness = new_facts_since_build / (raw_source_count + new_facts_since_build)
```
- 写入点：`saveFacts()` 批次结束后，按本批 dirty tags 一次性 UPDATE
- 触发重建阈值：staleness ≥ **0.4**（`/wiki sync` 与周任务使用同一阈值，保持幂等）

### 4.2 wiki_topics 表

```sql
CREATE TABLE IF NOT EXISTS wiki_topics (
  tag         TEXT PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,    -- NOT NULL，防 GC 的 NOT IN 失效
  label       TEXT NOT NULL,           -- 显示名称
  pinned      INTEGER DEFAULT 0,       -- 1=用户手工 pin，GC 保护
  created_at  TEXT DEFAULT (datetime('now'))
);
```

**主题注册责任点（明确）：**
- `saveFacts()` 批次写入后，对满足门槛的 dirty tags 调用 `upsertWikiTopic(tag)`
  - 门槛：该 tag 的 active raw facts ≥ 5 AND 30d 内有新增
  - slug 由 `core/wiki-slug.js::toSlug(tag)` 生成：
    ```javascript
    function toSlug(tag) {
      const base = tag.toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5 -]/g, '')  // 只保留字母/数字/中文/空格/连字符
        .replace(/\s+/g, '-')
        .replace(/-{2,}/g, '-')
        .slice(0, 80);
      if (!base) throw new Error(`tag "${tag}" 归一化后为空串，不允许注册`);
      return base;
    }
    // 示例: "Session 管理 / v2" → "session-管理-v2"

    // slug 碰撞处理（两个不同 tag 归一化后相同）：
    // upsertWikiTopic 插入前检查 wiki_topics 中是否已有相同 slug 但不同 tag；
    // 若碰撞，在 slug 末尾追加数字后缀直到唯一（-2、-3...），最多尝试 10 次，超出则报错拒绝注册。
    ```
  - label 由程序生成（转换失败则留 tag 原值，等用户 `/wiki pin` 修正）
- 用户 `/wiki pin <tag> <title>`：强制 upsert，跳过门槛，pinned=1

### 4.3 Staleness 更新 SQL（可执行）

**设计说明：** `new_facts_since_build` 是累计计数器，`saveFacts` 批次直接自增，不重新查询 watermark——避免了 LIKE 匹配 JSON 和标量子查询的歧义。`last_built_at` 是内容重建时间（wiki-reflect 写，用户可见），`updated_at` 是行修改时间（含 staleness 自增，不对外展示）。

```javascript
// saveFacts() 批次结束后执行，dirtyTags = Map<tag, newCount>
// newCount = 本批写入中命中该 tag 的 raw facts 数
function updateStalenessForTags(db, dirtyTagCounts) {
  for (const [tag, newCount] of dirtyTagCounts) {
    if (newCount <= 0) continue;
    // 只对 primary_topic 精确匹配，次级 tag 不触发 staleness
    db.prepare(`
      UPDATE wiki_pages
      SET new_facts_since_build = new_facts_since_build + ?,
          staleness = MIN(1.0,
            CAST(new_facts_since_build + ? AS REAL)
            / NULLIF(raw_source_count + new_facts_since_build + ?, 0)
          ),
          updated_at = datetime('now')
      WHERE lower(trim(primary_topic)) = lower(?)
    `).run(newCount, newCount, newCount, tag);
  }
}
// wiki-reflect 重建页面后，重置计数器并更新 last_built_at
// db.prepare(`UPDATE wiki_pages
//   SET staleness=0, new_facts_since_build=0, raw_source_count=?,
//       last_built_at=datetime('now'), updated_at=datetime('now')
//   WHERE slug=?`).run(totalCount, slug);  // totalCount = Step 1 无 LIMIT 总数，非 rawFacts.length
```
```

### 4.4 文件系统布局（Obsidian 兼容）

```
~/.metame/wiki/                    # 默认，可在 daemon.yaml 配置 wiki_output_dir
├── _index.md                      # MOC，程序生成
├── _meta.yaml
├── session-management.md
├── model-switching.md
└── ...
```

Frontmatter（程序负责，不由 LLM 输出）：
```yaml
---
title: Session 管理
slug: session-management
tags: [session, resume, engine]
created: 2026-04-08
last_built: 2026-04-08     # wiki-reflect 最后重建内容的时间（用户可见"更新于"）
raw_sources: 14
staleness: 0.0
---
```

### 4.5 合成流程：wiki-reflect

```
进程锁：wiki-reflect.lock（O_EXCL，10min 超时检测）

触发条件（任一）：
  - 每周一本地 03:00（scripts/daemon-default.yaml）
  - staleness ≥ 0.4 的页存在
  - 用户执行 /wiki sync

算法：
1. 取进程锁（失败则退出，记录 skipped）
2. 读取所有 wiki_topics
3. 对每个 topic（失败单页不中断，记 failed_slugs）：
   a. 分两步查询 raw facts（两步分开，确保 raw_source_count 不被截断）：

      -- Step 1: 获取真实总数（staleness 分母，不加 LIMIT）
      SELECT COUNT(*) as totalCount FROM memory_items mi
      JOIN json_each(mi.tags) jt ON lower(trim(jt.value)) = lower(:tag)
      WHERE mi.state = 'active'
        AND (mi.relation NOT IN ('synthesized_insight','knowledge_capsule')
             OR mi.relation IS NULL)
      → raw_source_count = totalCount

      -- Step 2: 取 top 30 喂给 LLM（LIMIT 30 只影响 prompt 内容）
      SELECT mi.* FROM memory_items mi
      JOIN json_each(mi.tags) jt ON lower(trim(jt.value)) = lower(:tag)
      WHERE mi.state = 'active'
        AND (mi.relation NOT IN ('synthesized_insight','knowledge_capsule')
             OR mi.relation IS NULL)
      ORDER BY mi.search_count DESC, mi.confidence DESC
      LIMIT 30
      → rawFacts（仅用于 prompt 构建，不影响 staleness 分母）

   b. 查询辅助 capsule 摘要（前 200 字，不作为 source_ids）

   c. 检查 wiki_pages.staleness：
      - 不存在 OR staleness ≥ 0.4 → 重建
      - slug 在 failedSlugsMap（loadFailedSlugs 返回）中且满足重试条件 → 重建（绕过 0.4 阈值）
      - 其余 → 跳过

   d. callHaiku(prompt, env, 30000, { model: 'haiku' })
      → 失败：记录到 failed_slugs，continue 下一页

   e. 校验 [[wikilinks]]（仅允许 wiki_topics 中的 slug）
      - 校验失败策略：剥除无效链接（`[[bad-slug]]` → `bad-slug`），不拒绝整页
      - 剥除的链接记录到审计日志，不阻断写入流程

   f. 两步分离（DB 是真相源，文件是可重建缓存，无需跨步骤事务）：

      Step f-1：wiki-reflect-build.js 负责
        BEGIN TRANSACTION
          UPSERT wiki_pages（primary_topic, slug, raw_source_count=totalCount,
            raw_source_ids, capsule_refs, staleness=0, new_facts_since_build=0,
            last_built_at=datetime('now')）
        COMMIT
        → 失败：ROLLBACK，记录 failed_slugs，continue（跳过文件导出）

      Step f-2：wiki-reflect-export.js 负责（在 f-1 COMMIT 成功后调用）
        exportWikiPage(slug, frontmatter, content, outputDir)
        → 失败：仅记录 export_failed_slugs，不回滚 DB
          （DB 已有正确内容，下次 /wiki sync 会重新导出）

4. 重建 _index.md
5. 释放进程锁
6. 写审计日志 wiki_reflect_log.jsonl
```

**callHaiku 正确调用签名（对齐现有代码）：**
```javascript
const { callHaiku, buildDistillEnv } = require('./providers');
const env = buildDistillEnv();
const result = await callHaiku(promptText, env, 30000, { model: 'haiku' });
```

### 4.6 searchWikiAndFacts（实现在 memory.js）

**FTS5 用户输入安全处理：**
```javascript
// 剥除 FTS5 特殊操作符，防止语法错误
function sanitizeFts5(input) {
  const s = String(input || '').replace(/["*^(){}:]/g, ' ').trim();
  return s || null;  // 空串返回 null
}
// 规则：sanitize 后为 null → 跳过 FTS5，直接返回空结果（不 fallback LIKE，避免全表扫描）
```

```javascript
// memory.js 新增导出函数
function searchWikiAndFacts(db, query, { trackSearch = true } = {}) {
  const safeQuery = sanitizeFts5(query);
  if (!safeQuery) return { wikiPages: [], facts: [] };
  // 1. FTS5 搜 wiki_pages_fts（权重 1.5x）
  const wikiRows = db.prepare(`
    SELECT wp.slug, wp.title, wp.staleness, wp.last_built_at,
           snippet(wiki_pages_fts, 2, '<b>','</b>','...', 20) as excerpt,
           rank * 1.5 as score
    FROM wiki_pages_fts
    JOIN wiki_pages wp ON wiki_pages_fts.rowid = wp.rowid
    WHERE wiki_pages_fts MATCH ?
    ORDER BY rank LIMIT 5
  `).all(safeQuery);   // ← 使用 safeQuery，非原始 query

  // 2. FTS5 搜 memory_items_fts
  const factRows = db.prepare(`
    SELECT mi.id, mi.title, mi.content, mi.kind, mi.confidence,
           snippet(memory_items_fts, 1, '<b>','</b>','...', 20) as excerpt,
           rank as score
    FROM memory_items_fts
    JOIN memory_items mi ON memory_items_fts.rowid = mi.rowid
    WHERE memory_items_fts MATCH ?
      AND mi.state = 'active'
    ORDER BY rank LIMIT 10
  `).all(safeQuery);   // ← 使用 safeQuery，非原始 query

  // 3. trackSearch: true 才更新 search_count
  if (trackSearch && factRows.length > 0) {
    const ids = factRows.map(r => r.id);
    _trackSearch(db, ids);
  }

  return { wikiPages: wikiRows, facts: factRows };
}
```

### 4.7 /wiki research 答案生成

```
搜索阶段：searchWikiAndFacts(query, { trackSearch: true })

答案生成：
- 有 wiki 页命中 → 截取最相关段落（top 3），拼接回答，末尾标注来源页 slug
- 无 wiki 页，有 facts → 用 facts 内容内联回答（不调 LLM，直接格式化展示）
- 无命中 → "暂无相关知识，可用 /wiki add <内容> 添加"

答案格式（Feishu 发送，不调 LLM，零 token 消耗）：
  📖 **<wiki 页标题>**
  <excerpt>
  来源: [[slug]] · 更新于 <date>

  📌 相关事实 (N 条)
  - <fact 1>
  - <fact 2>
```

---

## 五、用户命令接口

| 命令 | Phase | 行为 |
|------|-------|------|
| `/wiki` | 1 | 列出所有 wiki 页，staleness + source 数 |
| `/wiki research <topic>` | 1 | 搜索 + 格式化回答（零 LLM，trackSearch: true）|
| `/wiki page <slug>` | 1 | 输出指定页全文 |
| `/wiki sync` | 1 | 强制重建 staleness ≥ 0.4 的页 |
| `/wiki pin <tag> <title>` | 1 | 手工注册受控主题（Phase 1，因为 Phase 1 需要种子入口）|
| `/wiki add <text>` | 2 | 注入 memory_item（state=active, source_type=manual）|
| `/wiki open` | 2 | 打开 Obsidian vault |
| `/wiki add file:<path>` | 3 | 文件抽取管线 |

---

## 六、与现有系统的集成点

| 文件 | 改动 | 关键约束 |
|------|------|---------|
| `scripts/memory.js` | + wiki_pages/wiki_topics 表 + FTS5 + triggers + staleness + searchWikiAndFacts + upsertWikiTopic | tag 归一化入口：`lower(trim(tag))` |
| `scripts/memory-search.js` | 扩展调用 `searchWikiAndFacts`，透传 `trackSearch` | CLI 默认 `trackSearch: true` |
| `scripts/memory-gc.js` | GC 删 wiki_pages（subquery join wiki_topics），同步删文件 | GC 三步：DELETE wiki_pages → unlink .md → 可选 DELETE wiki_topics（非 pinned）|
| `scripts/memory-index.js` | 扫描 wiki/ 目录纳入 INDEX.md | — |
| `scripts/daemon-command-router.js` | 注册 /wiki 路由 | Phase 1 必须含此步 |
| `scripts/daemon-default.yaml` | 新增 wiki-reflect 定时任务（每周一 03:00 本地时区）| 改 daemon-default.yaml，不改 ~/.metame/ |

---

## 七、不做什么

1. TrendRadar 不接为 wiki 来源
2. synthesized_insight / knowledge_capsule 不作为 wiki 来源（用 `relation` 字段过滤）
3. 不对所有 tag 自动建页（三重门槛 + wiki_topics 受控）
4. LLM 不能自由发明 wikilinks（slug 白名单，程序校验）
5. 不把旧页全文喂给 LLM（整页重建）
6. wiki-reflect 内部不记 search_count（trackSearch: false）
7. .md 文件不是真相源（DB 是）
8. V1 不做 `/wiki add file:`

---

## 八、新增/修改文件清单（Unix 哲学：一文件一职责）

### 职责边界图（先看全局）

```
memory-wiki-schema.js  ← DDL only（建表 + triggers）
                              ↓
core/wiki-slug.js      ← 纯函数：string → string（toSlug, sanitizeFts5）
core/wiki-staleness.js ← 纯函数：numbers → number（calcStaleness 只做计算）
core/wiki-prompt.js    ← 纯函数：data → string（buildWikiPrompt, validateWikilinks）
core/wiki-db.js        ← DB 读写（CRUD + staleness UPDATE + searchWikiAndFacts）
                              ↓
wiki-reflect-query.js  ← 读 DB（无写，无 LLM，无文件 IO）
wiki-reflect-build.js  ← 调 LLM + 写 DB（无文件 IO）
wiki-reflect-export.js ← 写文件（无 DB，无 LLM）
wiki-reflect.js        ← 编排器（持锁，按序调用上面三个）
daemon-wiki.js         ← 用户命令（调编排器，格式化 Feishu 消息）
```

关键规则：
- `core/wiki-staleness.js` 只导出 `calcStaleness`（纯函数）；`updateStalenessForTags`（含 DB 写）归 `core/wiki-db.js`
- `wiki-reflect-build.js` 不碰文件 IO；`wiki-reflect-export.js` 不碰 DB
- `core/wiki-prompt.js::validateWikilinks(content, allowedSlugs)` 白名单显式入参，无隐藏 DB 依赖

---

### 新增文件与完整接口签名

**`core/wiki-slug.js`** — 纯函数，~50 行
```javascript
toSlug(tag: string) → string          // 空串抛异常；碰撞由调用方处理
sanitizeFts5(input: string) → string|null  // null 表示不可查询
```

**`core/wiki-staleness.js`** — 纯函数，~30 行
```javascript
calcStaleness(newFacts: number, rawSourceCount: number) → number  // [0,1]
// updateStalenessForTags 含 DB 写 → 移到 core/wiki-db.js
```

**`core/wiki-prompt.js`** — 纯函数，~70 行
```javascript
buildWikiPrompt(topic: {tag,slug,label}, facts: object[], capsuleExcerpts: string, allowedSlugs: string[]) → string
validateWikilinks(content: string, allowedSlugs: string[]) → { content: string, stripped: string[] }
// 返回清洗后正文 + 被剥除的无效 slug 列表（供审计日志）
```

**`core/wiki-db.js`** — DB 读写，~120 行
```javascript
// wiki_pages CRUD
getWikiPageBySlug(db, slug)                          → row | null
listWikiPages(db, { limit=20, orderBy='updated_at' }) → row[]
getStalePages(db, threshold=0.4)                      → row[]   // for /wiki sync
upsertWikiPage(db, { slug, primary_topic, title, content, raw_source_ids,
                     capsule_refs, raw_source_count, topic_tags })  → void
resetPageStaleness(db, slug, rawSourceCount)          → void   // wiki-reflect 重建后调用

// wiki_topics CRUD
upsertWikiTopic(db, tag, { label, pinned=0, force=false }) → { slug, isNew }
// slug 碰撞：追加 -2/-3，最多 10 次；空串抛异常；force=true 跳过门槛
checkTopicThreshold(db, tag)  → boolean
// 同时满足两个独立条件才返回 true：
//   条件1：SELECT COUNT(*) >= 5（lifetime，全量 active raw facts，无时间限制）
//   条件2：SELECT COUNT(*) >= 1 WHERE created_at >= datetime('now','-30 days')（UTC）
// 两条分开查询，逻辑 AND，任一不满足返回 false
listWikiTopics(db)             → row[]

// 搜索
searchWikiAndFacts(db, query, { trackSearch=true }) → { wikiPages, facts }

// staleness（含 DB 写，不属于纯函数层）
updateStalenessForTags(db, dirtyTagCounts: Map<tag,count>) → void
```

**`memory-wiki-schema.js`** — DDL only，~80 行
- 建 wiki_pages、wiki_topics 表
- 建 wiki_pages_fts + 三个 trigger（INSERT/UPDATE/DELETE）
- 幂等（IF NOT EXISTS + IF NOT EXISTS trigger）

**`wiki-reflect-query.js`** — 读 DB，~60 行
```javascript
queryRawFacts(db, tag) → { totalCount: number, facts: object[], capsuleExcerpts: string }
// totalCount = COUNT（无 LIMIT，staleness 分母）
// facts = top 30（ORDER BY search_count DESC，LLM prompt 用）
// capsuleExcerpts = 相关 capsule 文件前 200 字拼接（辅助背景）
```

**`wiki-reflect-build.js`** — 调 LLM + 写 DB，**不碰文件**，~100 行
```javascript
buildWikiPage(db, topic, queryResult, { allowedSlugs, providers })
→ { slug, content, strippedLinks: string[], rawSourceIds: string[] } | null
// null = LLM 失败；DB 写用 resetPageStaleness；事务在此文件内
```

**`wiki-reflect-export.js`** — 写文件，**不碰 DB**，~80 行
```javascript
exportWikiPage(slug, frontmatter, content, outputDir) → void
// 先写 <slug>.md.tmp，成功后 rename（原子性）
// 若 .tmp 已存在（上次中断）先删除再写
rebuildIndex(pages: object[], outputDir) → void
// pages 由调用方从 DB 查询传入，此文件不直接访问 DB
```

**`wiki-reflect.js`** — 编排器，~100 行
```javascript
// 职责：进程锁 → 读 topics → 循环（query→build→export）→ 失败收集 → 审计日志

// failed_slugs 读写接口（本文件负责）：
// loadFailedSlugs(logPath) → Map<slug, { retries, next_retry: ISO-string }>
//   读最近一条日志 failed_slugs 数组转为 Map

// 本轮重试判断：
//   retries < 3 AND Date.now() >= Date.parse(next_retry) → 加入本轮（绕过 0.4 阈值）
//   retries >= 3 → 标记 permanent_error，本轮跳过
//   permanent_error 存储：在审计日志对象中写 { slug, retries: 3, next_retry: null, permanent_error: true }

// 审计日志格式（追加到 wiki_reflect_log.jsonl）：
// {
//   ts: string,                           // ISO-8601
//   slugs_built: string[],
//   export_failed_slugs: string[],        // DB 已写成功，文件写失败（下次重新导出）
//   failed_slugs: [                       // LLM/DB 失败
//     { slug, retries: number, next_retry: string }  // next_retry = now + 2^retries days
//   ],
//   stripped_links: { [slug]: string[] },
//   duration_ms: number
// }
```

**`daemon-wiki.js`** — 命令 handler，~150 行
```javascript
// 子命令分发：/wiki → listWikiPages；/wiki research → searchWikiAndFacts（trackSearch:true）
// /wiki page <slug> → getWikiPageBySlug；/wiki sync → wiki-reflect（staleness≥0.4，与周任务相同）
// /wiki pin <tag> <title> → upsertWikiTopic(force:true, pinned:1)
```

---

### 测试文件

| 文件 | 覆盖要点 | 行数 |
|------|---------|------|
| `core/wiki-slug.test.js` | toSlug 边界/碰撞/空串/危险字符，sanitizeFts5 | ~50 |
| `core/wiki-staleness.test.js` | calcStaleness 公式边界（0/1 极值） | ~30 |
| `core/wiki-prompt.test.js` | buildWikiPrompt 结构，validateWikilinks 剥除+返回列表 | ~60 |
| `core/wiki-db.test.js` | checkTopicThreshold SQL、updateStalenessForTags 精确匹配 primary_topic | ~80 |
| `wiki-reflect.test.js` | mock callHaiku + 临时 DB：并发锁、失败重试退避、事务回滚、tmp 文件恢复 | ~120 |
| `daemon-wiki.test.js` | E2E：/wiki pin → saveFacts → /wiki sync → /wiki research → GC 清理 | ~150 |

---

### 修改文件

| 文件 | 改动 |
|------|------|
| `scripts/memory.js` | require wiki-schema；`saveFacts` 后调 `updateStalenessForTags` + `checkTopicThreshold`/`upsertWikiTopic` |
| `scripts/memory-search.js` | CLI 扩展：调 `searchWikiAndFacts`，透传 `trackSearch` |
| `scripts/memory-gc.js` | wiki 孤儿页三步清理：DELETE wiki_pages → unlink .md → 清理 wiki_topics |
| `scripts/memory-index.js` | 扫描 wiki/ 目录纳入 INDEX.md |
| `scripts/daemon-command-router.js` | 注册 /wiki 路由 |
| `scripts/daemon-default.yaml` | 新增 wiki-reflect 定时任务（周一 03:00）|

---

## 九、实现顺序

**Phase 1（完整可用闭环）：**
1. `memory-wiki-schema.js` — DDL only（无外部依赖，最先建）
2. `core/wiki-slug.js` + 测试 — 纯函数，先测后写
3. `core/wiki-staleness.js` + 测试 — 纯函数，calcStaleness only
4. `core/wiki-prompt.js` + 测试 — 纯函数，validateWikilinks 需 allowedSlugs 显式入参
5. `core/wiki-db.js` + 测试 — 依赖 schema，补全所有签名（含 checkTopicThreshold、updateStalenessForTags、listWikiPages、getStalePages）
6. `memory.js` — require wiki-schema；saveFacts 后依次调 updateStalenessForTags + checkTopicThreshold/upsertWikiTopic
7. `wiki-reflect-query.js` — queryRawFacts（COUNT + top30 + capsuleExcerpts）
8. `wiki-reflect-export.js` — 先于 build 定义文件写契约（tmp→rename + rebuildIndex）
9. `wiki-reflect-build.js` — 依赖 export 契约；LLM call + DB 写（无文件 IO）
10. `wiki-reflect.js` — 编排器（锁 + 循环 + failed_slugs 退避 + 审计日志）
11. `daemon-wiki.js` — 依赖 wiki-db.js 完整 API
12. `daemon-command-router.js` — 路由注册（Phase 1 必须）
13. 全测试（含 E2E daemon-wiki.test.js）

**Phase 2（集成调度 + 用户入口补全）：**
7. `daemon-default.yaml` — 定时任务（周一 03:00 本地时区）
8. `/wiki add` + `/wiki open`
9. `memory-search.js` — CLI 扩展

**Phase 3（完善）：**
10. `memory-gc.js` — 孤儿页清理（DB + 文件三步）
11. `memory-index.js` — INDEX.md 扩展
12. `/wiki add file:<path>`

---

## 十、已收口决策记录

| 决策点 | 结论 |
|--------|------|
| 真相源 | `wiki_pages` 表，`.md` 可重建导出物 |
| derived 过滤字段 | `relation NOT IN (...)` + IS NULL 保留历史数据，非 `source_type` |
| staleness 公式 | `new_facts / (raw_source_count + new_facts)`，仅统计 raw facts |
| staleness 阈值 | 统一 ≥ 0.4，`/wiki sync` 与周任务相同 |
| staleness 更新粒度 | `saveFacts` 批次聚合 dirty tags，一次 UPDATE |
| trackSearch 语义 | 用户命令 `true`，系统内部 `false`，实现在 `core/wiki-db.js::searchWikiAndFacts` |
| updateStalenessForTags 归属 | `core/wiki-db.js`（含 DB 写，非纯函数）；`core/wiki-staleness.js` 只导出 `calcStaleness` 纯函数 |
| failed_slugs 退避 | 最多重试 3 次（间隔 1d/2d/4d），超出写 `permanent_error`，持久化在 `wiki_reflect_log.jsonl` |
| topic 门槛 SQL | `checkTopicThreshold(db, tag)`，判定用 UTC（`datetime('now')` 默认 UTC）|
| tag 匹配 | `json_each` + `lower(trim(...))`，入口归一化 |
| topic 注册责任 | `saveFacts` 后自动 upsert（≥5 raw facts + 30d）+ 用户 `/wiki pin` |
| pinned 字段 | 在 `wiki_topics.pinned`，GC 用 subquery，NOT NULL slug 防 NOT IN 失效 |
| 进程锁 | `wiki-reflect.lock`（O_EXCL，10min 超时）|
| 事务边界 | build 只负责 DB 事务（BEGIN/COMMIT）；文件写失败不回滚 DB（DB 是真相源，文件是缓存，记 export_failed_slugs 下次重导）|
| 失败重试 | `wiki_reflect_log.jsonl` 记录 failed_slugs，下次优先 |
| callHaiku 签名 | `callHaiku(text, buildDistillEnv(), 30000, { model: 'haiku' })` |
| GC 三步 | DELETE wiki_pages → unlink .md → 可选清理 wiki_topics |
| 配置文件路径 | `scripts/daemon-default.yaml`（非 `~/.metame/daemon.yaml`）|
| Phase 1 闭环 | 含路由注册和 `/wiki pin` 种子入口，Phase 1 结束用户可真实使用 |
| `/wiki research` 答案 | 零 LLM 零 token，程序格式化；无命中给 `/wiki add` 引导 |
| wiki_output_dir | 可配置，默认 `~/.metame/wiki/` |
| last_built_at vs updated_at | `last_built_at` = wiki-reflect 重建内容时间（用户可见）；`updated_at` = 行修改时间（含 staleness 自增），不对外展示 |
| topic_tags V1 规则 | V1：`topic_tags = JSON_ARRAY(primary_topic)`（单值，由 wiki-reflect-build.js 写入）；V2 再扩展多 tag 跨主题检索 |
| staleness 自增实现 | `dirtyTagCounts: Map<tag, count>`，`saveFacts` 按本批命中数自增，不查 watermark |
| primary_topic 归属 | `wiki_pages.primary_topic` = 主责 tag（1:1 wiki_topics.tag），staleness 只对 `primary_topic` 精确更新；`topic_tags` 含次级 tag 仅供检索，不触发 staleness |
| slug 安全生成 | `toSlug(tag)`: 只保留字母/数字/中文/空格/连字符，其余剥除，`/:\[\]?` 等路径危险字符不允许 |
| wikilink 校验失败 | 剥除无效链接（`[[bad]]` → `bad`），记入审计日志，不拒绝整页 |
| raw_source_ids | UPSERT 时写入 rawFacts（top 30）的 ID 列表，rebuild 时全量替换 |
| capsule_refs | UPSERT 时写入本轮查询到的 capsule 文件名列表，rebuild 时全量替换 |
| slug 空串 | `toSlug` 归一化后为空串 → 抛异常，拒绝注册 |
| slug 碰撞 | 追加数字后缀（-2、-3...），最多尝试 10 次，超出则报错 |
| FTS5 输入安全 | `sanitizeFts5` 剥除 `"*^(){}:` 等操作符；结果为空则返回空结果，不 fallback LIKE |

---

---

## 十一、实现时需补齐的细节（Codex Go 后遗留备注）

| 优先级 | 项目 | 要求 |
|--------|------|------|
| High | 文件写入原子性 | 先写 `<slug>.md.tmp`，COMMIT 成功后 rename；`_index.md` 重建失败不阻塞；启动时若检测到 `.tmp` 文件则视为上次中断，重建并清理 |
| Medium | failed_slugs 持久化 | `wiki_reflect_log.jsonl` 每次运行追加一行，`failed_slugs` 为对象数组（与 Section 8 一致）：`{ ts, slugs_built, export_failed_slugs, failed_slugs: [{ slug, retries, next_retry }], stripped_links, duration_ms }`；`loadFailedSlugs` 读最近一条转为 Map；retries < 3 AND now >= next_retry 则本轮重建（绕过 0.4 阈值）；retries >= 3 标记 permanent_error |
| Medium | topic 门槛 SQL | `SELECT COUNT(*) FROM memory_items mi JOIN json_each(mi.tags) jt ON lower(trim(jt.value))=lower(:tag) WHERE mi.state='active' AND (mi.relation NOT IN (...) OR mi.relation IS NULL) AND mi.created_at >= datetime('now','-30 days')` — 统一 UTC（`datetime('now')` 是 UTC，与现有 nightly-reflect 一致）|
| Medium | topic_tags 生成规则 | V1 收敛为 `topic_tags = JSON_ARRAY(primary_topic)`（单值），次级 tag 等 V2 再扩展；rebuild 时 topic_tags 由程序写入，非 LLM 决定 |
| Low | E2E 测试链 | `daemon-wiki.test.js` 必须覆盖：`/wiki pin` → `saveFacts` → `/wiki sync` → `/wiki research` → GC 文件清理 的完整链路 |

---

_文档版本: v1.7 — Codex 放行（Go，8/10）_
