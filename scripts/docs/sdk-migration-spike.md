# Agent SDK 迁移 Spike 报告（plan P3.1，2026-07-17）

> 状态：历史 Spike 记录，不是当前 Runtime 架构或 Host 支持清单。现行执行边界由 Engine Plugin Runtime Adapter 与 ADR 0001/0003 定义。

## 最终结论（2026-07-18 修订）：技术达标，但因订阅政策**冻结迁移**

技术两条达标线均通过：延迟持平或更优 ✅（热复用快 2.6 倍）；事件流完整映射六事件协议 ✅。

**但迁移前提被订阅政策否决**（2026-07-18 调研，来源：code.claude.com 官方文档 + support.claude.com）：

- MetaMe 的存在目的是消耗 Claude Pro/Max **订阅额度**（本机 providers.yaml 无任何 API key，全链路走 CLI OAuth）。
- `claude -p`（现状路径）：消费者条款对 Claude Code CLI 的自动化使用有**明确豁免**，是官方钦定的订阅自动化通道。
- Agent SDK：目前事实上仍从订阅扣费（spike 在零 API key 环境跑通即为证；官方 2026-06-15 公告确认"暂时如此"），**但**官方文档导向 API key 认证、原定的 SDK 单独月度信用池只是"暂停"而非取消、2026-02 起已开始封杀第三方工具中的订阅 OAuth。SDK 是一条"现在能用、官方已预告要改"的路。
- 风险不对称：2.6× 延迟收益 vs 核心链路计费基础被单独计量/收紧的风险。**判定：不迁**。

后续处置：warm-pool + handoff 保留并维持"只修不扩"（它们手搓的正是官方唯一承诺给订阅用户的通道）；若未来 Anthropic 正式确认 SDK 的订阅额度政策（如恢复并明确月度信用方案），凭本报告的技术数据可随时重启立项。

---

以下为原始技术验证记录（仍然有效）：

## 数据（@anthropic-ai/claude-agent-sdk 0.3.212，haiku，两轮独立测量）

| 路径 | turn1 首 token | turn2 首 token |
|---|---|---|
| `claude -p` 单发（现状无 warm-pool 时每轮的代价） | 5.1s / 5.6s | 5.2s / 5.3s |
| SDK streaming-input 持久会话 | 7.8s / 6.3s（冷启动，每会话一次） | **2.0s / 2.1s**（热复用） |

- SDK 热复用比 CLI 单发快 ~2.6×，且优于 warm-pool 实测的 ~3s 水平。
- SDK 冷启动略慢于 CLI 单发，但每个会话只付一次，热复用是常态路径。

## 事件映射验证

SDK 消息流 `system / assistant / result / rate_limit_event` 映射 MetaMe 六事件：
`system(init)` → session；`assistant` 内容块 → text / tool_use；工具结果随后续消息 → tool_result；`result` → done；异常 → error。无缺口。

## 迁移方案（立项范围）

- claude descriptor 的 spawn/流解析实现换为 SDK `query()` streaming-input 会话（descriptor 架构已就位，codex/agy 仍走 CLI 子进程——两种实现并存正是 P2.1 可插拔的目的）。
- 可删除：warm-pool（228 行）+ core/handoff.js 大部（847 行）+ daemon-claude-engine 中 stream-json 手工解析。
- 回滚：descriptor 层保留 CLI 实现开关，一键切回。
- 依赖代价：新增 @anthropic-ai/claude-agent-sdk 一个官方依赖（用户已批准打破零依赖纪律换取删千行级自维护解析）。

## 风险注意

- `rate_limit_event` 是 CLI 流里没有的新事件，接入时按 status 通道处理（飞书卡片显示限流状态）。
- SDK 会话生命周期与 launchd 重启的恢复语义需对齐 pendingActivations 同级的持久化要求。
