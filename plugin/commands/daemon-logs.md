---
description: Show recent daemon logs
---
Display the last 30 lines of the MetaMe daemon log.

Steps:
1. Check if ~/.metame/daemon.log exists
   - If not, say "No log file yet. Start the daemon first."

2. Read the last 30 lines of the log file

3. Display the logs, highlighting:
   - [INFO] in normal text
   - [ERROR] in a way that stands out
   - [WARN] warnings

4. If there are connection errors, suggest:
   - Check internet connection
   - Verify bot tokens are correct
   - Check if another instance is running (Telegram conflict)
