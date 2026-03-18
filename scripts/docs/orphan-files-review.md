# 未被 daemon.js 直接引用的脚本文件审查

> 审查日期: 2026-03-17
> 目的: 确认哪些文件是活跃的、哪些可以安全删除

---

## 分类结果

### ACTIVE — 被其他活跃模块间接引用（无需处理）

| 文件 | 引用方 | 说明 |
|------|--------|------|
| `session-analytics.js` | daemon-claude-engine, distill, memory-extract, session-summarize | 会话分析核心库 |
| `mentor-engine.js` | daemon-claude-engine, daemon-admin-commands | AI 导师引擎 |
| `intent-registry.js` | daemon-claude-engine, hooks/intent-engine | 意图识别注册表 |
| `daemon-command-session-route.js` | daemon-exec-commands, daemon-ops-commands | 会话路由解析 |
| `daemon-siri-bridge.js` | daemon-bridges.js | Siri HTTP 桥接 |
| `daemon-siri-imessage.js` | daemon-siri-bridge.js | iMessage 数据库读取 |
| `telegram-adapter.js` | daemon-bridges.js | Telegram 适配器 |
| `feishu-adapter.js` | daemon-bridges.js | 飞书适配器 |
| `session-summarize.js` | daemon.js (spawn) | 会话总结，由 daemon.js 第1158行 spawn 调用 |

### HEARTBEAT — daemon.yaml 心跳任务调用（无需处理）

| 文件 | daemon.yaml 任务名 | 说明 |
|------|-------------------|------|
| `distill.js` (1447行) | `cognitive-distill` | 认知蒸馏引擎 |
| `memory-extract.js` (428行) | `memory-extract` | 记忆提取 |
| `memory-nightly-reflect.js` (607行) | (nightly task) | 夜间反思 |
| `self-reflect.js` (378行) | `self-reflect` | 自我反思 |

### DEPENDENCY — 被心跳任务间接依赖（无需处理）

| 文件 | 被谁引用 | 说明 |
|------|----------|------|
| `signal-capture.js` | distill.js + Claude Code UserPromptSubmit hook | 信号捕获（hook + 数据源） |
| `pending-traits.js` (147行) | distill.js | 待处理特征 |
| `skill-changelog.js` | skill-evolution.js | 技能变更日志 |

---

### ORPHAN — 疑似孤儿文件，需要王总决策

| 文件 | 行数 | 分析 | 建议 |
|------|------|------|------|
| `daemon-reactive-lifecycle.js` | ~500 | 未被任何生产模块 require，仅被 test 和 verify 脚本引用。**但仍会被部署到 ~/.metame/**（不在 EXCLUDED_SCRIPTS 中）。是计划中的"反应式生命周期"功能，尚未集成 | **删除或归档**？如果不再计划实现。至少应加入 EXCLUDED_SCRIPTS 避免无用部署 |
| `verify-reactive-claude-md.js` | ~100 | 仅引用 daemon-reactive-lifecycle，单独的验证脚本 | 随 reactive-lifecycle 一起处理 |
| `sync-readme.js` | ~50 | 未被任何模块引用，是独立 README 翻译工具。已在 EXCLUDED_SCRIPTS 中，不会被部署到 ~/.metame/ | **保留为 CLI 工具**（无害）还是 **删除**？ |

---

### plugin/scripts/ 孤儿文件（无对应源文件）

这些文件只存在于 `plugin/scripts/`，在 `scripts/` 中没有源文件：

| 文件 | 说明 | 建议 |
|------|------|------|
| `auto-start-daemon.js` | SessionStart hook 自启动 daemon | 迁移到 `scripts/` 还是删除？ |
| `distill-on-start.js` | 启动时 spawn 蒸馏 | 同上 |
| `inject-profile.js` | 注入 SYSTEM KERNEL 协议头 | 同上 |
| `setup.js` | 创建 ~/.claude_profile.yaml | 同上 |

> 风险：下次 `npm run sync:plugin` 会用 `scripts/` 覆盖 `plugin/scripts/`，这 4 个文件可能丢失。

---

## 需要王总确认的决策

1. **daemon-reactive-lifecycle.js** — 这个反应式生命周期功能还计划集成吗？如果不做了就可以删掉。
2. **sync-readme.js** — 是否还在用？
3. **plugin/scripts/ 的 4 个孤儿** — 应该迁移到 `scripts/` 作为源文件，还是已经不需要了？
