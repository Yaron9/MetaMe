# MetaMe Skill Creator

A complete skill lifecycle management system for [Claude Code](https://claude.ai/code) — create, iterate, evolve, and package skills that extend Claude's capabilities.

## What It Does

| Capability | Description |
|---|---|
| **Create** | Scaffold new skills with `init_skill.py`, write `SKILL.md`, bundle scripts/references/assets |
| **Iterate** | Structured workflow for improving skills after real usage |
| **Evolve** | Auto-captures session experience (bugs, preferences, workarounds) and stitches it into SKILL.md |
| **Package** | Produces portable `.skill` files for distribution |

## Install

Install via [skill-manager](https://github.com/anthropics/claude-code) or manually:

```bash
# Manual install
cp -r skill-creator ~/.claude/skills/

# One-time setup: enables auto-evolution after every session
python3 ~/.claude/skills/skill-creator/scripts/setup.py
```

That's it. Skills now evolve automatically.

## Auto-Evolution

After each Claude Code session, a Stop hook:
1. Detects which skills were active
2. Extracts failures and patterns from the transcript
3. If `ANTHROPIC_API_KEY` is set → Haiku analyzes and generates structured insights
4. Persists experience into `evolution.json` + stitches it into `SKILL.md`

Experience survives skill upgrades — it lives in a dedicated `## User-Learned Best Practices` section that persists through updates.

**No `ANTHROPIC_API_KEY`?** Hook runs in rule-based mode, capturing raw tool failures. Full Haiku analysis activates automatically once the key is available.

## Manual Triggers

```bash
# Evolve a skill from session experience
/evolve

# Or say: "进化技能", "记录这个经验", "skill evolution"
```

## Scripts

```
scripts/
├── init_skill.py          # Scaffold new skill directory
├── package_skill.py       # Validate + pack to .skill file
├── quick_validate.py      # Validate without packaging
├── merge_evolution.py     # Merge experience into evolution.json
├── smart_stitch.py        # Write evolution.json → SKILL.md section
├── align_all.py           # Re-stitch all skills after batch update
├── auto_evolve_hook.js    # Stop hook (configured by setup.py)
└── setup.py               # One-time hook installer
```

## References

- `references/creation-guide.md` — Full 7-step skill creation workflow
- `references/evolution-guide.md` — Evolution workflow and data format
- `references/workflows.md` — Sequential/conditional workflow design patterns
- `references/output-patterns.md` — Output quality and template patterns

## License

See `LICENSE.txt`
