#!/usr/bin/env bash
# device-session-panel-probe.sh — assert the session panel (Task 8) really
# lists, creates and deletes SESSIONS, not one row per bridge.
#
# Targets the emulator (127.0.0.1:5555) by default; override with
# CCPET_DEVICE_TARGET for a real device. Never touches the operator's real
# server or token -- it clears the target's app data and logs in fresh
# against a throwaway local server + bridge fixture it starts itself.
#
# Only the COMPACT breakpoint (SessionSheet) is exercised, because only the
# COMPACT breakpoint has ever been reachable on this project's emulator --
# see the honesty note in harmony/README.md. `SessionSidebar` renders the
# same rows through the same `SessionRow.ets` helpers, but this probe does
# not and cannot claim to have watched it.
#
# What it asserts, in order:
#   1. the sheet opens and offers 新建会话 even with no sessions yet;
#   2. creating twice leaves TWO sessions under ONE connection -- one under
#      「当前会话」 and one under「最近会话」 (the defect this phase exists to
#      fix was that a connection could only ever show one row);
#   3. tapping a 最近会话 row really switches to it -- it moves up into the
#      「当前会话」 section and the one it replaced drops into「最近会话」;
#   4. a first tap on a row's ✕ arms it (「确认删除」) rather than deleting;
#   5. closing and reopening the panel DISARMS it -- the reset that stops a
#      stray second tap deleting something the user never armed;
#   6. arming and confirming actually removes that session's row.
# Screenshots of steps 2 and 3 are saved next to $CCPET_PROBE_SHOT (default:
# the probe's temp dir; both paths are printed on PASS).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_NAME="device-session-panel-probe"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ccpet-session-panel-probe.XXXXXX")"
LAYOUT="$WORKDIR/layout.json"
SHOT="${CCPET_PROBE_SHOT:-$WORKDIR/session-panel.jpeg}"
SHOT_ARMED="${SHOT%.jpeg}-armed.jpeg"

cleanup() {
  local ec=$?
  stop_fixture_stack
  rm -rf "$WORKDIR"
  exit "$ec"
}
trap cleanup EXIT

require_hdc_and_target
ensure_screen_awake_and_unlocked "$LAYOUT"

SERVER_PORT="${CCPET_PROBE_SERVER_PORT:-19331}"
BRIDGE_PORT="${CCPET_PROBE_BRIDGE_PORT:-19332}"

start_fixture_stack "$SERVER_PORT" "$BRIDGE_PORT" 150
ensure_rport "$SERVER_PORT"

reset_app_state
launch_app
perform_login "http://127.0.0.1:$SERVER_PORT" "$FIXTURE_TOKEN" "$LAYOUT"
grant_notification_permission_if_present "$LAYOUT"

# The COMPACT shell keeps the switcher behind the top bar's 会话 button.
# Exact match: 切换会话 (the sheet's own title) and 新建会话 both contain it.
open_sheet() {
  dump_layout "$LAYOUT"
  local xy
  xy="$(ui_query_exact "$LAYOUT" text '会话')" || fail "top bar 会话 button not found -- is this the COMPACT shell?"
  ui_tap "$xy"
  if ! wait_until 10 1 sheet_is_open; then
    fail "tapped 会话 but the session sheet never showed 新建会话 within 10s -- layout at $LAYOUT"
  fi
}

sheet_is_open() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_contains "$LAYOUT" '新建会话'
}

close_sheet() {
  hdc_ shell uitest uiInput keyEvent Back >/dev/null 2>&1 || true
  sleep 1
}

# Every session-<epoch> row label currently on screen, deduplicated. The
# labels are the session KEYS because nothing has set a server-side label --
# which is exactly why `SessionRow.rowLabel` must not fall back to the bridge
# name (every row would read 'ProbeBridge' and this count would be 1).
session_rows() {
  python3 - "$LAYOUT" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding='utf-8') as f:
    doc = json.load(f)
def walk(n):
    yield n.get('attributes', {})
    for c in n.get('children', []):
        yield from walk(c)
seen = []
for a in walk(doc):
    t = (a.get('text') or '').strip()
    if re.fullmatch(r'session-\d+', t) and t not in seen:
        seen.append(t)
print('\n'.join(seen))
PY
}


# The row label sitting between the 当前会话 and 最近会话 section titles --
# i.e. the session the panel is claiming is on screen. Read positionally
# because a layout dump carries bounds, not colours.
current_session_row() {
  python3 - "$LAYOUT" <<'PYROW'
import json, re, sys
with open(sys.argv[1], encoding='utf-8') as f:
    doc = json.load(f)
def walk(n):
    yield n.get('attributes', {})
    for c in n.get('children', []):
        yield from walk(c)
def top(a):
    m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', a.get('bounds', ''))
    return int(m.group(2)) if m else None
current_y = recent_y = None
rows = []
for a in walk(doc):
    t = (a.get('text') or '').strip()
    y = top(a)
    if y is None:
        continue
    if t == '当前会话':
        current_y = y
    elif t == '最近会话':
        recent_y = y
    elif re.fullmatch(r'session-\d+', t):
        rows.append((y, t))
if current_y is None:
    sys.exit(1)
limit = recent_y if recent_y is not None else 10 ** 9
for y, t in sorted(rows):
    if current_y < y < limit:
        print(t)
        sys.exit(0)
sys.exit(1)
PYROW
}

# ---------------------------------------------------------------------------
# 1. The sheet opens, and offers a way to create a session.
# ---------------------------------------------------------------------------
open_sheet
ui_contains "$LAYOUT" '新建会话' || fail "session sheet opened without a 新建会话 entry"

# ---------------------------------------------------------------------------
# 2. Create two sessions -> two rows under one connection.
# ---------------------------------------------------------------------------
create_session() {
  dump_layout "$LAYOUT"
  local xy
  xy="$(ui_query "$LAYOUT" text '新建会话')" || fail "新建会话 entry not found in the open sheet"
  ui_tap "$xy"
  sleep 2   # POST /api/sessions round trip, then the sheet closes itself
}

create_session
open_sheet
create_session
open_sheet

dump_layout "$LAYOUT"
ROWS="$(session_rows)"
ROW_COUNT="$(printf '%s\n' "$ROWS" | grep -c . || true)"
if (( ROW_COUNT < 2 )); then
  fail "created two sessions but the panel shows $ROW_COUNT session row(s): [${ROWS//$'\n'/, }]" \
       " -- a connection is still collapsing to a single row"
fi
ui_contains "$LAYOUT" '当前会话' || fail "panel lists $ROW_COUNT sessions but has no 当前会话 section"
ui_contains "$LAYOUT" '最近会话' || fail "panel lists $ROW_COUNT sessions but has no 最近会话 section"

# Screenshot the thing being claimed: more than one session under a
# connection. `snapshot_display`, not `snapshot` (see harmony/README.md).
grab_screenshot() {
  local dest="$1" remote
  remote="$(hdc_ shell snapshot_display -f /data/local/tmp/ccpet-session-panel.jpeg 2>&1 | tr -d '\r')"
  hdc_ file recv /data/local/tmp/ccpet-session-panel.jpeg "$dest" >/dev/null 2>&1 \
    || fail "could not pull a panel screenshot off the device ($remote)"
}
grab_screenshot "$SHOT"

# ---------------------------------------------------------------------------
# 3. Tapping a 最近会话 row switches to it.
# ---------------------------------------------------------------------------
BEFORE_CURRENT="$(current_session_row)" || fail "no session row under 当前会话 before switching"
RECENT_ROW="$(printf '%s\n' "$ROWS" | grep -v "^$BEFORE_CURRENT$" | head -1)"
[[ -n "$RECENT_ROW" ]] || fail "could not identify a 最近会话 row to switch to"
SWITCH_XY="$(ui_query "$LAYOUT" text "$RECENT_ROW")" || fail "row '$RECENT_ROW' vanished before it could be tapped"
ui_tap "$SWITCH_XY"
sleep 2
open_sheet
dump_layout "$LAYOUT"
AFTER_CURRENT="$(current_session_row)" || fail "no session row under 当前会话 after switching"
if [[ "$AFTER_CURRENT" != "$RECENT_ROW" ]]; then
  fail "tapped '$RECENT_ROW' but 当前会话 still shows '$AFTER_CURRENT' -- the switch did not take"
fi
ui_contains "$LAYOUT" "$BEFORE_CURRENT" || fail "'$BEFORE_CURRENT' disappeared from the panel after switching away from it"

# ---------------------------------------------------------------------------
# 4. First ✕ tap arms, it does not delete.
# ---------------------------------------------------------------------------
dump_layout "$LAYOUT"
DELETE_XY="$(ui_query "$LAYOUT" text '✕')" || fail "no ✕ delete control on any session row"
ui_tap "$DELETE_XY"
sleep 1
dump_layout "$LAYOUT"
ui_contains "$LAYOUT" '确认删除' || fail "first ✕ tap did not arm the row (no 确认删除 control appeared)"
grab_screenshot "$SHOT_ARMED"
ARMED_ROWS="$(session_rows)"
ARMED_COUNT="$(printf '%s\n' "$ARMED_ROWS" | grep -c . || true)"
if (( ARMED_COUNT != ROW_COUNT )); then
  fail "first ✕ tap changed the session list ($ROW_COUNT -> $ARMED_COUNT rows) -- it must only arm"
fi

# ---------------------------------------------------------------------------
# 5. Closing the panel disarms it.
# ---------------------------------------------------------------------------
close_sheet
open_sheet
dump_layout "$LAYOUT"
if ui_contains "$LAYOUT" '确认删除'; then
  fail "a row was still armed (确认删除) after closing and reopening the panel -- the armed state must reset"
fi

# ---------------------------------------------------------------------------
# 6. Arm + confirm really deletes.
# ---------------------------------------------------------------------------
dump_layout "$LAYOUT"
DELETE_XY="$(ui_query "$LAYOUT" text '✕')" || fail "no ✕ delete control after reopening the panel"
ui_tap "$DELETE_XY"
sleep 1
dump_layout "$LAYOUT"
CONFIRM_XY="$(ui_query "$LAYOUT" text '确认删除')" || fail "row did not arm on the second run"
ui_tap "$CONFIRM_XY"
sleep 2
dump_layout "$LAYOUT"
AFTER_ROWS="$(session_rows)"
AFTER_COUNT="$(printf '%s\n' "$AFTER_ROWS" | grep -c . || true)"
if (( AFTER_COUNT >= ROW_COUNT )); then
  fail "confirming the delete left $AFTER_COUNT session row(s) (was $ROW_COUNT): [${AFTER_ROWS//$'\n'/, }]"
fi

pass "panel listed $ROW_COUNT sessions under one connection ([${ROWS//$'\n'/, }]), switched to" \
     " '$RECENT_ROW' by tapping its row, armed then deleted one" \
     " (now $AFTER_COUNT), and disarmed on close. Screenshots: $SHOT and $SHOT_ARMED"
