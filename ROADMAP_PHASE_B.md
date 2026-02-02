# MetaMe Roadmap: Phase A (Remaining) + Phase B

> Based on expert consultation from: Cognitive Psychologist, Linguist, User Modeling Specialist
> Date: 2026-01-30

---

## Phase A Remaining (v1.2.1 — do first)

### ~~A1. Create `scripts/schema.js`~~ ✅ DONE
41 fields defined across T1-T5 tiers, with type/enum/limit validation, wildcard support, and prompt export.

### ~~A2. Update Distill Prompt to Reference Schema~~ ✅ DONE
Distill prompt now includes full ALLOWED FIELDS list. Added `filterBySchema()` to reject non-whitelisted keys server-side.

### ~~A3. Add Token Budget Check After Write~~ ✅ DONE
3-step graceful degradation: clear recent_changes → truncate arrays → reject write. Budget: 800 tokens.

### A4. Publish v1.2.1

After A1-A3 are done: git commit, npm publish.

---

## Phase B: Deep Cognitive Memory Layer

## 1. Profile Schema v2 (Target Structure)

```yaml
# === T1: Identity (LOCKED, never auto-modify) ===
identity:
  nickname: "3D"              # [LOCKED]
  role: "Builder-Thinker"     # manual only
  locale: "zh-CN"             # [LOCKED]

# === T2: Core Traits (LOCKED, deep personality) ===
core_traits:                   # [LOCKED]
  crisis_reflex: Action        # enum: Action|Analysis|Delegation|Freeze
  flow_trigger: Ideation       # enum: Ideation|Execution|Teaching|Debugging
  shadow_self: Meaninglessness # free text
  learning_style: Hands-on     # enum: Hands-on|Conceptual|Social|Reflective
  north_star:
    aspiration: "Product + Financial + Growth"
    realistic: "Capability Upgrade"

# === T3: Preferences (auto-writable, needs confidence threshold) ===
preferences:
  code_style: concise          # enum: concise|verbose|documented
  communication: direct        # enum: direct|gentle|socratic
  language_mix: zh-main-en-term # enum: zh-only|en-only|zh-main-en-term|code-switch
  tech_terms_language: en      # enum: zh|en
  code_comments_language: null # enum: zh|en|null
  explanation_depth: brief_rationale # enum: result_only|brief_rationale|deep_dive
  interaction_tempo: incremental # enum: batch|incremental
  tools: []                    # string[], max 10
  anti_patterns: []            # string[], max 5

# === T3b: Cognition (auto-writable, trait-like, slow to change) ===
cognition:
  decision_style: adaptive     # enum: intuitive|analytical|adaptive
  info_processing:
    entry_point: big_picture   # enum: big_picture|details|examples
    preferred_format: structured # enum: structured|narrative|visual_metaphor
  abstraction:
    default_level: architectural # enum: strategic|architectural|implementation|operational
    range: wide                # enum: narrow|wide
  cognitive_load:
    chunk_size: medium         # enum: small|medium|large
    preferred_response_length: moderate # enum: concise|moderate|comprehensive
  motivation:
    primary_driver: meaning    # enum: autonomy|competence|meaning|social_proof
    energy_source: creation    # enum: creation|optimization|problem_solving|teaching
  metacognition:
    self_awareness: high       # enum: high|medium|low
    receptive_to_challenge: yes # enum: yes|sometimes|no

# === T4: Context (free overwrite, current state) ===
context:
  focus: null                  # string, current main task
  focus_since: null            # date, auto-set when focus changes
  active_projects: []          # string[], max 5
  blockers: []                 # string[], max 3, auto-expire 14 days
  energy: null                 # enum: high|medium|low|null

# === T5: Evolution (system-managed, strict limits) ===
evolution:
  last_distill: null           # ISO datetime
  distill_count: 0             # int
  recent_changes:              # max 5 entries, FIFO
    - { ts: "", field: "", old: "", new: "" }
```

---

## 2. Confidence-Based Upsert (Pending Traits)

### New file: `~/.metame/pending_traits.yaml`

```yaml
# System-internal, NOT injected into prompt
preferences.package_manager:
  value: "pnpm"
  count: 2                    # observation count
  first_seen: "2026-01-28"
  last_seen: "2026-01-30"
  confidence: normal          # high (strong signal words) | normal

preferences.code_comments_language:
  value: "zh"
  count: 1
  first_seen: "2026-01-30"
  last_seen: "2026-01-30"
  confidence: high            # user said "以后注释一律用中文"
```

### Promotion Rules

| Signal Type | Confidence | Action |
|-------------|-----------|--------|
| Strong directive ("以后一律"/"永远"/"always"/"never"/"记住") | high | Direct write to T3 |
| Repeated observation (same preference >= 3 times) | normal→high | Promote from pending to T3 |
| Single undirected observation | normal | Write to pending, wait |
| Contradicts existing T3 value | any | Don't delete old, add contradiction counter |

### Pending Cleanup

- If a pending trait hasn't been observed for > 30 days, auto-delete
- If a pending trait's count reaches threshold (3), promote + delete from pending

---

## 3. Strategic Merge (Replace deepMerge)

```javascript
function strategicMerge(profile, updates, schema, lockedKeys, pendingTraits) {
  for (const [key, value] of flatEntries(updates)) {
    // 1. Schema whitelist check
    if (!schema.has(key)) continue;

    // 2. LOCKED check
    if (lockedKeys.has(key)) continue;

    // 3. Null/empty protection — never delete existing values
    if (value === null || value === '') continue;

    // 4. Tier-based strategy
    const tier = schema.getTier(key);
    switch (tier) {
      case 'T1':
      case 'T2':
        continue; // Never auto-write

      case 'T3':
        // Check if strong signal (distiller should tag this)
        if (updates._confidence?.[key] === 'high') {
          directWrite(profile, key, value);
        } else {
          upsertPending(pendingTraits, key, value);
        }
        break;

      case 'T4':
        directWrite(profile, key, value);
        // Auto-set focus_since when focus changes
        if (key === 'context.focus') {
          directWrite(profile, 'context.focus_since', today());
        }
        break;
    }
  }

  // Promote mature pending traits
  for (const [key, meta] of Object.entries(pendingTraits)) {
    if (meta.count >= 3 || meta.confidence === 'high') {
      directWrite(profile, key, meta.value);
      delete pendingTraits[key];
    }
  }
}
```

---

## 4. Signal Capture Enhancement

### signal-capture.js additions

Tag captured signals with confidence level:

```javascript
// Strong signal patterns (direct write to T3)
const STRONG_SIGNAL_ZH = /以后(都|一律|每次|全部|统一)|永远(不要|别|不能|要)|千万(别|不要)|记住|一定(要|得)/;
const STRONG_SIGNAL_EN = /(from now on|always|never|don't ever|remember to|every time)/i;

// Implicit preference patterns (normal confidence, needs accumulation)
const IMPLICIT_ZH = /我(喜欢|偏好|习惯|讨厌|不喜欢|一般都|通常|总是|倾向于)/;
const IMPLICIT_EN = /I (prefer|like|hate|usually|tend to|always)/i;

// Correction patterns (high value — user is teaching us)
const CORRECTION_ZH = /不是.*我(要|想|说)的|我说的不是|你理解错了/;
const CORRECTION_EN = /(no,? I meant|that's not what I|you misunderstood)/i;

const entry = {
  ts: new Date().toISOString(),
  prompt: prompt,
  confidence: STRONG_SIGNAL_ZH.test(prompt) || STRONG_SIGNAL_EN.test(prompt) ? 'high' : 'normal',
  session: data.session_id || null,
  cwd: data.cwd || null
};
```

---

## 5. Anti-Bloat Measures

### Layer 0: Schema Whitelist
- Distiller can ONLY output keys defined in schema
- Any unknown key is silently dropped

### Layer 1: Field-Level Limits
| Type | Limit |
|------|-------|
| string | 80 chars |
| array | varies (tools: 10, anti_patterns: 5, projects: 5, blockers: 3, changes: 5) |
| evolution block | ~150 tokens |

### Layer 2: Global Token Budget
```javascript
function estimateTokens(yamlString) {
  return Math.ceil(yamlString.length / 3); // conservative mixed-language estimate
}

// After each write:
const tokens = estimateTokens(yaml.dump(profile));
if (tokens > 800) {
  // Degrade: clear evolution.recent_changes first
  profile.evolution.recent_changes = [];
  // If still over: truncate arrays to half
  // If still over: reject this write, keep previous version
}
```

### Layer 3: Time-Based Expiry
- `context.focus`: if `focus_since` > 30 days, auto-clear
- `context.blockers`: if > 14 days, auto-clear
- `context.energy`: reset to null on each session start
- `pending_traits`: if > 30 days without new observation, delete

---

## 6. Cognitive Bias Prevention

### Rules for the Distill Prompt

1. **No single-session trait inference** — One observation → State only, NOT Trait
2. **Behavior-only extraction** — Never infer cognition from identity/demographics
3. **Contradiction tracking** — When new signal contradicts existing value, log it don't overwrite
4. **Trait requires accumulation** — T3 fields need >= 3 consistent observations before write
5. **Separate signal levels**:
   - L1 Surface (word choice, tone) → low weight
   - L2 Behavior (question patterns, decision patterns) → medium weight
   - L3 Self-declaration ("I am...", "I prefer...") → high weight but cross-validate

---

## 7. Implementation Order

1. ~~**schema.js**~~ ✅ DONE in Phase A — 41 fields, tiers, types, limits, validation
2. ~~**distill.js prompt v2**~~ ✅ DONE in Phase A — schema-constrained output, filterBySchema()
3. ~~**Token budget checker**~~ ✅ DONE in Phase A — 3-step degradation, 800 token cap
4. ~~**B1: signal-capture.js v2**~~ ✅ DONE — Confidence tagging (strong/correction→high, else normal), 6 regex patterns (zh+en)
5. ~~**B2: strategicMerge**~~ ✅ DONE — Tier-aware upsert: T1/T2 skip, T3 high→direct/normal→pending, T4 direct, T5 direct
6. ~~**B3: pending_traits.yaml**~~ ✅ DONE — pending-traits.js module: upsert, promotion(count>=3 or high), contradiction tracking, 30d expiry, source_quote rationale
7. ~~**B4: distill prompt v3**~~ ✅ DONE — Cognitive profile framing, _confidence/_source output blocks, bias prevention rules (L1/L2/L3 signal weight)
8. ~~**B5: Time-based expiry**~~ ✅ DONE — index.js startup: focus>30d clear, energy reset null, pending 30d expiry
9. ~~**B6: Profile migration**~~ ✅ DONE — migrate-v2.js: status→context, v2 defaults, LOCKED preservation, --dry-run support

---

## 8. Competitive Reverse Engineering Insights (2026-01-30)

> 逆向工程 Claude.ai / ChatGPT / Gemini 的记忆系统后得出的结论

### 核心发现：三家都不做认知画像

| 平台 | 本质 | 格式 | 存什么 |
|------|------|------|--------|
| ChatGPT | 记事本 | 时间戳+自然语言句子，~6000 token上限 | 事实（"用户住西雅图"） |
| Claude | 事实检索 | XML bullet points + 按需搜索历史 | 事实偏好、项目上下文 |
| Gemini | 上下文文档 | 单一user_context文档+分类+rationale溯源 | 人口统计+兴趣+关系+事件 |
| **MetaMe** | **认知画像** | **分层YAML + schema + LOCKED** | **决策风格、认知负荷、动机、元认知** |

**差异化核心**：cognition层（决策风格、信息处理、抽象偏好、认知负荷、动机、元认知）是三家都没有的。MetaMe存的是"how you think"，不是"what you said"。

### 借鉴要点

1. **Gemini的rationale溯源** → pending_traits加`source_quote`字段，让用户知道"为什么系统认为我偏好concise"
2. **ChatGPT的教训：自动写入导致信任危机** → 保持置信度门槛，高置信才直写T3，不能随意写
3. **Profile ≠ Memory** → 不往profile里塞事实性信息，只存认知特征和偏好
4. **ChatGPT隐藏档案的confidence tag** → Phase B的pending_traits置信度机制方向正确

---

---

## Phase C: True Metacognition Layer (元认知引领系统)

> 灵感来源：周岭《认知觉醒》+ 元认知系统设计专家 + 行为模式分析师 + 成长系统架构师
> 核心转变：从"偏好记录器"升级为"认知镜像"——揭示用户自己都没意识到的模式，引领成长

### 设计原则

- **系统是你路过的镜子，不是跟着你的教练** — 永不打断心流
- **一句话胜过一页纸** — 每次最多注入一行反思
- **事件驱动，不是定时器** — 只在自然过渡点出现（session结束、突破瓶颈、上下文切换）
- **描述不处方** — "你倾向于X"而不是"你应该停止X"
- **零额外API成本** — 复用现有Haiku distill管道

### 架构：在现有管道上加一层

```
                          现有管道（Phase A+B）
用户消息 → hook捕获 → buffer → Haiku分析 → 写入profile
                                  │
                          Phase C 新增 ↓
                                  ├── 行为模式检测（同一次Haiku调用）
                                  ├── session摘要 → session_log.yaml（不注入prompt）
                                  └── 条件触发 → CLAUDE.md注入一行镜像
```

### ~~C1. 扩展Distill：偏好 + 行为模式（一次Haiku调用）~~ ✅ DONE

distill prompt v4：在现有偏好提取后追加行为模式检测指令。Haiku同一次调用额外输出`_behavior` block（decision_pattern, cognitive_load, zone, avoidance_topics, emotional_response, topics）。distill.js解析后传递给session_log writer。所有return路径增加`behavior`和`signalCount`字段。

### ~~C2. Session Log~~ ✅ DONE

新增`writeSessionLog()`函数写入`~/.metame/session_log.yaml`。每次distill后记录一条session摘要（ts, topics, zone, decision_pattern, cognitive_load, emotional_response, avoidance, signal_count）。FIFO保留最近30条。

### ~~C3. 模式检测（每5次distill跑一次）~~ ✅ DONE

新增`detectPatterns()`函数。当`distill_count % 5 === 0`且session_log >= 5条时触发。读最近20条session摘要，调用Haiku检测4类模式（回避、能量、区域、成长），只保留confidence > 0.7的结果。写入profile `growth.patterns`（max 3条）+ `growth.zone_history`（最近10次zone字母序列）。

### ~~C4. 一行镜像注入（CLAUDE.md条件注入）~~ ✅ DONE

index.js注入CLAUDE.md时，检查`growth.patterns`中未surfaced的模式。14天冷却期，每session最多注入一条。注入格式：`[MetaMe observation: ... 不要主动提起，只在用户自然提到相关话题时温和回应。]`。写入后自动标记`surfaced`日期。支持quiet模式和mirror开关。

### ~~C5. 反思微提示（session结束时）~~ ✅ DONE

CORE_PROTOCOL新增Section 4「REFLECTION MIRROR」：定义触发条件（每7次session / 突破瓶颈 / 3次comfort zone）、🪞格式、规则（永不打断心流、每session最多一次、尊重quiet模式）。Claude自行判断何时在session末尾附加反思提示。

### ~~C6. Growth字段~~ ✅ DONE

schema.js新增7个T5字段：`growth.patterns`（array max 3）、`growth.zone_history`（array max 10）、`growth.reflections_answered`（number）、`growth.reflections_skipped`（number）、`growth.last_reflection`（string）、`growth.quiet_until`（string）、`growth.mirror_enabled`（boolean）。

### ~~C7. 用户控制~~ ✅ DONE

index.js新增3个CLI命令：
- `metame quiet` — 设置`growth.quiet_until`为48小时后，静默镜像和反思
- `metame insights` — 显示当前检测到的模式、zone历史、反思统计
- `metame mirror on/off` — 开关镜像注入（`growth.mirror_enabled`）

### 实施顺序

| 步骤 | 内容 | 状态 | 改动范围 |
|------|------|------|----------|
| C6 | growth字段加入schema | ✅ | schema.js |
| C1 | distill prompt v4 + _behavior输出 | ✅ | distill.js prompt + 解析 |
| C2 | session_log.yaml写入 | ✅ | distill.js writeSessionLog() |
| C3 | 模式检测（每5次distill） | ✅ | distill.js detectPatterns() |
| C4 | CLAUDE.md条件注入一行镜像 | ✅ | index.js Section 4.5 |
| C5 | 反思微提示 | ✅ | index.js CORE_PROTOCOL Section 4 → 修复后改为 Section 4.6 条件注入 |
| C7 | 用户控制命令 | ✅ | index.js Section 5.5 |

### Bug Fix: C5 反思提示从静态注入改为条件注入

**问题**：反思指令写死在 CORE_PROTOCOL 静态文本中，每次启动都注入 CLAUDE.md。Claude 每次 `/compact` 重新加载时都会看到反思指令，导致每个 session 都可能触发反思，而非按设计的条件触发。

**修复**：
- 从 CORE_PROTOCOL 中移除 Section 4（REFLECTION MIRROR）静态文本
- 新增 Section 4.6：在 index.js 中用 Node.js 代码判断触发条件（`distill_count % 7 === 0` 或 `zone_history` 末尾 3 条全为 `C`）
- 只有条件满足时才注入一行 `[MetaMe reflection: ...]` 到 CLAUDE.md
- 不满足条件的 session，Claude 完全看不到反思指令——零干扰

**原则**：所有条件判断在 Node.js 侧完成，不依赖 Claude 自行判断。注入 CLAUDE.md 的永远是已决策的指令，不是需要 Claude 判断的规则。

---

## 10. Expert Sources

- **Cognitive Psychology**: Decision style (System 1/2), Kolb learning cycle, Miller's 7±2, SDT motivation theory
- **Linguistics**: Speech act theory, hedging vs commitment markers, code-switching patterns
- **User Modeling**: Tiered schema, upsert strategies, cold-start handling, feature drift detection
- **Reverse Engineering**: Manthan Gupta (Claude/ChatGPT memory), Simon Willison (memory comparison), Johann Rehberger (ChatGPT dossier), Leon Nicholls (Gemini Gems)
