---
description: Show daemon status and help
---
Check the MetaMe daemon status and show available commands.

Steps:
1. Check if ~/.metame/daemon.pid exists and if the process is running
2. Read ~/.metame/daemon_state.json for status info (if exists)
3. Display:
   - Running status (🟢 Running / 🔴 Stopped)
   - Connected adapters (Telegram, Feishu)
   - Budget usage (tokens used today)
   - Active sessions

4. Show available commands:
   - /metame:daemon-init — Configure Telegram/Feishu (first-time setup)
   - /metame:daemon-start — Start the daemon
   - /metame:daemon-stop — Stop the daemon
   - /metame:daemon-logs — Show recent logs
