#!/usr/bin/env bash
# device-chat-probe.sh — assert a real send/receive round trip: type a
# message through the actual MessageInput UI, and confirm both the sent
# bubble and a genuine assistant reply appear in the transcript.
#
# Targets the emulator (127.0.0.1:5555) by default; override with
# CCPET_DEVICE_TARGET for a real device. Never touches the operator's real
# server or token -- this probe clears the target's app data and logs in
# fresh against a throwaway local server + bridge fixture it starts itself,
# so it can control (and therefore actually verify) what comes back.
#
# What this actually asserts, and why: the brief's original wording asked for
# a hilog grep for 'stream-delta'/'stream-done'. Those are WS_EVENTS *protocol
# event names* (see entry/src/main/ets/model/Protocol.ets /
# packages/server/src/index.ts's WS_EVENTS) -- frames that travel over the
# socket, not strings this app ever hilog.info()'s (grep entry/src/main/ets
# for either literal string -- nothing). A probe that grepped device logs for
# them would either hang or falsely PASS on an unrelated substring match.
# Instead this probe reads real on-device UI state via `uitest`: it types a
# message, taps Send, and asserts the transcript (MessageList) actually shows
# both the sent text and the fixture's echoed reply -- which can only appear
# once bridge:stream-delta/bridge:stream-done have genuinely round-tripped
# through ConnectionGateway and ChatStore.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_NAME="device-chat-probe"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ccpet-chat-probe.XXXXXX")"
LAYOUT="$WORKDIR/layout.json"

cleanup() {
  local ec=$?
  stop_fixture_stack
  rm -rf "$WORKDIR"
  exit "$ec"
}
trap cleanup EXIT

require_hdc_and_target
ensure_screen_awake_and_unlocked "$LAYOUT"

SERVER_PORT="${CCPET_PROBE_SERVER_PORT:-19311}"
BRIDGE_PORT="${CCPET_PROBE_BRIDGE_PORT:-19312}"
MESSAGE="probe-chat-$$-$RANDOM"
EXPECTED_REPLY="probe-echo: $MESSAGE"

start_fixture_stack "$SERVER_PORT" "$BRIDGE_PORT" 150
ensure_rport "$SERVER_PORT"

reset_app_state
launch_app
perform_login "http://127.0.0.1:$SERVER_PORT" "$FIXTURE_TOKEN" "$LAYOUT"
# A fresh install can show the one-time notification-permission system
# dialog right as ChatWindow mounts, which overlays (and hides from
# uitest) the chat screen just filled in by perform_login. Clear it if
# present so it can't intermittently hide MessageInput from the next step.
grant_notification_permission_if_present "$LAYOUT"

dump_layout "$LAYOUT"
xy="$(ui_query "$LAYOUT" hint '输入消息')" || fail "MessageInput text field not found on the chat screen"
ui_tap "$xy"
ui_type_at "$xy" "$MESSAGE"

dump_layout "$LAYOUT"
send_xy="$(ui_query "$LAYOUT" text '发送')" || fail "发送 (Send) button not found after typing a message"
ui_tap "$send_xy"

hdc_ shell uitest uiInput keyEvent Back >/dev/null || true   # dismiss IME so the transcript is dumpable

chat_round_trip_visible() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_contains "$LAYOUT" "$MESSAGE" && ui_contains "$LAYOUT" "$EXPECTED_REPLY"
}

if ! wait_until 15 1 chat_round_trip_visible; then
  fail "sent '$MESSAGE' but the transcript never showed both the sent message and the reply" \
       " '$EXPECTED_REPLY' within 15s -- dumped layout at $LAYOUT"
fi

pass "sent '$MESSAGE', transcript shows it plus the real reply '$EXPECTED_REPLY' round-tripped through the actual server"
