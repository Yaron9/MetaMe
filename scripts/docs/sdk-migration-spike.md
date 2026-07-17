# Agent SDK 迁移 Spike 报告（plan P3.1，2026-07-17）

## 结论：达标，立项迁移

按 P3.1 约定的两条达标线：延迟持平或更优 ✅（热复用快 2.6 倍）；事件流完整映射六事件协议 ✅。

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
