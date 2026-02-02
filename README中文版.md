# 🔮 MetaMe

<p align="center">
  <img src="./logo.png" alt="MetaMe Logo" width="200"/>
</p>

> **Claude Code 的"认知画像"层 (The Cognitive Profile Layer)**
>
> *不是记忆系统——是认知镜像。它了解你怎么思考、怎么决策、怎么沟通，并时刻守护你的核心原则。*

## 📖 简介 (Introduction)

**Claude Code** 是一个强大的工具，但它患有“项目失忆症”。每当你切换文件夹时，它就会忘记你是谁、你的沟通风格以及你的具体限制。

**MetaMe** 通过为 Claude 包裹一层 **"认知画像层"** 来解决这个问题。它创建了一个跟随你穿梭于所有项目的  **"全局大脑"** 。不同于 ChatGPT/Claude/Gemini 的内置记忆（它们存的是"用户住在哪里"这种*事实*），MetaMe 捕捉的是*你怎么思考*——你的决策风格、认知负荷偏好、动机模式和沟通特征。

它不是记忆系统；它是你的  **认知镜像** 。

## ✨ 核心特性

* **🧠 全局大脑 (`~/.claude_profile.yaml`)：** 唯一的、可移植的真理来源——你的身份、认知特征和偏好跟随你穿梭于每个项目。
* **🧬 认知进化引擎：** MetaMe 通过三个通道学习你的思维方式：(1) **被动蒸馏**——静默捕获消息，启动时用 Haiku 提取认知特征；(2) **手动进化**——`!metame evolve` 显式教学；(3) **置信度门控**——强指令（"以后一律"/"always"）直写，普通观察需 3+ 次一致观察才晋升。Schema 白名单（41 字段、5 层 Tier、800 token 预算）防止膨胀。
* **🤝 动态握手：** "金丝雀测试"——Claude 必须在第一句话中叫你的**代号**。没叫就说明连接断了。
* **🛡️ 自动锁定：** 任何值标记 `# [LOCKED]` 即为宪法，永不被自动修改。
* **📱 远程 Claude Code（v1.3）：** 手机端完整 Claude Code 体验，支持 Telegram 和飞书。有状态会话（`--resume`）——和终端一样的对话历史、工具调用、文件编辑。可点击按钮选择项目/会话/目录，支持 macOS launchd 自启动。

## 🛠 前置要求 (Prerequisites)

MetaMe 是 **Claude Code** 的外壳。你必须先安装 Node.js 和官方的 Claude Code 工具。

1. **Node.js**: 版本 14 或更高。
2. **Claude Code**: 确保 `claude` 命令可用且已登录。

## 📦 安装 (Installation)

通过 NPM 全局安装 MetaMe：

**Bash**

```
npm install -g metame-cli
```

*(注意：如果你在 Mac/Linux 上遇到权限错误，请使用 `sudo npm install -g metame-cli`)*

## 🚀 使用指南 (Usage)

忘掉 `claude` 命令吧。从现在起，只需输入：

**Bash**

```
metame
```

或者，如果你喜欢混合大小写（效果一样）：

**Bash**

```
MetaMe
```

### 初次运行：创世纪 (The First Run)

当你第一次运行 MetaMe 时，它会检测到你的档案为空。它会暂停 AI 并进入 **校准模式 (Calibration Mode)** ：

1. 它会询问你的 **代号 (Codename/Nickname)**。
2. 它会开启一场 **深度认知访谈**，探索你的天赋领域、思维模式和潜在焦虑。
3. **请务必诚实**：它是一面镜子。你越坦诚（即便是关于你的恐惧），它就越能成为你的完美分身。
4. 完成后，它会保存你的“源代码”并启动 Claude。

### 日常工作流

1. `cd` 进入任何项目文件夹。
2. 运行 `metame`。
3. Claude 启动并立即说：*“Ready, [你的名字]...”*
4. 开始写代码。MetaMe 会在后台自动管理上下文。

### 认知进化

MetaMe 通过两条路径认识你：

**自动（零操作）：** 全局 Hook 捕获消息，下次启动时 Haiku 在后台蒸馏认知特征。强指令（"以后一律"/"always"）直接写入；普通观察需 3+ 次一致观察才晋升。所有写入经过 Schema 验证（41 字段，800 token 预算）。启动时你会看到：

```
🧠 MetaMe: Distilling 7 moments in background...
```

**手动：** 直接更新某个特征：

```bash
metame set-trait status.focus "Learning Rust"
metame evolve "我更喜欢函数式编程"
```

**防偏差机制：** 单次观察 ≠ 特征，矛盾信号追踪而非盲目覆盖，pending 特征 30 天无新观察自动过期，上下文字段过期自动清理。

### 远程 Claude Code —— Telegram & 飞书（v1.3）

手机端完整 Claude Code——有状态会话，支持对话历史、工具调用、文件编辑。同时支持 Telegram 和飞书（Lark）。

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
metame daemon start                   # 后台运行
metame daemon status                  # 查看状态
metame daemon logs                    # 查看日志
metame daemon stop                    # 停止
metame daemon install-launchd         # macOS 自启动（开机自启 + 崩溃重启）
```

**会话命令（Telegram 和飞书均支持可点击按钮）：**

| 命令 | 说明 |
|------|------|
| `/new` | 新建会话——从按钮列表选择项目目录 |
| `/resume` | 恢复会话——可点击列表，按当前工作目录过滤 |
| `/continue` | 继续电脑上最近一次终端会话 |
| `/cd` | 切换工作目录——带目录浏览器 |
| `/session` | 查看当前会话信息 |

直接打字即可对话——每条消息都在同一个 Claude Code 会话中，保持完整上下文。

**原理：**

每个聊天绑定一个持久会话，通过 `claude -p --resume <session-id>` 调用。这是和终端完全相同的 Claude Code 引擎——相同的工具（文件编辑、bash、代码搜索）、相同的对话历史。你可以在电脑上开始工作，手机上 `/resume` 继续，反之亦然。

**其他命令：**

| 命令 | 说明 |
|------|------|
| `/status` | 守护进程状态 + 画像摘要 |
| `/tasks` | 列出心跳任务 |
| `/run <名称>` | 立即执行某个任务 |
| `/budget` | 今日 token 用量 |
| `/quiet` | 静默 mirror/反思 48 小时 |

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

**Token 效率：**

* 轮询、斜杠命令、目录浏览：**零 token**
* 有状态会话：和终端使用 Claude Code 成本相同（对话历史由 Claude CLI 管理）
* 日 token 预算限额（默认 50000）
* Claude 调用间隔 10 秒冷却

**安全模型：**

* `allowed_chat_ids` 白名单——未授权用户静默忽略
* 不使用 `--dangerously-skip-permissions`——标准 `-p` 模式权限
* `~/.metame/` 目录权限 700
* Bot token 仅存本地，不外传

### 热重载 (Hot Reload)

如果你更新了个人档案，或者需要修复断开的上下文连接，而**不想重启会话**：

*   **在 Claude 内部**：运行 `!metame refresh`
*   **在外部终端**：运行 `metame refresh`

这会立即将你最新的档案重新注入 `CLAUDE.md`。

## ⚙️ 配置与“全局大脑”

你的个人档案存储在你用户主目录下的一个隐藏 YAML 文件中。

**位置：** `~/.claude_profile.yaml`

你可以手动编辑此文件来更新你的状态或锁定你的价值观。

**档案示例（v2 Schema）：**

**YAML**

```
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

```
node ~/.metame/migrate-v2.js --dry-run   # 预览变更
node ~/.metame/migrate-v2.js             # 执行迁移（自动创建备份）
```

## 🗑️ 卸载 (Uninstallation)

如果你希望从系统中彻底移除 MetaMe，请按照以下步骤操作：

### 1. 移除软件包

卸载 CLI 工具：

**Bash**

```
npm uninstall -g metame-cli
```

### 2. 移除全局大脑（可选）

如果你想删除存储的个人档案数据：

**Bash**

```
rm ~/.claude_profile.yaml
```

### 3. 停止守护进程（如有运行）

```bash
metame daemon stop
launchctl unload ~/Library/LaunchAgents/com.metame.daemon.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.metame.daemon.plist
```

### 4. 移除被动蒸馏数据（可选）

删除信号捕获脚本：

**Bash**

```
rm -rf ~/.metame
```

### 5. 移除信号捕获 Hook（可选）

MetaMe 在 `~/.claude/settings.json` 中安装了全局 Hook。可以手动编辑该文件删除 `hooks` 下的 `UserPromptSubmit` 条目，或运行：

**Bash**

```
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

MetaMe 会在项目的 `CLAUDE.md` 文件头部添加一段协议。如果你想恢复原状，可以用文本编辑器删除以 `## 🧠 SYSTEM KERNEL` 开头的块。

## ⚡ 性能与成本 (Performance & Cost)

你可能会担心：*“这会吃掉我的上下文窗口吗？”*

**简短回答：不会。它甚至通过减少废话为你省钱。**

*   **上下文占用**：整个 MetaMe 内核 + 你的完整档案仅占用 **约 800 - 1000 tokens**。
*   **占比**：在 Claude 的 200k 上下文窗口中，这仅占 **0.5%**。
*   **投资回报**：通过预加载你的完整背景，它避免了每个新会话开头的"磨合期"和重复指令修正，而那些通常会浪费数千 tokens。
*   **被动蒸馏成本**：信号捕获 Hook 是本地 Node.js 脚本（零 API 调用）。启动时的 Haiku 蒸馏仅处理少量过滤后的消息，通常只有几百 tokens，成本极低。

## ❓ 常见问题 (FAQ)

**Q: 这会覆盖我原本的 `CLAUDE.md` 吗？**
A: 不会。它只是将元认知协议 *插入* 到你现有 `CLAUDE.md` 的最顶部。你原本的项目笔记会保持原样。

**Q: 如果 Claude 突然不再叫我的昵称了怎么办？**
A: 这就是“金丝雀测试”失败了。这意味着上下文窗口被压缩了，或者文件链接断开了。在 Claude 中运行 `/compact` 或重启 `metame` 即可修复。

**Q: 我的数据会被发送给第三方吗？**
A: 不会。你的档案只保存在本地的 `~/.claude_profile.yaml` 中。MetaMe 只是将文本传递给官方的 Claude Code 工具。

## 📄 许可证 (License)

MIT License. 欢迎 Fork、修改并进化你自己的元认知系统。
