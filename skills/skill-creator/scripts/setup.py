#!/usr/bin/env python3
"""
skill-creator setup — auto-configures auto-evolution hook.

Detects platform (Claude Code or OpenAI Codex CLI) and installs accordingly.
Idempotent: safe to run multiple times.

  python3 ~/.claude/skills/skill-creator/scripts/setup.py   # CC
  python3 ~/.codex/skills/skill-creator/scripts/setup.py    # Codex
"""

import json
import os
import sys

CLAUDE_DIR = os.path.expanduser('~/.claude')
CODEX_DIR = os.path.expanduser('~/.codex')


def get_hook_path():
    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(scripts_dir, 'auto_evolve_hook.js')


def detect_platform():
    """Detect whether running under Claude Code or OpenAI Codex CLI."""
    # Prefer whichever directory contains the installed skill-creator
    hook = get_hook_path()
    if CLAUDE_DIR in hook or os.path.exists(os.path.join(CLAUDE_DIR, 'settings.json')):
        return 'cc'
    if CODEX_DIR in hook or os.path.exists(os.path.join(CODEX_DIR, 'config.toml')):
        return 'codex'
    # Fallback: check which dirs exist
    if os.path.exists(CLAUDE_DIR):
        return 'cc'
    if os.path.exists(CODEX_DIR):
        return 'codex'
    return 'cc'  # default


# ── Claude Code ───────────────────────────────────────────────────────────────

def cc_is_installed(hook_path):
    settings_file = os.path.join(CLAUDE_DIR, 'settings.json')
    if not os.path.exists(settings_file):
        return False
    try:
        with open(settings_file, 'r', encoding='utf-8') as f:
            s = json.load(f)
        for group in s.get('hooks', {}).get('Stop', []):
            for h in group.get('hooks', []):
                if hook_path in h.get('command', ''):
                    return True
    except Exception:
        pass
    return False


def cc_install(hook_path):
    settings_file = os.path.join(CLAUDE_DIR, 'settings.json')
    os.makedirs(CLAUDE_DIR, exist_ok=True)
    settings = {}
    if os.path.exists(settings_file):
        try:
            with open(settings_file, 'r', encoding='utf-8') as f:
                settings = json.load(f)
        except Exception:
            pass
    hooks = settings.setdefault('hooks', {})
    hooks.setdefault('Stop', []).append({
        'hooks': [{'type': 'command', 'command': f'node "{hook_path}"'}]
    })
    with open(settings_file, 'w', encoding='utf-8') as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write('\n')


# ── OpenAI Codex CLI ──────────────────────────────────────────────────────────

def codex_is_installed(hook_path):
    config_file = os.path.join(CODEX_DIR, 'config.toml')
    if not os.path.exists(config_file):
        return False
    with open(config_file, 'r', encoding='utf-8') as f:
        return 'auto_evolve_hook' in f.read()


def codex_install(hook_path):
    """
    Codex uses config.toml + notify hook (fires on agent-turn-complete).
    Note: Codex notify does NOT pass transcript data — evolution runs in
    signal-only mode (tool failures captured per-turn, no Haiku analysis).
    """
    config_file = os.path.join(CODEX_DIR, 'config.toml')
    os.makedirs(CODEX_DIR, exist_ok=True)
    entry = f'\n# skill-creator: auto-evolution hook (fires on agent-turn-complete)\nnotify = ["node", "{hook_path}", "--codex"]\n'
    with open(config_file, 'a', encoding='utf-8') as f:
        f.write(entry)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    hook_path = get_hook_path()

    if not os.path.exists(hook_path):
        print(f'Error: hook script not found at:\n  {hook_path}', file=sys.stderr)
        print('Make sure skill-creator is fully installed.', file=sys.stderr)
        sys.exit(1)

    platform = detect_platform()

    if platform == 'cc':
        if cc_is_installed(hook_path):
            print('✓ Auto-evolve hook already configured (Claude Code). Nothing to do.')
            return
        cc_install(hook_path)
        has_key = bool(os.environ.get('ANTHROPIC_API_KEY'))
        print('✓ Auto-evolve hook installed (Claude Code).')
        print(f'  Config: ~/.claude/settings.json → Stop hook')
        if has_key:
            print('  Mode: Haiku-powered analysis (ANTHROPIC_API_KEY detected)')
        else:
            print('  Mode: Rule-based signal capture')
            print('  Tip: Set ANTHROPIC_API_KEY to enable Haiku-powered experience analysis.')
        print('  Skills evolve automatically at the end of each session.')

    else:  # codex
        if codex_is_installed(hook_path):
            print('✓ Auto-evolve hook already configured (Codex CLI). Nothing to do.')
            return
        codex_install(hook_path)
        print('✓ Auto-evolve hook installed (Codex CLI).')
        print(f'  Config: ~/.codex/config.toml → notify hook')
        print('  Mode: Signal capture per turn (Codex notify has no transcript access)')
        print('  Note: Full Haiku analysis not available on Codex — tool failures are')
        print('        recorded each turn and stitched into SKILL.md incrementally.')


if __name__ == '__main__':
    main()
