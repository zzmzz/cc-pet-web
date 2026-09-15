#!/usr/bin/env bash
# device-notification-probe.sh — assert that a reply arriving while the app
# is backgrounded produces a real system notification.
#
# Targets the emulator (127.0.0.1:5555) by default; override with
# CCPET_DEVICE_TARGET for a real device. Never touches the operator's real
# server -- clears the target's app data and logs in fresh against a
# throwaway local server + bridge fixture this probe starts itself.
#
# What this actually asserts, and why: the brief's original wording asked for
# a hilog grep for 'notifyReply'. NotificationGateway.notifyReply() (see
# entry/src/main/ets/gateway/NotificationGateway.ets) has no log statement on
# its success path at all -- only console.warn() on the two failure paths
# (permission request failed / publish() threw). So "grep for notifyReply"
# would either find nothing on the success path this probe wants to prove,
# or -- worse -- silently PASS by finding one of the *failure* warnings and
# treating any match as success. Instead this probe drives the real flow and
# reads real system state:
#   1. Logs in, grants the one-time "允许 cc-pet 向你发送通知？" system dialog
#      if it appears (a truly fresh install always shows this once; a
#      previously-granted device/emulator won't show it again, which is fine).
#   2. Sends a message, then backgrounds the app (Home) before the fixture's
#      (deliberately delayed) reply lands -- confirmed via the real
#      "Ability onBackground" hilog line from entryability/EntryAbility.ets.
#   3. Waits for the reply, then swipes open the real notification shade and
#      dumps its layout via `uitest` -- asserting the reply text is actually
#      there, not the empty-state "没有通知" label.
#
# Environment note found while building this probe: a bundle's
# "允许向你发送通知" decision is sticky at the OS level and survives both
# `bm clean -n <bundle> -d` (data-only clear) and a full uninstall+reinstall
# of the HAP -- so on an emulator where a prior task already declined it,
# this probe cannot itself flip that back to allowed. That is a real
# constraint of the platform, not a bug in this probe: if the notification
# never appears and hidumper/dumpLayout show the permission was never
# re-prompted, that is the correct diagnosis, and this probe fails loudly
# with that message rather than guessing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_NAME="device-notification-probe"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ccpet-notification-probe.XXXXXX")"
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

SERVER_PORT="${CCPET_PROBE_SERVER_PORT:-19331}"
BRIDGE_PORT="${CCPET_PROBE_BRIDGE_PORT:-19332}"
REPLY_DELAY_MS=2500
MESSAGE="probe-notif-$$-$RANDOM"
EXPECTED_REPLY="probe-echo: $MESSAGE"

start_fixture_stack "$SERVER_PORT" "$BRIDGE_PORT" "$REPLY_DELAY_MS"
ensure_rport "$SERVER_PORT"

reset_app_state
launch_app
perform_login "http://127.0.0.1:$SERVER_PORT" "$FIXTURE_TOKEN" "$LAYOUT"
grant_notification_permission_if_present "$LAYOUT"

dump_layout "$LAYOUT"
xy="$(ui_query "$LAYOUT" hint '输入消息')" || fail "MessageInput text field not found on the chat screen"
ui_tap "$xy"
ui_type_at "$xy" "$MESSAGE"

dump_layout "$LAYOUT"
send_xy="$(ui_query "$LAYOUT" text '发送')" || fail "发送 (Send) button not found after typing a message"
BACKGROUND_MARK="$(hdc_ shell date '+%H:%M:%S' 2>/dev/null | tr -d '\r\n')"
ui_tap "$send_xy"
hdc_ shell uitest uiInput keyEvent Home >/dev/null

went_to_background() {
  # Filtered server-side by hilogd (-T tag, -e regex) rather than piping the
  # whole buffer through grep -- after three prior probes' worth of logging
  # in the same session, an unfiltered `hilog -x` dump got slow/large enough
  # that this check could time out even though the line was really there.
  # Compares against $BACKGROUND_MARK (captured right before the Home press)
  # so a *stale* onBackground line from an earlier probe run in this same
  # session can't produce a false match.
  local last_ts
  last_ts="$(hdc_ shell hilog -x -T EntryAbility -e 'onBackground' 2>/dev/null | tail -1 | awk '{print $2}')"
  [[ -n "$last_ts" && "$last_ts" > "$BACKGROUND_MARK" ]]
}
if ! wait_until 10 1 went_to_background; then
  fail "pressed Home but never observed the real 'Ability onBackground' hilog line" \
       " (entryability/EntryAbility.ets) -- the app may not have actually backgrounded"
fi
echo "[$PROBE_NAME] confirmed real onBackground, waiting for the delayed reply to land while backgrounded..."

# Give the fixture's deliberately delayed reply (${REPLY_DELAY_MS}ms) time to
# actually arrive and be processed while the app sits in the background.
sleep "$(python3 -c "print($REPLY_DELAY_MS/1000 + 1.5)")"

dump_layout "$LAYOUT"
read -r SCREEN_W SCREEN_H < <(screen_size "$LAYOUT") || fail "could not read screen size from a layout dump"
MID_X=$(( SCREEN_W / 2 ))
hdc_ shell uitest uiInput swipe "$MID_X" 50 "$MID_X" "$(( SCREEN_H * 4 / 10 ))" 400 >/dev/null
sleep 1

notification_visible() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_contains "$LAYOUT" "$EXPECTED_REPLY"
}

if ! wait_until 8 1 notification_visible; then
  dump_layout_soft "$LAYOUT" || true
  if ui_contains "$LAYOUT" '没有通知'; then
    fail "background reply never produced a notification -- shade shows 没有通知 (no notifications)." \
         " If this device/emulator previously declined the '允许...向你发送通知' dialog, that decision" \
         " is sticky at the OS level (survives bm clean -d and reinstall) and must be re-granted by" \
         " hand once via Settings before this probe can pass here."
  fi
  fail "background reply never appeared in the notification shade within 8s (expected '$EXPECTED_REPLY')" \
       " -- dumped shade layout at $LAYOUT"
fi

# Leave the device in a neutral state (shade closed) for whatever runs next.
hdc_ shell uitest uiInput keyEvent Back >/dev/null 2>&1 || true

pass "backgrounded app received a reply and a real system notification containing '$EXPECTED_REPLY' appeared"
