#!/usr/bin/env bash
# device-reconnect-probe.sh — assert backoff and recovery: kill the server
# out from under a connected app, confirm the connection badge leaves
# "已连接" (connected), bring the server back, and confirm it recovers to
# "已连接" again within the backoff window.
#
# Targets the emulator (127.0.0.1:5555) by default; override with
# CCPET_DEVICE_TARGET for a real device. Never touches the operator's real
# server -- clears the target's app data and logs in fresh against a
# throwaway local server this probe starts and kills itself.
#
# What this actually asserts, and why: the brief's original wording asked for
# a hilog grep for a literal "reconnect" + "connected" log line. ConnectionGateway
# never hilog.info()'s its phase transitions (grep gateway/ConnectionGateway.ets --
# the only hilog calls in that file are history-backfill error paths). The
# real, user-visible signal for this state machine is ConnectionBadge's label
# (entry/src/main/ets/components/ConnectionBadge.ets: 已连接 / 连接中 / 重连中 /
# 未连接), which is exactly what ConnectionStore.phase drives -- so this probe
# reads that label via `uitest dumpLayout` instead of grepping for a string
# that was never going to be there.
#
# Task 17's on-device verification found hdc's reverse port forward (rport)
# can silently die mid-session. This probe re-verifies (and re-establishes)
# it both before the initial connection and again right before the recovery
# wait, since that is exactly the moment a dead tunnel would otherwise make
# this probe hang waiting for a "connected" badge that can never arrive.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_NAME="device-reconnect-probe"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ccpet-reconnect-probe.XXXXXX")"
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

SERVER_PORT="${CCPET_PROBE_SERVER_PORT:-19321}"
BRIDGE_PORT="${CCPET_PROBE_BRIDGE_PORT:-19322}"

start_fixture_stack "$SERVER_PORT" "$BRIDGE_PORT"
ensure_rport "$SERVER_PORT"

reset_app_state
launch_app
perform_login "http://127.0.0.1:$SERVER_PORT" "$FIXTURE_TOKEN" "$LAYOUT"
# A fresh install can show the one-time notification-permission system
# dialog right as ChatWindow mounts, which overlays (and hides from uitest)
# the connection badge just confirmed by perform_login. Clear it if present.
grant_notification_permission_if_present "$LAYOUT"

badge_shows_connected() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_contains "$LAYOUT" '已连接'
}
if ! wait_until 10 1 badge_shows_connected; then
  fail "login succeeded but the connection badge never reached 已连接 (connected) to begin with"
fi
echo "[$PROBE_NAME] confirmed initial 已连接, now killing the fixture server to force a drop..."

kill_fixture_server

badge_left_connected() {
  dump_layout_soft "$LAYOUT" || return 1
  ! ui_contains "$LAYOUT" '已连接'
}

# ConnectionGateway's own backoff starts at 1s (backoffDelayMs(0)), so the
# badge should visibly leave 已连接 quickly once the socket errors out.
if ! wait_until 20 1 badge_left_connected; then
  fail "connection badge stayed at 已连接 for 20s after the server was killed -- no drop was ever observed"
fi
echo "[$PROBE_NAME] badge left 已连接 as expected, bringing the server back..."

# Re-verify the tunnel before the recovery wait -- this is exactly the moment
# a silently-dead rport (Task 17's concern) would otherwise strand this probe.
ensure_rport "$SERVER_PORT"
restart_fixture_server

badge_reconnected() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_contains "$LAYOUT" '已连接'
}

# backoffDelayMs caps at 30s; give it a full cycle plus margin.
if ! wait_until 45 2 badge_reconnected; then
  fail "server came back but the connection badge never returned to 已连接 within 45s"
fi

pass "connection badge went 已连接 -> (dropped) -> 已连接 after the server was killed and restarted"
