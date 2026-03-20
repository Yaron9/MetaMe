# Skill Creation Guide

## Step 1: Understand the Skill with Concrete Examples

Skip only when usage patterns are already clearly understood.

To create an effective skill, understand concrete examples of how it will be used. Ask:
- "What functionality should this skill support?"
- "Can you give examples of how this skill would be used?"
- "What would a user say to trigger this skill?"

Avoid asking too many questions at once. Conclude when the functionality scope is clear.

## Step 2: Plan Reusable Skill Contents

Analyze each example:
1. How to execute it from scratch
2. What scripts, references, and assets would help when repeating it

| Example task | What to bundle |
|---|---|
| "Rotate this PDF" | `scripts/rotate_pdf.py` |
| "Build me a todo app" | `assets/hello-world/` boilerplate |
| "How many users logged in today?" | `references/schema.md` |

## Step 3: Initialize the Skill

For new skills, always run `init_skill.py`:

```bash
python scripts/init_skill.py <skill-name> --path <output-directory>
```

Creates: skill directory, SKILL.md template, example `scripts/`, `references/`, `assets/`.

Skip if iterating on an existing skill.

## Step 4: Edit the Skill

You are writing for another Claude instance. Include non-obvious procedural knowledge.

### Frontmatter

Required fields only:
- `name`: skill name
- `description`: primary trigger mechanism — include what the skill does AND when to use it. Put ALL "when to use" info here (body is only loaded after triggering). Set `needs_browser: true` if Playwright MCP is required.

Do not add other frontmatter fields.

### Body

- Use imperative/infinitive form
- Keep under 500 lines — split larger content into references files
- Only include info Claude doesn't already have
- Move detailed reference material to `references/` files, link from SKILL.md
- See `workflows.md` for sequential/conditional workflow patterns
- See `output-patterns.md` for template and example patterns

### Resource Guidelines

**scripts/** — when the same code is rewritten repeatedly or deterministic reliability is needed. Always test scripts by running them.

**references/** — documentation to load as needed. For files >10k words, include grep patterns in SKILL.md. Keep SKILL.md lean; detail lives here.

**assets/** — files used in output (templates, images, fonts, boilerplate). Not loaded into context.

**Do NOT include:** README.md, INSTALLATION_GUIDE.md, CHANGELOG.md, or any auxiliary docs.

## Step 5: Package the Skill

```bash
python scripts/package_skill.py <path/to/skill-folder>
# Optional: specify output dir
python scripts/package_skill.py <path/to/skill-folder> ./dist
```

Validates then creates a `.skill` file (zip with .skill extension). Fix any validation errors before packaging.

**For Codex/CC users distributing skills:**
- Package produces a `.skill` file ready for `skill-manager` install
- Host on GitHub for others to discover via `skill-scout`
- The `.skill` format is portable — no path assumptions about `~/.claude/skills/`

## Step 6: Iterate

After real usage, notice struggles and inefficiencies, then update SKILL.md or bundled resources.

## Step 7: Evaluate & Optimize (Advanced)

### Skill Evals

Define test cases in SKILL.md to verify skill effectiveness:

```markdown
## Evals

| Input | Expected behavior | Success criteria |
|---|---|---|
| "Rotate this PDF" | calls rotate_pdf.py | file output succeeds |
| "Extract page 3 text" | calls extract_text.py | returns text content |
```

Re-validate after each modification.

### A/B Testing

Run two skill versions in parallel. Compare: output quality, token cost, trigger accuracy. Use before/after major changes (rewriting description, restructuring workflow). Keep the better version.

### Trigger Optimization

Analyze the `description` field for:
- **False triggers**: unrelated tasks triggering this skill
- **Missed triggers**: related tasks not triggering
- **Ambiguity**: unstable triggering due to vague description

Fix by adding concrete trigger examples to description. Explicitly exclude easily-confused scenarios with "Do NOT trigger when...".
