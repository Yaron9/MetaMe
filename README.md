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

> **Your digital twin. Lives on your machine.**

MetaMe is an AI that lives on your machine — remembers how you think, stays online 24/7, and takes commands from your phone via Telegram or Feishu. Not in the cloud. In your computer. Runs natively on macOS and Windows.

No cloud. Your machine, your data.

```bash
curl -fsSL https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.sh | bash
```

**Already have Node.js ≥ 22.5:**
```bash
npm install -g metame-cli
metame
```

**Windows (PowerShell):**
```powershell
npm install -g metame-cli
metame
```

---

> ### 🚀 v1.4.33 — 6-Dimension Soul Schema + Nightly Reflection + Auto-Provisioning
>
> - **6-dimension soul schema**: cognitive profile upgraded from key-value pairs to a structured 67-field model covering Values, Drive, Cognition Style, Stress & Shadow, Relational, and Identity Narrative — with tier-based lock protection.
> - **Nightly reflection**: every night, hot-zone facts are distilled into searchable decision logs and lessons learned.
> - **Memory index**: auto-generated global index of all memory documents for instant retrieval.
> - **Auto-provisioning**: first run automatically deploys default CLAUDE.md, docs, and `dispatch_to` — zero manual setup.
> - **Token budget tracking**: daily token usage monitoring with per-category breakdown and 80% warning threshold.
> - **Multi-user ACL**: role-based permissions (admin / member / stranger) with binding protection.
> - **Windows native support**: cross-platform path handling, Named Pipes IPC, GBK-safe encoding.
>
> Zero configuration. It just works.

---

## What It Does

### 1. Knows You Across Every Project

Claude Code forgets you every time you switch folders. MetaMe doesn't.

A cognitive profile (`~/.claude_profile.yaml`) follows you everywhere — not just facts like "user prefers TypeScript", but *how you think*. The profile is built on a **6-dimension soul schema**: Values, Drive, Cognition Style, Stress & Shadow, Relational, and Identity Narrative — 67 fields organized into 4 tiers (T1 locked identity → T5 system-managed evolution). First-time users go through a **Genesis Interview**: a structured deep conversation that builds your cognitive fingerprint from scratch.

Once established, the profile updates silently from your conversations via background distillation — no effort required.

```
$ metame
🧠 MetaMe: Distilling 7 moments in background...
🧠 Memory: 42 facts · 87 sessions tagged
Link Established. What are we building?
```

### 2. Full Claude Code From Your Phone

Your Mac runs a daemon. Your phone sends messages via Telegram or Feishu. Same Claude Code engine — same tools, same files, same session.

```
You (phone):  Fix the auth bug in api/login.ts
Claude:       ✏️ Edit: api/login.ts
              💻 Bash: npm test
              ✅ Fixed. 3 tests passing.
```

Start on your laptop, continue on the train. `/stop` to interrupt, `/undo` to rollback, `/mac check` for macOS automation diagnostics, and `/sh ls` for raw shell access when everything else breaks.

### 3. Layered Memory That Works While You Sleep

MetaMe's memory system runs automatically in the background — no prompts, no manual saves. Five layers, fully autonomous.

**Layer 1 — Long-term Facts**
When you go idle, MetaMe runs memory consolidation: extracts key decisions, patterns, and knowledge from your sessions into a persistent facts store. These are semantically recalled on every session start.

**Layer 2 — Session Continuity**
Resuming a conversation after 2+ hours? MetaMe injects a brief summary of what you were working on last time — so you pick up where you left off without re-explaining context.

**Layer 3 — Session Index**
Every session gets tagged with topics and intent. This powers future session routing: when you reference "that thing we worked on last week", MetaMe knows where to look.

**Layer 4 — Nightly Reflection**
Every night at 01:00, MetaMe reviews your most-accessed facts from the past week and distills them into high-level decision logs and operational lessons — searchable documents that grow your personal knowledge base over time.

**Layer 5 — Memory Index**
At 01:30, an auto-generated global index (`INDEX.md`) maps every memory document across all categories. This serves as a fast lookup table so MetaMe always knows where to find relevant context.

```
[Background, while you sleep]
idle 30min → memory consolidation triggered
  → session_tags.json updated (topics indexed)
  → facts extracted → ~/.metame/memory.db
  → session summary cached → daemon_state.json
01:00 → nightly reflection: hot facts → decisions + lessons
01:30 → memory index regenerated

[Next morning, when you resume]
"continue from yesterday" →
  [上次对话摘要] Auth refactor, decided on JWT with
  refresh token rotation. Token expiry set to 15min.
```

### 4. Heartbeat — A Programmable Nervous System

Most AI tools react when you talk to them. MetaMe keeps running while you sleep.

The heartbeat system is three-layered:

**Layer 0 — Kernel (always on, zero config)**
Built into the daemon. Runs every 60 seconds regardless of what's in your config:
- Drains the dispatch queue (IPC messages from other agents)
- Tracks daemon aliveness and rotates logs
- Detects when you go idle → generates session continuity summaries

**Layer 1 — System Evolution (built-in defaults)**
Five tasks shipped out of the box. They are precondition-gated and run only when useful:

```yaml
- cognitive-distill   # 4h · has signals? → distill preferences into profile
- memory-extract      # 4h · scan sessions → extract long-term facts + topic tags
- skill-evolve        # 6h · has signals? → evolve skills from task outcomes
- nightly-reflect     # 01:00 daily · hot facts → decision logs + lessons learned
- memory-index        # 01:30 daily · regenerate global memory index
```

`precondition` guards mean zero tokens burned when there's nothing to process.

**Layer 2 — Your Tasks (fully customizable)**
Anything you want Claude to do on a schedule, per project, with push notifications:

```yaml
projects:
  my_blog:
    heartbeat_tasks:
      - name: "daily-draft"
        prompt: "Research top AI news and write an article"
        at: "09:30"
        days: "weekdays"
        model: "sonnet"
        notify: true

heartbeat:
  tasks:
    - name: "morning-brief"
      prompt: "Summarize my git activity from yesterday"
      at: "09:00"
      notify: true
```

Chain skills into multi-step workflows — research → write → publish — fully automated:

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

**Task options:**

| Option | Description |
|--------|-------------|
| `at` | Fixed-time trigger, e.g. `"09:30"` (local time) |
| `days` | Day filter, e.g. `"weekdays"`, `[mon, wed, fri]` |
| `interval` | Interval trigger, e.g. `"4h"`, `"30m"` |
| `require_idle` | Skip if you're active; retry on next heartbeat tick |
| `precondition` | Shell guard — skip task if command returns non-zero (zero tokens consumed) |
| `notify` | Push result to phone when done |
| `model` | Override model, e.g. `"sonnet"`, `"haiku"` |
| `cwd` | Working directory for the task |
| `timeout` | Max run time |

> **Scheduled tasks require system registration.** Run `metame daemon install-launchd` (macOS) or `metame daemon install-task-scheduler` (Windows) and tasks fire on schedule even with the screen locked — as long as the machine is on.

### 5. Skills That Evolve Themselves

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

---

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.sh | bash
```

**Already have Node.js ≥ 22.5:**
```bash
npm install -g metame-cli
metame
```

> **First run auto-provisioning:** MetaMe automatically deploys a default `CLAUDE.md`, documentation files, and the `dispatch_to` tool to `~/.metame/`. No manual setup needed.

**Setup guide (3 minutes):**

| Step | What to do | What happens |
|------|-----------|-------------|
| 1. Log in to Claude | Run `claude` and complete the login (Anthropic account or API key) | Claude Code is ready to use |
| 2. Launch MetaMe | Run `metame` | Opens a Claude session with MetaMe loaded |
| 3. Genesis Interview | Just chat — MetaMe will automatically start a deep soul interview on first run | Builds `~/.claude_profile.yaml` (6-dimension cognitive profile) |
| 4. Connect phone | Say "help me set up mobile access" or "connect my phone" | Interactive wizard for Telegram/Feishu bot setup → `~/.metame/daemon.yaml` |
| 5. Start daemon | `metame start` | Background daemon launches, bot goes online |
| 6. Register with system | macOS: `metame daemon install-launchd` · Windows: `metame daemon install-task-scheduler` · Linux: see below | Always-on, crash recovery |

> **First time?** Just run `metame` and talk naturally. The interview and setup are conversational — no commands to memorize.

**Update MetaMe:**
```bash
npm install -g metame-cli
```

> **What does system registration mean?**
> Once registered, MetaMe runs in the background automatically — screen locked, lid closed, woken from sleep — as long as the machine is on. Scheduled tasks fire on time. No terminal window needed.

**Windows — register with Task Scheduler:**

```powershell
metame daemon install-task-scheduler
```

> The daemon auto-starts at login. Remove with: `schtasks /delete /tn "MetaMe-Daemon" /f`

> **Windows notes:** Emoji display uses ASCII fallback (`[OK]`, `[FAIL]`) for GBK terminal compatibility. Named Pipes replace Unix sockets for IPC. `/mac` commands are not available.

> **Windows users: install natively, not via WSL.** WSL often fails to inherit the host's network proxy (causing npm install and Claude API timeouts), has path mapping issues, and process management doesn't interoperate. `npm install -g metame-cli` directly in PowerShell/CMD is the most reliable approach.

**WSL2 / Linux — register with systemd:**

```bash
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

systemctl --user enable metame
systemctl --user start metame
```

> WSL2 requires systemd enabled first: add `[boot]\nsystemd=true` to `/etc/wsl.conf`, then restart WSL.

> **WSL limitation:** `/mac` commands (macOS AppleScript/JXA automation) are not available.

**Create your first Agent:**

1. In any existing group, say: `Create an agent, directory ~/xxx, responsible for xxx`
2. Bot replies: ✅ Agent created — **send `/activate` in your new group to bind it**
3. Create a new group, add the bot, send `/activate` → binding complete

> Want more Agents? Repeat: create in any group → new target group → `/activate`. Each group = independent AI workspace.

---

## Core Capabilities

| Capability | What It Does |
|-----------|-------------|
| **Cognitive Profile** | 6-dimension soul schema (Values, Drive, Cognition Style, Stress & Shadow, Relational, Identity Narrative). 67 fields, tier-locked, 800-token budget. First-time Genesis Interview builds your profile from scratch. |
| **Layered Memory** | Five-tier memory: long-term facts (semantic recall), session summaries (continuity bridge), session index (topic tags), nightly reflection (decision/lesson distillation), memory index (global lookup). All automatic. |
| **Mobile Bridge** | Full Claude Code via Telegram/Feishu. Stateful sessions, file transfer both ways, real-time streaming status. |
| **Skill Evolution** | Self-healing skill system. Auto-discovers missing skills, learns from browser recordings, evolves after every task. Skills get smarter over time. |
| **Token Budget** | Daily token usage tracking with per-category breakdown. Configurable daily limit, automatic 80% warning threshold, usage history with rollover. |
| **Auto-Provisioning** | First run deploys default CLAUDE.md, documentation, and `dispatch_to` to `~/.metame/`. Subsequent runs sync scripts without overwriting user config. |
| **Heartbeat System** | Three-layer programmable nervous system. Layer 0 kernel always-on (zero config). Layer 1 system evolution built-in (5 tasks: distill + memory + skills + nightly reflection + memory index). Layer 2 your custom scheduled tasks with `require_idle`, `precondition`, `notify`, workflows. |
| **Multi-Agent** | Multiple projects with dedicated chat groups. `/agent bind` for one-tap setup. True parallel execution. |
| **Browser Automation** | Built-in Playwright MCP. Browser control out of the box for every user. |
| **Cross-Platform** | Native support for macOS and Windows. Platform abstraction layer handles spawn, IPC, process management, and terminal encoding automatically. |
| **Provider Relay** | Route through any Anthropic-compatible API. Use GPT-4, DeepSeek, Gemini — zero config file mutation. |
| **Metacognition** | Detects behavioral patterns (decision style, comfort zones, goal drift) and injects mirror observations. Zero extra API cost. |
| **Multi-User ACL** | Role-based permission system (admin / member / stranger). Share bots with teammates safely. Dynamic user management via `/user` commands with hot-reload config. |
| **Team Task** | Multi-agent task board for cross-agent collaboration. Agents can create, assign, and track tasks across workspaces. N-agent session scoping for parallel team workflows. |
| **Emergency Tools** | `/doctor` diagnostics, `/mac` macOS control helpers, `/sh` raw shell, `/fix` config restore, `/undo` git-based rollback. |

## Defining Your Agents

MetaMe's design philosophy: **one folder = one agent.**

Give an agent a directory, drop a `CLAUDE.md` inside describing its role, and you're done. The folder is the agent — it can be a code project, a blog repo, any workspace you already have.

### Option 1: Just say it (recommended)

No commands needed. Tell the bot what you want in plain language. **The agent is created without binding to the current group** — send `/activate` in your new target group to complete the binding:

```
You:  Create an agent, directory ~/projects/assistant, responsible for writing and content
Bot:  ✅ Agent「assistant」created
      Dir: ~/projects/assistant
      📝 CLAUDE.md written

      Next: send /activate in your new group to bind

── In the new group ──

You:  /activate
Bot:  🤖 assistant bound
      Dir: ~/projects/assistant

You:  Change this agent's role to: focused on Python backend development
Bot:  ✅ Role definition updated in CLAUDE.md

You:  List all agents
Bot:  📋 Agent list
      🤖 assistant ◀ current
      Dir: ~/projects/assistant
      ...
```

Supported intents: create, bind (`/agent bind`), unbind, edit role, list — just say it naturally.

### Option 2: Commands

Use `/agent` commands in any Telegram/Feishu group:

| Command | What it does |
|---------|-------------|
| `/activate` | In a new group, sends this to auto-bind the most recently created pending agent. |
| `/agent bind <name> [dir]` | Manual bind: register this group as a named agent. Works anytime — no need to recreate if agent already exists. |
| `/agent list` | Show all configured agents. |
| `/agent edit` | Update the current agent's role description (rewrites its `CLAUDE.md` section). |
| `/agent unbind` | Remove this group's agent binding. |
| `/agent reset` | Remove the current agent's role section. |

> **Binding protection**: Each group can only be bound to one agent. Existing bindings cannot be overwritten without explicit `force:true`.

### From config file (for power users)

```yaml
# ~/.metame/daemon.yaml
projects:
  assistant:                      # project key — used by dispatch_to
    name: "Personal Assistant"
    icon: "💅"
    color: "blue"
    cwd: "~/AGI/MyAssistant"
    nicknames: ["小美", "助理"]
    heartbeat_tasks: []

  coder:
    name: "Backend Engineer"
    icon: "🛠"
    color: "orange"
    cwd: "~/projects/backend"
    heartbeat_tasks:
      - name: "daily-review"
        prompt: "Review yesterday's commits and flag any issues"
        at: "20:30"
        days: [mon, tue, wed, thu, fri]
        notify: true

feishu:
  chat_agent_map:
    oc_abc123: assistant          # this group → assistant agent
    oc_def456: coder              # this group → coder agent
```

All agents share your cognitive profile (`~/.claude_profile.yaml`) — they all know who you are. Each runs in its own `cwd` with its own Claude session, in parallel.

**Dispatch between agents** (from Claude or a heartbeat task):

```bash
~/.metame/bin/dispatch_to assistant "Schedule tomorrow's standup"
~/.metame/bin/dispatch_to coder "Run the test suite and report results"
```

## Mobile Commands

| Command | Action |
|---------|--------|
| `/continue` | Sync to computer's current work (session + directory) |
| `/last` | Resume most recent session |
| `/new` | Start new session (project picker) |
| `/resume` | Pick from session list |
| `/stop` | Interrupt current task (ESC) |
| `/undo` | Show recent messages as buttons — tap to roll back context + code to before that message |
| `/undo <hash>` | Roll back to a specific git checkpoint |
| `/list` | Browse & download project files |
| `/model` | Switch model (sonnet/opus/haiku) |
| `/activate` | Activate and bind the most recently created pending agent in a new group |
| `/agent bind <name> [dir]` | Manually register group as dedicated agent |
| `/mac` | macOS control helper: permissions check/open + AppleScript/JXA execution |
| `/sh <cmd>` | Raw shell — bypasses Claude |
| `/memory` | Memory stats: fact count, session tags, DB size |
| `/memory <keyword>` | Search long-term facts by keyword |
| `/doctor` | Interactive diagnostics |
| `/user add <open_id>` | Add a user (admin only) |
| `/user role <open_id> <admin\|member>` | Set user role |
| `/user list` | List all configured users |
| `/user remove <open_id>` | Remove a user |
| `/sessions` | Browse recent sessions with last message preview |
| `/teamtask create <agent> <goal>` | Create a cross-agent collaboration task |
| `/teamtask` | List recent TeamTasks (last 10) |
| `/teamtask <task_id>` | View task detail |
| `/teamtask resume <task_id>` | Resume a task |

## How It Works

```
┌─────────────┐     Telegram/Feishu      ┌──────────────────────────────┐
│  Your Phone  │ ◄──────────────────────► │   MetaMe Daemon              │
└─────────────┘                           │   (your machine, 24/7)       │
                                          │                              │
                                          │   ┌──────────────┐           │
                                          │   │ Claude Code   │           │
                                          │   │ (same engine) │           │
                                          │   └──────────────┘           │
                                          │                              │
                                          │   ~/.claude_profile          │
                                          │   (6-dim soul schema)        │
                                          │                              │
                                          │   ~/.metame/memory.db        │
                                          │   session_tags.json          │
                                          │   (5-layer memory)           │
                                          │                              │
                                          │   dispatch_to (auto-deployed)│
                                          └──────────────────────────────┘
                                                       ↑
                                          idle → summaries + memory tasks
                                          01:00 → nightly reflection
                                          01:30 → memory index rebuild
```

- **Profile** (`~/.claude_profile.yaml`): 6-dimension soul schema. Injected into every Claude session via `CLAUDE.md`.
- **Daemon**: Background process handling Telegram/Feishu messages, heartbeat tasks, Unix socket dispatch, and idle/sleep transitions.
- **Distillation**: Heartbeat task (4h, signal-gated) that updates your cognitive profile.
- **Memory Extract**: Heartbeat task (4h, idle-gated) that extracts long-term facts and session topic tags.
- **Nightly Reflection**: Daily at 01:00. Distills hot-zone facts into decision logs and operational lessons.
- **Memory Index**: Daily at 01:30. Regenerates the global memory index for fast retrieval.
- **Session Summarize**: Generates a brief summary for idle sessions. Injected as context when resuming after a 2h+ gap.

## Security

- All data stays on your machine. No cloud, no telemetry.
- `allowed_chat_ids` whitelist — new groups get a smart prompt: if a pending agent activation exists, they're guided to send `/activate`; otherwise they receive setup instructions.
- **Multi-user ACL**: role-based permissions (admin / member / stranger). Admins manage access via `/user` commands with hot-reload config.
- **Binding protection**: each group can only be bound to one agent. Existing bindings cannot be overwritten without explicit `force:true`.
- `operator_ids` for shared groups — non-operators get read-only mode.
- `~/.metame/` directory is mode 700.
- Bot tokens stored locally, never transmitted.

## Performance

| Metric | Value |
|--------|-------|
| Daemon memory (idle) | ~100 MB RSS — standard Node.js process baseline |
| Daemon CPU (idle, between heartbeats) | ~0% — event-loop sleeping |
| Cognitive profile injection | ~800 tokens/session (0.4% of 200k context) |
| Dispatch latency (Unix socket) | <100ms |
| Memory consolidation (per session) | ~1,500–2,000 tokens input + ~50–300 tokens output (Haiku) |
| Session summary (per session) | ~400–900 tokens input + ≤250 tokens output (Haiku) |
| Mobile commands (`/stop`, `/list`, `/undo`) | 0 tokens |

> Both memory consolidation and session summarization run in the background via Haiku (`--model haiku`). Input is capped by code: skeleton text ≤ 3,000 chars, summary output ≤ 500 chars. Neither runs per-message — memory consolidation follows heartbeat schedule with idle/precondition guards, and summaries trigger once per idle session on sleep-mode transitions.

## Plugin

Install directly into Claude Code without npm:

```bash
claude plugin install github:Yaron9/MetaMe/plugin
```

Includes: cognitive profile injection, daemon (Telegram/Feishu), heartbeat tasks, layered memory, all mobile commands, slash commands (`/metame:evolve`, `/metame:daemon`, `/metame:refresh`, etc.).

**One key difference from the npm CLI:** the plugin daemon starts when you open Claude Code and stops when you close it. It does not run 24/7 in the background. For always-on mobile access (receiving messages while Claude Code is closed), use the npm CLI with `metame daemon install-launchd`.

Use the plugin if you prefer not to install a global npm package and only need mobile access while Claude Code is open. Use the npm CLI (`metame-cli`) for 24/7 daemon, the `metame` command, and first-run interview.

## Contributing

MetaMe is early-stage and evolving fast. Every issue and PR directly shapes the project.

**Report a bug or request a feature:**
- Open an [Issue](https://github.com/Yaron9/MetaMe/issues) — describe what happened, what you expected, and your environment (macOS/Windows/WSL, Node version).

**Submit a PR:**
1. Fork the repo and create a branch from `main`
2. All source edits go in `scripts/` — run `npm run sync:plugin` to sync to `plugin/scripts/`
3. Run `npx eslint scripts/daemon*.js` — zero errors required
4. Run `npm test` — all tests must pass
5. Open a PR against `main` with a clear description

**Good first contributions:** Windows edge cases, new `/commands`, documentation improvements, test coverage.

## License

MIT
