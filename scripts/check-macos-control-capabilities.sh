#!/usr/bin/env bash
set -u
set -o pipefail

PASS=0
FAIL=0
WARN=0

print_line() {
  printf '%s\n' "$1"
}

run_check() {
  local name="$1"
  local mode="$2"
  local cmd="$3"

  local output
  output="$(bash -o pipefail -lc "$cmd" 2>&1)"
  local code=$?

  if [ "$mode" = "pass_on_zero" ]; then
    if [ $code -eq 0 ]; then
      PASS=$((PASS + 1))
      print_line "[PASS] $name"
      [ -n "$output" ] && print_line "  $output"
    else
      FAIL=$((FAIL + 1))
      print_line "[FAIL] $name"
      [ -n "$output" ] && print_line "  $output"
    fi
    return
  fi

  if [ "$mode" = "warn_on_nonzero" ]; then
    if [ $code -eq 0 ]; then
      PASS=$((PASS + 1))
      print_line "[PASS] $name"
      [ -n "$output" ] && print_line "  $output"
    else
      WARN=$((WARN + 1))
      print_line "[WARN] $name"
      [ -n "$output" ] && print_line "  $output"
    fi
    return
  fi

  FAIL=$((FAIL + 1))
  print_line "[FAIL] $name"
  print_line "  invalid mode: $mode"
}

print_line "MetaMe macOS control capability check"
print_line "Timestamp: $(date '+%Y-%m-%d %H:%M:%S %z')"
print_line ""

run_check "osascript binary available" "pass_on_zero" "which osascript"
run_check "AppleScript baseline" "pass_on_zero" "osascript -e 'return \"ok\"'"
run_check "Finder automation" "pass_on_zero" "osascript -e 'tell application \"Finder\" to get name of startup disk'"
run_check "System Events accessibility" "pass_on_zero" "osascript -e 'tell application \"System Events\" to get UI elements enabled'"
run_check "GUI app launch/control (Calculator)" "pass_on_zero" "open -a Calculator >/dev/null 2>&1; sleep 1; osascript -e 'tell application \"System Events\" to tell process \"Calculator\" to return {frontmost, (count of windows)}'; osascript -e 'tell application \"Calculator\" to quit' >/dev/null 2>&1"

SHOT_PATH="/tmp/metame_gui_test_$$.png"
run_check "Screenshot capability (screencapture)" "pass_on_zero" "screencapture -x '$SHOT_PATH' && ls -lh '$SHOT_PATH'"
rm -f "$SHOT_PATH" >/dev/null 2>&1

run_check "Full Disk probe: read ~/Library/Mail" "warn_on_nonzero" "ls '$HOME/Library/Mail' | head -n 3"
run_check "Full Disk probe: query Safari History.db" "warn_on_nonzero" "sqlite3 '$HOME/Library/Safari/History.db' 'select count(*) from history_items;'"

print_line ""
print_line "Summary: pass=$PASS warn=$WARN fail=$FAIL"

if [ $FAIL -gt 0 ]; then
  exit 1
fi

exit 0
