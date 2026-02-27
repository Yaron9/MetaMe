# macOS Automation Tooling Landscape (Fusion Notes)

## Goal

Map mature macOS automation ecosystems into one orchestration skill, with a native-first strategy.

## Native Foundation (Always Available)

1. AppleScript / JXA via `osascript`
   - Use for app control, system actions, and cross-app scripting.
2. Shortcuts CLI (`shortcuts`)
   - Use for reusable multi-step workflows and parameterized runs.
3. `launchd` / `launchctl`
   - Use for resilient user-level background tasks (`~/Library/LaunchAgents`).
4. `pmset`
   - Use for wake/sleep scheduling.
5. System Settings deep links (`x-apple.systempreferences:`)
   - Use for permission onboarding and recovery.

## Third-Party Integrations (Optional)

1. Hammerspoon
   - Best for event-driven automation and custom hotkey/event hooks.
   - Needs Accessibility permissions.
2. AeroSpace
   - Best for keyboard-first tiling workspace management.
   - CLI-oriented and SIP-friendly.
3. yabai + skhd
   - Best for advanced window tree manipulation + hotkey daemon.
   - Powerful but setup can be more complex than native/AeroSpace.
4. Raycast Script Commands
   - Best for launcher-style command catalog and human-triggered flows.
5. Keyboard Maestro
   - Best for mature macro workflows in GUI-heavy productivity use cases.

## Fusion Strategy

1. Keep one unified intent layer in `macos-local-orchestrator`.
2. Apply runtime detection:
   - If requested tool exists, use it.
   - If missing, fallback to native path and report gap briefly.
3. Keep confirmation gate for all side effects.
4. Prefer native fallback before introducing new dependencies.

## Source Links

- Apple: Mac Automation Scripting Guide  
  https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/
- Apple: `shortcuts` command-line docs  
  https://support.apple.com/guide/shortcuts-mac/command-line-interface-apd455c82f02/mac
- Apple: Launch daemons and agents  
  https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
- Apple: `pmset` usage  
  https://support.apple.com/en-sa/guide/mac-help/mchl40376151/mac
- Apple: Allow apps to control your Mac (Automation permission)  
  https://support.apple.com/en-vn/guide/mac-help/mchl108e1718/mac
- Apple: Allow accessibility apps to access your Mac  
  https://support.apple.com/en-kz/guide/mac-help/mh43185/mac
- Hammerspoon docs  
  https://www.hammerspoon.org/docs/
- AeroSpace repo/docs  
  https://github.com/nikitabobko/AeroSpace
- yabai repo/docs  
  https://github.com/koekeishiya/yabai
- skhd repo/docs  
  https://github.com/koekeishiya/skhd
- Raycast Script Commands  
  https://developers.raycast.com/information/lifecycle/script-commands
- Keyboard Maestro docs  
  https://wiki.keyboardmaestro.com
