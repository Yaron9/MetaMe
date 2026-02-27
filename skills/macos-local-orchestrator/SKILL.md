---
name: macos-local-orchestrator
description: |
  macOS 本地自动化编排与能力融合。通过 Bash + osascript/JXA + Shortcuts + launchd
  实现自然语言电脑管家，并在需要时编排 Hammerspoon、AeroSpace、yabai/skhd、
  Raycast Script Commands、Keyboard Maestro 等第三方工具。适用于应用控制、系统控制、
  权限引导、窗口管理、快捷操作、定时任务与桌面自动化场景。
---

# macOS Local Orchestrator

Use local deterministic automation on macOS with minimal token usage.

## Execution Policy

1. Prefer local deterministic tools first: `Bash` + `osascript`/JXA.
2. Prefer built-in macOS capabilities before third-party tools.
3. Avoid screenshot/visual workflows unless user explicitly asks for them.
4. Classify every request before execution:
   - Read/query action: execute directly.
   - Side-effect action: show a short preview and ask for explicit confirmation first.
5. Keep output short: success/failure + key result only.

## Capability Ladder

### L0 Native (default)

Use these first because they are stable and dependency-free:
- `osascript` AppleScript/JXA for app/system control
- `open` and `x-apple.systempreferences:` for settings navigation
- `shortcuts` CLI for reusable workflows
- `launchctl` + `~/Library/LaunchAgents` for scheduled/background jobs
- `pmset` for power scheduling

### L1 Optional Integrations (when user already has them)

Detect tool availability and then use:
- `AeroSpace` for tiling/workspace (SIP-friendly, CLI-first)
- `yabai` + `skhd` for advanced window + hotkey control
- `Hammerspoon` for event-driven automation (`~/.hammerspoon/init.lua`)
- `Raycast` Script Commands / Deeplinks for launcher workflows
- `Keyboard Maestro` CLI trigger for mature macro pipelines

Do not force-install tools automatically unless user explicitly requests installation.

## Tool Selection Rules

1. If user asks app open/quit, volume, lock/sleep, permissions: use `osascript` first.
2. If user asks reusable multi-step workflow: prefer `shortcuts run`.
3. If user asks scheduled recurring action: prefer `launchd` or `pmset`.
4. If user asks keyboard-first window tiling:
   - Prefer `AeroSpace` if installed.
   - Else use `yabai/skhd` if installed.
   - Else fallback to native scripting and explain capability limits.
5. If user asks event-driven desktop reactions (wifi change, battery alerts, app watcher): use `Hammerspoon` if installed.
6. If user already uses Raycast/Keyboard Maestro ecosystem, integrate by calling their commands instead of rebuilding features.

For ecosystem-level tool tradeoffs and install decisions, read:
`references/tooling-landscape.md`

## Side-Effect Confirmation Rules

Require confirmation before any action that changes state, including:
- Sending email, creating/deleting/modifying calendar events
- Quitting apps, system sleep, lock screen
- Writing/moving/deleting files or folders
- Any command with unclear scope or risk

Use this confirmation template:
- `准备执行：<one-line action>`
- `命令：<exact command>`
- `请回复“确认执行”后继续。`

## Native Command Patterns

Open app:

```bash
osascript -e 'tell application "WeChat" to activate'
```

Quit app:

```bash
osascript -e 'tell application "WeChat" to quit'
```

Set volume:

```bash
osascript -e 'set volume output volume 35'
```

Mute / unmute:

```bash
osascript -e 'set volume with output muted'
osascript -e 'set volume without output muted'
```

Lock screen:

```bash
osascript -e 'tell application "System Events" to keystroke "q" using {control down, command down}'
```

Sleep:

```bash
osascript -e 'tell application "System Events" to sleep'
```

Open permissions/settings:

```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
```

Run shortcut:

```bash
shortcuts list
shortcuts run "My Shortcut"
shortcuts run "My Shortcut" -i ~/Desktop/input.txt -o ~/Desktop/output.txt
```

Create/refresh LaunchAgent job:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.metame.task.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.metame.task.plist
launchctl print gui/$(id -u)/com.metame.task
```

Power schedule:

```bash
pmset -g sched
sudo pmset repeat wake M 08:00:00
sudo pmset repeat cancel
```

## Optional Tool Patterns

AeroSpace (if installed):

```bash
aerospace list-workspaces --all
aerospace focus-workspace 2
aerospace move-node-to-workspace 2
```

yabai/skhd (if installed):

```bash
yabai -m query --windows --window
yabai -m window --focus east
skhd --reload
```

Keyboard Maestro CLI (if installed):

```bash
ls "/Applications/Keyboard Maestro.app/Contents/MacOS" 2>/dev/null
```

## Error Handling

1. If command output is empty for successful action, report as `已执行` (not `no output`).
2. If permission is missing, explain which permission is required and guide user to open the corresponding settings page, then retry.
3. If app name is ambiguous, ask a clarification question before executing.
4. If requested third-party tool is missing, provide:
   - current state (`未检测到 <tool>`)
   - minimal install command (only when user asks to install)
   - immediate native fallback plan.

## Permission Checklist

- Automation: Privacy & Security -> Automation
- Accessibility: Privacy & Security -> Accessibility
- Screen & System Audio Recording (only if screen pipeline is explicitly needed)
- Full Disk Access (only for file-heavy operations)

Permission onboarding commands:

```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
```
