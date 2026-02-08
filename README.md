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

> **The Cognitive Profile Layer for Claude Code.**
>
> *Knows how you think. Works wherever you are.*

## 📖 Introduction

**Claude Code** is powerful, but it has two pain points:

1. **Project Amnesia** — Switch folders, and it forgets who you are. Your communication style, coding preferences, constraints — gone. Every project, you start from scratch.

2. **Desktop-Bound** — Leave your computer, work stops. You can't continue that debugging session on your phone. You can't vibe with Claude on the train, in bed, or waiting in line.

**MetaMe** solves both — and more:

**🧠 Cognitive Profile** — A persistent "Global Brain" (`~/.claude_profile.yaml`) that travels with you across every project. Unlike ChatGPT/Claude's built-in memory (which stores *facts* like "user lives in X"), MetaMe captures *how you think* — your decision style, cognitive load preferences, and communication traits. It's not a memory system; it's a **Cognitive Mirror**.

**📱 Mobile Bridge** — Full Claude Code from your phone via Telegram or Feishu. Same tools, same files, same conversation history. Start on your computer, continue anywhere. `/cd last` syncs you to exactly where you left off.

**🔔 Remote Wake** — Daemon runs in the background on your computer. Send a message from your phone, and it wakes up Claude Code to do real work — edit files, run commands, commit code — even while you're away from your desk.

**📂 File Transfer** — Send files from your computer to your phone (ask Claude to send any project file). Send files from your phone to your computer (just attach them in chat). Seamless both ways.

**⏰ Heartbeat Tasks** — Schedule Claude to run automatically. Daily summaries, automated workflows, multi-step skill chains — all running on your machine, pushing results to your phone.

## ✨ Key Features

* **🧠 Global Brain (`~/.claude_profile.yaml`):** A single, portable source of truth — your identity, cognitive traits, and preferences travel with you across every project.
* **🧬 Cognitive Evolution Engine:** MetaMe learns how you think through three channels: (1) **Passive** — silently captures your messages and distills cognitive traits via Haiku on next launch; (2) **Manual** — `!metame evolve` for explicit teaching; (3) **Confidence gates** — strong directives ("always"/"from now on") write immediately, normal observations need 3+ consistent sightings before promotion. Schema-enforced (41 fields, 5 tiers, 800 token budget) to prevent bloat.
* **🛡️ Auto-Lock:** Mark any value with `# [LOCKED]` — treated as a constitution, never auto-modified.
* **🪞 Metacognition Layer (v1.3):** MetaMe now observes *how* you think, not just *what* you say. Behavioral pattern detection runs inside the existing Haiku distill call (zero extra cost). It tracks decision patterns, cognitive load, comfort zones, and avoidance topics across sessions. When persistent patterns emerge, MetaMe injects a one-line mirror observation — e.g., *"You tend to avoid testing until forced"* — with a 14-day cooldown per pattern. Conditional reflection prompts appear only when triggered (every 7th distill or 3x consecutive comfort zone). All injection logic runs in Node.js; Claude receives only pre-decided directives, never rules to self-evaluate.
* **📱 Remote Claude Code (v1.3):** Full Claude Code from your phone via Telegram or Feishu (Lark). Stateful sessions with `--resume` — same conversation history, tool use, and file editing as your terminal. Interactive buttons for project/session picking, directory browser, and macOS launchd auto-start.
* **🔄 Workflow Engine (v1.3):** Define multi-step skill chains as heartbeat tasks. Each workflow runs in a single Claude Code session via `--resume`, so step outputs flow as context to the next step. Example: `deep-research` → `tech-writing` → `wechat-publisher` — fully automated content pipeline.
* **⏹ Full Terminal Control from Mobile (v1.3.10):** `/stop` (ESC), `/undo` (ESC×2) with native file-history restoration, concurrent task protection, daemon auto-restart, and `metame continue` for seamless mobile-to-desktop sync.
* **🎯 Goal Alignment & Drift Detection (v1.3.11):** MetaMe now tracks whether your sessions align with your declared goals. Each distill assesses `goal_alignment` (aligned/partial/drifted) at zero extra API cost. When you drift for 2+ consecutive sessions, a mirror observation is injected passively; after 3+ sessions, a reflection prompt gently asks: "Was this an intentional pivot, or did you lose track?" Session logs now record project, branch, intent, and file directories for richer retrospective analysis. Pattern detection can spot sustained drift trends across your session history.
* **🔌 Provider Relay (v1.3.11):** Use any Anthropic-compatible API relay as your backend — no file mutation, no invasion. MetaMe injects `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` at spawn time. Separate provider roles for `active`, `distill`, and `daemon` tasks. CLI: `metame provider add/use/remove/test`. Config stored in `~/.metame/providers.yaml`.
* **📊 Session History Bootstrap (v1.3.12):** Solves the cold-start problem — MetaMe previously needed 5-7 sessions before producing any visible feedback. Now, on first launch it auto-bootstraps your session history from existing Claude Code JSONL transcripts (zero API cost). Three complementary data layers: **Skeleton** (structural facts extracted locally — tools, duration, project, branch, intent), **Facets** (interaction quality from `/insights` — outcome, friction, satisfaction, when available), and **Haiku** (metacognitive judgments — cognitive load, zones, goal alignment, from the existing distill call). Patterns and mirror observations can appear from your very first MetaMe session.
* **🏥 Emergency Recovery (v1.3.13):** `/doctor` interactive diagnostics with one-tap fix buttons, `/sh` direct shell access from your phone (bypasses Claude entirely — the lifeline when everything else is broken), automatic config backup before any setting change, `/fix` to restore last known good config. `/model` interactive model switcher with auto-backup.
* **🌐 Browser Automation (v1.3.15):** Native Playwright MCP integration — auto-registered on first run. Every MetaMe user gets browser control capability out of the box. Combined with Skills, enables workflows like automated podcast publishing, form filling, and web scraping.
* **📂 Interactive File Browser (v1.3.15):** `/list` shows clickable button cards — folders expand inline, files download on tap. Folder buttons survive daemon restarts (absolute paths, no expiry). Zero token cost.

## 🛠 Prerequisites

MetaMe is a wrapper around **Claude Code**. You must have Node.js and the official Claude Code tool installed first.

1. **Node.js**: Version 14 or higher.
2. **Claude Code**: Ensure `claude` is available in your PATH and you are logged in.

## 📦 Installation

**One-command install (recommended)** — installs Node.js, Claude Code, and MetaMe:

macOS / Linux:
```bash
curl -fsSL https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.sh | bash
```

Windows (PowerShell):
```powershell
irm https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.ps1 | iex
```
> Windows uses WSL (auto-installed if missing). After WSL install you'll need to reboot once, then re-run the command.

**Manual install** — if you already have Node.js and Claude Code:

```bash
npm install -g metame-cli
```

**Claude Code Plugin** — lightweight alternative, profile injection + slash commands only:

```bash
claude plugin install github:Yaron9/MetaMe/plugin
```

## 🚀 Usage

Forget the `claude` command. From now on, simply type:

**Bash**

```
metame
```

Or, if you prefer mixed case (it's the same command):

**Bash**

```
MetaMe
```

### The First Run (Genesis)

When you run MetaMe for the first time, it will detect that your profile is empty. It will pause the AI and enter **Calibration Mode**:

1. It will ask you for a **Codename** (Nickname).
2. It will initiate a **Deep Cognitive Interview** to map your talents, mental models, and hidden anxieties.
3. **Be Honest**: It acts as a mirror. The more raw truth you provide, the better it can shadow you.
4. Once finished, it saves your "Source Code" and launches Claude.

### Daily Workflow

1. `cd` into any project folder.
2. Run `metame`.
3. Claude will start and immediately say: *"Ready, [Your Name]..."*
4. Start coding. MetaMe manages the context in the background.

### Global Initialization (Reset/Interview)

If you want to restart the **Genesis Interview** to update your psychological profile:

**Bash**

```
metame interview
```
(Command to be implemented in v1.3 - currently you can manually edit `~/.claude_profile.yaml` or use `set-trait`)

### Cognitive Evolution

MetaMe learns who you are through two paths:

**Automatic (zero effort):** A global hook captures your messages. On next launch, Haiku distills cognitive traits in the background. Strong directives ("always"/"from now on") write immediately; normal observations need 3+ consistent sightings. All writes are schema-validated (41 fields, 800 token budget). You'll see:

```
🧠 MetaMe: Distilling 7 moments in background...
```

**Manual:** Update a specific trait directly:

```bash
metame set-trait status.focus "Learning Rust"
metame evolve "I prefer functional programming patterns"
```

**Episodic memory (keyframe, not full log):** MetaMe is not a memory system, but it captures two types of experiential "keyframes" that pure personality traits can't replace:

* **Anti-patterns** (`context.anti_patterns`, max 5): Cross-project failure lessons — e.g., *"Promise.all rejects all on single failure, use Promise.allSettled"*. Auto-expires after 60 days. Prevents the AI from repeating the same mistakes across sessions.
* **Milestones** (`context.milestones`, max 3): Recent completed landmarks — e.g., *"MetaMe v1.3 published"*. Provides continuity so Claude knows where you left off without you having to recap.

**Anti-bias safeguards:** single observations ≠ traits, contradictions are tracked not overwritten, pending traits expire after 30 days, context fields auto-clear on staleness.

**In-session commands (type inside Claude Code):**

| Command | Description |
|---------|-------------|
| `!metame refresh` | Re-inject profile into current session |
| `!metame evolve "..."` | Teach MetaMe a new insight |
| `!metame set-trait key value` | Update a specific profile field |

**Metacognition controls:**

```bash
metame quiet            # Silence mirror observations & reflections for 48h
metame insights         # Show detected behavioral patterns
metame mirror on|off    # Toggle mirror injection
```

### Remote Claude Code — Telegram & Feishu (v1.3)

Full Claude Code from your phone — stateful sessions with conversation history, tool use, and file editing. Supports both Telegram and Feishu (Lark).

**Setup:**

```bash
metame daemon init                    # Create config + setup guide
```

Edit `~/.metame/daemon.yaml`:

```yaml
telegram:
  enabled: true
  bot_token: "YOUR_BOT_TOKEN"         # From @BotFather
  allowed_chat_ids:
    - 123456789                        # Your Telegram chat ID

feishu:
  enabled: true
  app_id: "YOUR_APP_ID"              # From Feishu Developer Console
  app_secret: "YOUR_APP_SECRET"
  allowed_chat_ids: []                # Empty = deny all (fill via setup wizard)
```

**Start the daemon:**

```bash
metame start                          # Background process
metame status                         # Check if running
metame logs                           # Tail the log
metame stop                           # Shutdown
metame daemon install-launchd         # macOS auto-start
metame daemon install-systemd         # Linux/WSL auto-start
```

**Auto-start (recommended):** The daemon survives reboots and auto-restarts on crash.

macOS:
```bash
metame daemon install-launchd
launchctl load ~/Library/LaunchAgents/com.metame.daemon.plist
```

Linux / WSL:
```bash
metame daemon install-systemd
```
> WSL requires systemd enabled: add `[boot]\nsystemd=true` to `/etc/wsl.conf` and restart WSL.

> **Important:** Choose one management method — either auto-start or manual (`metame start/stop`). Don't mix them, or you'll get duplicate processes.

**Session commands (interactive buttons on Telegram & Feishu):**

| Command | Description |
|---------|-------------|
| `/last` | **Quick resume** — prefers current directory's recent session, falls back to global recent |
| `/new` | Start new session — pick project directory from button list |
| `/new <name>` | Start new session with a name (e.g., `/new API Refactor`) |
| `/resume` | Resume a session — clickable list, shows session names + real-time timestamps |
| `/resume <name>` | Resume by name (supports partial match, cross-project) |
| `/name <name>` | Name the current session (syncs with computer's `/rename`) |
| `/cd` | Change working directory — with directory browser |
| `/cd last` | **Sync to computer** — jump to the most recent session's directory |
| `/session` | Current session info |
| `/stop` | Interrupt current Claude task (like pressing ESC in terminal) |
| `/undo` | Undo turns with file restoration (like pressing ESC×2 in terminal) |

Just type naturally for conversation — every message stays in the same Claude Code session with full context.

**Session naming:** Sessions can be named via `/new <name>`, `/name <name>` (mobile), or Claude Code's `/rename` (desktop). Names are stored in Claude's native session index and sync across all interfaces — name it on your phone, see it on your computer.

**How it works:**

Each chat gets a persistent session via `claude -p --resume <session-id>`. This is the same Claude Code engine as your terminal — same tools (file editing, bash, code search), same conversation history. You can start work on your computer and `/resume` from your phone, or vice versa.

**Seamless switching between desktop and mobile (v1.3.13):**

The same session works on both desktop and mobile, but there's an asymmetry:

* **Desktop → Mobile:** Automatic. Mobile spawns a fresh `claude -p --resume` for each message, so it always reads the latest session file. Just keep chatting.
* **Mobile → Desktop:** Requires a sync. Desktop Claude Code holds the session in memory — it won't see messages added by the mobile daemon. Exit Claude first (Ctrl+C), then:

```bash
metame continue
```

This resumes the latest session with all mobile messages included. Also works as `metame sync`.

**Parallel request handling:** The daemon uses async spawning, so multiple users or overlapping requests don't block each other. Each Claude call runs in a non-blocking subprocess.

**Streaming status (v1.3.7):** See Claude's work progress in real-time on your phone:

```
📖 Read: 「config.yaml」
✏️ Edit: 「daemon.js」
💻 Bash: 「git status」
🔧 Skill: 「wechat-publisher」
🌐 Browser: 「navigate」
🔗 MCP:server: 「action」
```

**File transfer (v1.3.8):** Seamlessly move files between your phone and computer.

*Computer → Phone (download):* Ask Claude to send any project file:

```
You: Send me report.md
Claude: Here you go!
        [📎 report.md]  ← tap to download
```

Works for documents, audio, images, etc. Click button to download. Links valid for 30 minutes.

*Phone → Computer (upload):* Send files directly to your project:

```
[📎 You send a PDF, image, or any file]
Claude: 📥 Saved: document.pdf
        File is in your project's upload/ folder.
```

Uploaded files are saved to `<project>/upload/`. Claude won't read large files automatically — just tell it when you want it to process them.

- **Telegram:** Works out of the box
- **Feishu:** Requires `im:resource` + `im:message` permissions in app settings

**Task control (v1.3.13):** Full terminal-equivalent control from your phone.

*`/stop` — ESC equivalent:* Sends SIGINT to the running Claude process. Instant interruption, just like pressing ESC in your terminal.

*`/undo` — git-based code rollback (v1.3.16):* Before each Claude turn, the daemon auto-commits a `[metame-checkpoint]` to git. `/undo` lists recent checkpoints; tap one to `git reset --hard` back to that state. Session history is also truncated. Reliable across both `-p` mode and interactive sessions — no dependency on Claude CLI internals.

```
You: /undo
Bot: 回退到哪一轮？
     ⏪ 重构API接口 (5分钟前)
     ⏪ 修复登录bug (12分钟前)
     ⏪ 添加测试用例 (30分钟前)
```

**Message queue & interrupt (v1.3.16):** If a Claude task is already running, new messages interrupt the current task and queue up. After 5 seconds of no new input, all queued messages are merged and processed together. Works identically on both Telegram and Feishu.

**Auto-restart (v1.3.13):** The daemon watches its own code for changes. When you update MetaMe (via npm or git), the daemon automatically restarts with the new code — no manual restart needed. A notification is pushed to confirm.

**Emergency & diagnostics (v1.3.13):**

| Command | Description |
|---------|-------------|
| `/sh <cmd>` | Run shell command directly on your computer — bypasses Claude entirely. Emergency lifeline when the model is broken. |
| `/doctor` | Interactive diagnostics: checks config, model validity, Claude CLI, backups. Shows fix buttons if issues found. |
| `/fix` | Restore `daemon.yaml` from last backup |
| `/reset` | Reset model to opus |

**Other commands:**

| Command | Description |
|---------|-------------|
| `/status` | Daemon status + profile summary |
| `/tasks` | List scheduled heartbeat tasks |
| `/run <name>` | Run a task immediately |
| `/model [name]` | Interactive model switcher with buttons (sonnet, opus, haiku). Accepts any model name when using a custom provider. Auto-backs up config before switching. |
| `/list` | File browser with clickable buttons — folders expand, files download. Zero tokens. |
| `/budget` | Today's token usage |
| `/quiet` | Silence mirror/reflections for 48h |
| `/reload` | Manually reload daemon.yaml (also auto-reloads on file change) |

**Heartbeat Tasks:**

Define scheduled tasks in `daemon.yaml`:

```yaml
heartbeat:
  tasks:
    - name: "morning-news"
      prompt: "Summarize today's top 3 AI news stories."
      interval: "24h"
      model: "haiku"
      notify: true
      precondition: "curl -s -o /dev/null -w '%{http_code}' https://news.ycombinator.com | grep 200"
```

* `precondition`: Shell command — empty output → task skipped, zero tokens.
* `type: "script"`: Run a local script directly instead of `claude -p`.
* `notify: true`: Push results to Telegram/Feishu.

**Workflow tasks** (multi-step skill chains):

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
          prompt: "Today's top 3 AI news stories"
        - skill: "tech-writing"
          prompt: "Write a WeChat article based on the research above"
        - skill: "wechat-publisher"
          prompt: "Publish the article"
          optional: true
```

Each step runs in the same Claude Code session. Step outputs automatically become context for the next step. Set `optional: true` on steps that may fail without aborting the workflow.

**Auto-reload:** The daemon watches `daemon.yaml` for changes. When Claude (or you) edits the config file, the daemon automatically reloads — no restart or `/reload` needed. A notification is pushed to confirm.

**Token efficiency:**

* Polling, slash commands, directory browsing: **zero tokens**
* Stateful sessions: same cost as using Claude Code in terminal (conversation history managed by Claude CLI)
* Budget tracking with daily limit (default 50k tokens)
* 10-second cooldown between Claude calls

**Security:**

* `allowed_chat_ids` whitelist — unauthorized users silently ignored (empty = deny all)
* `dangerously_skip_permissions` enabled by default for mobile (users can't click "allow" on phone — security relies on the chat ID whitelist)
* `~/.metame/` directory set to mode 700
* Bot tokens stored locally, never transmitted

### Provider Relay — Third-Party Model Support (v1.3.11)

MetaMe supports any Anthropic-compatible API relay as a backend. This means you can route Claude Code through a third-party relay that maps `sonnet`/`opus`/`haiku` to any model (GPT-4, DeepSeek, Gemini, etc.) — MetaMe passes standard model names and the relay handles translation.

**How it works:** At spawn time, MetaMe injects `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` environment variables. Zero file mutation — `~/.claude/settings.json` is never touched.

**CLI commands:**

```bash
metame provider                         # List all providers
metame provider add <name>              # Add a relay (prompts for URL & key)
metame provider use <name>              # Switch active provider
metame provider remove <name>           # Remove a provider (can't remove 'anthropic')
metame provider test [name]             # Test connectivity
metame provider set-role distill <name> # Use a different provider for background distill
metame provider set-role daemon <name>  # Use a different provider for daemon tasks
```

**Configuration** (`~/.metame/providers.yaml`):

```yaml
active: 'anthropic'
providers:
  anthropic:
    label: 'Anthropic (Official)'
  my-relay:
    label: 'My Relay'
    base_url: 'https://api.relay.example.com/v1'
    api_key: 'sk-xxx'
distill_provider: null          # null = use active
daemon_provider: null           # null = use active
```

Three independent provider roles let you optimize cost: e.g., use an official Anthropic key for active work, a cheaper relay for background distill, and another for daemon heartbeat tasks.

### Hot Reload (Refresh)

If you update your profile or need to fix a broken context **without restarting your session**:

*   **Inside Claude**: Run `!metame refresh`
*   **External Terminal**: Run `metame refresh`

This re-injects your latest profile into `CLAUDE.md` instantly.

## ⚙️ Configuration & The "Global Brain"

Your profile is stored in a hidden YAML file in your home directory.

**Location:** `~/.claude_profile.yaml`

You can edit this file manually to update your status or lock your values.

**Example Profile (v2 Schema):**

**YAML**

```
# === T1: Identity (LOCKED) ===
identity:
  nickname: Neo              # [LOCKED]
  role: Senior Architect
  locale: en-US              # [LOCKED]

# === T2: Core Traits (LOCKED) ===
core_traits:
  crisis_reflex: Analysis    # [LOCKED]
  flow_trigger: Debugging    # [LOCKED]
  learning_style: Hands-on   # [LOCKED]

# === T3: Preferences (auto-learnable) ===
preferences:
  code_style: concise
  communication: direct
  explanation_depth: brief_rationale

# === T3b: Cognition (auto-learnable, slow to change) ===
cognition:
  decision_style: analytical
  info_processing:
    entry_point: big_picture
    preferred_format: structured
  cognitive_load:
    chunk_size: medium
    preferred_response_length: moderate

# === T4: Context (auto-overwrite) ===
context:
  focus: "Refactoring Legacy Code"
  energy: high

# === T5: Evolution (system-managed) ===
evolution:
  distill_count: 12
  last_distill: "2026-01-30T10:00:00Z"
```

* **T1-T2 fields** marked `# [LOCKED]` are never auto-modified.
* **T3 fields** are auto-learned with confidence thresholds.
* **T4 fields** are freely overwritten as your context changes.
* **T5 fields** are managed by the distillation system.

### Profile Migration (v1 → v2)

If you have an existing v1 profile, run the migration script:

```
node ~/.metame/migrate-v2.js --dry-run   # preview changes
node ~/.metame/migrate-v2.js             # apply migration (auto-backup created)
```

## 🗑️ Uninstallation

If you wish to remove MetaMe completely from your system, follow these steps:

### 1. Remove the Package

Uninstall the CLI tool:

**Bash**

```
npm uninstall -g metame-cli
```

### 2. Remove the Global Brain (Optional)

If you want to delete your stored profile data:

**Bash**

```
rm ~/.claude_profile.yaml
```

### 3. Stop the Daemon (if running)

```bash
metame stop

# macOS: remove auto-start
launchctl unload ~/Library/LaunchAgents/com.metame.daemon.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.metame.daemon.plist

# Linux/WSL: remove auto-start
systemctl --user disable metame-daemon 2>/dev/null
rm -f ~/.config/systemd/user/metame-daemon.service
```

### 4. Remove Passive Distillation Data (Optional)

Remove the signal capture scripts:

**Bash**

```
rm -rf ~/.metame
```

### 5. Remove the Signal Capture Hook (Optional)

MetaMe installs a global hook in `~/.claude/settings.json`. To remove it, edit the file and delete the `UserPromptSubmit` entry under `hooks`, or run:

**Bash**

```
node -e "
const fs = require('fs');
const p = require('os').homedir() + '/.claude/settings.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
if (s.hooks) { delete s.hooks.UserPromptSubmit; }
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('Hook removed.');
"
```

### 6. Cleanup Project Files (Optional)

MetaMe adds a header to `CLAUDE.md` files in your projects. To restore them to their original state (if you have many), you can use a text editor to remove the block starting with `## 🧠 SYSTEM KERNEL`.

## ⚡ Performance & Cost

You might worry: *"Does this eat up my context window?"*

**Short answer: No. It likely saves you money.**

*   **Context Cost**: The entire MetaMe kernel + your profile takes up **~800-1000 tokens**.
*   **Impact**: On a 200k context window, this is **0.5%** of the memory.
*   **ROI**: By pre-loading your context, you avoid the "instructional drift" and repetitive correction loops that usually waste thousands of tokens at the start of every session.
*   **Passive Distillation Cost**: The signal capture hook is a local Node.js script (zero API calls). The Haiku distillation on launch processes only a small buffer of filtered messages — typically a few hundred tokens at Haiku's very low cost.

## ❓ FAQ

**Q: Does this replace `CLAUDE.md`?**
A: No. It *prepends* its meta-cognitive protocol to your existing `CLAUDE.md`. Your project-specific notes remain intact.


**Q: Is my data sent to a third party?**
A: No. Your profile stays local at `~/.claude_profile.yaml`. MetaMe simply passes text to the official Claude Code tool.

## 📋 Changelog

| Version | Highlights |
|---------|------------|
| **v1.3.17** | **Windows support** (WSL one-command installer), `install-systemd` for Linux/WSL daemon auto-start. Fix onboarding (Genesis interview was never injected, CLAUDE.md accumulated across runs). Marker-based cleanup, unified protocols, `--append-system-prompt` guarantees interview activation, Feishu auto-fetch chat ID, full mobile permissions, fix `/publish` false-success, auto-restart daemon on script update |
| **v1.3.16** | Git-based `/undo` (auto-checkpoint before each turn, `git reset --hard` rollback), `/nosleep` toggle (macOS caffeinate), custom provider model passthrough (`/model` accepts any name for non-anthropic providers), auto-fallback to anthropic/opus on provider failure, message queue works on Telegram (fire-and-forget poll loop), lazy background distill |
| **v1.3.15** | Native Playwright MCP (browser automation for all users), `/list` interactive file browser with buttons, Feishu image download fix, Skill/MCP/Agent status push, hot restart reliability (single notification, no double instance) |
| **v1.3.14** | Fix daemon crash on fresh install (missing bundled scripts) |
| **v1.3.13** | `/doctor` diagnostics, `/sh` direct shell, `/fix` config restore, `/model` interactive switcher with auto-backup, daemon state caching & config backup/restore |
| **v1.3.12** | Session history bootstrap (cold-start fix), three-layer data architecture (Skeleton + Facets + Haiku), session summary extraction |
| **v1.3.11** | Goal alignment & drift detection, provider relay system for third-party models, `/insights` facet integration |
| **v1.3.10** | `/stop`, `/undo` with file restoration, `/model`, concurrent task protection, `metame continue`, daemon auto-restart on code change |
| **v1.3.8** | Bidirectional file transfer (phone ↔ computer) |
| **v1.3.7** | Real-time streaming status on mobile |
| **v1.3** | Metacognition layer, remote Claude Code (Telegram & Feishu), workflow engine, heartbeat tasks, launchd auto-start |

## 📄 License

MIT License. Feel free to fork, modify, and evolve your own Meta-Cognition.
