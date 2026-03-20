---
name: skill-creator
description: Create, iterate, evolve, and package skills that extend Claude's capabilities. Use when: (1) Creating a new skill from scratch, (2) Updating or improving an existing skill's instructions or bundled resources, (3) Evolving a skill based on session experience (bugs, preferences, workarounds) — triggers: "进化技能", "更新 skill", "/evolve", "记录这个经验", "skill evolution", (4) Packaging a skill for distribution to other Claude Code (Codex) users. Do NOT trigger for general programming tasks unrelated to skill authoring.
license: Complete terms in LICENSE.txt
---

# Skill Studio

## Auto-Evolve Setup (run once, idempotent)

Before starting any task, run setup. The script auto-detects your platform:

```bash
# Claude Code
python3 "$(find ~/.claude/skills -path '*/skill-creator/scripts/setup.py' 2>/dev/null | head -1)"

# OpenAI Codex CLI
python3 "$(find ~/.codex/skills -path '*/skill-creator/scripts/setup.py' 2>/dev/null | head -1)"
```

Safe to run every time — exits immediately if already installed.

**CC**: adds a Stop hook to `~/.claude/settings.json` — skills evolve automatically at session end with full transcript analysis (Haiku if `ANTHROPIC_API_KEY` is set, rule-based otherwise).

**Codex**: adds a `notify` entry to `~/.codex/config.toml` — fires per turn but Codex passes no transcript data, so signals are recorded for manual `/evolve` review. Full auto-analysis not available on Codex.

---

Three paths — pick based on your goal:

**🆕 Creating a new skill** → read `references/creation-guide.md`

**🔄 Evolving an existing skill** (session experience, bugs, preferences) → read `references/evolution-guide.md`

**🎨 Designing workflows or output patterns** → read `references/workflows.md` and/or `references/output-patterns.md`

---

## Core Principles

**Context window is a public good.** Default assumption: Claude is smart. Only include what Claude doesn't already have. Challenge every paragraph: "Does this justify its token cost?"

**Progressive disclosure** — three loading levels:
1. Frontmatter `description` (~100 words) — always in context, determines triggering
2. SKILL.md body (<500 lines) — loaded when skill triggers
3. `references/` and `scripts/` — loaded only when Claude decides they're needed

**Degrees of freedom** — match specificity to fragility:
- High freedom (text instructions): multiple valid approaches
- Medium freedom (pseudocode/parameterized scripts): preferred pattern with variation
- Low freedom (specific scripts): fragile operations needing exact sequence

---

## Anatomy of a Skill

```
skill-name/
├── SKILL.md                  ← required: frontmatter + body
├── scripts/                  ← executable code (deterministic, reusable)
├── references/               ← docs loaded into context as needed
└── assets/                   ← files used in output (not loaded into context)
```

**Frontmatter required fields:** `name`, `description` (+ `needs_browser: true` if Playwright MCP needed)

**What NOT to include:** README.md, CHANGELOG.md, INSTALLATION_GUIDE.md, or any auxiliary docs.

---

## Scripts Reference

| Script | Purpose | Usage |
|---|---|---|
| `init_skill.py` | Scaffold new skill | `python scripts/init_skill.py <name> --path <dir>` |
| `package_skill.py` | Validate + pack to `.skill` file | `python scripts/package_skill.py <skill-dir> [output-dir]` |
| `quick_validate.py` | Validate without packaging | `python scripts/quick_validate.py <skill-dir>` |
| `merge_evolution.py` | Persist session experience to evolution.json | `python scripts/merge_evolution.py <skill-dir> '<json>'` |
| `smart_stitch.py` | Write evolution.json → SKILL.md section | `python scripts/smart_stitch.py <skill-dir>` |
| `align_all.py` | Re-stitch all skills after batch update | `python scripts/align_all.py <skills-root-dir>` |
| `auto_evolve_hook.js` | Stop hook — auto-runs after each CC session | configured by `setup.py` |
| `setup.py` | Install Stop hook into `~/.claude/settings.json` | `python3 scripts/setup.py` |

**For Codex/CC users:** `.skill` files are portable zip archives. Host on GitHub → discoverable via `skill-scout`. No hardcoded path assumptions — all scripts accept explicit paths.


<!-- METAME-EVOLUTION:START -->

## User-Learned Best Practices & Constraints

> **Auto-Generated Section**: Maintained by skill-evolution-manager. Do not edit manually.

### User Preferences
- Add template for semantic trigger hooks to prevent accidental skill invocation (Signal 23), and enforce pointer-style one-line descriptions instead of full skill content reads to reduce TOKEN bloat. User emphasizes elegance and conciseness across all skill configurations (Signals 25, 63).

<!-- METAME-EVOLUTION:END -->
