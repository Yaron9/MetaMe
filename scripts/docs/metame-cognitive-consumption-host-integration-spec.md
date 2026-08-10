# MetaMe 认知资产消费闭环与统一 Agent 接入层 Spec

> 状态：历史规划记录，已由 `scripts/docs/universal-agent-cli-spec.md` 与 ADR 0003 取代。文中的 Claude/Codex 范围描述只代表写作时的首批验证，不是当前支持边界；现行实现必须复用统一 Capability Registry、Session Source 与 Extraction Run 契约。

> #29 验收注记（2026-08）：现行跨 Host 验收入口是
> `scripts/cognitive-quality-integration.test.js`。它复用 #24–#28 的 claim、reconcile、
> Project Context Manifest、MCP、Wiki annotation、observability 与 Engine Plugin seam，
> 并以临时 fixture 验证生命周期、authority、预算/幂等和 stale recovery。`metame host
> status|doctor` 报告实际 capability：Claude/Codex 的 MCP/context 只有在探测到时才
> `verified`/`detected`，Pi、agy 或 external adapter 不因 PATH 可执行而获得 Cognitive
> Host 权限；未声明投影能力保持 `unsupported`。Wiki 人工修改始终留在 annotation 或
> conflict 边界，legacy null-key 只保留检索兼容，不进入新的 Synthesis/Manifest。

## Problem Statement

MetaMe 已经具备长期记忆、Wiki、Profile、Agent Context、Skill Evolution、Session 提炼、混合检索、MCP 服务、Claude/Codex 宿主接入和后台治理等大量基础设施，但这些资产的生产能力强于消费能力。系统目前不能可靠回答：Claude 与 Codex 实际拥有了哪些 MetaMe 能力；某项资产是否能被发现、返回、展开、采用并帮助任务成功；消费链路断在何处；哪些后台任务仍在持续生产没有消费出口的资产。

用户希望 MetaMe 成为其在数字世界中的个人认知基础设施，帮助所有 Agent 更好地服务用户，而不是成为另一个与 Agent 竞争的万能 Agent。Agent 和模型可以替换，用户积累的身份、原则、经历、认知、知识和能力必须保持连续、可控和可迁移。

当前最紧迫的问题不是继续扩充记忆基础设施，也不是推倒重建现有架构，而是先打通现有认知资产的消费链路，并把 Claude、Codex 接入 MetaMe 的公共能力抽象为统一、薄且可验证的 Agent 接入层。新增 Agent 时不应复制记忆、Wiki、Profile、召回和审计逻辑，也不应为每个宿主长期维护一套不同的 MetaMe 能力协议。

当前事实还可能以重复、过期、作用域错误、直接矛盾或语义前后不一致的形式同时参与召回。即使每条记录单独看起来合理，组合后的认知包也可能在时间、作用域、原则或行为上互相冲突，导致 Agent 获得错误指导。

MetaMe 目前也缺少认知资产的效果闭环。被写入、被索引或被搜索到都不等于产生价值。没有消费审计、结果证据和生产反压时，更多 Facts、Wiki 和 Skills 只会增加 token、维护成本和错乱风险。

## Solution

在保留现有存储、提炼、Wiki、Profile、Skill、daemon 和宿主运行语义的基础上，优先完成一条从现有认知资产到 Claude/Codex、再到任务结果的最小消费闭环。

MetaMe 将提供统一的认知能力契约，以现有 MCP Server 为首选标准协议。Claude 与 Codex 的配置位置、安装方式和生命周期差异由薄的 Cognitive Host Adapter 处理；记忆检索、Wiki 搜索、作用域过滤、去重、一致性、token budget、消费审计和结果治理均保留在 MetaMe Core，不复制到宿主适配器。

第一阶段先执行只读能力体检，生成 Claude/Codex 的真实能力矩阵，验证 Facts、Wiki、Profile、Agent Context、Skills 和消费审计的可达性。能力矩阵必须来自实际探测和契约调用，而不是仅从配置文件推断。

随后选择当前接入最完整的宿主作为参考宿主，跑通唯一的最高层验收 seam：一个真实 Agent 通过统一 MetaMe 认知契约完成任务，系统可追踪资产从可发现、返回、展开、采用到结果验证的链路。同一套契约和验收随后复用于另一个宿主。

认知资产消费状态分为 delivered、opened、applied 和 validated。系统不把“搜索命中”当作使用，也不把“Agent 声称完成”或用户未继续回复当作可靠成功。测试、验收、用户确认、持续复用和可观察结果构成不同强度的证据。

当前有效事实采用 canonical claim 语义。同一 canonical key、作用域和有效时间内只能有一个当前有效值。旧版本作为历史保留但不参与默认召回；错误事实被 invalidated；无法裁决的冲突进入隔离状态。每个返回给 Agent 的认知包必须经过跨类型去重和一致性检查，避免 Facts、Wiki、Profile、规则和 Skills 在时间、作用域、语义或行为上前后不一致。

治理层根据真实消费机会、消费状态和结果证据提供生产反压。消费出口未接通、重复率异常、负增益或长期无法采用的资产类型应暂停或降低后台生产预算，并产生可诊断的修复建议。自动系统可以降级、隔离和暂停低价值生产，但不能自行永久删除重要认知资产、修改身份原则、改变权限或启用高风险可执行能力。

每个已验证缺口在自研前必须依次评估：复用现有 MetaMe 能力、复用已安装 MCP/Skill、接入成熟开源组件、参照成熟项目的协议或数据模型做最小实现、最后才是完全自研。第一阶段不因架构美观引入新的记忆数据库、事件总线、知识图谱或微服务。

## User Stories

1. As a MetaMe user, I want my cognitive assets to belong to me rather than a specific Agent, so that changing models or Agents does not erase my accumulated experience.
2. As a MetaMe user, I want Claude and Codex to use the same MetaMe cognitive capability contract, so that their service quality does not depend on separately maintained memory integrations.
3. As a MetaMe user, I want a future Agent to connect through a small adapter and standard protocol, so that MetaMe can grow without copying cognitive logic.
4. As a MetaMe user, I want MetaMe to improve Agents rather than compete with them, so that professional reasoning remains with the appropriate Agent.
5. As a MetaMe user, I want MetaMe to provide only the minimum relevant context automatically, so that Agents remain aligned without wasting context tokens.
6. As a MetaMe user, I want Agents to fetch detailed knowledge only when needed, so that large Wiki pages and histories do not pollute every prompt.
7. As a MetaMe user, I want task results to return to MetaMe automatically, so that the system can learn from verified outcomes.
8. As a MetaMe user, I want all conversations to be eligible as episodes but not automatically treated as truth, so that plausible Agent output does not become permanent fact.
9. As a MetaMe user, I want only verified conclusions to become trusted cognition, so that long-term memory quality improves over time.
10. As a MetaMe user, I want repeatedly successful patterns to become capability candidates, so that useful experience can eventually reduce repeated work.
11. As a MetaMe user, I want executable capabilities to require tests and approval, so that repeated behavior does not silently gain execution authority.
12. As a MetaMe user, I want explicit corrections from me to override lower-authority Agent inferences, so that MetaMe remains aligned with me.
13. As a MetaMe user, I want identity, principles, permissions and important deletions to require my confirmation, so that background learning cannot redefine me.
14. As a MetaMe user, I want low-risk capture, candidate extraction, deduplication suggestions and consumption auditing to run autonomously, so that growth remains unobtrusive.
15. As a MetaMe user, I want personal, project, Agent and private scopes to remain distinct, so that relevant knowledge is shared without leaking unrelated context.
16. As a MetaMe user, I want private cognition to be inaccessible to an unauthorized Agent, so that unified access does not mean unrestricted access.
17. As a MetaMe user, I want project-local rules to stay within their project, so that one workspace cannot contaminate another.
18. As a MetaMe user, I want stable personal principles to follow me across Agents, so that service remains consistent.
19. As a MetaMe user, I want current facts to be updateable, so that MetaMe follows reality rather than preserving stale conclusions as active truth.
20. As a MetaMe user, I want only one current fact for the same key, scope and time, so that Agents do not receive contradictory active values.
21. As a MetaMe user, I want superseded facts preserved as history but excluded from normal recall, so that history remains explainable without confusing current work.
22. As a MetaMe user, I want incorrect facts to be invalidated with their correction evidence, so that they cannot silently reappear.
23. As a MetaMe user, I want unresolved conflicting claims isolated from normal recall, so that uncertainty is explicit rather than presented as truth.
24. As a MetaMe user, I want scope differences and temporal changes distinguished from real contradictions, so that valid exceptions are not destroyed by over-aggressive deduplication.
25. As a MetaMe user, I want an entire returned context package to be internally consistent, so that individually plausible assets cannot produce contradictory instructions together.
26. As a MetaMe user, I want a fact change to mark dependent Wiki knowledge or capabilities stale when appropriate, so that derived assets do not outlive their foundations unnoticed.
27. As a MetaMe user, I want current code, configuration and tests checked before historical memory guides a code change, so that source truth outranks stale memory.
28. As a MetaMe user, I want explicit historical questions to access superseded facts, so that I can understand why a decision changed.
29. As a Claude user, I want to know whether Claude can actually search Facts, Wiki and Profile, so that configuration presence is not mistaken for working access.
30. As a Codex user, I want to know whether Codex can actually search Facts, Wiki and Profile, so that configuration presence is not mistaken for working access.
31. As a MetaMe operator, I want a real Claude/Codex capability matrix, so that missing or drifting integrations are immediately visible.
32. As a MetaMe operator, I want host detection to be read-only, so that diagnosis cannot unexpectedly modify Agent configuration.
33. As a MetaMe operator, I want host installation and configuration changes to require confirmation, so that MetaMe does not silently mutate external tools.
34. As a MetaMe operator, I want one status command to show installed, configured, reachable and verified capabilities per host, so that “connected” has an operational meaning.
35. As a MetaMe operator, I want a doctor command to identify the exact broken stage, so that repair does not require reading multiple host-specific configs manually.
36. As a MetaMe operator, I want capability levels to distinguish MCP access, context delivery, session visibility and outcome feedback, so that partial integrations are represented honestly.
37. As a MetaMe maintainer, I want the common integration contract extracted from proven Claude/Codex behavior, so that the abstraction reflects reality rather than speculation.
38. As a MetaMe maintainer, I want host adapters to contain only detection, registration, capability declaration and host-specific connection details, so that cognitive logic stays centralized.
39. As a MetaMe maintainer, I want the MetaMe Core to remain unaware of Claude/Codex configuration formats, so that new hosts do not spread conditionals through the core.
40. As a MetaMe maintainer, I want MCP to remain the default cognitive capability protocol where supported, so that MetaMe uses an open standard rather than inventing another RPC layer.
41. As a MetaMe maintainer, I want a host without full lifecycle support to declare partial capability honestly, so that the common layer does not rely on unsupported hooks.
42. As a MetaMe maintainer, I want existing memory, Wiki, Profile and Skill implementations reused behind the common contract, so that integration work does not create parallel systems.
43. As a MetaMe maintainer, I want existing hybrid Wiki search reused by the public memory lookup path, so that produced Wiki assets gain a real consumption outlet.
44. As a MetaMe maintainer, I want public tool descriptions to match actual results and gating behavior, so that Agents can choose the correct tool reliably.
45. As an Agent, I want memory lookup results to identify their type, scope, freshness, confidence and provenance, so that I can judge how to use them.
46. As an Agent, I want Facts and Wiki results deduplicated before delivery, so that repeated content does not consume tokens or appear more credible through repetition.
47. As an Agent, I want an explicit lookup request to be treated as demand, so that an internal intent gate does not reject a search I already chose to perform.
48. As an Agent, I want an empty, honest result when reliable cognition is unavailable, so that I do not fabricate continuity.
49. As an Agent, I want lightweight summaries and stable references before full content, so that I can lazily open only what the task requires.
50. As an Agent, I want the returned context to respect a deterministic token budget, so that recall cannot crowd out the current task.
51. As a MetaMe operator, I want every returned asset recorded as delivered, so that the first stage of consumption is observable.
52. As a MetaMe operator, I want full-content reads recorded as opened, so that search results can be distinguished from actual inspection.
53. As a MetaMe operator, I want evidence that an Agent applied an asset recorded separately from delivery and opening, so that usage metrics are not inflated.
54. As a MetaMe operator, I want verified outcomes recorded separately from Agent self-report, so that MetaMe does not confuse confidence with success.
55. As a MetaMe operator, I want consumption audit separated from promotion counters, so that measurement cannot accidentally change memory retention or ranking.
56. As a MetaMe operator, I want consumption telemetry to avoid storing additional sensitive prompt content, so that observability does not expand the privacy footprint.
57. As a MetaMe operator, I want to see where an asset failed in the consumption funnel, so that production, indexing, retrieval, opening, application and validation failures are distinguishable.
58. As a MetaMe operator, I want recall opportunities distinguished from raw hit counts, so that rarely applicable safety rules are not misclassified as useless.
59. As a MetaMe operator, I want duplicate, stale, scope-error, conflict and negative-impact rates, so that memory quality is measured rather than inferred from database size.
60. As a MetaMe operator, I want host parity, returned token volume, latency, empty-result rate and failure stage reported, so that cross-Agent integration quality is comparable.
61. As a MetaMe user, I want background production reduced when its consumption path is broken, so that MetaMe does not accumulate dark assets.
62. As a MetaMe user, I want new Wiki expansion paused when existing Wiki cannot be discovered or adopted, so that infrastructure output follows demand.
63. As a MetaMe user, I want suspiciously harmful cognition isolated quickly, so that negative-value memory does not wait for routine cleanup.
64. As a MetaMe user, I want production pausing to remain reversible and distinct from deletion, so that automatic governance cannot destroy important history.
65. As a MetaMe maintainer, I want every confirmed gap checked against existing MetaMe capabilities first, so that wiring is preferred to rebuilding.
66. As a MetaMe maintainer, I want installed MCPs and Skills evaluated before custom code, so that mature reusable components receive priority.
67. As a MetaMe maintainer, I want relevant open-source projects assessed for activity, license, privacy, local data control, API stability and removal cost, so that reuse does not create hidden lock-in.
68. As a MetaMe maintainer, I want external components introduced only for verified gaps, so that architecture does not bend around fashionable tools.
69. As a MetaMe maintainer, I want the first delivery to avoid a new database, event bus, graph platform or microservice, so that the consumption loop can be validated with minimal change.
70. As a MetaMe maintainer, I want existing background jobs paused rather than rewritten when their outputs have no consumption outlet, so that maintenance cost stops growing during repair.
71. As a test author, I want one public end-to-end cognitive consumption seam, so that Claude and Codex are tested against the same user-visible contract.
72. As a test author, I want the reference-host suite reused for the second host, so that host parity is demonstrated rather than asserted.
73. As a test author, I want explicit history, implicit project constraint, Wiki synthesis and honest no-result scenarios covered, so that the main consumption behaviors are protected.
74. As a test author, I want inconsistent active context packages rejected in tests, so that direct and semantic contradictions cannot silently reach an Agent.
75. As a test author, I want consumption states and production backpressure tested through external effects, so that implementation details can evolve safely.
76. As a release owner, I want every change to preserve existing memory and daemon behavior unless the spec explicitly changes a public contract, so that the upgrade remains incremental.
77. As a release owner, I want each phase independently deployable and reversible, so that one broken integration does not require rolling back the whole memory system.
78. As a release owner, I want measured task improvement before expanding production infrastructure, so that MetaMe grows from demonstrated value rather than asset counts.

## Implementation Decisions

- MetaMe is a user-owned cognitive control plane. It does not replace Claude, Codex or future domain Agents and does not duplicate their professional reasoning.
- The historical first implementation scope covered Claude and Codex. It is superseded: Pi, agy, and external fixtures now validate the same contract when their plugins are registered and allowlisted.
- The work is an incremental retrofit of existing infrastructure. Existing memory, Wiki, Profile, Skill, daemon, session and runtime systems remain in place unless an acceptance test demonstrates a specific missing contract.
- Consumption is implemented before further asset production or broad architectural refactoring.
- The first phase is a read-only capability audit that records actual host capabilities for Facts, Wiki, Profile, Agent Context, Skills and consumption telemetry.
- Capability status distinguishes detected, configured, reachable and behaviorally verified states.
- The primary acceptance seam is the public MetaMe cognitive capability contract exercised by a real Agent task. It spans discovery, delivery, optional detail opening, application evidence and outcome validation.
- Existing MCP service behavior is the starting point for the common capability protocol. A second proprietary cognitive RPC protocol will not be introduced.
- The public lookup surface remains small. A unified search entry point may return typed results across canonical claims, episodes and Wiki synthesis; detail reads may remain separate for lazy loading.
- Explicit Agent-initiated lookup is itself a demand signal. Strict intent planning remains appropriate for automatic injection but must not silently defeat an explicit tool call.
- Search results expose type, stable identity, title, bounded summary, scope, freshness, confidence, provenance reference, canonical identity and ranking score where available.
- Search performs scope filtering, active-state filtering, cross-type deduplication, consistency checks and token-budget assembly before returning content.
- Summary-first delivery and stable references are preferred over injecting full Wiki or history text. Detail is read on demand through the existing capability surface.
- Profile and identity are control-plane assets. They are not ranked as ordinary episodic memory and must preserve their existing authority and approval rules.
- A canonical claim is the current assertion for one canonical key, scope and validity interval. Only one current active value may exist for that combination.
- Superseded claims remain queryable as history but are excluded from normal current-context retrieval.
- Invalidated claims retain correction provenance and are excluded from normal retrieval.
- Unresolved conflicts enter an isolated state and are not presented as reliable facts.
- Scope and temporal differences are evaluated before classifying two claims as contradictory.
- A context package must be coherent across canonical claims, Wiki synthesis, Profile, policies and capabilities. Direct contradiction, stale derivation and behavior-policy conflict are all consistency failures.
- When a canonical claim changes, dependent derived assets can be marked stale or in need of review without being deleted automatically.
- Authority order for automatic updates is: explicit user correction; current authoritative code/configuration/test evidence; verified task outcome; multiple independent observations; single-Agent inference.
- Lower-authority evidence cannot silently replace a higher-authority active claim.
- Consumption audit uses four distinct states: delivered, opened, applied and validated.
- Delivered and opened can be recorded deterministically. Applied and validated require explicit evidence strength and must not be inferred solely from a search hit or conversational silence.
- Consumption telemetry is separate from promotion, ranking and retention counters. Adding audit must not change existing search promotion semantics accidentally.
- Audit records stable asset IDs, host, Agent, project/scope, stage, timestamps, query/trace identifiers, token counts, latency and outcome class without duplicating sensitive prompt bodies.
- Production backpressure uses consumption opportunity, broken-stage evidence, duplication, staleness and negative-impact signals. Raw low hit count alone is insufficient.
- Automatic governance may pause or reduce low-value background production and isolate suspected harmful cognition. It may not permanently delete important assets or alter identity, permissions or executable capabilities without user approval.
- Cognitive Host Adapters are distinct from native CLI execution adapters. They handle MetaMe capability detection, registration, status, health and host-specific connection details; they do not own native turn execution or session semantics.
- Native Claude/Codex execution, authentication, session isolation and context projection remain governed by the existing deep native CLI adapter work. This spec consumes its host metadata where useful but does not redesign that runtime seam.
- Host-specific configuration formats remain inside thin adapters. MetaMe Core consumes a host-neutral capability declaration.
- Host capability levels distinguish MCP access, automatic context delivery, session visibility and outcome feedback.
- Host installation is explicit and reversible. Detection and diagnosis are read-only; configuration mutation requires user authorization.
- The common abstraction is extracted from verified Claude/Codex behavior. It is not designed around hypothetical future hosts.
- The common contract must allow partial capability because not every future Agent will support the same hooks or lifecycle signals.
- Existing hybrid Wiki search is preferred over a new Wiki index or retrieval engine.
- Existing memory provenance, lineage, scope and audit structures are extended where sufficient rather than replaced.
- Raw Claude/Codex sessions remain owned by their hosts. This phase does not create a unified transcript copy or ingestion log.
- No new graph database, vector platform, event bus, microservice boundary or second memory database is introduced in this phase.
- No module is removed merely because it appears redundant. Removal requires evidence that it is non-authoritative, unconsumed, safely reconstructable and covered by rollback.
- For each verified missing capability, implementation must document the reuse decision: existing MetaMe wiring, installed MCP/Skill, mature open-source component, minimal local implementation based on established prior art, or justified custom build.
- Open-source evaluation considers fit to the verified gap, local-first operation, data ownership, privacy, license, maintenance activity, stable API/MCP support, migration cost and reversibility.
- The rollout order is capability audit, reference-host consumption closure, second-host parity, quality governance, Wiki lineage/staleness closure, and only then broader host productization.
- Each rollout phase has an off switch or compatibility path and must preserve existing user-visible behavior unless the phase explicitly repairs a public contract.

## Testing Decisions

- Good tests assert public cognitive behavior: what an Agent can discover, what context it receives, which assets it opens or applies, what audit evidence is produced and whether inconsistent content is withheld. Tests do not assert private helper layout.
- The preferred and highest test seam is one end-to-end MetaMe cognitive request through the public MCP/host capability boundary, backed by a temporary memory store and deterministic host adapter fixture.
- The ideal number of new seams is one. Lower-level unit tests support pure ranking, consistency and state-transition logic but do not replace the public seam.
- Existing MCP server tests are prior art for tool discovery, input validation and public result contracts and should be extended rather than duplicated per host.
- Existing daemon recall end-to-end tests are prior art for automatic context injection, bounded characters and recall audit and should remain the acceptance path for automatic delivery.
- Existing hybrid search tests are prior art for Facts/Wiki retrieval, scope filtering and ranking behavior.
- Existing memory integration tests are prior art for database lifecycle, provenance and derived Wiki behavior.
- Existing Codex host tests and Claude engine/runtime tests are prior art for host detection and native runtime behavior. Cognitive adapter tests must not duplicate native execution coverage.
- A capability-matrix test fixture represents Claude and Codex as independently detected, configured, reachable and verified.
- Tests cover a host that is installed but missing MetaMe MCP registration.
- Tests cover a host with registered MCP whose server is unreachable.
- Tests cover a reachable MCP whose advertised tools do not match the required capability contract.
- Tests cover a partially capable host and ensure status does not report full integration.
- Explicit history-recall tests verify that a prior decision and its provenance can be found without automatic intent rejection.
- Implicit project-context tests verify that relevant active constraints can be delivered within budget while unrelated project facts are excluded.
- Wiki-consumption tests verify that existing Wiki synthesis is discoverable, typed and lazily readable through the public contract.
- Honest no-result tests verify that the system returns an explicit empty outcome rather than low-confidence filler.
- Deduplication tests seed semantically or canonically duplicated Fact/Wiki content and assert one bounded representation in the delivered package.
- Current-fact tests seed superseded and active values and assert that normal recall returns only the active value.
- Historical tests assert that an explicit history request can retrieve superseded values with their validity periods.
- Invalidation tests assert that corrected false claims do not participate in normal recall.
- Scope tests cover personal, project, Agent and private assets and assert permission-aware isolation.
- Conflict tests cover direct opposite values, different numeric values, stale Wiki derivation, global/local mismatch and policy/Skill behavioral incompatibility.
- Temporal and scope exception tests prove that valid historical changes and local exceptions are not misclassified as contradictions.
- Context coherence tests assert that the assembler rejects or isolates a package containing incompatible active assets.
- Token-budget tests assert deterministic upper bounds and stable truncation priorities.
- Consumption-audit tests distinguish delivered, opened, applied and validated without changing existing promotion counters.
- Privacy tests assert that audit rows do not contain prompt bodies, credentials or full recalled content.
- Outcome tests distinguish deterministic verification, explicit user feedback, repeated behavioral evidence and Agent self-report.
- Production-backpressure tests assert that a broken consumption path can pause eligible background production without deleting assets.
- Recovery tests assert that restoring a healthy consumption path can resume production through an explicit, observable state change.
- Negative-impact tests assert that suspected harmful cognition is isolated and surfaced for review.
- Cross-host contract tests run the same cognitive behavior suite against Claude and Codex adapter fixtures.
- The reference host is selected from the read-only capability audit, not hard-coded in advance.
- The second host must pass the same public contract before the abstraction is considered suitable for a future third host.
- Tests use sanitized deterministic fixtures and temporary databases. They do not require live credentials, mutate real host configuration or duplicate real user tasks.
- Live smoke tests may be used after deterministic acceptance to confirm actual Claude/Codex registration, but they are not the only proof of correctness.
- Any changed daemon modules must pass the project-required daemon lint suite.
- The complete daemon test suite remains required for delivery; targeted tests alone are not acceptance.
- Deployment occurs only after source tests pass. Runtime copies are generated through the established deployment command and are never edited directly.

## Out of Scope

- Integrating Pi in the first implementation.
- Replacing Claude, Codex or another Agent with a MetaMe super-Agent.
- Redesigning native Claude/Codex turn execution, authentication, sandbox, approval or session isolation.
- Duplicating or converting native Claude/Codex sessions into a universal transcript.
- Building a new ingestion event bus or global conversation JSONL.
- Replacing the current primary memory database.
- Migrating all Wiki or Skill assets to a single physical storage medium.
- Building a new vector database, knowledge graph platform or Graph-RAG system.
- Splitting MetaMe into microservices.
- Large-scale daemon decomposition unrelated to the verified consumption seam.
- Rewriting Profile, Wiki, Skill Evolution, memory extraction or task scheduling wholesale.
- Automatically compiling repeated tool calls into enabled executable code.
- Automatically deleting important memory or historical evidence.
- Automatically changing identity, locked principles, permissions or high-risk policies.
- Treating all low-frequency assets as low value without measuring applicability opportunities.
- Treating search hits, Agent completion statements or conversational silence as validated success.
- Adding new production pipelines before existing asset consumption is demonstrated.
- Selecting or integrating an external memory framework before a concrete local gap is verified.
- Removing existing projectors, auditors or repair tools without authority, replacement evidence and rollback.
- Solving every possible semantic contradiction with an LLM-only judge.
- Defining a universal protocol for hosts that have not yet been observed.

## Further Notes

- The repository currently has no domain glossary file. This spec uses the terminology resolved in the architecture discussion: Episode is what happened; canonical claim is what MetaMe currently believes within a scope and time; synthesis is organized derived knowledge such as Wiki; capability is a verified reusable way of working; identity/policy is the user-controlled authority layer.
- “Unified Agent integration” in this spec means a shared MetaMe cognitive capability plane, not a universal native execution engine.
- The existing ready-for-agent spec for deep Claude/Codex/Agy native CLI adapters owns native turn execution, engine-scoped session semantics and context projection. The two specs must not duplicate or contradict one another.
- The current memory infrastructure review distinguishes verified problems from high-probability hypotheses. Implementation should preserve that evidence discipline and must not convert inventory counts into quality conclusions without sampling or task evaluation.
- The first useful artifact is a verified Claude/Codex capability matrix and a failing/passing end-to-end consumption trace, not a new architecture diagram.
- Success is measured by fewer repeated user explanations, fewer violations of user/project constraints, faster retrieval of prior decisions, less repeated trial and error, lower duplicate/stale context and preserved continuity across Agents.
- Database size, Fact count, Wiki page count, Skill count and extraction throughput are operational inventory metrics, not proof of cognitive growth.
- A rare safety rule can be highly valuable. Backpressure decisions must consider whether an applicable opportunity occurred, not merely whether the asset was frequently consumed.
- Open-source and MCP research is required only after the capability audit identifies a verified gap. Research findings should compare reuse, adaptation and custom implementation, including removal cost and data ownership.
- The intended architecture remains a modular monolith with explicit boundaries. Clear contracts and measurable feedback are preferred to distributed infrastructure.
