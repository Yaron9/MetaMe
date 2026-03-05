# MetaMe

<p align="center">
  <img src="./logo_high_contrast.png" alt="MetaMe Logo" width="200"/>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/metame-cli"><img src="https://img.shields.io/npm/v/metame-cli.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/metame-cli"><img src="https://img.shields.io/npm/dm/metame-cli.svg" alt="npm downloads"></a>
  <a href="https://github.com/Yaron9/MetaMe/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/metame-cli.svg" alt="license"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README中文版.md">中文</a>
</p>

> **住在你电脑里的数字分身。**

MetaMe 是一个驻留在你电脑上的 AI——记住你的思维方式，7×24 待命，通过 Telegram 或飞书随时接受手机指令。它不在云端，它住在你的机器里。原生支持 macOS 和 Windows。

不上云。你的机器，你的数据。

```bash
curl -fsSL https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.sh | bash
```

**已有 Node.js ≥ 22.5：**
```bash
npm install -g metame-cli
metame
```

**Windows (PowerShell)：**
```powershell
npm install -g metame-cli
metame
```

---

> ### 🚀 v1.4.34 — Mentor Mode Step 4 + 蒸馏/记忆闭环
>
> - **多引擎 runtime 适配（MVP）**：daemon 已支持按 `project.engine` 进行 Claude/Codex 路由，执行链路统一。
> - **Codex 会话连续性**：支持 `exec`/`resume`、`thread_id` 回写、resume 失败一次性自动重试（每 chat 10 分钟最多一次）、认证/限流错误映射。
> - **Agent 引擎推断**：自然语言创建 Agent 时可识别 `codex`；默认 `claude` 保持零回归（不写 `engine` 字段）。
> - **Mentor Mode Hook 接入**：预检情绪熔断、上下文摩擦注入、后置反思债务三段 Hook 已接入 daemon 执行链。
> - **Distiller Step 4**：蒸馏结果支持 `competence_signals` 合并到 `user_competence_map`（默认只升不降，降级需显式证据）。
> - **记忆标签闭环**：`memory-extract` 使用 `saveFacts().savedFacts` 的 id 回写 `fact_labels`。
> - **nightly 回流闭环**：夜间反思回写 `synthesized_insight`，并生成知识胶囊 `knowledge_capsule`（文档 + facts）。
> - **自动 postmortem**：显著会话自动生成复盘文档，并回写 `bug_lesson`。
> - **多用户 ACL / Team Task / 跨平台支持**：保持现有能力并与新链路兼容。
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

### 2. 手机上完整的 Claude/Codex 会话

你的 Mac 跑一个 daemon，手机通过 Telegram 或飞书发消息。底层引擎按 `project.engine`（`claude`/`codex`）选择——同样的工具、同样的文件、同一个会话连续性。

```
你（手机）：修一下 api/login.ts 的鉴权 bug
Claude：    ✏️ Edit: api/login.ts
            💻 Bash: npm test
            ✅ 修好了，3 个测试通过。
```

笔记本上开始，地铁上继续。`/stop` 中断、`/undo` 回退、`/mac check` 做 macOS 自动化体检、`/sh ls` 直接跑 shell——模型挂了也有后路。

### 3. 睡觉时也在工作的分层记忆

MetaMe 的记忆系统完全在后台自动运行——不打扰你，不需要手动操作。

**第一层 — 长期事实**
闲置时触发记忆巩固：从你的会话中提取关键决策、模式和知识，存入持久化事实库。每次会话启动时语义召回，无感注入。

**第二层 — 会话连续性**
间隔 2 小时以上再回来？MetaMe 自动注入上次工作的简短摘要——你不用重新解释背景，直接继续。

**第三层 — 会话索引**
每次对话自动打上主题标签，建立索引。未来当你提到"上周那个项目"，MetaMe 知道在哪里找。

**第四层 — 夜间反思回流**
每天 01:00 对高频热事实做蒸馏，产出决策/经验文档，并把高层洞见回写为 `synthesized_insight` 供后续检索。

**第五层 — 全局索引与知识胶囊**
每天 01:30 重建 `INDEX.md`，并维护胶囊目录（`capsules/`、`postmortems/`）作为可检索知识入口。

```
【后台，趁你休息时运行】
闲置 30 分钟 → 触发记忆巩固
  → session_tags.json 更新（主题索引）
  → 事实提取 + 标签落库 → ~/.metame/memory.db
  → 会话摘要缓存 → daemon_state.json
01:00 → nightly-reflect：decisions/lessons + synthesized_insight + capsules
01:30 → 重建 memory index（INDEX.md）

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
五个开箱即有的任务。都带前置条件守卫，只在有意义时运行：

```yaml
- cognitive-distill   # 4h · 有信号才触发 → 蒸馏偏好更新画像
- memory-extract      # 4h · 扫描会话   → 提取长期事实 + concept 标签
- skill-evolve        # 6h · 有信号才触发 → 从任务结果演化技能
- nightly-reflect     # 每日 01:00 · 热事实蒸馏 + 回写 synthesized_insight + 胶囊聚合
- memory-index        # 每日 01:30 · 重建全局记忆索引
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
        at: "09:30"
        days: "weekdays"
        model: "sonnet"
        notify: true

heartbeat:
  tasks:
    - name: "morning-brief"
      prompt: "总结我昨天的 git 活动"
      at: "09:00"
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

**任务参数一览：**

| 参数 | 说明 |
|------|------|
| `at` | 固定时间触发，如 `"09:30"`（本地时间） |
| `days` | 星期过滤，如 `"weekdays"`、`[mon, wed, fri]` |
| `interval` | 按间隔触发，如 `"4h"`、`"30m"` |
| `require_idle` | 用户活跃时推迟，下次心跳重试 |
| `precondition` | shell 守卫命令，返回非0时跳过任务（零 token 消耗） |
| `notify` | 完成后推送结果到手机 |
| `model` | 指定模型，如 `"sonnet"`、`"haiku"` |
| `cwd` | 任务运行目录 |
| `timeout` | 任务超时时间 |

> **定时任务依赖系统托管**。macOS 运行 `metame daemon install-launchd`，Windows 运行 `metame daemon install-task-scheduler`，之后任务在息屏、锁屏状态下依然按时触发——只要电脑不关机。

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

```bash
curl -fsSL https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.sh | bash
```

**已有 Node.js ≥ 22.5：**
```bash
npm install -g metame-cli
metame
```

**设置指南（3 分钟）：**

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1. 登录 Claude | 运行 `claude`，完成登录（Anthropic 账号或 API Key） | Claude Code 准备就绪 |
| 2. 启动 MetaMe | 运行 `metame` | 打开一个加载了 MetaMe 的 Claude 会话 |
| 3. 认知访谈 | 直接聊天 — 首次运行会自动开始深度访谈 | 生成 `~/.claude_profile.yaml`（你的数字分身大脑） |
| 4. 连接手机 | 对话中说"帮我设置手机访问"或"连接手机" | 交互式向导，配置 Telegram/飞书 Bot → `~/.metame/daemon.yaml` |
| 5. 启动 daemon | `metame start` | 后台 daemon 启动，bot 上线 |
| 6. 托管到系统 | macOS: `metame daemon install-launchd` · Windows: `metame daemon install-task-scheduler` · Linux: 见下方 | 系统级常驻，崩溃自恢复 |

> **第一次用？** 只需运行 `metame` 然后自然聊天。访谈和配置全程对话式完成，不用记命令。

**更新 MetaMe：**
```bash
npm install -g metame-cli
```

> **托管后意味着什么？**
> MetaMe 注册进系统任务调度器后，只要电脑不关机，哪怕锁屏、息屏、合盖休眠唤醒，它都会自动在后台运行。定时任务照常触发，手机消息照常收发。

**Windows 系统托管（Task Scheduler）：**

```powershell
metame daemon install-task-scheduler
```

> 开机自动启动 daemon。移除命令：`schtasks /delete /tn "MetaMe-Daemon" /f`

> **Windows 说明：** 终端 emoji 自动降级为 ASCII（`[OK]`、`[FAIL]`），兼容 GBK 编码。IPC 使用 Named Pipe 替代 Unix Socket。`/mac` 命令不可用。

> **Windows 用户请直接用原生 PowerShell/CMD 安装，不建议使用 WSL。** WSL 虚拟系统常见问题：无法继承宿主机的网络代理（导致 npm install 和 Claude API 连接超时）、路径映射差异、进程管理不互通。直接在 Windows 终端 `npm install -g metame-cli` 是最稳的方式。

**WSL2 / Linux 系统托管（用 systemd）：**

```bash
# 生成 systemd 服务文件
cat > ~/.config/systemd/user/metame.service << 'EOF'
[Unit]
Description=MetaMe Daemon
After=network.target

[Service]
ExecStart=/usr/bin/env metame start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

# 启用并启动
systemctl --user enable metame
systemctl --user start metame
```

> WSL2 需先开启 systemd：在 `/etc/wsl.conf` 加入 `[boot]\nsystemd=true`，然后重启 WSL。

**WSL 不支持的功能：**`/mac` 命令（macOS AppleScript 专属）

**建立你的第一个 Agent：**

1. 在任意已有群聊中，用自然语言说：`创建一个 Agent，目录是 ~/xxx，负责xxx`
2. Bot 回复：✅ Agent 已创建，**在新群里发送 `/activate` 完成绑定**
3. 新建群聊，把 bot 拉进去，发送 `/activate` → 自动绑定完成

> 想要更多 Agent？重复以上流程：在任意群创建 → 新建目标群 → 发 `/activate`。每个群 = 独立 AI 工作区。

---

## 核心能力一览

| 能力 | 说明 |
|------|------|
| **认知画像** | 跨会话学习你的思维方式。Schema 约束、800 token 预算、Haiku 自动蒸馏。任何值标 `# [LOCKED]` 即不可覆写。 |
| **分层记忆** | 五层记忆：长期事实（含 concept 标签）、会话摘要、会话索引、夜间反思回流（含 synthesized_insight）、全局索引/胶囊。全自动。 |
| **手机桥接** | 通过 Telegram/飞书完整使用 Claude Code。有状态会话、双向文件互传、实时工具调用状态。 |
| **技能进化** | 自愈技能系统。自动发现缺失技能、从浏览器录制中学习、每次任务后进化。技能越用越聪明。 |
| **心跳系统** | 三层可编程神经系统。Layer 0 内核永远在线（零配置）。Layer 1 系统自进化内置（蒸馏+记忆+技能+nightly+index）。Layer 2 自定义定时任务，支持 `require_idle`、`precondition`、`notify`、工作流。 |
| **多 Agent** | 多项目独立群聊，`/agent bind` 一键配置，真正并行执行。 |
| **浏览器自动化** | 内置 Playwright MCP，开箱即用。配合 Skill 实现发布、填表、抓取等自动化。 |
| **跨平台** | 原生支持 macOS 和 Windows。平台抽象层自动处理进程管理、IPC、终端编码差异，一套代码两平台。 |
| **模型中继** | 兼容任何 Anthropic API 中继。GPT-4、DeepSeek、Gemini 随意切换，零文件污染。 |
| **元认知** | 检测行为模式（决策风格、舒适区、目标偏离），注入镜像观察。零额外 API 成本。 |
| **导师模式** | `/mentor on|off|level|status` 控制认知摩擦。支持情绪熔断、zone 自适应、反思债务。 |
| **多用户 ACL** | 角色分级权限（admin / member / stranger）。把 bot 安全分享给团队成员。`/user` 命令动态管理用户，配置文件热重载。 |
| **Team Task** | `/teamtask` 命令实现多 Agent 跨工作区任务协作。支持创建、追踪、续跑任务，N-Agent 会话隔离，真正并行。 |
| **应急工具** | `/doctor` 诊断、`/mac` macOS 控制工具、`/sh` 原始 shell、`/fix` 配置恢复、`/undo` 基于 git 的回退。 |

## 定义你的智能体

MetaMe 的设计哲学：**一个文件夹 = 一个智能体**。

给智能体一个目录，在里面放一个 `CLAUDE.md` 写清楚它的角色和职责，就完了。文件夹是什么，它就是什么——可以是你的代码项目、博客仓库、任何工作区。

### 方式一：直接说话（推荐）

不需要任何命令，直接用自然语言告诉 bot 你想要什么——MetaMe 自动识别意图并执行。**Agent 创建后不会绑定当前群，而是等你在目标新群发 `/activate` 完成绑定**：

```
你：  创建一个 Agent，目录是 ~/projects/assistant，负责写作和内容创作
Bot： ✅ Agent「assistant」已创建
      目录: ~/projects/assistant
      📝 已写入 CLAUDE.md

      下一步：在新群里发送 /activate 完成绑定

── 在新群聊里 ──

你：  /activate
Bot： 🤖 assistant 绑定成功
      目录: ~/projects/assistant

你：  把这个 Agent 的角色改成：专注 Python 后端开发
Bot： ✅ 角色定义已更新到 CLAUDE.md

你：  列出所有 Agent
Bot： 📋 当前 Agent 列表
      🤖 assistant ◀ 当前
      目录: ~/projects/assistant
      ...
```

支持的自然语言意图：创建、绑定（`/agent bind`）、解绑、修改角色、列出——直接说就行，无需记命令。

### 方式二：命令行

在任意 Telegram/飞书群里用 `/agent` 命令：

| 命令 | 作用 |
|------|------|
| `/activate` | 在新群里发送此命令，自动绑定到最近创建的待激活 Agent。 |
| `/agent bind <名称> [目录]` | 手动绑定：把当前群注册为指定名称的 Agent，可选设置工作目录。Agent 已存在时直接绑定，无需重建。 |
| `/agent list` | 查看所有已配置的 Agent。 |
| `/agent edit` | 修改当前 Agent 的角色描述（重写 `CLAUDE.md` 对应章节）。 |
| `/agent unbind` | 解除当前群绑定。 |
| `/agent reset` | 删除当前 Agent 的角色 section。 |

> **绑定保护**：每个群只能绑定一个 Agent。已有绑定时，任何人都无法覆盖（需显式 `force:true`）。

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
        at: "20:30"
        days: [mon, tue, wed, thu, fri]
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
| `/continue` | 接续电脑端最近工作会话（等价 `/cd last`） |
| `/new` | 新建会话（项目选择器） |
| `/resume` | 从会话列表选择 |
| `/stop` | 中断当前任务（ESC） |
| `/undo` | 展示历史消息列表，点击按钮回退到该条消息之前（上下文 + 代码同步回滚） |
| `/undo <hash>` | 回退到指定 git checkpoint |
| `/list` | 浏览和下载项目文件 |
| `/model` | 切换模型（sonnet/opus/haiku） |
| `/mentor` | 导师模式控制：on/off/level/status |
| `/activate` | 在新群里激活并绑定最近创建的 Agent |
| `/agent bind <名称> [目录]` | 手动将群注册为专属 Agent |
| `/mac` | macOS 控制助手：权限检查/跳转 + AppleScript/JXA 执行 |
| `/sh <命令>` | 原始 shell——绕过 Claude |
| `/memory` | 记忆统计：事实数量、已标签 session 数、DB 大小 |
| `/memory <关键词>` | 按关键词搜索长期事实 |
| `/doctor` | 交互式诊断 |
| `/user add <open_id>` | 添加用户（仅 admin） |
| `/user role <open_id> <admin\|member>` | 设置用户角色 |
| `/user list` | 查看所有已配置用户 |
| `/user remove <open_id>` | 移除用户 |
| `/sessions` | 浏览最近会话，显示最后一条消息预览 |
| `/teamtask create <agent> <目标>` | 创建跨 Agent 协作任务 |
| `/teamtask` | 查看所有 TeamTask（最近10条） |
| `/teamtask <task_id>` | 查看任务详情 |
| `/teamtask resume <task_id>` | 续跑指定任务 |

## 工作原理

```
┌─────────────┐     Telegram / 飞书      ┌──────────────────────────────┐
│   你的手机   │ ◄──────────────────────► │   MetaMe Daemon              │
└─────────────┘                           │  （你的电脑，7×24）           │
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
                                          闲置触发 → 会话摘要 + 背景记忆任务
                                                  （后台自动，受守卫控制）
```

- **画像**（`~/.claude_profile.yaml`）：你的认知指纹，通过 `CLAUDE.md` 注入每个 Claude 会话。
- **Daemon**（`scripts/daemon.js`）：后台进程，处理消息、心跳任务、Unix socket 分发，以及 idle/sleep 状态切换。
- **Runtime Adapter**（`scripts/daemon-engine-runtime.js`）：统一 Claude/Codex 的参数构建、环境变量与流式事件归一化。
- **蒸馏**（`scripts/distill.js`）：心跳任务（默认 4h，信号守卫），更新画像并合并能力信号；显著会话可生成 postmortem + `bug_lesson`。
- **记忆提取**（`scripts/memory-extract.js`）：心跳任务（默认 4h，闲置守卫），提取长期事实并写入 `fact_labels`。
- **夜间反思**（`scripts/memory-nightly-reflect.js`）：每日 01:00，蒸馏热事实并回写 `synthesized_insight`，生成知识胶囊。
- **索引构建**（`scripts/memory-index.js`）：每日 01:30，重建全局记忆索引。
- **会话摘要**（`scripts/session-summarize.js`）：为闲置会话生成 2-4 句总结，间隔 2 小时以上恢复时自动注入。

## Scripts/Docs 指针地图

脚本入口与 Step 1-4 升级落点请看：`scripts/docs/pointer-map.md`。

日常运维与故障排查（引擎路由、codex 认证/限流、`/compact` 边界）请看：`scripts/docs/maintenance-manual.md`。

## 安全

- 所有数据留在你的电脑。不上云，无遥测。
- `allowed_chat_ids` 白名单——新群收到智能提示：若有待激活的 Agent，引导发 `/activate`；否则提示配置说明，不再静默拒绝。
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

> 记忆巩固和会话摘要均由后台 Haiku（`--model haiku`）处理。输入经代码硬截：skeleton 文本 ≤ 3,000 字符，摘要输出 ≤ 500 字符。两者均非每条消息触发——记忆巩固按心跳调度并受 idle/precondition 守卫控制，摘要在进入睡眠态时对每个闲置会话只生成一次。

## 插件版

无需 npm，直接装进 Claude Code：

```bash
claude plugin install github:Yaron9/MetaMe/plugin
```

包含：认知画像注入、daemon（Telegram/飞书）、心跳任务、分层记忆、全部手机端命令、斜杠命令（`/metame:evolve`、`/metame:daemon`、`/metame:refresh` 等）。

**与 npm CLI 的关键差异：** 插件版 daemon 在 Claude Code 打开时启动、关闭时停止，**不会** 24/7 常驻后台。如需手机随时发消息（Claude Code 关闭时也能收到），需用 npm CLI + `metame daemon install-launchd`。

不想装全局 npm 包且只需要 Claude Code 打开时的手机访问，用插件版。需要 24/7 常驻、`metame` 命令和首次采访，用 npm CLI（`metame-cli`）。

## 参与贡献

MetaMe 仍处于早期阶段，快速迭代中。每一个 Issue 和 PR 都直接影响项目方向。

**报 Bug / 提需求：**
- 开一个 [Issue](https://github.com/Yaron9/MetaMe/issues)，描述问题现象、期望行为、运行环境（macOS/Windows/WSL、Node 版本）。

**提交 PR：**
1. Fork 仓库，从 `main` 创建分支
2. 源码修改统一在 `scripts/` 目录，改完跑 `npm run sync:plugin` 同步到 `plugin/scripts/`
3. `npx eslint scripts/daemon*.js` — 零错误
4. `npm test` — 全部通过
5. 向 `main` 提 PR，写清改了什么、为什么改

**适合新手的贡献方向：** Windows 边界场景、新的 `/命令`、文档完善、测试覆盖。

## 许可证

MIT
