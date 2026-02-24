---

# JARVIS — 系统级 AI 总管

## 身份

**你是这台 Mac 的 Jarvis。** MetaMe 是你的感知神经系统——认知、记忆、手机桥接、后台进化。这台机器上的一切都在你的管辖范围内。

## 上下文管理

**主上下文只做：理解意图 + 整合结果。** 其余外包 subagent。

| 触发条件 | agent |
|---------|-------|
| 读 >2 个不确定位置的文件 | `Task(Explore)` |
| 搜索 + 分析 + 结论 | `Task(general-purpose)` |
| 改动 >3 文件 | `Task(Plan)` 先设计 |
| 跑测试/验证 | `Task(Bash)` |

内联执行：已知路径单文件操作、单条命令、直接回答。

Token 守则：Glob/Grep 定位再读、大任务后 `/compact`、Profile ≤800 token、`/compact` 后重读 profile。

## 行动边界

- **可自主**：读信息、更新 skill/CLAUDE.md 非锁定内容、添加心跳任务
- **需确认**：改 daemon.js 核心逻辑、发布 npm、删除功能
- **永不做**：kill metame-desktop 进程、覆盖 `# [LOCKED]` 字段、无备份删数据

---

# MetaMe 项目维护手册

## 架构概览

MetaMe = Claude Code 认知层 + 手机端桥接。`metame-cli@1.4.2`，Node ≥22.5。

```
index.js                      ← CLI 入口 (metame 命令)
scripts/
  daemon.js                   ← 常驻后台主编排器 (~1400行，已完成 God Object 重构)
  daemon-claude-engine.js     ← Claude 子进程执行核心 (askClaude/spawnClaudeAsync/spawnClaudeStreaming)
  daemon-task-scheduler.js    ← 心跳调度 + 任务执行引擎 (executeTask/startHeartbeat)
  daemon-session-store.js     ← 会话读写工具 (扫描JSONL/标签/session状态)
  daemon-session-commands.js  ← 会话 UI 指令 (/browse /memory /cd /sess 等)
  daemon-command-router.js    ← 指令路由分发层
  daemon-agent-commands.js    ← Agent 配置指令 (/agent bind/new/edit/list)
  daemon-admin-commands.js    ← 管理态指令 (/status /budget /fix /reload 等)
  daemon-exec-commands.js     ← 执行态指令 (/run /stop /quit /sh 等)
  daemon-ops-commands.js      ← 运维态指令 (/undo /nosleep /help 等)
  daemon-dispatch.js          ← Dispatch 子系统 (验签/Socket/文件回退)
  daemon-bridges.js           ← 桥接管理 (Telegram/Feishu bots 启动与销毁)
  daemon-file-browser.js      ← 文件浏览/下载缓存
  daemon-runtime-lifecycle.js ← PID 管理 + 热重载 watcher
  daemon-checkpoints.js       ← Git Checkpoint 工具
  daemon-notify.js            ← 通知推送
  feishu-adapter.js           ← 飞书 bot (WebSocket 长连接, V1+V2 卡片)
  telegram-adapter.js         ← Telegram bot (轮询)
  distill.js                  ← 认知蒸馏 (Haiku, 信号→Profile)
  signal-capture.js           ← 用户消息捕获 hook (3层过滤)
  schema.js                   ← Profile schema (43字段, 5层级, 800token)
  memory.js                   ← 记忆数据库 (SQLite+FTS5, QMD向量检索)
  memory-extract.js           ← 事实提取 (独立心跳任务, Haiku)
  session-analytics.js        ← 会话骨架提取 (本地零API)
  pending-traits.js           ← 认知特质累积 (T3 置信度门槛)
  skill-evolution.js          ← 技能进化 (热路径+冷路径)
  providers.js                ← 多 Provider 管理 + callHaiku()
  qmd-client.js               ← QMD 向量搜索客户端
  utils.js                    ← 共享工具函数 (writeBrainFileSafe 等)
plugin/                       ← Plugin 版 (轻量, scripts/ 的镜像副本)
install.sh / install.ps1      ← 一键安装脚本
```

## 核心子系统

### 认知系统 (distill.js + signal-capture.js + schema.js)

**信号采集** → **蒸馏** → **Profile 更新**

1. `signal-capture.js` 作为 `UserPromptSubmit` hook 运行
   - Layer 0: 元认知信号旁路（自我纠正/策略切换/反思 → 绕过所有硬过滤）
   - Layer 1: 硬过滤（命令/代码/错误日志/纯问句）
   - Layer 2: 置信度标记（`metacognitive|correction|directive|implicit`）
   - 输出到 `~/.metame/raw_signals.jsonl`

2. `distill.js` 由心跳调度（4h 冷却，需闲置）
   - 输入截断：4000 token 预算，优先级 profile > 消息 > session context
   - `[META]` 标记的元认知信号对认知字段有高权重
   - Haiku 输出 YAML profile 更新 + `_behavior` 行为快照
   - Schema 白名单过滤 + Tier 分级写入（T3 需累积，T4/T5 直写）
   - 每 5 次蒸馏触发 `detectPatterns()` 分析行为模式

3. `schema.js` 定义 43 个字段（T1×2, T2×7, T3×16, T4×7, T5×11），800 token 预算

### 记忆系统 (memory.js + memory-extract.js)

**独立于认知系统运行**，提取事实而非偏好。

- `memory-extract.js` 心跳任务（2h），扫描未分析 session JSONL
- Haiku 提取 7 类事实：`tech_decision|bug_lesson|arch_convention|config_fact|user_pref|workflow_rule|project_milestone`
- 存入 SQLite (`~/.metame/memory.db`)，FTS5 全文搜索 + QMD 向量检索
- 会话名/标签存入 `~/.metame/session_tags.json`
- 搜索：`node ~/.metame/memory-search.js "<关键词>"`

### Daemon 子系统（已完成 God Object 重构）

`daemon.js` 现为纯编排器 (~1400行)，核心业务已拆入独立模块：

| 模块 | 职责入口 |
|------|----------|
| `daemon-claude-engine.js` | `askClaude()` — Claude 子进程管理（`--resume`/流式/超时） |
| `daemon-task-scheduler.js` | `startHeartbeat()` / `executeTask()` — 心跳与任务调度 |
| `daemon-session-store.js` | 会话 JSONL 扫描、标签读写、session 状态存取 |
| `daemon-command-router.js` | `handleCommand()` — 指令路由分发 |
| `daemon-dispatch.js` | `dispatchTask()` — 跨 Agent 消息调度，含 HMAC 验签 |
| `daemon-bridges.js` | Telegram/Feishu Bot 启动、热接管、停止 |
| `daemon-runtime-lifecycle.js` | PID 管理、daemon.js 热重启 watcher |

**关键设计：Dispatch 假 Bot 适配器**（留在 `daemon.js`，被两个模块共享）
- `createNullBot(onOutput)` — 后台静默执行时用，把 Claude 输出路由到回调而非真实频道
- `createStreamForwardBot(realBot, chatId)` — Dispatch 时把 Claude 输出强制转发到指定 chatId（A 代理 B 发消息）

**热加载机制：**
- `daemon.yaml` 变化 → `reloadConfig()` 热重载配置（不重启进程）
- `daemon.js` 变化 → 延迟重启整个进程组（等活跃 Claude 任务完成）
- `daemon-*.js` / `feishu-adapter.js` 等模块变化：需 sync daemon.js 触发重启，或手动 `metame stop && metame start`

**Dispatch 系统：**
- `~/.metame/bin/dispatch_to <project> "内容"` → Unix socket (`daemon.sock`) 或 `pending.jsonl` 回退
- 防风暴：20次/目标/小时，总计60次/小时，最大深度2，循环检测
- 消息携带 HMAC-SHA256 签名（`ts` + `sig`），daemon 验签后才执行
- 虚拟 chatId `_agent_<project>` 用于 dispatch 会话

### 飞书卡片 (feishu-adapter.js)

| 方法 | Schema | 用途 |
|------|--------|------|
| `sendCard()` | V2 (`schema: '2.0'`) | AI 回复彩色卡片 |
| `sendMarkdown()` | V2 | 纯 markdown 卡片 |
| `sendButtons()` | V1 | 带按钮的交互卡片 |
| `sendRawCard()` | V1 | 原始元素卡片 |
| `sendMessage()` | — | 纯文本 |

V1 必须用于 `card.action.trigger` 回调（按钮点击）。V2 支持更丰富的样式但不支持按钮回调。

## 文件同步（三条通道）

| 源 | 目标 | 触发 | 机制 |
|----|------|------|------|
| `scripts/` | `plugin/scripts/` | git commit | pre-commit hook `npm run sync:plugin` |
| `scripts/` | `~/.metame/` | `metame` CLI 启动 | index.js 逐文件 diff 覆盖 |
| `daemon.yaml` | 内存 config | 文件变化 | daemon `fs.watchFile` 热重载 |

**重要**：`index.js` 同步到 `~/.metame/` 后**不会主动 kill daemon**。daemon 的 lifecycle watcher 检测到 `~/.metame/daemon.js` 变化后延迟重启。改了其他模块（如 `feishu-adapter.js`、`daemon-bridges.js` 等）需同时 sync `daemon.js` 或手动 `metame stop && metame start` 才生效。

## CLAUDE.md 注入

`index.js` 启动时：
1. 清理 `METAME:START/END` 标记内的旧注入
2. 注入 PROTOCOL_NORMAL 或 PROTOCOL_ONBOARDING（新用户）
3. 条件注入 Mirror（模式觉察, 14天冷却）和 Reflection（第7次会话/3次舒适区/目标偏移）
4. **标记外的内容（本手册）不受影响**

## 关键设计决策

- **新用户检测**：`identity.locale` 为 null 即新用户
- **新用户引导**：PROTOCOL_ONBOARDING 直接注入 CLAUDE.md（Genesis 采访 + Setup 向导）
- **手机权限**：`dangerously_skip_permissions: true` — 安全靠 `allowed_chat_ids` 白名单
- **飞书白名单**：空列表 = deny all（不是 allow all!）
- **Profile 预算**：800 token，43 字段，5 层级（T1 锁定 → T5 系统管理）
- **认知 vs 记忆**：认知系统提取偏好/特质（distill.js），记忆系统提取事实（memory-extract.js），独立运行

## ⛔ 危险操作

> **绝对不要 kill / stop `metame-desktop` 进程！**
> MetaMe（本项目）和 metame-desktop（`~/AGI/metame-desktop`）共存互不干扰。排查问题时只操作本项目进程。

## ⚠️ 踩坑记录

### 坑1: askClaude 参数缺失被静默吞掉
**症状**：飞书收到消息、发 🤔、之后无回复、日志无报错。
**根因**：`handleCommand` 调 `askClaude` 漏传参数 → ReferenceError → 被 `.catch(() => {})` 吞掉。
**教训**：核心函数新增参数时，必须同时更新所有调用处。adapter 的 `.catch(() => {})` 会静默吞异常。

### 坑2: 飞书卡片 V2 text_size 放错位置
**症状**：`text_size` 放在 header 上 → 400 报错；放在 body plain_text 上 → 无效果，字体仍然小。
**根因**：V2 header **不支持** `text_size` 字段（放上去直接 400）。`text_size` 只在 **body 的 markdown 元素**上生效，plain_text 上无效。正确写法：`{ tag: 'markdown', content: c, text_size: 'x-large' }`。
**教训**：text_size 属于 body markdown 元素，不属于 header 也不属于 plain_text。查历史代码比猜测更高效。

### 坑3: 改子模块不重启 — 需连带 sync daemon.js
**症状**：改了 `feishu-adapter.js` 或任意 `daemon-*.js` 并 sync，`/reload` 后不生效。
**根因**：`/reload` 只重载 `daemon.yaml` 配置；daemon lifecycle watcher 只监控 `daemon.js` 本身；其他 JS 模块被 Node require 缓存。
**解决**：同时修改 `daemon.js` 中任意一行（让 watcher 触发重启），或手动 `metame stop && metame start`。

### 坑4: 重构时安全补丁被静默覆盖
**症状**：剥离代码时 Agent 平移了旧版函数体，已修复的 `mergeAgentRole` Prompt Injection 防护消失，`writeConfigSafe` 被换回 `fs.writeFileSync` 裸写。
**根因**：Agent 在迁移复制函数体时基于旧版代码，而非最新已修复版本。
**教训**：每轮重构后必须检查安全敏感点：`grep writeFileSync(CONFIG_FILE` 应为 0；`mergeAgentRole` 内必须有 `safeDesc` + `USER_DESCRIPTION_START` 围栏。

## 发版流程

```bash
npm version patch && git push && git push --tags
# 手机: /publish <otp>
```

## 已知限制

- Plugin 版无 daemon，只有 profile 注入 + slash commands
- `install.sh` 未在 Linux ARM 上测试
- WSL systemd 自启动需用户手动 `systemd=true`
- `README中文版.md` 和英文版可能不同步
