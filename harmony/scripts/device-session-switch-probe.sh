#!/usr/bin/env bash
# device-session-switch-probe.sh — assert the three Task 9 behaviours that
# only a real device can show: switching session LOADS that session's history
# from the server, a session NAMES ITSELF from its first message, and the name
# comes back from the transcript after the server's own session list has
# overwritten it.
#
# Targets the emulator (127.0.0.1:5555) by default; override with
# CCPET_DEVICE_TARGET for a real device. Never touches the operator's real
# server or token -- it clears the target's app data and logs in fresh
# against a throwaway local server + bridge fixture it starts itself.
#
# Only the COMPACT breakpoint (SessionSheet) is exercised, for the same
# reason device-session-panel-probe.sh gives: COMPACT is the only breakpoint
# this project's emulator has ever reached.
#
# THE LOAD-BEARING TRICK is the app restart. Without it, seeing A's messages
# after switching back to A proves nothing -- they could still be sitting in
# `ChatStore` from when they were sent. After a force-stop the store is empty,
# and a cold start backfills ONLY `currentChatKey`, which this client lands on
# the bridge's `default` session (measured: the top bar reads the BRIDGE name,
# not a session label, and the transcript is blank -- `initPersistence`
# restores the per-connection session pointer but `Index`'s landing pick has
# already run by then). So neither created session is loaded, and if A's text
# appears after tapping A's row, the ONLY thing that can have put it there is
# the `ConnectionGateway.ensureHistory` call this task added to
# `SessionRow.selectSession`.
#
# What it asserts, in order:
#   1. a session created and then talked in renames itself to its first
#      message, truncated to web's 15 chars + '…' (`logic/autoTitle.ets`);
#   2. a session created AFTER that one opens with an empty transcript --
#      none of the previous session's text follows the switch;
#   3. after an app restart the app lands on the bridge's `default` session
#      with an EMPTY transcript -- neither created session's text is loaded;
#   4. tapping a session's row makes its history appear -> the switch really
#      fetched it from the server.
#
# Step 1 is a genuinely CLIENT-side assertion even though `packages/server`
# derives the same label itself (`storage/messages.ts`, same 15-char rule):
# the client only learns the server's copy from `/api/sessions`, which this
# client fetches on `bridge:manifest` and nowhere else, so no such fetch
# happens between the send and the assertion. The only thing that can put
# that title on screen mid-run is `SessionStore.touchSessionAutoTitle`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_NAME="device-session-switch-probe"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ccpet-session-switch-probe.XXXXXX")"
LAYOUT="$WORKDIR/layout.json"
SHOT="${CCPET_PROBE_SHOT:-$WORKDIR/session-switch.jpeg}"

cleanup() {
  local ec=$?
  stop_fixture_stack
  rm -rf "$WORKDIR"
  exit "$ec"
}
trap cleanup EXIT

require_hdc_and_target
ensure_screen_awake_and_unlocked "$LAYOUT"

SERVER_PORT="${CCPET_PROBE_SERVER_PORT:-19341}"
BRIDGE_PORT="${CCPET_PROBE_BRIDGE_PORT:-19342}"

# Both texts are deliberately LONGER than AUTO_SESSION_TITLE_MAX_LEN (15), so
# the auto-title is a string that can only ever be a LABEL: the transcript
# always shows the full text, never the truncated form. That is what lets
# `ui_contains` tell "the row is named after this message" apart from "this
# message is on screen" without reading bounds.
MSG_A='probe-alpha-message-one'
TITLE_A='probe-alpha-mes…'
MSG_B='probe-beta-message-two'
TITLE_B='probe-beta-mess…'

start_fixture_stack "$SERVER_PORT" "$BRIDGE_PORT" 150
ensure_rport "$SERVER_PORT"

reset_app_state
launch_app
perform_login "http://127.0.0.1:$SERVER_PORT" "$FIXTURE_TOKEN" "$LAYOUT"
grant_notification_permission_if_present "$LAYOUT"

sheet_is_open() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_contains "$LAYOUT" '新建会话'
}

open_sheet() {
  dump_layout "$LAYOUT"
  local xy
  xy="$(ui_query_exact "$LAYOUT" text '会话')" || fail "top bar 会话 button not found -- is this the COMPACT shell?"
  ui_tap "$xy"
  if ! wait_until 10 1 sheet_is_open; then
    fail "tapped 会话 but the session sheet never showed 新建会话 within 10s -- layout at $LAYOUT"
  fi
}

close_sheet() {
  hdc_ shell uitest uiInput keyEvent Back >/dev/null 2>&1 || true
  sleep 1
}

create_session() {
  open_sheet
  dump_layout "$LAYOUT"
  local xy
  xy="$(ui_query "$LAYOUT" text '新建会话')" || fail "新建会话 entry not found in the open sheet"
  ui_tap "$xy"
  sleep 3   # POST /api/sessions round trip, then the sheet closes itself
}

send_text() {
  local text="$1" xy
  dump_layout "$LAYOUT"
  xy="$(ui_query "$LAYOUT" hint '输入消息')" || fail "MessageInput not found when trying to send '$text'"
  ui_tap "$xy"
  ui_type_at "$xy" "$text"
  dump_layout "$LAYOUT"
  xy="$(ui_query "$LAYOUT" text '发送')" || fail "发送 button not found after typing '$text'"
  ui_tap "$xy"
  hdc_ shell uitest uiInput keyEvent Back >/dev/null 2>&1 || true   # dismiss IME
}

transcript_has() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_contains "$LAYOUT" "$1"
}

# The single row under 最近会话 -- the session that is NOT on screen. Read
# positionally (a layout dump carries bounds, not colours), the same way
# device-session-panel-probe.sh reads its 当前会话 row.
recent_session_row_xy() {
  python3 - "$LAYOUT" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding='utf-8') as f:
    doc = json.load(f)
def walk(n):
    yield n.get('attributes', {})
    for c in n.get('children', []):
        yield from walk(c)
def box(a):
    m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', a.get('bounds', ''))
    return tuple(int(g) for g in m.groups()) if m else None
recent_y = None
rows = []
for a in walk(doc):
    t = (a.get('text') or '').strip()
    b = box(a)
    if b is None:
        continue
    if t == '最近会话':
        recent_y = b[1]
    elif re.fullmatch(r'session-\d+', t):
        rows.append((b[1], (b[0] + b[2]) // 2, (b[1] + b[3]) // 2))
if recent_y is None:
    sys.exit(1)
for y, cx, cy in sorted(rows):
    if y > recent_y:
        print(f'{cx} {cy}')
        sys.exit(0)
sys.exit(1)
PY
}

grab_screenshot() {
  local dest="$1" remote
  remote="$(hdc_ shell snapshot_display -f /data/local/tmp/ccpet-session-switch.jpeg 2>&1 | tr -d '\r')"
  hdc_ file recv /data/local/tmp/ccpet-session-switch.jpeg "$dest" >/dev/null 2>&1 \
    || fail "could not pull a screenshot off the device ($remote)"
}

# ---------------------------------------------------------------------------
# 1. Session A: create it, talk in it, watch it name itself.
# ---------------------------------------------------------------------------
create_session
send_text "$MSG_A"
if ! wait_until 20 1 transcript_has "probe-echo: $MSG_A"; then
  fail "session A never round-tripped '$MSG_A' -- layout at $LAYOUT"
fi
if ! wait_until 10 1 transcript_has "$TITLE_A"; then
  fail "sent '$MSG_A' in a brand-new session but nothing on screen reads '$TITLE_A'" \
       " -- the send-time auto-title never ran"
fi

# ---------------------------------------------------------------------------
# 2. Session B: created after A, must open clean.
# ---------------------------------------------------------------------------
create_session
dump_layout "$LAYOUT"
if ui_contains "$LAYOUT" "probe-echo: $MSG_A"; then
  fail "a session created after A opened showing A's transcript -- residue followed the switch"
fi

send_text "$MSG_B"
if ! wait_until 20 1 transcript_has "probe-echo: $MSG_B"; then
  fail "session B never round-tripped '$MSG_B' -- layout at $LAYOUT"
fi

# ---------------------------------------------------------------------------
# 3. Cold restart: ChatStore is empty and the landing pick loads nothing.
# ---------------------------------------------------------------------------
hdc_ shell aa force-stop "$BUNDLE_NAME" >/dev/null 2>&1 || true
sleep 2
launch_app
if ! wait_until 30 1 transcript_has '已连接'; then
  fail "the app never got back to a connected chat screen after the restart -- layout at $LAYOUT"
fi
dump_layout "$LAYOUT"
if ui_contains "$LAYOUT" "$MSG_A" || ui_contains "$LAYOUT" "$MSG_B"; then
  fail "a created session's text is on screen right after a cold start -- this probe cannot then" \
       " tell a switch-triggered fetch from leftover state; the assumption it rests on is wrong"
fi

# ---------------------------------------------------------------------------
# 4. Switch to session A: its history must arrive from the server.
# ---------------------------------------------------------------------------
# Rows read the SERVER's own label here (`/api/sessions` ran on this run's
# manifest and `applySessions` replaced the local records), and the server
# derives the same title from the same first message -- so the row is still
# findable by $TITLE_A. With the transcript blank there is nothing else on
# screen carrying that string.
open_sheet
dump_layout "$LAYOUT"
ROW_XY="$(ui_query "$LAYOUT" text "$TITLE_A")" \
  || fail "no session row labelled '$TITLE_A' after the restart -- layout at $LAYOUT"
ui_tap "$ROW_XY"
sleep 1

if ! wait_until 20 1 transcript_has "probe-echo: $MSG_A"; then
  fail "switched to session '$TITLE_A' but its history never loaded (no '$MSG_A' within 20s)" \
       " -- ConnectionGateway.ensureHistory did not fire on the switch. Layout at $LAYOUT"
fi
grab_screenshot "$SHOT"

pass "a new session named itself '$TITLE_A' from its first message, a session created after it" \
     " opened clean, and after a full app restart (blank transcript) tapping that session's row" \
     " pulled its history ('$MSG_A') off the server. Screenshot: $SHOT"
