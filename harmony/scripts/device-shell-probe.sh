#!/usr/bin/env bash
# device-shell-probe.sh — end-to-end check of the WebView shell: cold start on
# a wiped app, type a server address into the shell's own native setup screen,
# then log in and round-trip a message THROUGH THE WEB UI inside the WebView.
#
# This probe exists because the WebView-shell design doc (§8) predicted it
# could not: the feasibility spike reported that `uitest dumpLayout` sees zero
# text nodes inside a `Web` component and that coordinate taps cannot focus a
# web `<input>`. Measured against this shell on the emulator, BOTH are false.
# `dumpLayout` returns a full accessibility tree for the page (`rootWebArea`,
# `heading`, `paragraph`, `textField`, `button` — with text, hints and bounds),
# `uitest uiInput click` on a web `<input>`'s bounds focuses it and raises the
# soft keyboard, and `uitest uiInput text` commits into it verbatim. The whole
# flow below is therefore genuinely asserted, not eyeballed.
#
# Targets the emulator (127.0.0.1:5555) by default; override with
# CCPET_DEVICE_TARGET. Never touches the operator's real server or token: it
# wipes the target's app data and stands up its own throwaway server + bridge
# fixture with an invented token, exactly like the native-port probes did.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_NAME="device-shell-probe"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ccpet-shell-probe.XXXXXX")"
LAYOUT="$WORKDIR/layout.json"
SHOT="${CCPET_PROBE_SHOT:-$WORKDIR/shell-round-trip.jpeg}"

cleanup() {
  local ec=$?
  stop_fixture_stack
  rm -rf "$WORKDIR"
  exit "$ec"
}
trap cleanup EXIT

# `ui_type_at` fires the click and the text back to back, which is fine for a
# native TextInput but loses the first characters against a web `<input>`:
# ArkWeb attaches the IME to the focused DOM node asynchronously, and anything
# committed before that attach lands nowhere. One second of settle was enough
# on this emulator; measured, not guessed.
web_type_at() {
  local xy="$1" text="$2"
  hdc_ shell uitest uiInput click $xy >/dev/null
  sleep 1
  hdc_ shell uitest uiInput text "$text" >/dev/null
}

require_hdc_and_target
ensure_screen_awake_and_unlocked "$LAYOUT"

SERVER_PORT="${CCPET_PROBE_SERVER_PORT:-19411}"
BRIDGE_PORT="${CCPET_PROBE_BRIDGE_PORT:-19412}"
MESSAGE="probe-shell-$$-$RANDOM"
EXPECTED_REPLY="probe-echo: $MESSAGE"

start_fixture_stack "$SERVER_PORT" "$BRIDGE_PORT" 150
ensure_rport "$SERVER_PORT"

reset_app_state
launch_app

# --- the shell's own native screen (§4) -------------------------------------
setup_screen_visible() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_query "$LAYOUT" hint 'https://your-server' >/dev/null 2>&1
}
if ! wait_until 20 1 setup_screen_visible; then
  fail "the shell never showed its server-address screen after a data wipe" \
       " (looked for a TextInput with hint 'https://your-server')"
fi
dump_layout "$LAYOUT"
xy="$(ui_query "$LAYOUT" hint 'https://your-server')"
ui_type_at "$xy" "http://127.0.0.1:$SERVER_PORT"
# Dismiss the IME first: it shrinks the page and moves the button, and the
# bounds we are about to read must be the ones the tap will land on.
hdc_ shell uitest uiInput keyEvent Back >/dev/null
dump_layout "$LAYOUT"
xy="$(ui_query_exact "$LAYOUT" text '连接')" || fail "连接 button not found on the server-address screen"
ui_tap "$xy"

# --- inside the WebView: packages/web's own login (§2 — the shell must NOT
# --- own this; it only has to not break it) ---------------------------------
web_login_visible() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_query "$LAYOUT" hint '请输入 token' >/dev/null 2>&1
}
if ! wait_until 30 1 web_login_visible; then
  fail "the web app's token screen never appeared inside the WebView within 30s" \
       " -- the page either did not load or did not render"
fi
dump_layout "$LAYOUT"
xy="$(ui_query "$LAYOUT" hint '请输入 token')"
web_type_at "$xy" "$FIXTURE_TOKEN"
# `ui_query_exact`, NOT `ui_query`. Substring matching is far more dangerous
# against a web page than against native components: ArkWeb's accessibility
# tree exposes whole paragraphs as one node's `text`, and this login screen's
# body copy is '认证通过后才可进入会话界面。' — which contains '进入'. A
# substring query therefore returns the PARAGRAPH's bounds, and the probe
# taps the middle of a sentence forever while the button sits untouched 360px
# lower. Cost: three failed probe runs that looked like a timing problem.
dump_layout "$LAYOUT"
xy="$(ui_query_exact "$LAYOUT" text '进入')" || fail "进入 button not found on the web login screen"
ui_tap "$xy"

chat_visible() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_query "$LAYOUT" hint '输入消息' >/dev/null 2>&1
}
if ! wait_until 30 1 chat_visible; then
  fail "the web chat screen never appeared after submitting the fixture token"
fi

# --- a real send/receive round trip through the real server and bridge ------
dump_layout "$LAYOUT"
xy="$(ui_query "$LAYOUT" hint '输入消息')"
web_type_at "$xy" "$MESSAGE"
dump_layout "$LAYOUT"
# Exact match again: the composer's own placeholder is
# '输入消息，Enter 发送，Shift+Enter 换行', so '发送' is a substring of a hint
# and of the send button's label both.
xy="$(ui_query_exact "$LAYOUT" text '发送')" || fail "发送 button not found after typing a message"
ui_tap "$xy"

round_trip_visible() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_contains "$LAYOUT" "$MESSAGE" && ui_contains "$LAYOUT" "$EXPECTED_REPLY"
}
if ! wait_until 20 1 round_trip_visible; then
  fail "sent '$MESSAGE' from inside the WebView but the transcript never showed" \
       " both it and the reply '$EXPECTED_REPLY' within 20s"
fi

hdc_ shell snapshot_display -f /data/local/tmp/ccpet-shell-probe.jpeg >/dev/null 2>&1 || true
"$HDC_BIN" -t "$CCPET_DEVICE_TARGET" file recv /data/local/tmp/ccpet-shell-probe.jpeg "$SHOT" >/dev/null 2>&1 || true

pass "server address entered on the shell's native screen, packages/web loaded in the" \
     " WebView, logged in, and '$MESSAGE' round-tripped back as '$EXPECTED_REPLY' (screenshot: $SHOT)"
