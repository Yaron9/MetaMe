# MetaMe — Claude Code Plugin

Cognitive Profile Layer for Claude Code. Knows how you think, not just what you said.

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
| `/last` | Quick resume the most recent session |
| `/new <name>` | Start a new session with a name |
| `/name <name>` | Name the current session (syncs with desktop) |
| `/resume` | Pick from recent sessions (shows names) |
| `/cd` | Change working directory |

**Features:**
- Full Claude Code engine on your phone (file editing, bash, code search)
- Session naming syncs between phone and computer
- Parallel request handling (async spawning, non-blocking)
- Stateful sessions with `--resume`

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
