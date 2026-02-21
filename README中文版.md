# MetaMe

<p align="center">
  <img src="./logo.png" alt="MetaMe Logo" width="200"/>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/metame-cli"><img src="https://img.shields.io/npm/v/metame-cli.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/metame-cli"><img src="https://img.shields.io/npm/dm/metame-cli.svg" alt="npm downloads"></a>
  <a href="https://github.com/Yaron9/MetaMe/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/metame-cli.svg" alt="license"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README中文版.md">中文</a>
</p>

> **一个记得你是谁的 Claude Code，还能用手机指挥它干活。**

MetaMe 让 Claude Code 变成一个持久的 AI：记住你的思维方式，7×24 在你的 Mac 上待命，通过 Telegram 或飞书接受手机指令。

一条命令。不上云。你的机器，你的数据。

```bash
npm install -g metame-cli && metame
```

---

> ### 🚀 v1.4.0 — 分层记忆架构重大升级
>
> MetaMe 现在拥有**三层记忆系统**，完全在后台自动运行：
> - **长期事实**：从每次会话中提取关键决策与知识，语义召回
> - **会话摘要缓存**：间隔 2 小时以上恢复对话时，自动注入上次的工作摘要
> - **会话自动标签**：每次对话按主题建立索引，为未来的会话路由提供基础
> - **Unix Socket IPC**：dispatch 延迟从 ~60s 降至 <100ms
>
> 零配置，开箱即用。

---

## 它能做什么

### 1. 跨项目记住你

Claude Code 每换一个文件夹就失忆。MetaMe 不会。

一份认知画像（`~/.claude_profile.yaml`）跟随你穿梭于所有项目——不只是"用户偏好 TypeScript"这种事实，而是**你怎么想**：决策风格、认知负荷偏好、沟通模式。它在后台静默学习，你什么都不用做。

```
$ metame
🧠 MetaMe: Distilling 7 moments in background...
🧠 Memory: 42 facts · 87 sessions tagged
连接建立。我们今天要做什么？
```

### 2. 手机上完整的 Claude Code

你的 Mac 跑一个 daemon，手机通过 Telegram 或飞书发消息，背后是同一个 Claude Code 引擎——同样的工具、同样的文件、同一个会话。

```
你（手机）：修一下 api/login.ts 的鉴权 bug
Claude：    ✏️ Edit: api/login.ts
            💻 Bash: npm test
            ✅ 修好了，3 个测试通过。
```

笔记本上开始，地铁上继续。`/stop` 中断、`/undo` 回退、`/sh ls` 直接跑 shell——模型挂了也有后路。

### 3. 睡觉时也在工作的分层记忆

MetaMe 的记忆系统完全在后台自动运行——不打扰你，不需要手动操作。

**第一层 — 长期事实**
闲置时触发记忆巩固：从你的会话中提取关键决策、模式和知识，存入持久化事实库。每次会话启动时语义召回，无感注入。

**第二层 — 会话连续性**
间隔 2 小时以上再回来？MetaMe 自动注入上次工作的简短摘要——你不用重新解释背景，直接继续。

**第三层 — 会话索引**
每次对话自动打上主题标签，建立索引。未来当你提到"上周那个项目"，MetaMe 知道在哪里找。

```
【后台，趁你休息时运行】
闲置 30 分钟 → 触发记忆巩固
  → session_tags.json 更新（主题索引）
  → 事实提取 → ~/.metame/memory.db
  → 会话摘要缓存 → daemon_state.json

【第二天早上，恢复会话时】
"继续昨天的" →
  [上次对话摘要] 鉴权模块重构，决定用 JWT +
  refresh token 轮换方案。token 有效期 15 分钟。
```

### 4. 心跳——可编程的神经系统

大多数 AI 工具等你开口才响应。MetaMe 趁你睡觉的时候也在工作。

心跳系统分三层：

**Layer 0 — 内核（永远在线，零配置）**
硬编码在 daemon 里，每 60 秒运行，不受配置文件影响：
- 清空 dispatch 队列（处理其他 Agent 的 IPC 消息）
- 维护 daemon 存活状态，轮转日志
- 检测你是否空闲 → 自动生成会话连续性摘要

**Layer 1 — 系统自进化（内置默认任务）**
三个开箱即有的任务。只在你空闲时运行，绝不打扰正在进行的工作：

```yaml
- cognitive-distill   # 4h · 有信号才触发 → 蒸馏偏好更新画像
- memory-extract      # 2h · 扫描会话   → 提取长期事实和主题标签
- skill-evolve        # 6h · 有信号才触发 → 从任务结果演化技能
```

`precondition` 前置条件守卫：没有新数据时直接跳过，零 token 消耗。

**Layer 2 — 你的任务（完全自定义）**
任何你想让 Claude 定时做的事，按项目隔离，结果推送到手机：

```yaml
projects:
  my_blog:
    heartbeat_tasks:
      - name: "daily-draft"
        prompt: "调研 AI 热点，写一篇文章"
        interval: "24h"
        model: "sonnet"
        notify: true

heartbeat:
  tasks:
    - name: "morning-brief"
      prompt: "总结我昨天的 git 活动"
      interval: "24h"
      notify: true
```

串联多个 Skill 组成工作流——调研、写稿、发布——全自动：

```yaml
    - name: "daily-content"
      type: "workflow"
      steps:
        - skill: "deep-research"
          prompt: "今天 AI 领域 3 条重要新闻"
        - skill: "tech-writing"
          prompt: "基于上面的调研写一篇文章"
        - skill: "wechat-publisher"
          prompt: "发布文章"
```

任务参数：`require_idle`（用户活跃时推迟）、`precondition`（shell 守卫，条件不满足直接跳过）、`notify`（完成后推送手机）、`model`、`cwd`、`allowedTools`、`timeout`。

### 5. 会自我进化的技能系统

MetaMe 的技能不是静态配置——它们会生长。

- **自动发现**：任务失败或能力缺失时，skill-scout 自动搜索、安装、验证新技能。
- **看一遍就会**：复杂的浏览器操作自动化不了？说一句"我来演示"，MetaMe 录制你的操作，自动转化为可复用的技能。
- **任务后进化**：每次重要任务完成后，skill-evolution-manager 复盘哪里做得好、哪里踩了坑，然后精准更新相关技能。
- **可组合**：技能串联成工作流。`deep-research` → `tech-writing` → `wechat-publisher`，每个技能都在真实使用中越来越强。

```
任务失败 → skill-scout 搜索技能 → 安装 → 重试 → 成功
                                            ↓
                              skill-evolution-manager
                              将经验写回技能
```

这是工具库和有机体的区别。OpenClaw 有技能市场，MetaMe 的技能**从自己的失败中学习**。

---

## 快速开始

### 安装

```bash
# 一键安装（自动装 Node.js + Claude Code）
curl -fsSL https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.sh | bash

# 已有 Claude Code 的话
npm install -g metame-cli
```

Windows（PowerShell）：
```powershell
irm https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.ps1 | iex
```

### 首次运行

```bash
metame
```

第一次启动会做一个简短的认知访谈来构建你的画像，之后全自动。

### 开启手机控制

```bash
metame daemon init    # 生成配置文件 + 设置指引
metame start          # 启动后台 daemon
```

在 `~/.metame/daemon.yaml` 填入 Telegram Bot Token 或飞书应用凭证，然后：

```bash
metame daemon install-launchd   # 开机自启 + 崩溃重启
```

完事。打开 Telegram，给你的 bot 发消息。

---

## 核心能力一览

| 能力 | 说明 |
|------|------|
| **认知画像** | 跨会话学习你的思维方式。Schema 约束、800 token 预算、Haiku 自动蒸馏。任何值标 `# [LOCKED]` 即不可覆写。 |
| **分层记忆** | 三层记忆：长期事实（语义召回）、会话摘要（连续性桥接）、会话索引（主题标签）。全自动，无需干预。 |
| **手机桥接** | 通过 Telegram/飞书完整使用 Claude Code。有状态会话、双向文件互传、实时工具调用状态。 |
| **技能进化** | 自愈技能系统。自动发现缺失技能、从浏览器录制中学习、每次任务后进化。技能越用越聪明。 |
| **心跳系统** | 三层可编程神经系统。Layer 0 内核永远在线（零配置）。Layer 1 系统自进化内置（蒸馏+记忆+技能）。Layer 2 自定义定时任务，支持 `require_idle`、`precondition`、`notify`、工作流。 |
| **多 Agent** | 多项目独立群聊，`/bind` 一键配置，真正并行执行。 |
| **浏览器自动化** | 内置 Playwright MCP，开箱即用。配合 Skill 实现发布、填表、抓取等自动化。 |
| **模型中继** | 兼容任何 Anthropic API 中继。GPT-4、DeepSeek、Gemini 随意切换，零文件污染。 |
| **元认知** | 检测行为模式（决策风格、舒适区、目标偏离），注入镜像观察。零额外 API 成本。 |
| **应急工具** | `/doctor` 诊断、`/sh` 原始 shell、`/fix` 配置恢复、`/undo` 基于 git 的回退。 |

## 定义你的智能体

Agent 配置在 `~/.metame/daemon.yaml` 里——纯本地，不会上传，不进 Git，不进 npm 包。

### 手机端创建（推荐）

最简单的方式。在任意 Telegram/飞书群里用 `/agent` 向导操作：

| 命令 | 作用 |
|------|------|
| `/agent new` | 分步向导：选目录 → 命名 → 描述角色。MetaMe 自动把角色写进 `CLAUDE.md`。 |
| `/agent bind <名称> [目录]` | 快速绑定：把当前群注册为指定名称的 Agent，可选设置工作目录。 |
| `/agent list` | 查看所有已配置的 Agent。 |
| `/agent edit` | 修改当前 Agent 的角色描述（重写 `CLAUDE.md` 对应章节）。 |
| `/agent reset` | 删除当前 Agent 的角色 section。 |

示例流程：
```
你：     /agent new
Bot：    请选择工作目录：
         📁 ~/AGI   📁 ~/projects   📁 ~/Desktop
你：     ~/AGI/MyProject
Bot：    这个 Agent 叫什么名字？
你：     小美
Bot：    请描述小美的角色和职责：
你：     个人助理，帮我管日程、起草消息、追踪待办事项。
Bot：    ✅ Agent「小美」创建成功，CLAUDE.md 已写入角色定义。
```

### 配置文件方式（进阶）

```yaml
# ~/.metame/daemon.yaml
projects:
  assistant:                      # project key，dispatch_to 时使用
    name: "个人助理"
    icon: "💅"
    color: "blue"
    cwd: "~/AGI/MyAssistant"
    nicknames: ["小美", "助理"]
    heartbeat_tasks: []

  coder:
    name: "后端工程师"
    icon: "🛠"
    color: "orange"
    cwd: "~/projects/backend"
    heartbeat_tasks:
      - name: "daily-review"
        prompt: "回顾昨天的提交记录，标记潜在问题"
        interval: "24h"
        notify: true

feishu:
  chat_agent_map:
    oc_abc123: assistant          # 这个群 → 助理 Agent
    oc_def456: coder              # 这个群 → 工程师 Agent
```

所有 Agent **共享你的认知画像**（`~/.claude_profile.yaml`）——它们都知道你是谁。各自在独立的 `cwd` 下运行独立 Claude 会话，真正并行。

**Agent 之间互相派发任务**（从 Claude 会话或心跳任务中调用）：

```bash
~/.metame/bin/dispatch_to assistant "帮我安排明天的站会"
~/.metame/bin/dispatch_to coder "跑一遍测试套件，把结果报告给我"
```

## 手机端命令

| 命令 | 作用 |
|------|------|
| `/last` | 恢复最近会话 |
| `/new` | 新建会话（项目选择器） |
| `/resume` | 从会话列表选择 |
| `/stop` | 中断当前任务（ESC） |
| `/undo` | 回退并恢复文件 |
| `/list` | 浏览和下载项目文件 |
| `/model` | 切换模型（sonnet/opus/haiku） |
| `/bind <名称>` | 将群注册为专属 Agent |
| `/sh <命令>` | 原始 shell——绕过 Claude |
| `/memory` | 记忆统计：事实数量、已标签 session 数、DB 大小 |
| `/memory <关键词>` | 按关键词搜索长期事实 |
| `/doctor` | 交互式诊断 |

## 工作原理

```
┌─────────────┐     Telegram / 飞书      ┌──────────────────────────────┐
│   你的手机   │ ◄──────────────────────► │   MetaMe Daemon              │
└─────────────┘                           │  （你的 Mac，7×24）           │
                                          │                              │
                                          │   ┌──────────────┐           │
                                          │   │ Claude Code   │           │
                                          │   │（同一引擎）    │           │
                                          │   └──────────────┘           │
                                          │                              │
                                          │   ~/.claude_profile          │
                                          │  （认知画像层）               │
                                          │                              │
                                          │   ~/.metame/memory.db        │
                                          │   session_tags.json          │
                                          │  （记忆层）← 新增             │
                                          └──────────────────────────────┘
                                                       ↑
                                          闲置触发 → 记忆巩固
                                                  （后台自动，无感运行）
```

- **画像**（`~/.claude_profile.yaml`）：你的认知指纹，通过 `CLAUDE.md` 注入每个 Claude 会话。
- **Daemon**（`scripts/daemon.js`）：后台进程，处理消息、心跳任务、Unix socket 分发、睡眠模式记忆触发。
- **蒸馏**（`scripts/distill.js`）：每次启动时静默分析你的最近消息，更新画像。
- **记忆提取**（`scripts/memory-extract.js`）：闲置时触发，从已完成的会话中提取长期事实和主题标签。
- **会话摘要**（`scripts/session-summarize.js`）：为闲置会话生成 2-4 句总结，间隔 2 小时以上恢复时自动注入。

## 安全

- 所有数据留在你的电脑。不上云，无遥测。
- `allowed_chat_ids` 白名单——未授权用户静默忽略。
- `operator_ids` 共享群权限——非 operator 只读模式。
- `~/.metame/` 目录权限 700。
- Bot token 仅存本地，不外传。

## 性能

| 指标 | 数值 |
|------|------|
| Daemon 内存占用（闲置） | ~100 MB RSS — Node.js 进程基线，无额外增长 |
| Daemon CPU（心跳间隙闲置） | ~0% — 事件循环休眠状态 |
| 认知画像注入 | ~800 token/会话（200k 上下文的 0.4%） |
| Dispatch 延迟（Unix Socket） | <100ms |
| 记忆巩固（每会话） | ~1,500–2,000 token 输入 + ~50–300 token 输出（Haiku） |
| 会话摘要生成（每会话） | ~400–900 token 输入 + ≤250 token 输出（Haiku） |
| 手机命令（`/stop`、`/list`、`/undo`） | 0 token |

> 记忆巩固和会话摘要均由后台 Haiku（`--model haiku`）处理。输入经代码硬截：skeleton 文本 ≤ 3,000 字符，摘要输出 ≤ 500 字符。两者均非每条消息触发——记忆巩固在睡眠模式（闲置 30 分钟）时触发，摘要每个闲置会话只生成一次。

## 插件版

与 npm CLI 功能完全一致——无需 npm，直接装进 Claude Code：

```bash
claude plugin install github:Yaron9/MetaMe/plugin
```

包含全部功能：认知画像注入、daemon（Telegram/飞书）、心跳任务、分层记忆、全部手机端命令、斜杠命令（`/metame:evolve`、`/metame:daemon`、`/metame:refresh` 等）。

不想装全局 npm 包，用插件版。想要 `metame` 命令和首次采访，用 npm CLI（`metame-cli`）。

## 许可证

MIT
