# 🔮 MetaMe

<p align="center">
  <img src="./logo.png" alt="MetaMe Logo" width="200"/>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/metame-cli"><img src="https://img.shields.io/npm/v/metame-cli.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/metame-cli"><img src="https://img.shields.io/npm/dm/metame-cli.svg" alt="npm downloads"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/metame-cli.svg" alt="node version"></a>
  <a href="https://github.com/Yaron9/MetaMe/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/metame-cli.svg" alt="license"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README中文版.md">中文</a>
</p>

> **Claude Code 的"认知画像"层 (The Cognitive Profile Layer)**
>
> *懂你怎么想，陪你到处走。*

## 📖 简介

**Claude Code** 很强大，但有两个痛点：

1. **项目失忆症** — 切换文件夹，它就忘了你是谁。你的沟通风格、编码偏好、约束条件——全没了。每个项目都要从头来过。

2. **被困在电脑前** — 离开电脑，工作就中断。你没法在手机上继续那个调试会话，没法在地铁上、床上、排队时跟 Claude 继续 vibe。

**MetaMe** 全都解决——还有更多：

**🧠 认知画像** — 一个持久的"全局大脑"（`~/.claude_profile.yaml`），跟随你穿梭于每个项目。不同于 ChatGPT/Claude 的内置记忆（存的是"用户住在哪里"这种*事实*），MetaMe 捕捉的是*你怎么想*——你的决策风格、认知负荷偏好、沟通特征。它不是记忆系统，是你的**认知镜像**。

**📱 移动桥接** — 手机端完整 Claude Code，通过 Telegram 或飞书。同样的工具、同样的文件、同样的对话历史。在电脑上开始，随处继续。`/cd last` 让你精准同步到之前的位置。

**🔔 远程唤醒** — Daemon 在你电脑后台运行。手机发条消息，就能唤醒电脑上的 Claude Code 干活——编辑文件、跑命令、提交代码——即使你不在电脑前。

**📂 文件互传** — 电脑传手机（让 Claude 发送任何项目文件）。手机传电脑（直接在聊天里发附件）。双向无缝。

**⏰ 心跳任务** — 定时自动运行 Claude。每日总结、自动化工作流、多步骤 Skill 链——全在你的电脑上跑，结果推送到手机。

## ✨ 核心特性

* **🧠 全局大脑 (`~/.claude_profile.yaml`)：** 唯一的、可移植的真理来源——你的身份、认知特征和偏好跟随你穿梭于每个项目。
* **🧬 认知进化引擎：** 三条学习通道：(1) **被动蒸馏**——静默捕获消息，启动时用 Haiku 提取认知特征；(2) **手动进化**——`!metame evolve` 显式教学；(3) **置信度门控**——强指令（"以后一律"/"always"）直写，普通观察需 3+ 次一致观察才晋升。Schema 白名单（41 字段、5 层 Tier、800 token 预算）防止膨胀。
* **🛡️ 自动锁定：** 任何值标记 `# [LOCKED]` 即为宪法，永不被自动修改。
* **🪞 元认知层 (v1.3)：** MetaMe 不只观察你*说什么*，还观察你*怎么想*。行为模式检测复用现有的 Haiku 蒸馏调用（零额外成本），跨会话追踪决策模式、认知负荷、舒适区和回避主题。当持续模式出现时，注入一行镜像观察——例如"你倾向于拖延测试直到被迫"——每个模式 14 天冷却。反思提示仅在触发条件下出现（每 7 次蒸馏或连续 3 次舒适区）。所有注入逻辑在 Node.js 中运行，Claude 只收到已决策的指令。
* **📱 远程 Claude Code (v1.3)：** 手机端完整 Claude Code 体验，支持 Telegram 和飞书。有状态会话（`--resume`）——和终端一样的对话历史、工具调用、文件编辑。可点击按钮选择项目/会话/目录，支持 macOS launchd 自启动。
* **🔄 工作流引擎 (v1.3)：** 将多步骤 Skill 链定义为心跳任务。每个工作流在单个 Claude Code 会话中通过 `--resume` 运行，上一步的输出自动成为下一步的上下文。示例：`deep-research` → `tech-writing` → `wechat-publisher`——全自动内容流水线。
* **⏹ 手机端完整终端控制 (v1.3.10)：** `/stop`（ESC）、`/undo`（ESC×2，原生 file-history 恢复）、并发任务保护、代码变更自动热重启、`metame continue` 手机→电脑一键同步。
* **🎯 目标对齐与偏离检测 (v1.3.11)：** MetaMe 现在能追踪你的 session 是否偏离声明目标。每次蒸馏自动评估 `goal_alignment`（aligned/partial/drifted），零额外 API 成本。连续 2 个 session 偏离时，镜像观察被动注入；连续 3 个 session 后，反思提示温和地问："是方向有意调整了，还是不小心偏了？" Session 日志现在记录项目名、分支、意图和文件目录，提供更丰富的回顾分析。模式检测可发现跨 session 历史的持续偏离趋势。
* **🔌 第三方模型中继 (v1.3.11)：** 支持任何 Anthropic 兼容 API 中继作为后端——零文件污染、零侵入。MetaMe 在进程启动时注入 `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` 环境变量。支持按任务类型分配不同 provider（`active` / `distill` / `daemon`）。CLI: `metame provider add/use/remove/test`。配置存储于 `~/.metame/providers.yaml`。
* **📊 会话历史冷启动 (v1.3.12)：** 解决冷启动问题——此前 MetaMe 需要 5-7 个 session 才能产生可感知的反馈。现在首次启动即自动从现有 Claude Code JSONL 会话记录中批量补全历史（零 API 成本）。三层互补数据架构：**骨架层**（本地提取的结构事实——工具调用、时长、项目、分支、意图）、**切片层**（`/insights` 提供的交互质量——outcome、friction、satisfaction，有则用无则跳过）、**Haiku 层**（元认知判断——认知负荷、舒适区、目标对齐，复用已有蒸馏调用）。从你的第一个 MetaMe session 起就能看到模式检测和镜像观察。
* **🏥 应急恢复 (v1.3.13)：** `/doctor` 交互式诊断 + 一键修复、`/sh` 手机直接执行电脑 shell 命令（完全绕过 Claude，断线时的最后生命线）、配置修改前自动备份、`/fix` 一键恢复上次正常配置。`/model` 交互式模型切换，切换前自动备份。
* **🌐 浏览器自动化 (v1.3.15)：** 原生 Playwright MCP 集成——首次运行自动注册。每个 MetaMe 用户开箱即获浏览器操控能力。配合 Skills 可实现播客发布、表单填写、网页抓取等自动化工作流。
* **📂 交互式文件浏览器 (v1.3.15)：** `/list` 显示可点击按钮卡片——文件夹点击展开，文件点击下载。文件夹按钮使用绝对路径，重启不过期。零 token 消耗。
* **🔀 多 Agent 专属群并行执行 (v1.3.19)：** 为每个 Agent 创建独立飞书/Telegram 群，不同群同时发消息真正并行执行、互不等待。通过 `daemon.yaml` 中的 `chat_agent_map` 配置 chatId → Agent 路由。新建群后发 `/bind <名称>` 即可一键完成全部配置。
* **🔧 配置热重载修复 (v1.3.19)：** `allowed_chat_ids` 改为每条消息动态读取——修改 `daemon.yaml` 后立即生效，无需重启。`/fix` 恢复备份时自动合并当前 chatId 配置，不再丢失手动添加的群组。
* **🛡️ Daemon 自动保活 LaunchAgent (v1.3.19)：** MetaMe npm daemon 现在由 macOS launchd 管理，崩溃或意外退出后 5 秒自动重启。
* **👥 Operator 权限 & 只读聊天模式 (v1.3.19)：** 在共享群（如有同事或测试用户）中，通过 `operator_ids` 限制哪些用户能执行 Claude 命令。非 operator 可以正常聊天和查询（读取/搜索/网页），但不能编辑文件、执行 bash 或触发斜杠命令。用 `/myid` 获取任意飞书用户的 open_id。

## 🛠 前置要求

MetaMe 是 **Claude Code** 的外壳。你必须先安装 Node.js 和官方的 Claude Code 工具。

1. **Node.js**: 版本 14 或更高。
2. **Claude Code**: 确保 `claude` 命令可用且已登录。

## 📦 安装

**方式 A: NPM（推荐）** — 完整 CLI，含 daemon、移动桥接、访谈

```bash
npm install -g metame-cli
```

**方式 B: Claude Code Plugin** — 轻量级，档案注入 + 斜杠命令

```bash
claude plugin install github:Yaron9/MetaMe/plugin
```

*(NPM 注：Mac/Linux 如遇权限错误，使用 `sudo npm install -g metame-cli`)*

## 🚀 使用指南

忘掉 `claude` 命令吧。从现在起，只需输入：

```bash
metame
```

### 初次运行：创世纪

当你第一次运行 MetaMe 时，它会检测到你的档案为空，进入 **校准模式**：

1. 它会询问你的 **代号**（昵称）。
2. 它会开启一场 **深度认知访谈**，探索你的天赋领域、思维模式和潜在焦虑。
3. **请务必诚实**：它是一面镜子。你越坦诚（即便是关于你的恐惧），它就越能成为你的完美分身。
4. 完成后，它会保存你的"源代码"并启动 Claude。

### 日常工作流

1. `cd` 进入任何项目文件夹。
2. 运行 `metame`。
3. Claude 启动并立即识别你。
4. 开始写代码。MetaMe 会在后台自动管理上下文。

### 认知进化

MetaMe 通过两条路径认识你：

**自动（零操作）：** 全局 Hook 捕获消息，下次启动时 Haiku 在后台蒸馏认知特征。强指令（"以后一律"/"always"）直接写入；普通观察需 3+ 次一致观察才晋升。所有写入经过 Schema 验证（41 字段，800 token 预算）。启动时你会看到：

```
🧠 MetaMe: Distilling 7 moments in background...
```

**手动：** 直接更新某个特征：

```bash
metame set-trait status.focus "学习 Rust"
metame evolve "我更喜欢函数式编程"
```

**情境记忆（关键帧，非全量日志）：** MetaMe 不是记忆系统，但它捕获两类纯性格特征无法替代的经验"关键帧"：

* **避坑指南** (`context.anti_patterns`, 最多 5 条)：跨项目的失败教训——例如*"Promise.all 单点失败会全部 reject，应使用 Promise.allSettled"*。60 天自动过期。防止 AI 在不同会话中重复犯同样的错误。
* **里程碑** (`context.milestones`, 最多 3 条)：最近完成的关键节点——例如*"MetaMe v1.3 已发布"*。提供连续性，让 Claude 知道你进展到哪了，无需你每次复述。

**防偏差机制：** 单次观察 ≠ 特征，矛盾信号追踪而非盲目覆盖，pending 特征 30 天无新观察自动过期，上下文字段过期自动清理。

**会话内命令（在 Claude Code 中输入）：**

| 命令 | 说明 |
|------|------|
| `!metame refresh` | 重新注入个人档案到当前会话 |
| `!metame evolve "..."` | 教 MetaMe 一个新洞察 |
| `!metame set-trait key value` | 更新某个档案字段 |

**元认知控制：**

```bash
metame quiet            # 静默镜像观察和反思提示 48 小时
metame insights         # 查看已检测到的行为模式
metame mirror on|off    # 开关镜像注入
```

### 远程 Claude Code —— Telegram & 飞书（v1.3）

手机端完整 Claude Code——有状态会话，支持对话历史、工具调用、文件编辑。同时支持 Telegram 和飞书。

**配置：**

```bash
metame daemon init                    # 创建配置 + 设置指引
```

编辑 `~/.metame/daemon.yaml`：

```yaml
telegram:
  enabled: true
  bot_token: "你的BOT_TOKEN"           # 从 @BotFather 获取
  allowed_chat_ids:
    - 123456789                        # 你的 Telegram chat ID

feishu:
  enabled: true
  app_id: "你的APP_ID"                # 从飞书开发者后台获取
  app_secret: "你的APP_SECRET"
  allowed_chat_ids: []                # 空 = 允许所有
```

**启动守护进程：**

```bash
metame start                          # 后台运行
metame status                         # 查看状态
metame logs                           # 查看日志
metame stop                           # 停止
metame daemon install-launchd         # macOS 自启动（开机自启 + 崩溃重启）
```

**macOS 自启动（推荐）：** 让 daemon 在睡眠唤醒、开机后自动恢复：

```bash
metame daemon install-launchd
launchctl load ~/Library/LaunchAgents/com.metame.daemon.plist
```

加载后，daemon 开机自启、睡眠唤醒自动恢复、崩溃自动重启。不再需要手动 `metame start`。

> **注意：** 二选一 —— 要么用 launchd 管理，要么手动管理（`metame start/stop`）。不要混用，否则会产生重复进程。

```bash
# 查看状态（两种方式都可以用）
metame status

# 关闭自启动
launchctl unload ~/Library/LaunchAgents/com.metame.daemon.plist

# 彻底删除
rm ~/Library/LaunchAgents/com.metame.daemon.plist
```

**会话命令（Telegram 和飞书均支持可点击按钮）：**

| 命令 | 说明 |
|------|------|
| `/last` | **快速恢复** — 优先当前目录最近 session，否则全局最近 |
| `/new` | 新建会话——从按钮列表选择项目目录 |
| `/new <path> [name]` | 在指定路径新建会话，可选命名 |
| `/resume` | 恢复会话——可点击列表，显示会话名 + 实时时间戳 |
| `/resume <name>` | 按名称恢复（支持模糊匹配，跨项目搜索） |
| `/name <name>` | 为当前会话命名（与桌面端 `/rename` 同步） |
| `/cd` | 切换工作目录——带目录浏览器 |
| `/cd last` | **同步到电脑** — 跳转到最近 session 所在目录 |
| `/session` | 查看当前会话信息 |
| `/stop` | 中断当前任务（相当于终端按 ESC） |
| `/undo` | 回退对话轮次并恢复文件（相当于终端按 ESC×2） |

直接打字即可对话——每条消息都在同一个 Claude Code 会话中，保持完整上下文。

**原理：**

每个聊天绑定一个持久会话，通过 `claude -p --resume <session-id>` 调用。这是和终端完全相同的 Claude Code 引擎——相同的工具（文件编辑、bash、代码搜索）、相同的对话历史。你可以在电脑上开始工作，手机上 `/resume` 继续，反之亦然。

**桌面与手机无缝切换 (v1.3.13)：**

同一个 session 在桌面和手机上共用，但有一个不对称性：

* **电脑 → 手机：** 自动同步。手机端每条消息都会启动新的 `claude -p --resume`，自动读取最新的 session 文件。直接打字即可。
* **手机 → 电脑：** 需要同步。桌面 Claude Code 会话在内存中运行，不会自动读取手机新增的对话。先退出 Claude（Ctrl+C），然后：

```bash
metame continue
```

自动恢复最新 session，包含手机上的所有对话。也可以用 `metame sync`。

**实时状态显示 (v1.3.7)：** 手机上实时看到 Claude 的工作进度：

```
📖 Read: 「config.yaml」
✏️ Edit: 「daemon.js」
💻 Bash: 「git status」
```

**文件互传 (v1.3.8)：** 手机和电脑之间无缝传输文件。

*电脑 → 手机（下载）：* 让 Claude 把项目文件发到手机：

```
你: 把 report.md 发过来
Claude: 请查收~!
        [📎 report.md]  ← 点击下载
```

支持文档、音频、图片等任意文件。点击按钮即可下载，链接 30 分钟有效。

*手机 → 电脑（上传）：* 直接发送文件到项目目录：

```
[📎 你发送了一个 PDF、图片或任意文件]
Claude: 📥 已保存: document.pdf
        文件在项目的 upload/ 文件夹中。
```

上传的文件保存在 `<项目目录>/upload/`。Claude 不会自动读取大文件——需要时再让它处理。

- **Telegram:** 开箱即用
- **飞书:** 需要在应用权限中添加 `im:resource` + `im:message`

**任务控制 (v1.3.13)：** 手机端完整复刻终端操控能力。

*`/stop` — 等同于 ESC：* 向正在运行的 Claude 进程发送 SIGINT，立即中断，和终端按 ESC 完全一样。

*`/undo` — 等同于 ESC×2：* 交互式轮次选择器，显示你的实际消息内容。选择回退到哪一轮——会话历史被截断，所有修改过的文件通过 Claude 原生的 `~/.claude/file-history/` 备份恢复（和终端按两次 ESC 完全相同的机制）。被新建的文件会删除，被删除的文件会恢复。零风险。

```
你: /undo
Bot: 回退到哪一轮？
     ⏪ 重构API接口 (5分钟前)
     ⏪ 修复登录bug (12分钟前)
     ⏪ 添加测试用例 (30分钟前)
```

**并发任务保护：** 如果已有 Claude 任务在运行，新消息会被拦截，提示等待或 `/stop`。防止会话冲突。

**热重启 (v1.3.13)：** 守护进程监听自身代码变化。当你更新 MetaMe（通过 npm 或 git）时，daemon 自动用新代码重启——无需手动操作。重启后推送通知确认。

**应急与诊断 (v1.3.13)：**

| 命令 | 说明 |
|------|------|
| `/sh <命令>` | 手机直接执行电脑 shell 命令——完全绕过 Claude。模型坏了时的最后生命线。 |
| `/doctor` | 交互式诊断：检查配置、模型、CLI、备份。有问题显示修复按钮。 |
| `/fix` | 从上次备份恢复 daemon.yaml |
| `/reset` | 重置模型为 opus |

**其他命令：**

| 命令 | 说明 |
|------|------|
| `/status` | 守护进程状态 + 画像摘要 |
| `/tasks` | 列出心跳任务 |
| `/run <名称>` | 立即执行某个任务 |
| `/model [名称]` | 交互式模型切换，带按钮选择（sonnet, opus, haiku），切换前自动备份 |
| `/budget` | 今日 token 用量 |
| `/quiet` | 静默镜像/反思 48 小时 |
| `/reload` | 手动重载 daemon.yaml（文件变化时也会自动重载） |
| `/bind <名称>` | 将当前群注册为专属 Agent 群，弹出目录浏览器选择工作目录 |
| `/chatid` | 显示当前群的 chatId |
| `/myid` | 显示你自己的飞书 sender open_id（用于配置 `operator_ids`） |

**心跳任务：**

在 `daemon.yaml` 中定义定时任务：

```yaml
heartbeat:
  tasks:
    - name: "morning-news"
      prompt: "抓取今天AI领域的重要新闻，整理成3条摘要。"
      interval: "24h"
      model: "haiku"
      notify: true
      precondition: "curl -s -o /dev/null -w '%{http_code}' https://news.ycombinator.com | grep 200"
```

* `precondition`：预检命令——输出为空则跳过，零 token 消耗。
* `type: "script"`：直接运行本地脚本，不走 `claude -p`。
* `notify: true`：结果推送到 Telegram/飞书。

**工作流任务**（多步骤 Skill 链）：

```yaml
heartbeat:
  tasks:
    - name: "daily-wechat"
      type: "workflow"
      interval: "24h"
      model: "sonnet"
      notify: true
      steps:
        - skill: "deep-research"
          prompt: "今天 AI 领域 3 条重要新闻"
        - skill: "tech-writing"
          prompt: "基于上面的调研结果写一篇公众号文章"
        - skill: "wechat-publisher"
          prompt: "发布文章"
          optional: true
```

每个步骤在同一个 Claude Code 会话中运行。上一步的输出自动成为下一步的上下文。`optional: true` 表示该步骤失败不中断整个工作流。

**自动重载：** 守护进程监听 `daemon.yaml` 的变化。当 Claude（或你）编辑配置文件时，守护进程自动重载——无需重启或手动发 `/reload`。重载后推送通知确认。

**Token 效率：**

* 轮询、斜杠命令、目录浏览：**零 token**
* 有状态会话：和终端使用 Claude Code 成本相同
* 日 token 预算限额（默认 50000）
* Claude 调用间隔 10 秒冷却

**安全模型：**

* `allowed_chat_ids` 白名单——未授权用户静默忽略（空列表 = 拒绝所有）
* `operator_ids`——在已授权群内，限制命令执行权限到特定用户；非 operator 进入只读聊天模式
* 手机端默认开启 `dangerously_skip_permissions`（手机无法点击「允许」，安全靠 chatId 白名单保证）
* `~/.metame/` 目录权限 700
* Bot token 仅存本地，不外传

### 多 Agent 专属群并行执行 & `/bind` 命令 (v1.3.19)

为每个 Agent 创建独立的群聊——不同群里的消息同时执行，互不等待、真正并行。

**工作原理：**

在 `daemon.yaml` 的 `chat_agent_map` 中把每个 `chatId` 映射到一个 Agent。消息到达时，daemon 查找该群归属哪个 Agent，把 Claude 调用分发到对应的工作目录——完全并行。

**配置方式 — `/bind` 命令（推荐）：**

1. 新建一个飞书或 Telegram 群，把 bot 拉进来。
2. 在群里发 `/bind <名称>`（例如 `/bind 后端`）。
3. Bot 弹出 Finder 风格的目录浏览器——点击文件夹逐级导航，点击文件夹名选定为工作目录。
4. 完成。Bot 自动执行：
   - 将该群 `chatId` 加入 `allowed_chat_ids` 白名单
   - 在 `chat_agent_map` 中创建路由条目
   - 在 `projects` 中创建 Agent 配置
   - 发送欢迎卡片

> **免白名单：** `/bind` 命令无需预先配置，新群可直接自注册——不用提前把 chatId 加到 `allowed_chat_ids`。

> **重新绑定：** 在同一个群再次发 `/bind <名称>` 即可覆盖之前的配置。

**手动配置**（`~/.metame/daemon.yaml`）：

```yaml
chat_agent_map:
  "oc_abc123": "backend"          # chatId → project key
  "oc_def456": "frontend"

projects:
  backend:
    name: "后端 API"
    cwd: "~/projects/api"
  frontend:
    name: "前端应用"
    cwd: "~/projects/app"
```

**`/chatid` 命令：**

在任意已授权群中发 `/chatid`，bot 回复当前群的 chatId。适合手动配置时查询。

| 命令 | 说明 |
|------|------|
| `/bind <名称>` | 将当前群注册为专属 Agent 群——弹出目录浏览器选择工作目录 |
| `/chatid` | 显示当前群的 chatId |
| `/myid` | 显示你的飞书 open_id |

**Operator 权限管理（`operator_ids`）：**

在有多个用户的共享群中（例如带测试用户的群），可以限制哪些人能执行 Claude 命令。非 operator 进入只读聊天模式——可以提问和查询，但不能编辑文件、跑 bash 或触发斜杠命令。

```yaml
feishu:
  operator_ids:
    - "ou_abc123yourid"   # 只有这些用户可以执行命令
```

用 `/myid` 在飞书群中获取某用户的 open_id，加入 `operator_ids` 即授予完整执行权限。

| 用户类型 | 聊天 & 查询 | 斜杠命令 | 写 / 改 / 执行 |
|---------|:---:|:---:|:---:|
| Operator | ✅ | ✅ | ✅ |
| 非 Operator | ✅ | ❌ | ❌ |

> 若 `operator_ids` 为空，所有白名单用户均有完整执行权限（默认行为）。

### 第三方模型中继 — Provider Relay (v1.3.11)

MetaMe 支持任何 Anthropic 兼容 API 中继作为后端。你可以将 Claude Code 的请求通过中继转发到任意模型（GPT-4、DeepSeek、Gemini 等）——MetaMe 传递标准模型名，中继负责翻译映射。

**原理：** 进程启动时注入 `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` 环境变量。零文件污染——`~/.claude/settings.json` 永远不会被修改。

**CLI 命令：**

```bash
metame provider                         # 列出所有 provider
metame provider add <名称>               # 添加中继（交互式输入 URL 和 Key）
metame provider use <名称>               # 切换当前 provider
metame provider remove <名称>            # 删除 provider（不能删除 'anthropic'）
metame provider test [名称]              # 测试连通性
metame provider set-role distill <名称>  # 为后台蒸馏指定不同 provider
metame provider set-role daemon <名称>   # 为 daemon 任务指定不同 provider
```

**配置文件** (`~/.metame/providers.yaml`)：

```yaml
active: 'anthropic'
providers:
  anthropic:
    label: 'Anthropic (Official)'
  my-relay:
    label: '我的中继'
    base_url: 'https://api.relay.example.com/v1'
    api_key: 'sk-xxx'
distill_provider: null          # null = 跟随 active
daemon_provider: null           # null = 跟随 active
```

三个独立的 provider 角色可以按需优化成本：例如主力工作用官方 Anthropic Key，后台蒸馏用便宜的中继，daemon 心跳任务用另一个。

### 热刷新 (Refresh)

如果你更新了个人档案，或者需要修复断开的上下文连接，而**不想重启会话**：

*   **在 Claude 内部**：运行 `!metame refresh`
*   **在外部终端**：运行 `metame refresh`

这会立即将你最新的档案重新注入 `CLAUDE.md`。

## ⚙️ 配置与"全局大脑"

你的个人档案存储在你用户主目录下的一个隐藏 YAML 文件中。

**位置：** `~/.claude_profile.yaml`

你可以手动编辑此文件来更新你的状态或锁定你的价值观。

**档案示例（v2 Schema）：**

```yaml
# === T1: 身份（锁定）===
identity:
  nickname: Neo              # [LOCKED]
  role: Senior Architect
  locale: en-US              # [LOCKED]

# === T2: 核心特质（锁定）===
core_traits:
  crisis_reflex: Analysis    # [LOCKED]
  flow_trigger: Debugging    # [LOCKED]
  learning_style: Hands-on   # [LOCKED]

# === T3: 偏好（自动学习）===
preferences:
  code_style: concise
  communication: direct
  explanation_depth: brief_rationale

# === T3b: 认知（自动学习，缓慢变化）===
cognition:
  decision_style: analytical
  info_processing:
    entry_point: big_picture
    preferred_format: structured
  cognitive_load:
    chunk_size: medium
    preferred_response_length: moderate

# === T4: 上下文（自动覆写）===
context:
  focus: "重构遗留代码"
  energy: high
  milestones:
    - "MetaMe v1.3 已发布"
  anti_patterns:
    - text: "Promise.all 单点失败全部 reject，用 Promise.allSettled"
      added: "2026-01-20"

# === T5: 进化（系统管理）===
evolution:
  distill_count: 12
  last_distill: "2026-01-30T10:00:00Z"
```

* **T1-T2** 标记 `# [LOCKED]` 的字段永远不会被自动修改。
* **T3** 字段通过置信度门槛自动学习。
* **T4** 字段随上下文变化自由覆写。
* **T5** 字段由蒸馏系统管理。

### 档案迁移（v1 → v2）

如果你有旧版 v1 档案，运行迁移脚本：

```bash
node ~/.metame/migrate-v2.js --dry-run   # 预览变更
node ~/.metame/migrate-v2.js             # 执行迁移（自动创建备份）
```

## 🗑️ 卸载

如果你希望从系统中彻底移除 MetaMe：

### 1. 移除软件包

```bash
npm uninstall -g metame-cli
```

### 2. 移除全局大脑（可选）

```bash
rm ~/.claude_profile.yaml
```

### 3. 停止守护进程

```bash
metame stop
launchctl unload ~/Library/LaunchAgents/com.metame.daemon.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.metame.daemon.plist
```

### 4. 移除被动蒸馏数据（可选）

```bash
rm -rf ~/.metame
```

### 5. 移除信号捕获 Hook（可选）

MetaMe 在 `~/.claude/settings.json` 中安装了全局 Hook。移除方式：

```bash
node -e "
const fs = require('fs');
const p = require('os').homedir() + '/.claude/settings.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
if (s.hooks) { delete s.hooks.UserPromptSubmit; }
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('Hook 已移除。');
"
```

### 6. 清理项目文件（可选）

MetaMe 会在项目的 `CLAUDE.md` 文件头部添加一段协议。恢复原状：用文本编辑器删除以 `## 🧠 SYSTEM KERNEL` 开头的块。

## ⚡ 性能与成本

> "这会吃掉我的上下文窗口吗？"

**简短回答：不会。它甚至通过减少废话为你省钱。**

* **上下文占用**：整个 MetaMe 内核 + 你的完整档案仅占用 **约 800-1000 tokens**。
* **占比**：在 Claude 的 200k 上下文窗口中，这仅占 **0.5%**。
* **投资回报**：通过预加载你的完整背景，它避免了每个新会话开头的"磨合期"和重复指令修正，而那些通常会浪费数千 tokens。
* **被动蒸馏成本**：信号捕获 Hook 是本地 Node.js 脚本（零 API 调用）。启动时的 Haiku 蒸馏仅处理少量过滤后的消息，通常只有几百 tokens，成本极低。

## ❓ 常见问题

**Q: 这会覆盖我原本的 `CLAUDE.md` 吗？**
A: 不会。它只是将元认知协议 *插入* 到你现有 `CLAUDE.md` 的最顶部。你原本的项目笔记会保持原样。

**Q: 我的数据会被发送给第三方吗？**
A: 不会。你的档案只保存在本地的 `~/.claude_profile.yaml` 中。MetaMe 只是将文本传递给官方的 Claude Code 工具。

## 📋 版本历史

| 版本 | 主要更新 |
|------|----------|
| **v1.3.19** | **多 Agent 专属群并行执行** — `chat_agent_map` 配置 chatId → Agent 路由，真正并行；`/bind` 一键注册专属群（含 Finder 风格目录浏览器）；`/chatid` 查询群 ID；`allowed_chat_ids` 热重载修复（每条消息动态读取，无需重启）；`/fix` 自动合并当前 chatId 配置；Daemon 由 macOS LaunchAgent 管理，5 秒自动保活；**operator_ids** 权限层——非 operator 进入只读聊天模式（可查询，不可写/执行）；`/myid` 获取飞书 open_id |
| **v1.3.18** | **多 Agent 项目隔离** — `daemon.yaml` 支持 `projects` 配置，每项目独立心跳任务、飞书彩色卡片、`/agent` 选择器按钮、昵称路由（说 Agent 名字即切换）、回复消息自动恢复会话、修复项目 cwd 中 `~` 展开 |
| **v1.3.15** | 原生 Playwright MCP（浏览器自动化）、`/list` 交互式文件浏览器、飞书图片下载修复、Skill/MCP/Agent 状态推送、热重启可靠性优化 |
| **v1.3.14** | 修复全新安装时 daemon 崩溃（缺少打包脚本） |
| **v1.3.13** | `/doctor` 交互式诊断、`/sh` 直接 shell、`/fix` 配置恢复、`/model` 交互式切换 + 自动备份、daemon 状态缓存与配置备份/恢复 |
| **v1.3.12** | 会话历史冷启动（解决冷启动问题）、三层数据架构（骨架 + 切片 + Haiku）、会话摘要提取 |
| **v1.3.11** | 目标对齐与偏离检测、第三方模型中继（Provider Relay）、`/insights` 切片集成 |
| **v1.3.10** | `/stop`、`/undo` 带文件恢复、`/model`、并发任务保护、`metame continue`、代码变更自动热重启 |
| **v1.3.8** | 双向文件互传（手机 ↔ 电脑） |
| **v1.3.7** | 手机端实时流式状态显示 |
| **v1.3** | 元认知层、远程 Claude Code（Telegram & 飞书）、工作流引擎、心跳任务、launchd 自启动 |

## 📄 许可证

MIT License. 欢迎 Fork、修改并进化你自己的元认知系统。
