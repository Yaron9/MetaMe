---
description: Stop the MetaMe daemon
---
Stop the running MetaMe daemon process.

Steps:
1. Check if ~/.metame/daemon.pid exists
   - If not, say "No daemon running (no PID file)"

2. Read the PID from the file

3. Send SIGTERM to stop gracefully:
   ```bash
   kill <pid>
   ```

4. Wait up to 3 seconds for it to stop

5. If still running, force kill:
   ```bash
   kill -9 <pid>
   ```

6. Remove the PID file

7. Report: "✅ Daemon stopped (PID: xxx)"
