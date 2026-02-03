---
description: Start the MetaMe daemon (Telegram/Feishu bot)
---
Start the MetaMe daemon process.

Steps:
1. Check if ~/.metame/daemon.yaml exists
   - If not, tell user to run /metame:daemon-init first

2. Check if daemon is already running (check ~/.metame/daemon.pid)
   - If running, say "Daemon already running (PID: xxx)"

3. Start the daemon:
   ```bash
   node ~/.metame/daemon.js &
   ```
   Or if using the plugin's bundled version:
   ```bash
   node <plugin-path>/scripts/daemon.js &
   ```

4. Wait 2 seconds, then verify it started by checking the PID file

5. Report success: "✅ MetaMe daemon started (PID: xxx)"
   - Mention: "Logs: ~/.metame/daemon.log"
   - Mention: "Stop: /metame:daemon-stop"
