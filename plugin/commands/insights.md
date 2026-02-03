---
description: Show detected behavioral patterns and growth insights
---
Read ~/.claude_profile.yaml and display the user's detected patterns and growth data.

Display:
1. growth.patterns — each pattern with its type, summary, confidence, and detection date
2. growth.zone_history — recent zone sequence (C=Comfort, S=Stretch, P=Panic)
3. growth.reflections_answered and growth.reflections_skipped counts
4. If no patterns exist yet, say: "No patterns detected yet. Keep using MetaMe and patterns will emerge after ~5 sessions."
