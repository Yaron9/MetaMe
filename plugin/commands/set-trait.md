---
description: Set a specific profile field (e.g. /metame:set-trait status.focus "Learning Rust")
---
Parse "$ARGUMENTS" as "key value" and update ~/.claude_profile.yaml accordingly.

Rules:
- The first word is the dotted key path (e.g. status.focus, preferences.code_style)
- Everything after the key is the value
- Respect [LOCKED] fields — refuse to modify any field on a line containing # [LOCKED]
- Validate enum fields against their allowed values
- After updating, confirm the change: "Set `key` = value"
