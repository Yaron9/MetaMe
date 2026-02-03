---
description: Teach MetaMe a new insight about yourself
---
Record this insight to the user's cognitive profile at ~/.claude_profile.yaml:
"$ARGUMENTS"

Use the distill engine to determine the appropriate tier and field.
Rules:
- Read the current profile first
- Respect fields marked with # [LOCKED] — never modify those
- Add the insight as a timestamped entry under evolution.log
- If the insight clearly maps to a known field (e.g. "I prefer concise code" → preferences.code_style), update that field directly
- After updating, confirm what was changed
