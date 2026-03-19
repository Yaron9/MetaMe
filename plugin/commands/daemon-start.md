---
description: Start the MetaMe daemon (Telegram/Feishu bot)
---
Start the MetaMe daemon process.

Steps:
1. Check if ~/.metame/daemon.yaml exists
   - If not, tell user to run /metame:daemon-init first

2. Check if daemon is already running (check ~/.metame/daemon.pid)
   - If running, say "Daemon already running (PID: xxx)"

3. Start the daemon (macOS uses launchd for auto-restart):
   ```bash
   # macOS — delegates to launchd (auto-restart on crash/reboot)
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.metame.npm-daemon.plist 2>/dev/null
   launchctl kickstart gui/$(id -u)/com.metame.npm-daemon

   # Other platforms — direct spawn
   node ~/.metame/daemon.js &
   ```

4. Wait 2 seconds, then verify it started by checking the PID file

5. Report success: "Daemon started (PID: xxx)"
   - Mention: "Logs: ~/.metame/daemon.log"
   - Mention: "Stop: /metame:daemon-stop"
