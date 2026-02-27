#!/usr/bin/env python3
import argparse
import os
import re
import sys
from pathlib import Path

import yaml

START_MARKER = "<!-- AUTO-SKILL-INDEX:START -->"
END_MARKER = "<!-- AUTO-SKILL-INDEX:END -->"


def parse_frontmatter(skill_md_path: Path):
    try:
        text = skill_md_path.read_text(encoding="utf-8")
    except Exception:
        return None, None

    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return None, None

    try:
        meta = yaml.safe_load(m.group(1)) or {}
    except Exception:
        return None, None

    name = str(meta.get("name") or "").strip()
    desc = str(meta.get("description") or "").strip()
    return name, desc


def short_desc(text: str, limit: int = 72):
    clean = re.sub(r"\s+", " ", text).strip()
    if len(clean) <= limit:
        return clean
    return clean[: limit - 3] + "..."


def table_escape(text: str):
    return text.replace("|", "\\|")


def source_label(root: Path):
    s = str(root)
    if "/.claude/" in s:
        return "claude"
    if "/.opencode/" in s:
        return "opencode"
    return root.name or "local"


def collect_skills(roots):
    skills = {}
    for root in roots:
        if not root.exists() or not root.is_dir():
            continue
        src = source_label(root)
        for entry in sorted(root.iterdir(), key=lambda p: p.name.lower()):
            if entry.name.startswith("."):
                continue
            if not entry.is_dir():
                continue
            skill_md = entry / "SKILL.md"
            if not skill_md.exists():
                continue
            name, desc = parse_frontmatter(skill_md)
            if not name:
                name = entry.name
            if name in skills:
                continue
            skills[name] = {
                "source": src,
                "desc": short_desc(desc or "No description"),
            }
    return skills


def render_table(skills):
    lines = [
        "| Skill 名 | 来源 | 描述摘要 |",
        "|---|---|---|",
    ]
    for name in sorted(skills.keys(), key=str.lower):
        item = skills[name]
        lines.append(
            f"| `{table_escape(name)}` | {table_escape(item['source'])} | {table_escape(item['desc'])} |"
        )
    return "\n".join(lines)


def inject_table(skill_md_path: Path, table_md: str):
    text = skill_md_path.read_text(encoding="utf-8")
    block = f"{START_MARKER}\n{table_md}\n{END_MARKER}"

    if START_MARKER in text and END_MARKER in text:
        pattern = re.compile(
            re.escape(START_MARKER) + r".*?" + re.escape(END_MARKER),
            re.DOTALL,
        )
        new_text = pattern.sub(block, text)
    else:
        append = (
            "\n\n## 已注册技能清单（自动生成）\n\n"
            "由 `scripts/sync_index.py` 维护，请勿手工编辑该区块。\n\n"
            f"{block}\n"
        )
        new_text = text + append

    skill_md_path.write_text(new_text, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(
        description="Scan skills folders and sync auto-generated skill index section in SKILL.md."
    )
    parser.add_argument(
        "--skill-md",
        required=True,
        help="Path to skill-manager SKILL.md to update.",
    )
    parser.add_argument(
        "roots",
        nargs="+",
        help="Skill root folders to scan (e.g. ~/.claude/skills ~/.opencode/skills).",
    )
    args = parser.parse_args()

    skill_md_path = Path(os.path.expanduser(args.skill_md)).resolve()
    roots = [Path(os.path.expanduser(r)).resolve() for r in args.roots]

    if not skill_md_path.exists():
        print(f"[ERROR] skill markdown not found: {skill_md_path}")
        sys.exit(1)

    skills = collect_skills(roots)
    table_md = render_table(skills)
    inject_table(skill_md_path, table_md)
    print(f"[OK] synced {len(skills)} skills into {skill_md_path}")


if __name__ == "__main__":
    main()
