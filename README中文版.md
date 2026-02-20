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

## 它能做什么

### 1. 跨项目记住你

Claude Code 每换一个文件夹就失忆。MetaMe 不会。

一份认知画像（`~/.claude_profile.yaml`）跟随你穿梭于所有项目——不只是"用户偏好 TypeScript"这种事实，而是**你怎么想**：决策风格、认知负荷偏好、沟通模式。它在后台静默学习，你什么都不用做。

```
$ metame
🧠 MetaMe: Distilling 7 moments in background...
Ready, Neo. What are we building?
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

### 3. 自主运行

定时任务跑在你的电脑上，结果推送到手机：

```yaml
# ~/.metame/daemon.yaml
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
| **手机桥接** | 通过 Telegram/飞书完整使用 Claude Code。有状态会话、双向文件互传、实时工具调用状态。 |
| **心跳任务** | 定时跑 Claude，支持前置条件、多步骤工作流、推送通知。 |
| **多 Agent** | 多项目独立群聊，`/bind` 一键配置，真正并行执行。 |
| **浏览器自动化** | 内置 Playwright MCP，开箱即用。配合 Skill 实现发布、填表、抓取等自动化。 |
| **模型中继** | 兼容任何 Anthropic API 中继。GPT-4、DeepSeek、Gemini 随意切换，零文件污染。 |
| **元认知** | 检测行为模式（决策风格、舒适区、目标偏离），注入镜像观察。零额外 API 成本。 |
| **应急工具** | `/doctor` 诊断、`/sh` 原始 shell、`/fix` 配置恢复、`/undo` 基于 git 的回退。 |

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
| `/doctor` | 交互式诊断 |

## 工作原理

```
┌─────────────┐     Telegram / 飞书      ┌──────────────────────┐
│   你的手机   │ ◄──────────────────────► │   MetaMe Daemon      │
└─────────────┘                           │  （你的 Mac，7×24）   │
                                          │                      │
                                          │   ┌──────────────┐   │
                                          │   │ Claude Code   │   │
                                          │   │（同一引擎）    │   │
                                          │   └──────────────┘   │
                                          │                      │
                                          │   ~/.claude_profile  │
                                          │  （认知画像层）      │
                                          └──────────────────────┘
```

- **画像**（`~/.claude_profile.yaml`）：你的认知指纹，通过 `CLAUDE.md` 注入每个 Claude 会话。
- **Daemon**（`scripts/daemon.js`）：后台进程，处理消息、心跳任务、文件监听。
- **蒸馏**（`scripts/distill.js`）：每次启动时静默分析你的最近消息，更新画像。

## 安全

- 所有数据留在你的电脑。不上云，无遥测。
- `allowed_chat_ids` 白名单——未授权用户静默忽略。
- `operator_ids` 共享群权限——非 operator 只读模式。
- `~/.metame/` 目录权限 700。
- Bot token 仅存本地，不外传。

## 性能

整个认知层每个会话约 800 token（200k 上下文窗口的 0.4%）。后台蒸馏用 Haiku，成本极低。`/stop`、`/list`、`/undo` 等命令零 token 消耗。

## 轻量插件版

不需要手机端？装 Claude Code 插件——只有画像注入 + 斜杠命令：

```bash
claude plugin install github:Yaron9/MetaMe/plugin
```

## 许可证

MIT
