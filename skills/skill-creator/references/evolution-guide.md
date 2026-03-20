# Skill Evolution Guide

Evolution captures runtime experience (bugs, preferences, workarounds) and stitches it persistently into a skill's SKILL.md — surviving future skill upgrades.

## When to Evolve

Trigger: user says `/evolve`, "复盘一下", "记录这个经验", "把这个偏好保存到 Skill", or expresses friction during a skill session.

## Workflow

### 1. Review & Extract

Scan the conversation for:
- Things the user was unhappy with (errors, wrong style, bad params)
- Things that worked well (effective prompts, useful patterns)
- Environment-specific quirks (OS differences, path issues)

Identify which skill needs evolving.

Build a JSON structure in memory:

```json
{
  "preferences": ["user prefers silent download by default"],
  "fixes": ["on Windows, ffmpeg path needs backslash escaping"],
  "custom_prompts": "always print estimated time before starting"
}
```

Fields:
- `preferences` — user workflow preferences (list, deduplicated)
- `fixes` — known bugs, workarounds, env-specific patches (list, deduplicated)
- `custom_prompts` — persistent instruction injection (string, overwrites previous)

### 2. Persist to evolution.json

```bash
python scripts/merge_evolution.py <skill_dir> '<json_string>'
```

Merges new data into `<skill_dir>/evolution.json` with deduplication on list fields.

### 3. Stitch into SKILL.md

```bash
python scripts/smart_stitch.py <skill_dir>
```

Writes or updates a `## User-Learned Best Practices & Constraints` section at the end of SKILL.md. This section survives skill upgrades because it's in a dedicated marked block.

### 4. Post-Upgrade Realignment

After `skill-manager` updates a skill (which replaces SKILL.md), re-stitch all stored experience:

```bash
python scripts/align_all.py <skills_root_dir>
```

Traverses all skill folders, re-applies any existing `evolution.json` to the updated SKILL.md. Run this after any batch skill update.

**For Codex/CC users:** `<skills_root_dir>` defaults to `~/.claude/skills/` but can be any path — pass the actual location of your skills directory.

## Important Rules

- **Never directly edit** the `## User-Learned Best Practices & Constraints` section in SKILL.md — it will be overwritten by `smart_stitch.py`. All changes must go through `evolution.json`.
- If a conversation touches multiple skills, run the full workflow for each skill separately.
- The `evolution.json` file is the source of truth; SKILL.md section is derived from it.

## Multi-Skill Session

When one session uses several skills, after the session:
1. List all skills used
2. For each skill, extract relevant experience
3. Run `merge_evolution.py` + `smart_stitch.py` per skill
