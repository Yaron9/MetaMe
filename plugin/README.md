# MetaMe — Claude Code Plugin

Cognitive Profile Layer for Claude Code. Knows how you think. Works wherever you are.

## Install

```bash
claude plugin install /path/to/MetaMe/plugin
# or from GitHub:
claude plugin install github:Yaron9/MetaMe/plugin
```

## What It Does

MetaMe builds a persistent cognitive profile (`~/.claude_profile.yaml`) that captures your thinking patterns, preferences, and working style across sessions.

### On Session Start
- Injects your profile into the session context (CLAUDE.md)
- Runs background distillation if there are buffered signals
- Cleans up expired data

### On Every Prompt
- Captures preference signals from your messages (filtered for noise)
- Tags confidence levels (strong directives vs. implicit preferences)

## Slash Commands

### Profile Commands
| Command | Description |
|---------|-------------|
| `/metame:evolve "insight"` | Teach MetaMe a new insight about yourself |
| `/metame:set-trait key value` | Set a specific profile field |
| `/metame:refresh` | Re-inject your profile into the current session |
| `/metame:quiet` | Silence mirror & reflections for 48 hours |
| `/metame:insights` | Show detected behavioral patterns |
| `/metame:mirror on\|off` | Toggle metacognition mirror |

### Daemon Commands (Telegram/Feishu)
| Command | Description |
|---------|-------------|
| `/metame:daemon` | Show daemon status and help |
| `/metame:daemon-init` | Configure Telegram/Feishu (first-time setup) |
| `/metame:daemon-start` | Start the daemon |
| `/metame:daemon-stop` | Stop the daemon |
| `/metame:daemon-logs` | Show recent logs |

## Telegram/Feishu Setup

The plugin includes full daemon support for mobile access via Telegram and Feishu — **same features as the npm CLI**.

**Quick Start:**
1. Run `/metame:daemon-init` and follow the interactive setup wizard
2. The daemon auto-starts on each Claude session (if configured)
3. Use `/last` on your phone to quickly resume the most recent session

**Mobile Session Commands:**
| Command | Description |
|---------|-------------|
| `/last` | 优先当前目录最近 session，否则全局最近 |
| `/new <name>` | Start a new session with a name |
| `/resume` | Pick from recent sessions (real-time timestamps) |
| `/resume <name>` | Resume by name (partial match, cross-project) |
| `/name <name>` | Name current session (syncs with desktop `/rename`) |
| `/cd` | Change working directory (with picker) |
| `/cd last` | **Sync to computer** — jump to most recent session + directory |
| `/session` | Current session info |
| `/stop` | Interrupt current Claude task (ESC equivalent) |
| `/undo` | Undo turns with file restoration (ESC×2 equivalent) |
| `/model` | Interactive model switcher with auto-backup |
| `/doctor` | Interactive diagnostics with one-tap fix buttons |
| `/sh <cmd>` | Run shell command directly — bypasses Claude entirely |
| `/fix` | Restore `daemon.yaml` from last backup |

**Features:**
- Full Claude Code engine on your phone (file editing, bash, code search)
- **Remote Wake** — daemon runs in background; phone wakes up Claude Code on your computer
- **File Transfer** — send files from computer to phone, or phone to computer (saved to `<project>/upload/`)
- **Provider Relay** — route through any Anthropic-compatible relay for third-party models
- **Emergency Recovery** — `/doctor` diagnostics, `/sh` direct shell, `/fix` config restore
- Session naming uses Claude's native `customTitle` — syncs everywhere
- Auto-attach: first message on phone continues your computer's latest session
- Parallel request handling (async spawning, non-blocking)
- Daemon takeover: new instance auto-kills old (no conflicts)

**Feishu Permissions Required:**
- `im:message` (获取与发送消息)
- `im:message.p2p_msg:readonly` (单聊消息)
- `im:message.group_at_msg:readonly` (群聊@机器人)
- `im:message:send_as_bot` (发消息)
- `im:resource` (文件上传下载)

## Heartbeat Tasks

Schedule Claude to run automatically:

```yaml
# ~/.metame/daemon.yaml
heartbeat:
  tasks:
    - name: "daily-summary"
      prompt: "Summarize today's git commits"
      interval: "24h"
      notify: true   # push results to phone
```

## Session History Bootstrap (v1.3.12)

On first launch, MetaMe auto-bootstraps your session history from existing Claude Code JSONL transcripts — zero API cost. Three data layers:

- **Skeleton** — structural facts (tools, duration, project, branch, intent) extracted locally
- **Facets** — interaction quality (outcome, friction) from `/insights`, when available
- **Haiku** — metacognitive judgments (cognitive load, zones, goal alignment) from the existing distill call

Patterns and mirror observations can appear from your very first session, no warm-up needed.

## Profile Tiers

- **T1 — Identity** (LOCKED): nickname, role
- **T2 — Core Values** (LOCKED): crisis reflex, flow trigger, shadow self
- **T3 — Preferences** (auto-learned): code style, communication, cognition
- **T4 — Context** (free overwrite): current focus, active projects
- **T5 — Evolution** (system-managed): distill history, growth patterns

## Requirements

- Node.js >= 14
- Claude Code CLI installed
- `js-yaml` npm package (install globally or in the plugin directory)

## Also Available As

- **npm package**: `npm install -g metame-cli` — same features, plus `metame interview` for genesis
- **Source**: https://github.com/Yaron9/MetaMe

Both plugin and npm CLI share the same daemon code and feature set.
