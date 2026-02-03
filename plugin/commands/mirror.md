---
description: Toggle the metacognition mirror on or off
---
Parse "$ARGUMENTS" as "on" or "off" and update growth.mirror_enabled in ~/.claude_profile.yaml.

Steps:
1. Read ~/.claude_profile.yaml
2. If argument is "on", set growth.mirror_enabled to true
3. If argument is "off", set growth.mirror_enabled to false
4. If argument is missing or invalid, show usage: "/metame:mirror on|off"
5. Confirm: "Mirror [enabled|disabled]."
