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

> **Claude Code that knows you — and works from your phone.**

MetaMe turns Claude Code into a persistent AI that remembers how you think, runs on your Mac 24/7, and takes commands from your phone via Telegram or Feishu.

One command. No cloud. Your machine, your data.

```bash
npm install -g metame-cli && metame
```

---

## What It Does

### 1. Knows You Across Every Project

Claude Code forgets you every time you switch folders. MetaMe doesn't.

A cognitive profile (`~/.claude_profile.yaml`) follows you everywhere — not just facts like "user prefers TypeScript", but *how you think*: your decision style, cognitive load preferences, communication patterns. It learns silently from your conversations via background distillation, no effort required.

```
$ metame
🧠 MetaMe: Distilling 7 moments in background...
Ready, Neo. What are we building?
```

### 2. Full Claude Code From Your Phone

Your Mac runs a daemon. Your phone sends messages via Telegram or Feishu. Same Claude Code engine — same tools, same files, same session.

```
You (phone):  Fix the auth bug in api/login.ts
Claude:       ✏️ Edit: api/login.ts
              💻 Bash: npm test
              ✅ Fixed. 3 tests passing.
```

Start on your laptop, continue on the train. `/stop` to interrupt, `/undo` to rollback, `/sh ls` for raw shell access when everything else breaks.

### 3. Runs Autonomously

Schedule tasks that run on your machine and push results to your phone:

```yaml
# ~/.metame/daemon.yaml
heartbeat:
  tasks:
    - name: "morning-brief"
      prompt: "Summarize my git activity from yesterday"
      interval: "24h"
      notify: true
```

Chain skills into workflows — research, write, publish — fully automated:

```yaml
    - name: "daily-content"
      type: "workflow"
      steps:
        - skill: "deep-research"
          prompt: "Top 3 AI news today"
        - skill: "tech-writing"
          prompt: "Write an article from the research above"
        - skill: "wechat-publisher"
          prompt: "Publish it"
```

### 4. Skills That Evolve Themselves

MetaMe has a living skill ecosystem. Skills aren't static configs — they grow.

- **Auto-discovery**: When a task fails or a capability is missing, MetaMe's skill-scout automatically searches for, installs, and verifies new skills.
- **Learning by watching**: Can't automate a complex browser workflow? Say "我来演示" and MetaMe records your actions, then converts them into a reusable skill.
- **Post-task evolution**: After every significant task, the skill-evolution-manager reviews what worked and what didn't, then surgically updates the relevant skills with new knowledge.
- **Composable**: Skills chain together in workflows. A `deep-research` skill feeds into `tech-writing`, which feeds into `wechat-publisher` — each one improving from real usage.

```
Task fails → skill-scout finds a skill → installs → retries → succeeds
                                                          ↓
                                          skill-evolution-manager
                                          updates skill with lessons learned
```

This is the difference between a tool library and an organism. OpenClaw has a skill marketplace; MetaMe has skills that **learn from their own failures**.

---

## Quick Start

### Install

```bash
# One-line install (includes Node.js + Claude Code if missing)
curl -fsSL https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.sh | bash

# Or if you already have Claude Code
npm install -g metame-cli
```

### First Run

```bash
metame
```

On first launch, MetaMe runs a brief cognitive interview to build your profile. After that, it's automatic.

### Enable Mobile Access

```bash
metame daemon init    # Creates config with setup guide
metame start          # Launches background daemon
```

Edit `~/.metame/daemon.yaml` with your Telegram bot token or Feishu app credentials, then:

```bash
metame daemon install-launchd   # Auto-start on boot + crash recovery
```

Done. Open Telegram, message your bot.

---

## Core Capabilities

| Capability | What It Does |
|-----------|-------------|
| **Cognitive Profile** | Learns how you think across sessions. Schema-enforced, 800-token budget, auto-distilled via Haiku. Lock any value with `# [LOCKED]`. |
| **Mobile Bridge** | Full Claude Code via Telegram/Feishu. Stateful sessions, file transfer both ways, real-time streaming status. |
| **Skill Evolution** | Self-healing skill system. Auto-discovers missing skills, learns from browser recordings, evolves after every task. Skills get smarter over time. |
| **Heartbeat Tasks** | Scheduled Claude runs with cron-like intervals. Preconditions, workflows, push notifications. |
| **Multi-Agent** | Multiple projects with dedicated chat groups. `/bind` for one-tap setup. True parallel execution. |
| **Browser Automation** | Built-in Playwright MCP. Browser control out of the box for every user. |
| **Provider Relay** | Route through any Anthropic-compatible API. Use GPT-4, DeepSeek, Gemini — zero config file mutation. |
| **Metacognition** | Detects behavioral patterns (decision style, comfort zones, goal drift) and injects mirror observations. Zero extra API cost. |
| **Emergency Tools** | `/doctor` diagnostics, `/sh` raw shell, `/fix` config restore, `/undo` git-based rollback. |

## Mobile Commands

| Command | Action |
|---------|--------|
| `/last` | Resume most recent session |
| `/new` | Start new session (project picker) |
| `/resume` | Pick from session list |
| `/stop` | Interrupt current task (ESC) |
| `/undo` | Rollback with file restoration |
| `/list` | Browse & download project files |
| `/model` | Switch model (sonnet/opus/haiku) |
| `/bind <name>` | Register group as dedicated agent |
| `/sh <cmd>` | Raw shell — bypasses Claude |
| `/doctor` | Interactive diagnostics |

## How It Works

```
┌─────────────┐     Telegram/Feishu      ┌──────────────────────┐
│  Your Phone  │ ◄──────────────────────► │   MetaMe Daemon      │
└─────────────┘                           │   (your Mac, 24/7)   │
                                          │                      │
                                          │   ┌──────────────┐   │
                                          │   │ Claude Code   │   │
                                          │   │ (same engine) │   │
                                          │   └──────────────┘   │
                                          │                      │
                                          │   ~/.claude_profile  │
                                          │   (cognitive layer)  │
                                          └──────────────────────┘
```

- **Profile** (`~/.claude_profile.yaml`): Your cognitive fingerprint. Injected into every Claude session via `CLAUDE.md`.
- **Daemon** (`scripts/daemon.js`): Background process handling Telegram/Feishu messages, heartbeat tasks, and file watching.
- **Distillation** (`scripts/distill.js`): On each launch, silently analyzes your recent messages and updates your profile.

## Security

- All data stays on your machine. No cloud, no telemetry.
- `allowed_chat_ids` whitelist — unauthorized users are silently ignored.
- `operator_ids` for shared groups — non-operators get read-only mode.
- `~/.metame/` directory is mode 700.
- Bot tokens stored locally, never transmitted.

## Performance

The entire cognitive layer costs ~800 tokens per session (0.4% of a 200k context window). Background distillation uses Haiku at minimal cost. Mobile commands like `/stop`, `/list`, `/undo` consume zero tokens.

## Plugin (Lightweight)

Don't need mobile access? Install as a Claude Code plugin — profile injection + slash commands only:

```bash
claude plugin install github:Yaron9/MetaMe/plugin
```

## License

MIT
